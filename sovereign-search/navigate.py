#!/usr/bin/env python
"""
Navigable Retrieval — small-world navigation layer over sovereign-search.

Turns a flat lookup into a WALK to reach the long-tail "small data":
  seed with a normal search  ->  hop:
     A) snowball: fetch the best results, harvest their outbound links, keep the
        credible/relevant neighbors (the page no keyword surfaced, one hop from a hub)
     B) re-query with the VOCABULARY learned from the landing pages (you couldn't
        have typed the field's jargon up front; you learn it by landing near the target)
  ...to a hop/fetch budget, then MMR re-rank (relevance x credibility x diversity)
  so weak-tie / adjacent-cluster results survive instead of only the dense core.

Harvested links accumulate in a local SQLite graph (cache/navgraph/graph.db) so each
query makes the next more navigable — same pattern as gdelt_ingest.py. Reuses
canonical.readable (unicode-safe text) + server.classify (credibility tiers). Zero new
deps (httpx, lxml, sqlite3, re) -> run under the same python as server.py (searxng venv).

CLI:    python navigate.py "your query" [--hops 4] [--fetches 16] [--show-path]
Module: from navigate import navigable_search   ->  (results, path, stats)
"""
import argparse
import hashlib
import os
import re
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse

import httpx
from lxml import html as lxhtml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import classify                       # credibility tiers (single source of truth)
from canonical import readable                    # unicode-safe clean text (our security primitive)
from netfetch import guarded_client, safe_get, strip_url_creds, reg_domain, BROWSER_UA, MAX_FETCH_BYTES  # ONE guarded fetcher

SEARXNG = "http://127.0.0.1:8888"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SovereignSearch/navigate"
HERE = os.path.dirname(os.path.abspath(__file__))
GRAPH_DB = os.path.join(HERE, "cache", "navgraph", "graph.db")
TIER_W = {0: 1.4, 1: 1.15, 2: 1.0, 3: 0.7, 4: 0.4}   # credibility -> weight
STOP = set((
    "the a an of to in on and or for with from by is are was were be been being as at that this it its "
    "into about over under how what why who when where which their his her they them he she you your our we "
    "i do does did not no yes can could would should will more most very how-to page home search com www "
    "http https html org net you https www use using used one two new get see also may than then them "
    "prev next subjects organizations recent submission submit cite download abstract authors author "
    "license copyright comments version revision permalink bibtex export metadata pdf doi issn isbn vol "
    "pp published journal article paper login sign share tweet email print menu skip content main "
    "undergraduate graduate department faculty students resources permissions affiliations enter major "
    "latest overall subject submitted various close those both displaystyle mathrm href www full text "
    "bibsonomy requtask bibtexhandler upload download endnote refworks mendeley zotero citeulike fixed-growth"
).split())


# ---------------------------------------------------------------- helpers
def _terms(s):
    # `^` kept so "max^n" survives tokenisation as itself. It used to reduce to
    # "max", which means nothing on its own — the exponent IS the name.
    return [w for w in re.findall(r"[a-z][a-z0-9\-\^']{2,}", (s or "").lower()) if w not in STOP]


# CLOSED GRAMMATICAL CLASS — determiners, prepositions, pronouns, auxiliaries,
# conjunctions. English stopped inventing these centuries ago, so unlike a
# stopword list this needs no curation and encodes no domain opinion.
#
# It is deliberately NOT the STOP list above. STOP mixes function words with
# domain-generic ones ("search", "page", "home"), and those are exactly the
# words mechanism names are built from: "paranoid SEARCH", "opening BOOK",
# "transposition TABLE", "null MOVE pruning". Filtering bigrams with STOP
# would delete the very terms worth learning.
FUNC = set((
    "the a an this that these those of to in on at by for with from into over under "
    "and or but nor so yet if then than as is are was were be been being am do does did "
    "have has had can could will would shall should may might must it its they them their "
    "he she his her you your we our i me my not no all any each every some most more much "
    "very both other same only also there here when where which who whom what why how "
    "about after before during while since until such own too just even still again once further"
).split())


