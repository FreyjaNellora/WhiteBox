#!/usr/bin/env python
"""
Sovereign Search - local GDELT event ingest (no API, no rate limits).

Downloads GDELT 2.0 'export' event files (tiny ~26 KB zips, published every 15 min) from
the FILE server (data.gdeltproject.org — a plain file host, NOT the throttled API), parses
them, tags each event's source article with our credibility tier, and stores them in a local
SQLite DB. Keeps a rolling window and prunes old rows, so it never fills the disk.

Run:   python gdelt_ingest.py [--hours 24] [--keep-days 3]
Incremental: re-running only fetches the 15-min slots newer than the last ingest.
Verified against a real file: 61 tab-sep cols; col52=place, col53=country, col60=SOURCEURL.
"""
import argparse
import io
import os
import sqlite3
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import classify, http_url  # credibility tiers + the single URL-emission gate

BASE = "https://data.gdeltproject.org/gdeltv2"   # HTTPS: integrity + no cleartext MITM of the feed
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "cache", "gdelt", "events.db")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SovereignSearch"
MAX_ZIP_BYTES = 50 * 1024 * 1024        # a real 15-min export zip is ~26 KB; refuse anything huge (compressed)
MAX_CSV_BYTES = 100 * 1024 * 1024       # cap the DECOMPRESSED read so a zip-bomb can't OOM the box


def db_connect():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    con = sqlite3.connect(DB, timeout=30)
    con.execute("PRAGMA journal_mode=WAL")   # concurrent reads while the refresher writes
    con.execute("""CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY, day INTEGER, dateadded TEXT,
        actor1 TEXT, actor2 TEXT, eventcode TEXT, quadclass INTEGER,
        goldstein REAL, nummentions INTEGER, avgtone REAL,
        geo_name TEXT, geo_country TEXT, geo_lat REAL, geo_long REAL,
        sourceurl TEXT, domain TEXT, tier INTEGER, source_type TEXT)""")
    con.execute("CREATE INDEX IF NOT EXISTS idx_day ON events(day)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_country ON events(geo_country)")
    con.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
    return con


def fnum(s):
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def inum(s):
    try:
        return int(s)
    except (ValueError, TypeError):
        return 0


def slots(hours):
    """15-min timestamps (UTC) for the last `hours`, newest first."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now -= timedelta(minutes=now.minute % 15)
    return [(now - timedelta(minutes=15 * i)).strftime("%Y%m%d%H%M%S")
            for i in range(int(hours * 4) + 1)]


def ingest_file(client, con, ts):
    try:
        r = client.get(f"{BASE}/{ts}.export.CSV.zip")
        if r.status_code != 200 or not r.content:
            return 0
        if len(r.content) > MAX_ZIP_BYTES:                 # oversized compressed payload -> refuse
            return 0
        zf = zipfile.ZipFile(io.BytesIO(r.content))
        names = zf.namelist()
        if not names:
            return 0
        # Read the DECOMPRESSED member with a hard cap (don't trust the zip's declared size):
        # ZipExtFile.read(n) stops after n decompressed bytes, so a zip-bomb can't expand to GBs.
        with zf.open(names[0]) as fh:
            data = fh.read(MAX_CSV_BYTES + 1)
        if len(data) > MAX_CSV_BYTES:                      # bomb / absurdly large export -> refuse
            return 0
        raw = data.decode("utf-8", "replace")
    except Exception:
        return 0
    rows = []
    for line in raw.splitlines():
        c = line.split("\t")
        if len(c) < 61 or not c[0]:
            continue
        u = http_url(c[60])                              # scheme + internal-literal + cred gate (one gate)
        tier, label = classify(u) if u else (2, "WEB")
        rows.append((c[0], inum(c[1]), c[59], c[6], c[16], c[26], inum(c[29]),
                     fnum(c[30]), inum(c[31]), fnum(c[34]),
                     c[52], c[53], fnum(c[56]), fnum(c[57]),
                     u, (urlparse(u).hostname or "") if u else "", tier, label))
    con.executemany("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--keep-days", type=int, default=3)
    ap.add_argument("--full", action="store_true", help="fetch the whole window, ignoring last_ts (backfill)")
    args = ap.parse_args()

    con = db_connect()
    row = con.execute("SELECT v FROM meta WHERE k='last_ts'").fetchone()
    last_ts = row[0] if row else "0"
    fetched = inserted = 0
    newest_ok = last_ts
    with httpx.Client(timeout=45, headers={"User-Agent": UA}) as client:
        for ts in slots(args.hours):
            if not args.full and ts <= last_ts:   # incremental unless --full (backfill)
                break
            n = ingest_file(client, con, ts)
            if n:
                fetched += 1
                inserted += n
                newest_ok = max(newest_ok, ts)
    con.execute("INSERT OR REPLACE INTO meta VALUES('last_ts', ?)", (newest_ok,))
    cutoff = int((datetime.now(timezone.utc) - timedelta(days=args.keep_days)).strftime("%Y%m%d"))
    con.execute("DELETE FROM events WHERE day < ?", (cutoff,))
    con.commit()

    total = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    lo, hi = con.execute("SELECT MIN(day), MAX(day) FROM events").fetchone()
    size = os.path.getsize(DB) / 1e6 if os.path.exists(DB) else 0
    print(f"files fetched: {fetched}   events added: {inserted}")
    print(f"DB total: {total} events   day range: {lo}..{hi}   size: {size:.1f} MB")
    con.close()


if __name__ == "__main__":
    main()
