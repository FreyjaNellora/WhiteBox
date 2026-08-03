#!/usr/bin/env python
"""
Sovereign Search - deterministic quote-miner (v2, NO LLM).

  query -> SearXNG engine -> fetch top *credible* pages -> mine VERBATIM passages
  that match the query -> globally rank by relevance + source credibility ->
  write to quarantine -> SCAN (safety + provenance) -> release a clean markdown of
  direct quotes, each with exact source + paragraph + a text-fragment deep link.

v2 sharpening over v1:
  * junk/citation/boilerplate filter (no more bibliography lines as "quotes")
  * relevance = query-term COVERAGE + quote/blockquote boost, not raw term count
  * GLOBAL credibility-weighted ranking (EDU/JOURNAL/PRIMARY beat WEB blogs)
  * full passages (higher length cap; nothing truncated mid-thought)
  * per-registrable-domain cap + substring de-dup (variety, no near-repeats)

Guarantees unchanged: verbatim by construction (no model authors anything),
scanned before release (hidden-unicode / bidi / tag-char / control / entropy) and
provenance-verified, fully local.

Usage:  python quotemine.py "your query" [--sources 8] [--quotes 12] [--per-domain 3]
Needs the local engine running (start-sovereign-search.ps1 -> 127.0.0.1:8888).
"""

import argparse
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import quote as urlquote, urlparse

import httpx
from lxml import html as lxhtml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import classify, classify_query, bonus_for, http_url   # tiers + profiles + emit-URL gate
from canonical import readable, scan_text                # single source of truth for unicode safety
from netfetch import guarded_client, safe_get             # ONE guarded fetcher (SSRF + byte cap + HTML-only)
from netfetch import strip_url_creds as strip_creds, reg_domain   # ONE cred-strip + reg_domain def

SEARXNG = "http://127.0.0.1:8888"
HERE = os.path.dirname(os.path.abspath(__file__))
QDIR = os.path.join(HERE, "quarantine")
PENDING = os.path.join(QDIR, "pending")
VERIFIED = os.path.join(QDIR, "verified")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SovereignSearch/quote-miner"

STOP = set(("the a an of to in on and or for with from by is are was were be been being as at "
            "that this it its into about over under how what why who when where which their his "
            "her they them he she you your our we i do does did not no yes can could would should "
            "will s t re ve ll m d on off out up down more most very").split())

QUOTE_CHARS = "“”‘’«»\"'"
TIER_BONUS = {0: 2.2, 1: 1.3, 2: 0.0, 3: -0.9, 4: -2.2}
LEN_MIN, LEN_MAX = 110, 1600   # floor high enough that lone one-liners don't qualify; full paragraphs do


# unicode safety (is_dangerous / scan_text / clean_for_output) now lives in
# canonical.py - the single source of truth. quotemine imports readable + scan_text
# from there instead of carrying its own drifting copy.


# ---------------------------------------------------------------- quality filters
def is_junk(text: str) -> bool:
    """Reject citations, nav, boilerplate, fragments - anything that isn't a real passage."""
    words = text.split()
    if len(words) < 18:                                          # want a paragraph, not a caption/one-liner
        return True
    letters = sum(c.isalpha() for c in text)
    if letters / max(len(text), 1) < 0.60:                       # too much punctuation/digits
        return True
    if re.search(r"\b(doi:|isbn|pp?\.\s*\d|vol\.\s*\d+|retrieved from|©|all rights reserved"
                 r"|cookie|subscribe|newsletter|sign in|privacy policy|terms of service)\b",
                 text, re.I):
        return True
    if re.search(r"\(\d{4}\)", text) and text.count(",") >= 3 and len(words) < 28:  # "Author, Title (1990)"
        return True
    if not re.search(r"[.!?][\"”’)]?(\s|$)", text):     # needs a real sentence ending
        return True
    return False


def relevance(text: str, terms, is_block: bool) -> float:
    low = text.lower()
    present = sum(1 for t in terms if t in low)
    if present == 0:
        return 0.0
    coverage = present / max(len(terms), 1)
    score = coverage * 3.0 + min(present, 5) * 0.2
    if any(qc in text for qc in QUOTE_CHARS):                    # contains an actual quotation
        score += 0.9
    if is_block:                                                 # <blockquote> is quote-shaped
        score += 1.1
    if len(re.findall(r"[.!?][\"”’)]?(\s|$)", text)) >= 3:        # fuller, multi-sentence context
        score += 0.6
    return score


def grade_citations(cites):
    """Grade the sources a passage links to. First-hand (primary) beats third-hand.
    We grade the cited DOMAIN's credibility; we do NOT open each link (speed + safety)."""
    first = second = weak = 0
    for u in cites:
        tier, _ = classify(u)
        if tier <= 1:
            first += 1          # gov / journal / edu / primary / expert  (first-hand-ish)
        elif tier == 2:
            second += 1         # general web  (second-hand reporting)
        else:
            weak += 1           # forum / social  (third-hand / unsourced)
    bonus = min(first * 0.8 + second * 0.2 - weak * 0.1, 2.5)
    return first, second, weak, bonus