def _phrases(s):
    """Bigrams whose ends are both content words.

    THE REASON THIS EXISTS: field vocabulary is overwhelmingly MULTIWORD, and
    unigram tokenisation dissolves it into its generic parts. Measured:

        max^n              -> ['max']          the exponent deleted
        paranoid search    -> ['paranoid']     "search" is in STOP
        null move pruning  -> ['null','move','pruning']   three ordinary words

    So the learner could not represent "alpha-beta pruning" or "opening book"
    at all, and reported the debris instead — which is why it kept returning
    `even, other, many, some`. The jargon was never missing from the corpus;
    tokenisation destroyed it on the way in.

    Bigrams also solve the background-corpus problem that defeated two earlier
    attempts (a document-frequency band, then association-graph degree — both
    measured, both failed, see _learn_vocab). Generic word PAIRS are far rarer
    than generic words: "opening book" is unmistakably technical while
    "opening" and "book" are not. The contrast comes free from the pairing, so
    no external frequency table is needed.

    Measured on the 8-page curated 4PC set: opening book, chess engine,
    computer chess, neural network, deep learning, learning algorithm.
    """
    toks = re.findall(r"[a-z][a-z0-9\-\^']{1,}", (s or "").lower())
    out = set()
    for a, b in zip(toks, toks[1:]):
        if a in FUNC or b in FUNC or len(a) < 3 or len(b) < 3:
            continue
        out.add(f"{a} {b}")
    return out


def _cred(r):
    return TIER_W.get(r.get("tier", 2), 1.0)


def _relevance(text, terms):
    if not terms:
        return 0.0
    low = (text or "").lower()
    return sum(1 for t in terms if t in low) / len(terms)


def _blob(r):
    return (r.get("title", "") or "") + " " + (r.get("content", "") or "")


def _nid(url):
    return hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------- search + fetch
def _search(query, n=12, engines=None):
    params = {"q": query, "format": "json"}
    if engines:
        params["engines"] = engines
    try:
        r = httpx.get(f"{SEARXNG}/search", params=params, timeout=25, headers={"User-Agent": UA})
        r.raise_for_status()
        raw = r.json().get("results", [])
    except Exception:
        return []
    out, seen = [], set()
    for res in raw[: n * 2]:
        url = res.get("url") or ""
        if not url.startswith(("http://", "https://")):
            continue
        host = (urlparse(url).hostname or "").lower()
        if not host or url in seen:
            continue
        seen.add(url)
        tier, label = classify(url)
        out.append({"url": url, "host": host, "title": (res.get("title") or url),
                    "content": (res.get("content") or ""), "tier": tier, "source_type": label})
        if len(out) >= n:
            break
    return out


def _fetch(url, client):
    """Return (clean_text, [(link_url, anchor)...]) for a page. Fails soft to ('', []).
    All fetching goes through netfetch.safe_get: SSRF host-guard on every hop, capped manual
    redirects, HTML-only, byte-capped streaming (the ONE shared guard, see netfetch.py)."""
    if url.lower().split("?")[0].endswith((".pdf", ".zip", ".gz", ".png", ".jpg", ".jpeg", ".mp4", ".ps")):
        return "", []                                     # binary -> lxml would emit junk tokens
    content = safe_get(client, url)
    if content is None:
        return "", []
    try:
        doc = lxhtml.fromstring(content)
    except Exception:
        return "", []
    for bad in doc.xpath("//script | //style | //noscript | //nav | //footer | //header"):
        p = bad.getparent()
        if p is not None:
            p.remove(bad)
    text = readable(doc.text_content())
    links = []
    for a in doc.xpath("//a[@href]"):
        full = strip_url_creds(urljoin(url, a.get("href", "")).split("#")[0])   # no creds into the graph
        if full.startswith(("http://", "https://")):
            links.append((full, readable(a.text_content())[:80]))
    return text, links


