# Our SearXNG build (Sovereign Search engine)

> This folder is a **modified copy of [SearXNG](https://github.com/searxng/searxng)** (AGPL-3.0). The
> upstream project's own docs are in `docs/` and `README.rst`. This file describes only *our* changes
> and how to run them. For the required AGPL change-notice, see [`MODIFICATIONS.md`](MODIFICATIONS.md).

SearXNG is a privacy-respecting meta-search engine: it queries many search engines for you and
aggregates the results, so no single engine profiles you. Our build configures it for **private,
research-grade, credibility-aware** search and runs it as a headless JSON engine that our
[Sovereign Search face](../) sits in front of.

## What our build changes (all in `my-settings.yml` + `run_engine.py`)

1. **Localhost-only + private.** Binds `127.0.0.1:8888`, `public_instance: false`, `limiter: false`.
   Serves both `html` and `json` (the face consumes JSON).

2. **No query logging.** `run_engine.py` launches SearXNG with the web-server access log filtered
   out — those log lines contain your query strings, and we keep no query history.

3. **A credibility layer** (via SearXNG's `hostnames` plugin), applied across every engine:
   - **Removed:** pinterest, quora.
   - **Down-ranked:** facebook, instagram, tiktok, x/twitter, medium, buzzfeed, businessinsider,
     wikihow, msn, yahoo, forbes.
   - **Up-ranked:** `.gov`, `.edu`, `.ac.uk`, arxiv, nature, sciencedirect, cell, jstor, springer,
     wikipedia, gutenberg, loc.gov.

4. **An academic retrieval tier** (enabled engines): arxiv, semantic scholar, crossref, openalex,
   pubmed — so research papers actually surface instead of being ranked-up but unfetchable.

5. **An indie-web / small-web tier** (weighted up): searchmysite, wiby, mwmbl, mojeek — to surface
   independent sites the mainstream engines bury — merged *into* (not replacing) the default engine
   list so mainstream coverage stays for balance.

6. **People / creative engines** (in non-general categories, so ordinary search is unaffected):
   mastodon, github, gitlab, codeberg, lemmy, bandcamp, soundcloud, peertube, deviantart, artstation,
   500px, pixiv, flickr, goodreads, hackernews, vimeo, dailymotion.

## Run
See the repo-root **[SETUP.md](../SETUP.md)**. In short: create `venv/` here, `pip install -e .`
plus `httpx flask`, set your own `secret_key` in `my-settings.yml`, then launch from the repo root
with `start-sovereign-search.ps1` (or run `run_engine.py` directly).

`my-settings.yml` uses `use_default_settings: true`, so it is a small *overlay* on SearXNG's shipped
defaults — everything not mentioned there keeps upstream behavior.
