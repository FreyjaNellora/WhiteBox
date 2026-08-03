#!/usr/bin/env python
"""
seed_links.py — feed a curated link list into the navgraph.

WHY THIS IS DIFFERENT FROM A WALK
---------------------------------
`navigate.py` starts from a QUERY and discovers its way outward: it has to
guess which results are worth following. A hand-curated reference list is the
opposite — a human already did the judging, over months. Feeding it in
directly gives the graph a set of anchors it would take many walks and a lot
of luck to reach, and every subsequent walk gets to start closer to them.

Concretely: a master 4PC reference list contains Korf's multi-player alpha-beta
paper, chessprogramming.org's NNUE and Vector_Attacks pages, and Fairy-Stockfish's
bitboard source. No keyword walk lands on that set cleanly, because those pages
are linked from communities rather than ranked by engines.

WHAT IT DOES NOT DO
-------------------
It does NOT bypass any guard. Every fetch goes through `netfetch.safe_get` —
the same SSRF host-guard, capped redirects, HTML-only, byte-capped streaming
that the walker uses. There is exactly one fetcher in this codebase and this
is not a second one.

It respects the graph ceiling (`navigate.GRAPH_MAX_BYTES`) and reports when it
stops. Fetching is sequential and unhurried on purpose: a curated list is
small, and politeness costs nothing at this size.

Usage:
    python seed_links.py links.txt
    python seed_links.py links.txt --tag four-player-chess
    python seed_links.py --urls https://a.example https://b.example
"""
import argparse
import os
import sys
import time
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import navigate as nav                                    # noqa: E402
from netfetch import guarded_client                       # noqa: E402
from server import classify                               # noqa: E402

for s in (sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def seed(urls, tag=None, pause=0.6, max_links_per_page=40):
    con = nav._graph_db()
    used, allowed, full = nav.graph_room_left()
    if full:
        print(f"graph is at its {allowed/1048576:.0f} MB ceiling — nothing written.")
        return {}

    stats = {"fetched": 0, "failed": 0, "nodes": 0, "edges": 0, "vocab": []}
    texts, seen_hosts = [], []
    # The tag becomes the anchor term every seeded page associates with, so a
    # later query for it reaches the whole curated set in one hop.
    tag_terms = nav._terms(tag) if tag else []

    with guarded_client() as client:
        for url in urls:
            if nav.graph_room_left()[2]:
                print("  ceiling reached mid-seed — stopping cleanly.")
                break
            text, links = nav._fetch(url, client)
            if not text:
                stats["failed"] += 1
                print(f"  [skip] {url[:72]}")
                continue
            stats["fetched"] += 1
            texts.append(text[:4000])
            seen_hosts.append((urlparse(url).hostname or url).lower())

            tier, label = classify(url)
            host = (urlparse(url).hostname or "").lower()
            title = text.strip().split("\n")[0][:120] or url
            nav._record_node(con, {"url": url, "host": host, "title": title,
                                   "tier": tier, "source_type": label})
            stats["nodes"] += 1

            # Outbound links: the curated page's OWN judgement about what is
            # worth reading next. That is the signal being harvested.
            for dst, anchor in links[:max_links_per_page]:
                nav._record_edge(con, nav._nid(url), nav._nid(dst),
                                 "seed", 1.0, (anchor or "")[:80])
                stats["edges"] += 1
            print(f"  [ok]   [{label:9}] {url[:66]}")
            time.sleep(pause)

    if texts:
        # Count DISTINCT DOMAINS: a curated list is exactly where site chrome
        # would otherwise dominate, since several links often share a host.
        learned = nav._learn_vocab(texts, set(tag_terms), k=18, hosts=seen_hosts)
        stats["vocab"] = learned
        if tag_terms and learned:
            nav._record_assoc(con, tag_terms, learned)
    con.commit()
    con.close()
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", nargs="?", help="file with one URL per line")
    ap.add_argument("--urls", nargs="*", default=[])
    ap.add_argument("--tag", help="anchor term to associate the whole set with")
    args = ap.parse_args()

    urls = list(args.urls)
    if args.file:
        with open(args.file, encoding="utf-8") as f:
            urls += [ln.strip() for ln in f
                     if ln.strip() and ln.strip().startswith(("http://", "https://"))]
    urls = list(dict.fromkeys(urls))
    if not urls:
        print("no urls given")
        return 1

    before = {t: nav._graph_db().execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("nodes", "edges", "term_assoc")}
    print(f"seeding {len(urls)} curated links"
          f"{f' under tag {args.tag!r}' if args.tag else ''}...\n")
    st = seed(urls, tag=args.tag)

    con = nav._graph_db()
    after = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
             for t in ("nodes", "edges", "term_assoc")}
    used, allowed, _ = nav.graph_room_left()
    print(f"\n  fetched {st.get('fetched', 0)} · failed {st.get('failed', 0)}")
    for t in ("nodes", "edges", "term_assoc"):
        print(f"  {t:11} {before[t]:>5} -> {after[t]:>5}  (+{after[t]-before[t]})")
    print(f"  disk        {used/1048576:.2f} MB of {allowed/1048576:.0f} MB")
    if st.get("vocab"):
        print(f"\n  vocabulary learned from the curated set:\n    "
              + ", ".join(st["vocab"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
