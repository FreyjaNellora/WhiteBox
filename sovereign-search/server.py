"""
Sovereign Search — front-end + credibility layer over the local SearXNG JSON engine.

Architecture (Plan B): SearXNG (127.0.0.1:8888) is a headless JSON search *engine*.
This tiny Flask app is the *face*: it serves our UI and proxies search SERVER-SIDE
(so no browser CORS problem), then annotates every result with a source-type / credibility
tier so the user can SEE why each result ranks. This same service is the natural home for
the future MCP `credible_search` tool.

Run with the SearXNG venv (has flask + httpx), from this folder:
  searxng\\venv\\Scripts\\python.exe server.py            (Windows)
  searxng/venv/bin/python server.py                       (Linux/macOS)
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import os
import socket as _socket
import unicodedata
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib.parse import unquote_to_bytes, urljoin, urlparse

import httpx
from flask import Flask, request, jsonify, send_from_directory

from netfetch import _ip_bad  # one shared IP-safety definition (embedded-IPv4 aware); no divergence

SEARXNG = "http://127.0.0.1:8888"
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SovereignSearch"
HERE = os.path.dirname(os.path.abspath(__file__))
EVENTS_CACHE = os.path.join(HERE, "cache", "events")

app = Flask(__name__)
# Privacy: silence werkzeug's per-request access log — those lines contain your query
# strings. Sovereign Search keeps no query history.
logging.getLogger("werkzeug").setLevel(logging.ERROR)

# --- Optional API lock (OFF by default; single-user localhost needs no auth). ---
# Set SOVEREIGN_AUTH_TOKEN to require a token on every API call — do this BEFORE exposing the
# face beyond this machine (e.g. Tailscale Serve/Funnel). When unset, this is a no-op and the
# local flow is unchanged. Token accepted via the `X-Sovereign-Token` HEADER ONLY — the UI reads
# it from the URL hash (#token=) and sends the header, so the long-lived secret never lands in a
# query string / server access log / browser history / shell history.
AUTH_TOKEN = os.environ.get("SOVEREIGN_AUTH_TOKEN", "")


def require_auth(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if AUTH_TOKEN:
            supplied = request.headers.get("X-Sovereign-Token", "")
            if not hmac.compare_digest(supplied, AUTH_TOKEN):   # constant-time: no timing side-channel
                return jsonify({"error": "unauthorized"}), 401
        return f(*a, **kw)
    return wrapper

# Credibility tiers. Lower tier number = more authoritative. First matching rule wins.
# (tier, label, [hostname regexes])
TIERS = [
    (0, "GOV",       [r"\.gov$", r"\.mil$", r"\.gov\.[a-z]{2}$", r"(^|\.)europa\.eu$"]),
    (0, "EDU",       [r"\.edu$", r"\.ac\.[a-z]{2}$"]),
    (0, "JOURNAL",   [r"(^|\.)nature\.com$", r"(^|\.)sciencedirect\.com$", r"(^|\.)cell\.com$",
                      r"(^|\.)springer\.com$", r"(^|\.)wiley\.com$", r"(^|\.)jstor\.org$",
                      r"(^|\.)plos\.org$", r"(^|\.)nih\.gov$", r"(^|\.)ncbi\.nlm\.nih\.gov$",
                      r"(^|\.)arxiv\.org$", r"(^|\.)pubmed\.", r"(^|\.)frontiersin\.org$",
                      r"(^|\.)bmj\.com$", r"(^|\.)thelancet\.com$", r"(^|\.)acm\.org$",
                      r"(^|\.)ieee\.org$", r"(^|\.)semanticscholar\.org$"]),
    (1, "PRIMARY",   [r"(^|\.)loc\.gov$", r"(^|\.)gutenberg\.org$", r"(^|\.)wikisource\.org$",
                      r"(^|\.)archive\.org$", r"(^|\.)hathitrust\.org$"]),
    (1, "REFERENCE", [r"(^|\.)wikipedia\.org$", r"(^|\.)wikiquote\.org$", r"(^|\.)wikidata\.org$",
                      r"(^|\.)britannica\.com$", r"(^|\.)plato\.stanford\.edu$"]),
    (1, "EXPERT",    [r"(^|\.)theconversation\.com$", r"(^|\.)featured\.com$",
                      r"(^|\.)helpareporter\.com$"]),   # academic / vetted-expert-sourced (HARO/Featured)
    (1, "PROFILE",   [r"(^|\.)github\.com$", r"(^|\.)gitlab\.com$", r"(^|\.)codeberg\.org$",
                      r"(^|\.)bandcamp\.com$", r"(^|\.)soundcloud\.com$", r"(^|\.)linkedin\.com$",
                      r"(^|\.)about\.me$", r"(^|\.)keybase\.io$", r"(^|\.)gravatar\.com$",
                      r"(^|\.)bsky\.app$", r"(^|\.)mastodon\.", r"(^|\.)substack\.com$",
                      r"(^|\.)patreon\.com$", r"(^|\.)carrd\.co$", r"(^|\.)linktr\.ee$",
                      r"(^|\.)behance\.net$", r"(^|\.)dribbble\.com$", r"(^|\.)classmates\.com$",
                      r"(^|\.)gitea\.", r"(^|\.)tumblr\.com$", r"(^|\.)wordpress\.com$",
                      r"(^|\.)blogspot\.", r"(^|\.)archiveofourown\.org$", r"(^|\.)wattpad\.com$",
                      r"(^|\.)deviantart\.com$", r"(^|\.)artstation\.com$", r"(^|\.)500px\.com$",
                      r"(^|\.)pixiv\.net$", r"(^|\.)goodreads\.com$", r"(^|\.)dev\.to$",
                      r"(^|\.)flickr\.com$", r"(^|\.)vimeo\.com$"]),   # where people present THEMSELVES (People mode)
    (2, "NEWS",      [r"(^|\.)bbc\.com$", r"(^|\.)bbc\.co\.uk$", r"(^|\.)npr\.org$", r"(^|\.)pbs\.org$",
                      r"(^|\.)reuters\.com$", r"(^|\.)apnews\.com$", r"(^|\.)theguardian\.com$",
                      r"(^|\.)aljazeera\.com$", r"(^|\.)dw\.com$", r"(^|\.)france24\.com$",
                      r"(^|\.)propublica\.org$", r"(^|\.)ctpublic\.org$", r"(^|\.)wnpr\.org$",
                      r"(^|\.)bloomberg\.com$", r"(^|\.)economist\.com$", r"(^|\.)ft\.com$",
                      r"(^|\.)axios\.com$", r"(^|\.)politico\.com$", r"(^|\.)c-span\.org$",
                      r"(^|\.)abcnews\.go\.com$", r"(^|\.)cbsnews\.com$", r"(^|\.)nbcnews\.com$"]),
    (3, "FORUM",     [r"(^|\.)reddit\.com$", r"(^|\.)quora\.com$", r"(^|\.)stackexchange\.com$",
                      r"(^|\.)stackoverflow\.com$", r"(^|\.)ycombinator\.com$"]),
    (4, "SOCIAL",    [r"(^|\.)pinterest\.", r"(^|\.)instagram\.com$", r"(^|\.)facebook\.com$",
                      r"(^|\.)tiktok\.com$", r"(^|\.)x\.com$", r"(^|\.)twitter\.com$",
                      r"(^|\.)medium\.com$", r"(^|\.)forbes\.com$"]),
]
DEFAULT = (2, "WEB")

# Reddit isn't a monolith. Citation-normed Q&A subs are treated as neutral web (they can
# earn a mid-list spot on merit); everything else on reddit stays demoted (FORUM), so it
# lands below the authoritative + general-web results instead of dominating the top.
REDDIT_RIGOROUS = {"askhistorians", "askscience", "askphilosophy", "askengineers",
                   "asksocialscience", "askstatistics", "neutralpolitics", "askdocs"}


def classify(url: str):
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
    except Exception:
        return DEFAULT
    if host == "reddit.com" or host.endswith(".reddit.com"):   # not 'subreddit.com' / 'notreddit.com'
        m = re.search(r"/r/([A-Za-z0-9_]+)", parsed.path or "")
        if m and m.group(1).lower() in REDDIT_RIGOROUS:
            return 2, "REDDIT-QA"           # nuance: a rigorous, sourced subreddit
        return 3, "FORUM"
    for tier, label, pats in TIERS:
        for p in pats:
            if re.search(p, host):
                return tier, label
    return DEFAULT


# --- Adaptive source-balancing: the ideal source mix (the "pie") depends on query type. ---
QUERY_PATTERNS = [
    ("practical", r"\b(how\s+(to|do|can|does)|fix|repair|install|set\s?up|configure|troubleshoot|"
                  r"tutorial|guide|step[- ]by[- ]step|best\s+way|not\s+working|build\s+a|make\s+a)\b"),
    ("contested", r"\b(vs\.?|versus|should\s+(we|i|you|they)|debate|pros\s+and\s+cons|controvers|"
                  r"better\s+than|is\s+it\s+(good|bad|worth|ethical))\b"),
    ("science",   r"\b(stud(y|ies)|research|clinical|trial|evidence|peer[- ]?reviewed|meta[- ]?analysis|"
                  r"efficacy|dosage|mechanism|hypothesis|scientific)\b"),
    ("news",      r"\b(news|latest|today|breaking|current|right\s+now|live|happening|update)\b"),
    ("reference", r"\b(what\s+(is|are|was|were)|who\s+(is|was|were)|when\s+(did|was)|where\s+(is|was)|"
                  r"define|definition|meaning\s+of|history\s+of|origin\s+of|biography)\b"),
    # CODE GOES LAST, and that placement is the whole design.
    #
    # Why the type exists: PROFILE (github/gitlab/codeberg) was listed in
    # exactly ONE of seven profiles, so bonus_for(qtype, "PROFILE") fell
    # through to 0.0 everywhere except People mode. Measured on "Athena four
    # player chess engine": the engine returned github.com/arianahejazyan/
    # Athena as raw result #1, and the face scored it 0.0 -- below a random
    # unclassified site at 0.6 -- and buried it under arxiv/edu/wikipedia.
    # A software query is not a general query, and a repository is not a
    # "profile".
    #
    # Why LAST: this list contains weak words. `engine` and `api` are the
    # useful ones AND the dangerous ones. Placed first, it took "history of
    # the steam engine" (reference) and "search engine optimization vs paid
    # ads" (contested) -- measured, not imagined. The same false-fire family
    # the codebase already documents in _infer_primitives, where "factorial"
    # contains "to" and "arrange" contains "range".
    #
    # Last position makes it a fallback rather than a claim: it fires only
    # when no stronger signal did, so a strong pattern always wins and the
    # weak words can stay broad enough to catch a bare "chess engine".
    ("code",      r"\b(git(hub|lab|ea)?|bitbucket|source\s?code|repo(sitory)?|"
                  r"librar(y|ies)|framework|package|module|plugin|crate|npm|pypi|"
                  r"sdk|api|compiler|interpreter|runtime|engine|implementation|"
                  r"algorithm|open[- ]?source|codebase|fork|pull\s+request)\b"),
]

# label -> bonus, per query type. Label-level control, so e.g. a NEWS query ranks news OUTLETS
# above university .edu pages. Unlisted labels default to 0.
PROFILES = {
    "science": {"JOURNAL": 2.6, "EDU": 2.4, "GOV": 2.2, "PRIMARY": 1.6, "EXPERT": 1.6,
                "REFERENCE": 1.0, "NEWS": 0.2, "WEB": 0.0, "REDDIT-QA": -0.2, "FORUM": -1.0, "SOCIAL": -2.6},
    "reference": {"REFERENCE": 2.4, "PRIMARY": 2.2, "EDU": 1.8, "JOURNAL": 1.6, "GOV": 1.6, "EXPERT": 1.4,
                  "NEWS": 0.4, "WEB": 0.2, "REDDIT-QA": 0.0, "FORUM": -0.6, "SOCIAL": -1.8},
    "news": {"NEWS": 2.8, "GOV": 1.8, "EXPERT": 1.4, "PRIMARY": 1.1, "WEB": 0.6, "REDDIT-QA": 0.4,
             "FORUM": 0.3, "EDU": 0.1, "JOURNAL": 0.0, "REFERENCE": -0.3, "SOCIAL": -0.2},
    "practical": {"FORUM": 1.9, "REDDIT-QA": 1.6, "WEB": 1.3, "EXPERT": 0.8, "PRIMARY": 0.6, "GOV": 0.4,
                  "EDU": 0.3, "NEWS": 0.2, "REFERENCE": 0.2, "JOURNAL": 0.0, "SOCIAL": -0.7},
    "contested": {"EXPERT": 1.8, "PRIMARY": 1.6, "GOV": 1.5, "NEWS": 1.4, "JOURNAL": 1.3, "EDU": 1.2,
                  "REFERENCE": 0.8, "WEB": 0.6, "REDDIT-QA": 0.3, "FORUM": 0.1, "SOCIAL": -1.0},
    "general": {"REFERENCE": 1.4, "PRIMARY": 1.4, "JOURNAL": 1.3, "EDU": 1.3, "GOV": 1.3, "EXPERT": 1.3,
                "NEWS": 1.0, "WEB": 0.6, "REDDIT-QA": 0.5, "FORUM": 0.0, "SOCIAL": -1.5},
    # Code search: the SOURCE outranks the commentary about it. PROFILE at 2.6
    # sits just under the 2.8 top of the scale (people/PROFILE, news/NEWS), so
    # a repository wins without the table growing a new maximum. JOURNAL and
    # EDU stay respectable — arxiv papers and course pages are often the right
    # answer for an algorithm query — but they no longer outrank the code
    # itself. FORUM is mildly positive on purpose: stackoverflow is genuinely
    # useful here, unlike in `science`.
    "code": {"PROFILE": 2.6, "WEB": 1.2, "REFERENCE": 1.0, "EDU": 0.9, "JOURNAL": 0.9,
             "EXPERT": 0.8, "FORUM": 0.7, "REDDIT-QA": 0.6, "PRIMARY": 0.4, "GOV": 0.3,
             "NEWS": 0.1, "SOCIAL": -1.5},
    # People search INVERTS the usual demotion — people live on profiles / social / personal sites.
    "people": {"PROFILE": 2.8, "WEB": 1.4, "SOCIAL": 1.2, "EDU": 1.0, "EXPERT": 0.8, "REDDIT-QA": 0.7,
               "FORUM": 0.6, "REFERENCE": 0.6, "PRIMARY": 0.5, "NEWS": 0.4, "GOV": 0.3, "JOURNAL": 0.2},
}


def bonus_for(qtype: str, label: str) -> float:
    return PROFILES.get(qtype, PROFILES["general"]).get(label, 0.0)


def _internal_literal(host: str) -> bool:
    """True iff host is an internal IP in ANY literal form a browser would resolve to loopback/
    metadata. Covers what a naive ipaddress-only check misses: octal/hex/decimal/short IPv4 encodings
    (0177.0.0.1, 0x7f.0.0.1, 127.1, 2130706433 -> all 127.0.0.1) via inet_aton (same parser browsers
    use), and 6to4/teredo/ipv4-mapped IPv6 embeddings via netfetch._ip_bad (one shared definition,
    no divergence). A real hostname is NOT resolved here (too costly per-URL) — the localhost family
    is handled by the caller."""
    host = host.strip("[]").rstrip(".")
    if not host:
        return True
    try:                                              # canonical IPv4/IPv6 (incl. embedded-IPv4 checks)
        return _ip_bad(str(ipaddress.ip_address(host)))
    except ValueError:
        pass
    try:                                              # non-canonical IPv4 literal — normalize like a browser
        return _ip_bad(str(ipaddress.IPv4Address(_socket.inet_aton(host))))
    except (OSError, ValueError):
        return False                                  # not an IP literal at all -> treat as a hostname


def _percent_decode(s: str):
    """Decode percent-encoding ONCE. Returns None (fail-closed) on invalid UTF-8 — if we can't tell
    what host the browser will see, we refuse to emit the URL rather than guess-and-pass."""
    try:
        return unquote_to_bytes(s).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return None


_IDNA_DOTS = {0x3002: ".", 0xFF0E: ".", 0xFF61: "."}   # ideographic / fullwidth / halfwidth label separators


def _browser_host_norm(host: str) -> str:
    """Approximate the browser's IDNA/UTS46 host mapping enough to catch a Unicode host that resolves
    to an INTERNAL IP (127。0。0。1, fullwidth digits, soft-hyphen/word-joiner/BOM-obscured IPs, etc.):
    drop invisible format chars (UTS46 'ignored'), unify the three IDNA dot separators to '.', and
    NFKC-fold (fullwidth digits/dots -> ASCII). Deliberately narrow — we only need it to reveal an
    internal IP, not to fully reimplement UTS46 — so a legitimate IDN (münchen.de) passes through and
    is NOT rejected; only the normalized form that IS an internal IP gets blocked."""
    host = "".join(ch for ch in host if unicodedata.category(ch) != "Cf")   # strip invisibles
    host = "".join(_IDNA_DOTS.get(ord(ch), ch) for ch in host)              # unify label separators
    return unicodedata.normalize("NFKC", host).lower()


def _whatwg_preprocess(s: str) -> str:
    """The steps a browser applies to the raw URL string BEFORE parsing (WHATWG URL Standard):
    strip leading/trailing C0-control + space, remove ALL tab/newline/CR, and replace backslash with
    forward slash. Python's urlparse does none of these, so without this the server and the browser
    disagree about where the host ends (e.g. 127.0.0.1\\evil.com -> browser host is 127.0.0.1)."""
    s = s.strip("".join(chr(c) for c in range(0x21)))    # C0 (0x00-0x1F) + space (0x20)
    for ch in ("\t", "\n", "\r"):
        s = s.replace(ch, "")
    return s.replace("\\", "/")


def http_url(u: str) -> str:
    """The single gate for every URL handed to a client. Upstreams (SearXNG, GDELT, CourtListener)
    are attacker-influenceable. A URL is a protocol between Python's parser and the BROWSER's — they
    disagree on IPv4 encodings, percent-encoding, `@`-authority-splits, AND backslash/tab/newline
    normalization. Rather than chase each trick, we (1) apply the browser's pre-parse normalization,
    (2) percent-decode the authority (fail-closed on bad encoding) + `@`-split to get the host the
    BROWSER will resolve, (3) reject any host still carrying a structural delimiter (a real host never
    does — a generic backstop against the next normalization variant), then (4) gate that host: http(s)
    only, no internal IP in any form, no localhost family, credentials dropped."""
    u = _whatwg_preprocess((u or "").strip())
    try:
        p = urlparse(u)
        if p.scheme not in ("http", "https") or not p.hostname:
            return ""
        decoded = _percent_decode(p.netloc or "")        # what the browser decodes the authority to
        if decoded is None:
            return ""
        p2 = urlparse("//" + _whatwg_preprocess(decoded))  # re-normalize decoded authority; @-split + v6
        real_host = (p2.hostname or "").lower()
        if not real_host:
            return ""
        # Browsers IDNA/UTS46-normalize the host BEFORE deciding if it's an IPv4 literal, so check the
        # browser-normalized form: 127。0。0。1 / fullwidth digits / invisible-obscured IPs -> 127.0.0.1.
        norm_host = _browser_host_norm(real_host)
        # generic backstop: after correct normalization a host never contains these URL delimiters or
        # control/format chars. Their presence = a parser differential we didn't model -> refuse.
        if (any(c in norm_host for c in "\\/@%? \t\r\n#")
                or any(unicodedata.category(c) in ("Cc", "Cf") for c in norm_host)):
            return ""
        hn = norm_host.rstrip(".")                       # 'localhost.' / '127.0.0.1.' also resolve internal
        if hn == "localhost" or hn.endswith(".localhost") or _internal_literal(norm_host):
            return ""
        ip_host = f"[{real_host}]" if ":" in real_host else real_host
        netloc = ip_host + (f":{p2.port}" if p2.port else "")   # emit the REAL host, normalized, no userinfo
        return p._replace(netloc=netloc).geturl()
    except Exception:
        return ""


def classify_query(q: str) -> str:
    ql = " " + q.lower() + " "
    for qtype, pat in QUERY_PATTERNS:
        if re.search(pat, ql):
            return qtype
    return "general"


@app.route("/")
def index():
    return send_from_directory(HERE, "index.html")


@app.route("/api/search")
@require_auth
def search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"query": q, "results": []})
    people = bool(request.args.get("people"))
    params = {"q": q, "format": "json"}
    if people:  # cast a wide net across where people present themselves
        params["engines"] = ("mastodon users,github,gitlab,codeberg,lemmy users,bandcamp,"
                             "soundcloud,peertube,searchmysite,deviantart,artstation,500px,"
                             "pixiv,flickr,goodreads,hackernews,vimeo,dailymotion,reddit,"
                             "duckduckgo,brave,startpage")  # general engines carry the public Tumblr/AO3/WordPress pages, same as Google
    try:
        r = httpx.get(f"{SEARXNG}/search", params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as e:  # engine down / error — report cleanly, don't 500
        return jsonify({"query": q, "error": f"search engine unavailable ({type(e).__name__})", "results": []}), 502

    qtype = "people" if people else classify_query(q)
    out = []
    for i, res in enumerate(data.get("results", [])):
        url = res.get("url", "") or ""
        tier, label = classify(url)
        out.append({
            "title": res.get("title", "") or url,
            "url": http_url(url),
            "host": (urlparse(url).hostname or "") if url else "",
            "content": res.get("content", "") or "",
            "engine": res.get("engine", "") or "",
            "published": res.get("publishedDate"),
            "tier": tier,
            "source_type": label,
            "_i": i,
        })
    # ADAPTIVE rank: source-type bonus is tuned to THIS query type (the "pie"),
    # then original engine-relevance order breaks ties.
    out.sort(key=lambda r: (-bonus_for(qtype, r["source_type"]), r["_i"]))
    # KEEP THE RAW ORDER — it used to be popped here, one line before the
    # response, which is precisely why the UI could not offer a second view.
    # The engines' own relevance ranking is a real signal, computed for free,
    # and thrown away: on "Athena four player chess engine" it had the right
    # answer at position 1 while the credibility sort buried it.
    #
    # Two orderings of ONE result set, both shipped, no second query and no
    # extra latency. The client can flip between them instantly -- a
    # dual-bar idea, which costs a field rather than a feature.
    for r in out:
        r["rank_raw"] = r.pop("_i")
    comp = Counter(r["source_type"] for r in out)
    return jsonify({"query": q, "query_type": qtype, "count": len(out),
                    "composition": dict(comp.most_common()), "results": out})


# /api/navigate is the most expensive endpoint (up to hops*fetches outbound requests + graph writes)
# and an association-poisoning amplifier. A GENEROUS per-client cap (default 20/min) never bites a human
# but throttles an abuse loop. Keyed by token if set, else source IP. In-memory (single-process Flask).
_NAV_HITS = {}
_NAV_LIMIT = int(os.environ.get("SOVEREIGN_NAV_RATE", "20"))
_NAV_LOCK = threading.Lock()


def _nav_rate_ok(key: str) -> bool:
    with _NAV_LOCK:                                       # atomic read-modify-write (Flask is threaded)
        now = time.time()
        hits = [t for t in _NAV_HITS.get(key, []) if now - t < 60]
        if len(hits) >= _NAV_LIMIT:
            _NAV_HITS[key] = hits
            return False
        if len(_NAV_HITS) > 4096:                         # bound memory BEFORE recording this hit, so the
            for k in [k for k, v in list(_NAV_HITS.items()) if all(now - t >= 60 for t in v)]:
                del _NAV_HITS[k]                          # evict idle keys first
            if len(_NAV_HITS) > 4096:                     # still over? buckets are ephemeral — reset all
                _NAV_HITS.clear()
        hits.append(now)                                  # record AFTER any reset so this hit isn't lost
        _NAV_HITS[key] = hits
        return True


@app.route("/api/navigate")
@require_auth
def api_navigate():
    """Small-world navigable retrieval: seed search -> snowball + vocab-walk + weak-tie
    -> MMR re-rank. Reaches the long-tail 'small data' a flat lookup misses."""
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"query": q, "results": []})
    # Key by SOURCE IP (an attacker rotating X-Sovereign-Token can't mint fresh buckets when auth is
    # off); add the token to the key only when auth is actually on (then the token is meaningful).
    rl_key = request.remote_addr or "?"
    if AUTH_TOKEN:
        rl_key += "|" + request.headers.get("X-Sovereign-Token", "")
    if not _nav_rate_ok(rl_key):
        return jsonify({"query": q, "error": "rate limit: too many navigate calls — slow down"}), 429
    try:
        hops = max(1, min(int(request.args.get("hops", 4)), 8))
        fetches = max(2, min(int(request.args.get("fetches", 16)), 30))
        diversity = max(0.0, min(float(request.args.get("diversity", 0.3)), 1.0))
        from navigate import navigable_search          # lazy: navigate imports classify from us
        results, path, stats = navigable_search(q, budget_hops=hops, budget_fetches=fetches, diversity=diversity)
        for r in results:                              # gate every emitted URL: scheme + no creds + no internal-literal
            r["url"] = http_url(r.get("url", ""))
    except Exception as e:
        return jsonify({"query": q, "error": f"navigate failed ({type(e).__name__})", "results": []}), 502
    comp = Counter(r["source_type"] for r in results)
    out = {"query": q, "count": len(results), "navigable": True,
           "composition": dict(comp.most_common()), "stats": stats, "results": results}
    if request.args.get("path") == "1":
        out["path"] = path
    return jsonify(out)


@app.route("/events")
def events_page():
    return send_from_directory(HERE, "events.html")


@app.route("/records")
def records_page():
    return send_from_directory(HERE, "records.html")


@app.route("/api/events")
@require_auth
def api_events():
    """Query GDELT's free news-event API, cache to local disk, rank by credibility.
    GDELT rate-limits aggressively, so we serve a fresh cache when we have one and
    fall back to a stale cache on error rather than failing."""
    q = request.args.get("q", "").strip()
    days = request.args.get("days", "7")
    days = days if days.isdigit() and 1 <= int(days) <= 60 else "7"
    if not q:
        return jsonify({"query": q, "articles": [], "timeline": []})

    os.makedirs(EVENTS_CACHE, exist_ok=True)
    cpath = os.path.join(EVENTS_CACHE, hashlib.sha256(f"{q}|{days}".encode()).hexdigest()[:16] + ".json")
    if os.path.exists(cpath) and time.time() - os.path.getmtime(cpath) < 1800:   # < 30 min old
        with open(cpath, encoding="utf-8") as f:
            return jsonify(json.load(f))

    ts = f"{days}d"
    try:
        art = httpx.get(GDELT, params={"query": q, "mode": "artlist", "timespan": ts,
                        "maxrecords": 60, "sort": "datedesc", "format": "json"},
                        timeout=30, headers={"User-Agent": UA}).json()
        time.sleep(2)  # space the calls — GDELT 429s on rapid requests
        tl = httpx.get(GDELT, params={"query": q, "mode": "timelinevol", "timespan": ts,
                       "format": "json"}, timeout=30, headers={"User-Agent": UA}).json()
    except Exception as e:
        if os.path.exists(cpath):
            with open(cpath, encoding="utf-8") as f:
                d = json.load(f)
            d.update(stale=True, note=f"GDELT unavailable ({type(e).__name__}); showing your last cached copy.")
            return jsonify(d)
        return jsonify({"query": q, "error": f"GDELT unavailable (it rate-limits hard) ({type(e).__name__})",
                        "articles": [], "timeline": []}), 502

    articles = []
    for a in (art.get("articles", []) if isinstance(art, dict) else []):
        url = a.get("url", "") or ""
        tier, label = classify(url)
        articles.append({"title": a.get("title", ""), "url": http_url(url), "domain": a.get("domain", ""),
                         "date": a.get("seendate", ""), "lang": a.get("language", ""),
                         "source_type": label, "tier": tier})
    articles.sort(key=lambda x: x["tier"])                          # most credible first
    timeline = (tl.get("timeline") or [{}])[0].get("data", []) if isinstance(tl, dict) else []
    result = {"query": q, "days": days, "count": len(articles), "articles": articles, "timeline": timeline}
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(result, f)
    return jsonify(result)


GDELT_DB = os.path.join(HERE, "cache", "gdelt", "events.db")
COURT_CACHE = os.path.join(HERE, "cache", "court")
COURTLISTENER = "https://www.courtlistener.com/api/rest/v4/search/"
QUAD = {1: "cooperation (verbal)", 2: "cooperation (material)",
        3: "conflict (verbal)", 4: "conflict (material)"}


@app.route("/api/events_local")
@require_auth
def api_events_local():
    """Query the LOCAL GDELT event DB (no external API, no rate limits). Matches place /
    actor / source-domain / URL-slug — this is structured event data, not full-text search."""
    q = request.args.get("q", "").strip()
    country = request.args.get("country", "").strip().upper()[:2]
    days = request.args.get("days", "3")
    days = days if days.isdigit() and 1 <= int(days) <= 30 else "3"
    if not os.path.exists(GDELT_DB):
        return jsonify({"local": True, "articles": [], "timeline": [],
                        "note": "No local event data yet — run gdelt_ingest.py."})
    cutoff = int((datetime.now(timezone.utc) - timedelta(days=int(days))).strftime("%Y%m%d"))
    where, params = ["day >= ?"], [cutoff]
    if country:
        where.append("geo_country = ?")
        params.append(country)
    if q:
        like = f"%{q}%"
        where.append("(geo_name LIKE ? OR actor1 LIKE ? OR actor2 LIKE ? OR domain LIKE ? OR sourceurl LIKE ?)")
        params += [like] * 5
    w = " AND ".join(where)
    con = sqlite3.connect(GDELT_DB)
    con.row_factory = sqlite3.Row
    try:
        timeline = [{"date": str(r[0]), "value": r[1]} for r in
                    con.execute(f"SELECT day, COUNT(*) FROM events WHERE {w} GROUP BY day ORDER BY day", params)]
        rows = con.execute(
            f"SELECT sourceurl, domain, source_type, tier, geo_name, geo_country, dateadded, quadclass "
            f"FROM events WHERE {w} AND sourceurl<>'' GROUP BY sourceurl "
            f"ORDER BY tier ASC, dateadded DESC LIMIT 80", params).fetchall()
    finally:
        con.close()
    articles = [{"url": http_url(r["sourceurl"]), "domain": r["domain"], "source_type": r["source_type"],
                 "place": r["geo_name"], "country": r["geo_country"], "date": r["dateadded"],
                 "kind": QUAD.get(r["quadclass"], "")} for r in rows]
    return jsonify({"local": True, "query": q, "country": country, "days": days,
                    "count": len(articles), "articles": articles, "timeline": timeline})


@app.route("/api/court")
@require_auth
def api_court():
    """Live court-record search via CourtListener's free API (published U.S. opinions).
    Cached to disk (it can rate-limit); falls back to cache on error."""
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"query": q, "cases": []})
    os.makedirs(COURT_CACHE, exist_ok=True)
    cpath = os.path.join(COURT_CACHE, hashlib.sha256(q.encode()).hexdigest()[:16] + ".json")
    if os.path.exists(cpath) and time.time() - os.path.getmtime(cpath) < 1800:
        with open(cpath, encoding="utf-8") as f:
            return jsonify(json.load(f))
    try:
        r = httpx.get(COURTLISTENER, params={"q": q, "type": "o", "format": "json"},
                      timeout=30, headers={"User-Agent": UA})
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        if os.path.exists(cpath):
            with open(cpath, encoding="utf-8") as f:
                return jsonify(json.load(f))
        return jsonify({"query": q, "error": f"CourtListener unavailable ({type(e).__name__})", "cases": []}), 502
    cases = []
    for c in (data.get("results", []) if isinstance(data, dict) else [])[:40]:
        # urljoin (not string concat): correct whether absolute_url is a relative path
        # ("/opinion/123/") or already a full URL. But urljoin does NOT constrain the origin —
        # a poisoned "//evil.com/x" would resolve off-site — so pin the result to courtlistener.
        curl = urljoin("https://www.courtlistener.com", c.get("absolute_url") or "")
        cp = urlparse(curl)
        if cp.scheme != "https" or cp.hostname not in ("www.courtlistener.com", "courtlistener.com"):
            curl = ""                                    # refuse anything that left the expected origin
        cases.append({"name": c.get("caseName") or c.get("caseNameFull") or "(case)",
                      "court": c.get("court") or "", "date": (c.get("dateFiled") or "")[:10],
                      "docket": c.get("docketNumber") or "",
                      "url": curl})
    try:                                                  # count comes straight from upstream JSON —
        count = int(data.get("count", len(cases)))        # coerce to int so a string payload can't
    except (ValueError, TypeError):                       # ride into the DOM (records.html renders it)
        count = len(cases)
    result = {"query": q, "count": count, "cases": cases}
    with open(cpath, "w", encoding="utf-8") as f:
        json.dump(result, f)
    return jsonify(result)


def _refresher():
    """Keep the local GDELT DB fresh while the server runs: incremental ingest every 20 min."""
    script = os.path.join(HERE, "gdelt_ingest.py")
    while True:
        try:
            subprocess.run([sys.executable, script, "--hours", "2"], timeout=300, capture_output=True)
        except Exception:
            pass
        time.sleep(1200)


if __name__ == "__main__":
    threading.Thread(target=_refresher, daemon=True).start()
    print("Sovereign Search UI -> http://127.0.0.1:8890   (engine: SearXNG @ 8888)")
    if AUTH_TOKEN:
        print("API auth: ON (SOVEREIGN_AUTH_TOKEN set) — clients must send the X-Sovereign-Token header")
    else:
        print("API auth: OFF (local only). Set SOVEREIGN_AUTH_TOKEN before exposing beyond this machine "
              "(Tailscale Serve/Funnel).")
    app.run(host="127.0.0.1", port=8890, debug=False)
