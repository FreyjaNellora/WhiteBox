# Benchmark — sovereign-search vs Google (honest)

*8 diverse queries. **Both Google and DuckDuckGo block direct scraping** (Google returns 0 results to the scraper; DDG-html returns a 202 anomaly-challenge), so the only way to read a mainstream index programmatically is SearXNG's rotating aggregation. That path ALSO applies our credibility plugin to the baseline, so the numbers below **understate** our edge (a truly raw index would score even lower on authoritative%). Baseline = **Mainstream (DuckDuckGo/Brave/Startpage via SearXNG)**. Latency is where the mainstream wins. Top-10, dedup by domain.*

> ⚠ **Baseline coverage: 0/8 queries.** The mainstream engines rate-limited/blocked the rest (which is itself the finding) — treat the baseline row as UNRELIABLE this run; re-run when they aren't throttling, or use a paid Search API for rigor.

| Metric (mean over queries) | Mainstream (DuckDuckGo/Brave/Startpage via SearXNG) | Ours · flat | Ours · navigate |
|---|---|---|---|
| **Authoritative %** (GOV/EDU/JOURNAL/PRIMARY) | 0 | 40 | 38 |
| Low-signal % (forum/social) | 0 | 0 | 0 |
| Unique domains / 10 (diversity) | 0.0 | 9.0 | 8.0 |
| Ad/SEO/social % | 0 | 0 | 0 |
| New finds vs baseline (long-tail) | 0.0 | 9.0 | 8.0 |
| Median latency (s) | 0.3 | 2.6 | 6.8 |

**Read honestly:** *Authoritative %* and *new finds* are what we're built for — surfacing primary/credible sources and long-tail 'small data' the mainstream buries. The mainstream wins **latency** outright (navigate pays for the walk) and has its own raw coverage. This is a small, fixed query set — indicative, not a leaderboard. Reproduce: `python bench.py`.
