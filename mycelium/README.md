# Mycelium

A **local-first, private-by-default** meta-search engine with a credibility layer, academic +
indie-web sources, live world-events, and a quote-miner. Nothing phones home, needs an account, or
leaves your machine — it binds to `127.0.0.1` only.

> **Why "Mycelium"?** Like the fungal network that threads a forest floor — linking distant trees
> through short underground paths, with no center and no server — Mycelium treats the web as a
> **small-world network**: densely-clustered local nodes with short hops between any two sources. The
> navigator (`navigate.py`) walks that link-graph the way hyphae follow nutrients, scoring the
> connections between pages rather than trusting a single ranked list. Decentralized, local, and
> yours — the search layer's version of the same sovereignty the vault gives your memory.

It's two cooperating parts, both in this folder:

| Part | What it is |
|---|---|
| [`searxng/`](searxng/) | A **customized [SearXNG](https://github.com/searxng/searxng)** meta-search engine (AGPL-3.0), run headless as a JSON API on port 8888. Our changes (a settings overlay + a no-logging launcher) are described in [`searxng/README-MYCELIUM.md`](searxng/README-MYCELIUM.md). |
| the **face** (this folder) | A small Flask app (`server.py`, port 8890) that proxies search server-side and turns raw results into a credibility-ranked, research-oriented UI. |

## What the face adds over plain SearXNG
- **Credibility tiers** — every result is tagged (authoritative / academic / general / down-ranked) and the UI shows *why* it ranks where it does.
- **Dual-bar ranking** — the same result set shown two ways with no extra query: the credibility sort **and** the engines' own raw relevance rank. Flip instantly.
- **Live world events** — a "Live Events" tab reads a local, rolling **GDELT** mirror (`gdelt_ingest.py` refreshes it in the background). Public event data, not your query history.
- **Quote-miner** — pulls verbatim, source-linked quotes for a query into a local review queue (`quotemine.py`).
- **Navigator** — a link-graph walker (`navigate.py`) that follows and scores connections between pages.

## Privacy
- `127.0.0.1` only. **No query logging** (the engine launcher filters the web-server access log, which would otherwise record query strings).
- **`wipe-history.ps1`** erases every on-disk trace derived from your queries (event/court caches, the navigation graph + learned associations, the quote-miner quarantine). `-All` also wipes the public GDELT mirror.
- **Optional auth for remote use** — set `MYCELIUM_AUTH_TOKEN` before launching to require a token (`X-Mycelium-Token` header) on every API call. Off by default for single-user localhost; turn it **on** before exposing the face beyond this machine (e.g. over your own Tailscale tailnet).

## Setup & run
See **[SETUP.md](SETUP.md)**. Short version: create the venv in `searxng/venv`, set your own
`secret_key` in `searxng/my-settings.yml`, then (Windows) right-click `start-mycelium.ps1`
→ *Run with PowerShell* and open <http://127.0.0.1:8890>.

## Files (the face)
`server.py` (UI + proxy + credibility + dual-bar) · `gdelt_ingest.py` (events mirror) ·
`navigate.py` (link-graph walker) · `netfetch.py` (safe fetch/canonicalization) ·
`canonical.py` + `test_canonical.py` · `quotemine.py` · `seed_links.py` ·
`bench.py` + `BENCHMARK.md` · `*.html` (UI) · `wipe-history.ps1`.

## License
**AGPL-3.0** (see [`LICENSE`](LICENSE)). The `searxng/` subfolder is a modified copy of SearXNG,
also AGPL-3.0 — see [`searxng/MODIFICATIONS.md`](searxng/MODIFICATIONS.md) for the change notice.