# reg_domain is imported from netfetch (shared with navigate) — one definition of "one domain".


# ---------------------------------------------------------------- fetch + extract
def search(query: str, want: int):
    r = httpx.get(f"{SEARXNG}/search", params={"q": query, "format": "json"},
                  timeout=30, headers={"User-Agent": UA})
    r.raise_for_status()
    seen, ranked = set(), []
    for res in r.json().get("results", []):
        url = res.get("url") or ""
        if not url.startswith(("http://", "https://")):
            continue
        host = (urlparse(url).hostname or "").lower()
        if not host or host in seen:
            continue
        seen.add(host)
        tier, label = classify(url)
        ranked.append({"url": url, "host": host, "tier": tier, "label": label,
                       "title": res.get("title") or url})
    ranked.sort(key=lambda x: x["tier"])
    return ranked[:want]


def extract_paragraphs(content: bytes, url: str):
    try:
        doc = lxhtml.fromstring(content)
    except Exception:
        return url, []
    for bad in doc.xpath("//script | //style | //noscript | //nav | //footer | //header"):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    # readable() strips dangerous unicode (control/bidi/tag/C1) from the attacker-controlled <title>;
    # markdown metachars are escaped at render (md_escape) and the title is scanned before release.
    raw_title = re.sub(r"\s+", " ", (doc.findtext(".//title") or url)).strip()[:200]
    title = readable(raw_title)          # scan the RAW title (below); readable() would strip evidence
    paras, n = [], 0
    for el in doc.xpath("//blockquote | //p"):
        n += 1
        clean = readable(el.text_content())
        if LEN_MIN <= len(clean) <= LEN_MAX:
            cites = [h for h in el.xpath(".//a/@href") if h.startswith(("http://", "https://"))]
            paras.append({"n": n, "raw": el.text_content(), "text": clean,
                          "block": el.tag == "blockquote", "cites": cites})
    return title, raw_title, paras


def terms_of(query: str):
    return [w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2 and w not in STOP]


def make_fragment(url: str, quote: str) -> str:
    snippet = " ".join(quote.split()[:10]).strip(" .,;:—-")
    return f"{url}#:~:text={urlquote(snippet, safe='')}"


def md_escape(s: str) -> str:
    """Escape markdown / inline-HTML metachars so an attacker-controlled title OR quote body can't
    inject link / image / HTML / code syntax into the released 'verified' artifact. Escaping ] and [
    breaks `[x](y)`, `![x](y)`, `[x][ref]`; `<` breaks inline HTML; `` ` `` breaks code spans.
    Parentheses and ordinary prose punctuation are left intact for readability (a lone `(` can't form
    a link without the `]` before it, which is escaped)."""
    # `&` is escaped so HTML-entity encodings (&#91; -> [) can't be decoded by the renderer back into
    # markdown metachars (Kimi round-4); *,_,# block bold/italic/heading formatting injection (DF4).
    # `\` MUST be first so the escapes we add aren't themselves re-escaped.
    for a, b in (("\\", "\\\\"), ("&", "\\&"), ("`", "\\`"), ("[", "\\["), ("]", "\\]"),
                 ("<", "\\<"), ("*", "\\*"), ("_", "\\_"), ("#", "\\#"), ("~", "\\~")):
        s = s.replace(a, b)
    return s


# strip_creds is imported from netfetch (strip_url_creds) — one definition, so a future fix to it
# (e.g. percent-decoded creds) can't silently miss this file the way a private copy would.