def _learn_vocab(texts, known, k=4, hosts=None):
    """Distinctive field terms: CORROBORATED but not UNIVERSAL.

    The docstring always said "distinctive". The implementation was
    `df.most_common(120)`, which selects the exact opposite: over a small
    corpus the most frequent terms are generic English, because they appear in
    every document. Seeding a curated 4-player-chess reference set produced

        change, results, even, evaluation, references, other, many, some,
        further, number, algorithm, have, links, approach, same, stockfish,
        while, error

    — three useful words carried by fifteen passengers. A term present in ALL
    documents cannot distinguish them from each other; that is the whole idea
    behind IDF, and it was inverted here.

    THE BAND BELOW DOES NOT FIX THAT, and the measurement says so plainly.
    Over the 8-page curated set:

        generic   even 5/8  other 4/8  many 4/8  some 4/8  approach 4/8
        jargon    evaluation 5/8  stockfish 4/8  engines 4/8  parameters 4/8

    The distributions are IDENTICAL. `stockfish` and `many` both appear in 4
    of 8; `evaluation` and `even` both in 5. No threshold on document
    frequency separates them — not at this corpus size, not at any, because
    the signal is simply not in within-corpus frequency.

    A second mechanism was tried and also failed: genericness as DEGREE in the
    accumulated association graph, on the theory that common words connect to
    many unrelated topics. Measured over 779 associations spanning 3 topics —
    generic 5,5,5,5,8,10 versus jargon 5,9,6,0,0,0. `metamorphic` scored
    HIGHER than most function words. That idea needs breadth (many unrelated
    topics) before it can discriminate; it is not wrong, it is starved.

    So what the band actually buys is NOT distinctiveness:
      df >= 2            CORROBORATION — a term backed by more than one page.
                         Real, independent value: it is the same defence
                         assoc_src enforces against one page poisoning the
                         vocabulary.
      df <= 70% of docs  drops the true universals only.

    Both failed because they looked for the signal in FREQUENCY. It was never
    there.

    THE FIX THAT DID WORK is upstream, in `_phrases`: learn BIGRAMS. Field
    vocabulary is multiword, unigram tokenisation was dissolving it into
    generic debris, and generic word PAIRS are rare enough to separate
    themselves without any background corpus. Phrases are returned first and
    banded unigrams only fill the remainder — so the corroboration floor still
    applies, it just no longer has to carry a job it could not do.
    """
    # COUNT DISTINCT DOMAINS, NOT PAGES, when the caller can say which is
    # which. This is not a new idea — `_record_assoc` already refuses to warm a
    # term unless >=2 DISTINCT domains carry it, and its comment notes the rule
    # "happens to sharpen quality too". The learner simply never applied it.
    #
    # It is the exact mechanism that kills the remaining noise. Site chrome
    # ("wiki jump", "navigation search", "signed out", "another tab") repeats
    # across many pages of ONE host; topical vocabulary recurs across
    # DIFFERENT hosts. Counting pages cannot tell those apart; counting
    # domains does, with no list of banned phrases anywhere.
    n = max(1, len(texts))
    floor = 2 if n >= 2 else 1                 # corroboration, per assoc_src
    ceiling = max(2, int(n * 0.7)) if n >= 3 else n
    keys = list(hosts) if hosts and len(hosts) == len(texts) else list(range(len(texts)))

    pdf = {}
    for key, t in zip(keys, texts):
        for p in _phrases(t):
            pdf.setdefault(p, set()).add(key)
    pdf = Counter({p: len(srcs) for p, srcs in pdf.items()})
    phrases = [(p, c) for p, c in pdf.items()
               if c >= floor and not any(w in known for w in p.split())]
    phrases.sort(key=lambda x: (-x[1], x[0]))
    out = [p for p, _ in phrases[:k]]

    if len(out) < k:                            # top up with banded unigrams
        df = Counter()
        for t in texts:
            df.update(set(_terms(t)))
        band = [(w, c) for w, c in df.items()
                if floor <= c <= ceiling and w not in known
                and re.fullmatch(r"[a-z][a-z\-\^]{3,}", w)]
        band.sort(key=lambda x: (-x[1], x[0]))
        out += [w for w, _ in band[:k - len(out)]]
    return out[:k]