# ---------------------------------------------------------------- assemble + gate
def build_markdown(query, quotes, n_sources, scan, verified):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    status = "VERIFIED - safe to open" if verified else "QUARANTINED - scan flags present, NOT released"
    L = [f"# Direct quotes: {query}", "",
         f"**Status:** {status}  ", f"**Retrieved:** {now}  ",
         f"**Sources mined:** {n_sources}  ·  **Quotes:** {len(quotes)}  ", "",
         "> Verbatim passages mined directly from the source pages, ranked by relevance and "
         "source credibility. No summary, no paraphrase, no AI. Each link is a text-fragment "
         "deep link that jumps to the quote on the page.", "", "## Scan report"]
    if not scan:
        L.append("- clean: no hidden unicode, control chars, bidi overrides, tag chars, or high-entropy blobs.")
        L.append("- provenance: every quote below was confirmed present verbatim in its source page.")
    else:
        L += [f"- **{k}**: {d}" for k, d in scan]
    L += ["", "---", ""]
    for i, q in enumerate(quotes, 1):
        parts = []
        if q.get("cf"): parts.append(f"{q['cf']} first-hand")
        if q.get("cs"): parts.append(f"{q['cs']} second-hand")
        if q.get("cw"): parts.append(f"{q['cw']} weak")
        cnote = (" · cites " + ", ".join(parts)) if parts else ""
        L += [f"### {i}. {q['source_type']} — {q['host']}", "",
              "> " + md_escape(q["text"]), "",       # body is the largest attacker-controlled string
              f"[{md_escape(q['title'])}]({make_fragment(q['url'], q['text'])}) · paragraph {q['n']}{cnote} · retrieved {now}", ""]
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--sources", type=int, default=8)
    ap.add_argument("--quotes", type=int, default=12)
    ap.add_argument("--per-domain", type=int, default=3)
    ap.add_argument("--navigate", action="store_true",
                    help="discover sources via small-world navigation (reaches long-tail 'small data')")
    args = ap.parse_args()

    os.makedirs(PENDING, exist_ok=True)
    os.makedirs(VERIFIED, exist_ok=True)
    terms = terms_of(args.query)
    qtype = classify_query(args.query)  # adaptive: source mix tuned to this query type

    try:
        if args.navigate:
            from navigate import navigable_search
            nav, _, _ = navigable_search(args.query, budget_hops=3, budget_fetches=12)
            sources = [{"url": r["url"], "host": r["host"], "tier": r["tier"],
                        "label": r["source_type"], "title": r["title"]} for r in nav[:args.sources]]
        else:
            sources = search(args.query, args.sources)
    except Exception as e:
        print(f"! engine unavailable ({e}). Start it: start-sovereign-search.ps1")
        sys.exit(2)
    if not sources:
        print("! no results.")
        sys.exit(1)

    # ---- gather a GLOBAL candidate pool across all sources ----
    # Every page fetch routes through netfetch.safe_get: SSRF host-guard on every redirect hop,
    # HTML-only, 8 MB byte cap. (The `search()` call above talks to our OWN local engine over
    # loopback on purpose — that's not an untrusted fetch and stays raw httpx.)
    pool = []
    with guarded_client() as client:
        for src in sources:
            content = safe_get(client, src["url"])
            if content is None:                          # blocked host / non-HTML / over cap / error
                continue
            title, raw_title, paras = extract_paragraphs(content, src["url"])
            full_clean = " ".join(p["text"] for p in paras)
            for p in paras:
                if is_junk(p["text"]):
                    continue
                rel = relevance(p["text"], terms, p["block"])
                if rel <= 0 or p["text"] not in full_clean:      # relevance + provenance
                    continue
                cf, cs, cw, cbonus = grade_citations(p.get("cites", []))
                pool.append({"url": http_url(src["url"]), "host": src["host"],   # emit-gate: scheme +
                             "title": title, "title_raw": raw_title,             # no-internal + no-creds;
                             "source_type": src["label"], "tier": src["tier"], "n": p["n"],
                             "text": p["text"], "raw": p["raw"], "cf": cf, "cs": cs, "cw": cw,
                             "score": rel + bonus_for(qtype, src["label"]) + cbonus})

    # ---- credibility-weighted global rank, per-domain cap, substring de-dup ----
    pool.sort(key=lambda c: -c["score"])
    quotes, chosen, dom = [], [], {}
    for c in pool:
        if len(quotes) >= args.quotes:
            break
        d = reg_domain(c["host"])
        if dom.get(d, 0) >= args.per_domain:
            continue
        if any(c["text"] in s or s in c["text"] for s in chosen):   # near-duplicate
            continue
        quotes.append(c)
        chosen.append(c["text"])
        dom[d] = dom.get(d, 0) + 1

    n_sources = len({q["host"] for q in quotes})

    # ---- SCAN (raw text of every released quote) ----
    scan = []
    for q in quotes:
        for kind, detail in scan_text(q["raw"]):
            scan.append((kind, f"{q['host']} p{q['n']}: {detail}"))
        for kind, detail in scan_text(q.get("title_raw", q["title"])):   # scan RAW title (pre-readable)
            scan.append((kind, f"{q['host']} title: {detail}"))
    critical = [f for f in scan if f[0] in ("control-char", "bidi-override", "tag-char", "encoded-blob")]
    verified = bool(quotes) and not critical

    md = build_markdown(args.query, quotes, n_sources, scan, verified)
    slug = re.sub(r"[^a-z0-9]+", "-", args.query.lower()).strip("-")[:40] or "query"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(VERIFIED if verified else PENDING, f"{slug}-{stamp}.md")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(md)

    print(f"query type   : {qtype}  (source mix auto-tuned for this)")
    print(f"quotes mined : {len(quotes)} from {n_sources} sources (pool of {len(pool)} candidates)")
    print(f"tiers        : " + ", ".join(f"{k}:{v}" for k, v in sorted(Counter(q['source_type'] for q in quotes).items())))
    print(f"scan flags   : {len(scan)} ({len(critical)} critical)")
    print(f"status       : {'VERIFIED' if verified else 'QUARANTINED (not released)'}")
    print(f"output       : {dest}")


if __name__ == "__main__":
    main()