def _mmr(results, q_terms, lam=0.3, k=20):
    """Maximal-marginal-relevance: keep relevant+credible, penalize similarity to the
    already-selected set so weak-tie / adjacent-cluster hits survive the cut."""
    def sim(a, b):
        ta, tb = set(_terms(_blob(a))), set(_terms(_blob(b)))
        return len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    pool, chosen = list(results), []
    while pool and len(chosen) < k:
        best, best_s = None, -1e9
        for r in pool:
            base = (1 - lam) * _relevance(_blob(r), q_terms) * _cred(r)
            div = max((sim(r, s) for s in chosen), default=0.0)
            s = base - lam * div
            if s > best_s:
                best, best_s = r, s
        chosen.append(best)
        pool.remove(best)
    return chosen


# ---------------------------------------------------------------- persistent graph
# HARD CEILING on the graph — "expand for now, cut off until we have more
# memory" made mechanical, because a rule that lives only in someone's head is
# a rule that gets forgotten at exactly the wrong moment.
#
# Measured 2026-07-25: 1447 nodes / 2057 edges / 591 associations = 984 KB.
# The graph is CHEAP; 64 MB is roughly 60x the current corpus, so this does not
# bite today. It exists so that unattended growth later cannot quietly eat a
# disk that is already 91% full, and so the cutoff is visible in the code
# rather than remembered.
#
# When it trips, READS AND SEARCH KEEP WORKING — only new writes stop. A search
# tool that goes dark because its cache filled is worse than one that stops
# learning.
GRAPH_MAX_BYTES = int(os.environ.get("SOVEREIGN_GRAPH_MAX_MB", "64")) * 1024 * 1024
_GRAPH_FULL = False


def graph_room_left():
    """(bytes_used, bytes_allowed, is_full). Cheap enough to call per walk."""
    try:
        used = sum(os.path.getsize(GRAPH_DB + s) for s in ("", "-wal", "-shm")
                   if os.path.exists(GRAPH_DB + s))
    except OSError:
        return (0, GRAPH_MAX_BYTES, False)
    return (used, GRAPH_MAX_BYTES, used >= GRAPH_MAX_BYTES)


def _graph_db():
    global _GRAPH_FULL
    os.makedirs(os.path.dirname(GRAPH_DB), exist_ok=True)
    used, allowed, full = graph_room_left()
    if full and not _GRAPH_FULL:
        print(f"[navgraph] CEILING REACHED — {used/1048576:.1f} MB of "
              f"{allowed/1048576:.0f} MB. Learning is paused; search and the "
              f"existing graph still work. Raise SOVEREIGN_GRAPH_MAX_MB when "
              f"there is room.", file=sys.stderr)
    _GRAPH_FULL = full
    con = sqlite3.connect(GRAPH_DB, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("""CREATE TABLE IF NOT EXISTS nodes(
        id TEXT PRIMARY KEY, url TEXT, host TEXT, title TEXT, tier INTEGER, label TEXT,
        first_seen TEXT, last_seen TEXT, seen INTEGER DEFAULT 1)""")
    con.execute("""CREATE TABLE IF NOT EXISTS edges(
        src TEXT, dst TEXT, kind TEXT, weight REAL, anchor TEXT,
        first_seen TEXT, last_seen TEXT, seen INTEGER DEFAULT 1,
        PRIMARY KEY(src, dst, kind))""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_edge_src ON edges(src)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst)")
    con.execute("""CREATE TABLE IF NOT EXISTS term_assoc(
        a TEXT, b TEXT, weight REAL DEFAULT 1.0, seen INTEGER DEFAULT 1, last_seen TEXT,
        PRIMARY KEY(a, b))""")                            # the vocabulary of associations (grows with use)
    con.execute("CREATE INDEX IF NOT EXISTS idx_assoc_a ON term_assoc(a)")
    con.execute("""CREATE TABLE IF NOT EXISTS assoc_src(
        a TEXT, b TEXT, src TEXT, PRIMARY KEY(a, b, src))""")   # PROVENANCE: which domains corroborate
    con.execute("CREATE INDEX IF NOT EXISTS idx_assoc_src_b ON assoc_src(b)")   # each (a,b) association
    return con


def _record_node(con, r):
    # Writes stop at the ceiling; reads never do. A node already known still
    # gets its `seen` bumped elsewhere on read paths, so the graph degrades to
    # frozen rather than broken.
    if _GRAPH_FULL:
        return
    now = datetime.now(timezone.utc).isoformat()
    con.execute("""INSERT INTO nodes(id,url,host,title,tier,label,first_seen,last_seen,seen)
        VALUES(?,?,?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, seen=seen+1""",
        (_nid(r["url"]), r["url"], r.get("host", ""), (r.get("title") or "")[:200],
         r.get("tier", 2), r.get("source_type", ""), now, now))


def _record_edge(con, src, dst, kind, weight, anchor):
    if _GRAPH_FULL:
        return
    now = datetime.now(timezone.utc).isoformat()
    con.execute("""INSERT INTO edges(src,dst,kind,weight,anchor,first_seen,last_seen,seen)
        VALUES(?,?,?,?,?,?,?,1)
        ON CONFLICT(src,dst,kind) DO UPDATE SET last_seen=excluded.last_seen, seen=seen+1""",
        (_nid(src), _nid(dst), kind, weight, (anchor or "")[:120], now, now))


def _graph_hubs(con, q_terms, limit=6):
    """WARM phase: pull accumulated, credible, on-topic hubs (high out-degree) from the
    persistent graph, so a related query starts from known shortcuts instead of cold."""
    if not q_terms:
        return []
    clause = " OR ".join(["lower(n.title) LIKE ?"] * len(q_terms))
    args = [f"%{t}%" for t in q_terms]
    rows = con.execute(
        f"""SELECT n.url, n.host, n.title, n.tier, n.label,
                   (SELECT COUNT(*) FROM edges e WHERE e.src = n.id) AS outdeg
            FROM nodes n
            WHERE ({clause}) AND n.tier <= 2
            ORDER BY outdeg DESC, n.seen DESC LIMIT ?""",
        args + [limit]).fetchall()
    hubs = [{"url": u, "host": h, "title": t, "content": "", "tier": ti, "source_type": lab}
            for (u, h, t, ti, lab, od) in rows if od > 0]
    if len(q_terms) >= 2:                                 # require >=2 query terms in the title -> cuts
        hubs = [h for h in hubs                           # single-term pollution (smalltalk -> "Small Business")
                if sum(1 for t in q_terms if t in h["title"].lower()) >= 2]
    return hubs


def _record_assoc(con, q_terms, learned, title_srcs=()):
    """Reinforce the vocabulary of associations: every time a query surfaces a field's terms,
    strengthen the query-term <-> field-term links. The map sharpens with every use.

    Two anti-poisoning controls (DF4/Kimi, rounds 2-4):
      * weight is CAPPED at 10 — no amount of repeat-querying lets one edge dominate by magnitude.
      * PROVENANCE: each learned term b is credited to the source DOMAINS whose titles actually
        contain it (via title_srcs). `_assoc_expand` then only warms a term corroborated by >=2
        DISTINCT domains — so a single attacker domain (even with many capped edges) can't steer
        future searches, and it happens to sharpen quality too (only cross-source vocab warms)."""
    if _GRAPH_FULL:
        return
    now = datetime.now(timezone.utc).isoformat()
    for a in set(q_terms):
        for b in set(learned):
            if a != b:
                con.execute(
                    """INSERT INTO term_assoc(a,b,weight,seen,last_seen) VALUES(?,?,1.0,1,?)
                       ON CONFLICT(a,b) DO UPDATE SET weight=min(weight+1.0, 10.0), seen=seen+1,
                       last_seen=excluded.last_seen""", (a, b, now))
                for title, host in title_srcs:            # credit b only to domains whose title has it
                    h = reg_domain(host)                   # eTLD+1: a.evil.com & b.evil.com == one source
                    if h and b in (title or "").lower():
                        con.execute("INSERT OR IGNORE INTO assoc_src(a,b,src) VALUES(?,?,?)", (a, b, h))


def _assoc_expand(con, q_terms, k=5):
    """WARM vocabulary from ACCUMULATED memory, **recency-decayed** (90-day half-life, so it SHARPENS
    not dilutes over time) and weighted by **how many of the query's terms** each associates with
    (topic-coherence — cuts single-term cross-topic pollution like flask->'python snake')."""
    if not q_terms:
        return []
    qs = list(q_terms)
    ph = ",".join("?" * len(qs))
    rows = con.execute(
        f"""SELECT b, SUM(weight) AS w, MAX(last_seen) AS ls, COUNT(DISTINCT a) AS qcov
            FROM term_assoc WHERE a IN ({ph}) AND b NOT IN ({ph})
              AND b IN (SELECT b FROM assoc_src GROUP BY b HAVING COUNT(DISTINCT src) >= 2)
            GROUP BY b""", qs + qs).fetchall()   # only warm terms corroborated by >=2 distinct domains
    now = datetime.now(timezone.utc)
    scored = []
    for b, w, ls, qcov in rows:
        try:
            age_days = max(0, (now - datetime.fromisoformat(ls)).days)
        except Exception:
            age_days = 0
        decay = 0.5 ** (age_days / 90.0)                  # 90-day half-life
        scored.append((b, (w or 0) * decay * qcov))       # qcov>1 => associates with MULTIPLE query terms
    scored.sort(key=lambda x: -x[1])
    return [b for b, _ in scored[:k]]


# ---------------------------------------------------------------- the walk
def navigable_search(query, budget_hops=4, budget_fetches=16, diversity=0.3, engines=None):
    q_terms = _terms(query)
    con = _graph_db()
    visited, fetched, results, path, vocab = set(), set(), [], [], list(q_terms)

    seed = _search(query, n=12, engines=engines)
    for r in seed:
        _record_node(con, r)
        if r["url"] not in visited:
            visited.add(r["url"]); results.append(r)
    path.append({"hop": 0, "action": "seed", "query": query, "got": len(seed)})

    warm_added = 0                                         # WARM: known hubs from prior walks
    for r in _graph_hubs(con, q_terms):
        if r["url"] not in visited:
            visited.add(r["url"]); results.append(r); warm_added += 1
    if warm_added:
        path.append({"hop": 0, "action": "warm_hubs", "added": warm_added})

    mem_terms = _assoc_expand(con, q_terms)               # WARM vocab from accumulated associations
    for w in mem_terms:
        if w not in vocab:
            vocab.append(w)
    if mem_terms:
        path.append({"hop": 0, "action": "assoc_memory", "terms": mem_terms})

    stagnation = 0
    walk_titles = []                                      # accumulate across the walk for cross-page DF
    walk_hosts = []                                       # ...and the DOMAIN each title came from, so
    #                                                       _learn_vocab can count distinct sources rather
    #                                                       than distinct pages (the assoc_src rule)
    with guarded_client() as client:                      # follow_redirects=False + per-hop host check
        for hop in range(1, budget_hops + 1):
            if len(fetched) >= budget_fetches:
                break
            new_here = 0

            # ---- ACTION A: snowball from the best not-yet-fetched credible results ----
            frontier = sorted(
                (r for r in results if r["url"] not in fetched),
                key=lambda r: -(_cred(r) * (1 + _relevance(_blob(r), q_terms))))
            for src in frontier[:3]:
                if len(fetched) >= budget_fetches:
                    break
                fetched.add(src["url"])
                text, links = _fetch(src["url"], client)
                neigh = []
                for lurl, anchor in links[:50]:
                    if lurl in visited:
                        continue
                    tier, label = classify(lurl)
                    nr = {"url": lurl, "host": (urlparse(lurl).hostname or "").lower(),
                          "title": anchor or lurl, "content": "", "tier": tier, "source_type": label}
                    _record_node(con, nr)
                    if src["tier"] <= 2:                   # graph hygiene: only credible pages persist edges
                        _record_edge(con, src["url"], lurl, "hyperlink", 0.7, anchor)
                    neigh.append(nr)
                # link-discovered pages are title-only + noisier: gate to credible AND on-topic
                neigh = [r for r in neigh if r["tier"] <= 2 and _relevance(r["title"], q_terms) > 0]
                neigh.sort(key=lambda r: -(_cred(r) * (1 + _relevance(r["title"], q_terms))))
                kept = 0
                for nr in neigh[:8]:
                    if nr["url"] not in visited:
                        visited.add(nr["url"]); results.append(nr); new_here += 1; kept += 1
                # learn from kept on-topic link TITLES across the WHOLE walk (cross-page DF, clean signal);
                # only reinforce the association memory when the source was actually useful (not noise)
                take = [nr for nr in neigh[:8]]
                walk_titles.extend([nr["title"] for nr in take] + [src.get("title", "")])
                walk_hosts.extend([nr.get("host", "") for nr in take] + [src.get("host", "")])
                learned = _learn_vocab(walk_titles, set(vocab) | set(q_terms), k=4,
                                       hosts=walk_hosts)
                if kept > 0:
                    # (title, host) pairs so each learned term is credited only to the domains whose
                    # title actually contains it -> real multi-source corroboration (anti-poisoning)
                    title_srcs = [(nr["title"], nr["host"]) for nr in neigh[:8]] + [(src.get("title", ""), src.get("host", ""))]
                    _record_assoc(con, q_terms, learned, title_srcs)
                for w in learned:
                    if w not in vocab:
                        vocab.append(w)
                path.append({"hop": hop, "action": "snowball", "from": src["host"],
                             "links": len(links), "kept": min(len(neigh), 8)})

            # ---- ACTION B: re-query with the learned vocabulary (the walk finds the words) ----
            expansion = [w for w in vocab if w not in q_terms][:4]
            exp_q = " ".join(q_terms + expansion)
            if expansion and exp_q != query:
                got = 0
                for r in _search(exp_q, n=10, engines=engines):
                    _record_node(con, r)
                    if r["url"] not in visited:
                        visited.add(r["url"]); results.append(r); new_here += 1; got += 1
                path.append({"hop": hop, "action": "requery", "query": exp_q, "new": got})

            stagnation = stagnation + 1 if new_here == 0 else 0
            if stagnation >= 2:
                break

    con.commit()
    total_nodes = con.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    total_edges = con.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    total_assoc = con.execute("SELECT COUNT(*) FROM term_assoc").fetchone()[0]
    con.close()

    results = [r for r in results if _relevance(_blob(r), q_terms) > 0 or r["tier"] <= 1]  # drop pure drift
    ranked = _mmr(results, q_terms, lam=diversity, k=20)
    stats = {"visited": len(visited), "fetched": len(fetched), "vocab_learned": vocab[len(q_terms):],
             "assoc_memory_used": mem_terms, "assoc_links": total_assoc,
             "graph_nodes": total_nodes, "graph_edges": total_edges}
    return ranked, path, stats


# ---------------------------------------------------------------- CLI
def main():
    ap = argparse.ArgumentParser(description="Navigable (small-world) retrieval over sovereign-search.")
    ap.add_argument("query")
    ap.add_argument("--hops", type=int, default=4)
    ap.add_argument("--fetches", type=int, default=16)
    ap.add_argument("--diversity", type=float, default=0.3)
    ap.add_argument("--show-path", action="store_true")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass

    results, path, stats = navigable_search(args.query, args.hops, args.fetches, args.diversity)
    print(f"query        : {args.query}")
    print(f"walk         : {len(path)} steps, {stats['fetched']} fetches, {stats['visited']} unique urls seen")
    print(f"vocab learned: {', '.join(stats['vocab_learned']) or '(none)'}")
    print(f"from memory  : {', '.join(stats.get('assoc_memory_used', [])) or '(cold - first time on this topic)'}")
    print(f"assoc links  : {stats.get('assoc_links', 0)} (the vocabulary of associations, growing)")
    print(f"graph now    : {stats['graph_nodes']} nodes / {stats['graph_edges']} edges (accumulating)")
    if args.show_path:
        print("path:")
        for s in path:
            print("   " + " ".join(f"{k}={v}" for k, v in s.items()))
    print(f"\ntop {len(results)} navigable results:")
    for i, r in enumerate(results, 1):
        print(f"  {i:2}. [{r['source_type']:8}] {r['host']}")
        print(f"      {(r['title'] or '')[:88]}")


if __name__ == "__main__":
    main()
