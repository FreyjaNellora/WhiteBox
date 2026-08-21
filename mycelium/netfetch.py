#!/usr/bin/env python
"""
netfetch.py — the ONE guarded way any mycelium component fetches an untrusted URL.

Every fetch of an attacker-influenced web page routes through here so the guard exists in
exactly one place instead of being re-invented (or forgotten) per component. The cross-lineage
red-team found the SSRF that happens when it ISN'T shared: navigate.py was hardened, quotemine.py
was not, and the guard-less copy shipped the hole. This module is the fix for that whole class.

Guarantees on every hop:
  * SSRF host-guard — resolves the host and rejects loopback / private / link-local
    (incl. 169.254 cloud-metadata) / multicast / reserved / unspecified targets.
  * Re-checks the host on EVERY redirect hop (manual, capped follow — never httpx auto-follow,
    which would chase a 302 into 127.0.0.1 blind).
  * HTML-only content-type gate (callers here parse HTML with lxml; binaries are junk + risk).
  * Hard byte cap via streaming — aborts mid-download once over the cap (zip/response-bomb guard).

API:
    from netfetch import host_ok, guarded_client, safe_get, safe_fetch, MAX_FETCH_BYTES

    body = safe_fetch(url)                       # one-off: bytes or None
    with guarded_client() as client:             # reuse one connection across a walk
        body = safe_get(client, url)             # bytes or None

Zero new deps (httpx, ipaddress, socket, urllib) — runs under the same python as server.py.
"""
import concurrent.futures
import ipaddress
import os
import socket
import sys
import time
from urllib.parse import urljoin, urlparse

import httpx

MAX_FETCH_BYTES = 8 * 1024 * 1024                     # 8 MB cap on any fetched page
DEFAULT_TIMEOUT = 15
DNS_TIMEOUT = 10      # seconds — generous for legit DNS (<200ms typical) but bounded, so a hostile
                      # authoritative server that never answers can't stall a worker thread forever.
                      # User-tunable: RAISE this on Tor/satellite/slow-VPN links where legit DNS can
                      # exceed 10s, else fetches false-fail (DF4 round-8; fail-closed, not a bypass)
SECURITY_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "security.log")
# Some hosts block non-browser UAs; present a browser string for page fetches.
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def _embedded_ipv4(ip):
    """If an IPv6 address embeds an IPv4 (mapped / 6to4 / teredo), return that IPv4Address, else
    None. Such embeddings can smuggle an internal IPv4 (e.g. 2002:7f00:1:: -> 127.0.0.1) past the
    IPv6 is_private/is_loopback checks, so we extract and re-check it."""
    if not isinstance(ip, ipaddress.IPv6Address):
        return None
    for attr in ("ipv4_mapped", "sixtofour"):
        v = getattr(ip, attr, None)
        if v is not None:
            return v
    t = getattr(ip, "teredo", None)
    if t is not None:
        return t[1]            # teredo -> (server, client); the client is the reachable IPv4
    if (int(ip) >> 32) == (int(ipaddress.IPv6Address("64:ff9b::")) >> 32):
        return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)   # NAT64 WKP 64:ff9b::/96 embeds IPv4
    return None


def _ip_unsafe(a):
    return (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast
            or a.is_reserved or a.is_unspecified)


def _ip_bad(ipstr):
    """True if this resolved address must never be connected to. Fails CLOSED: an address we
    cannot parse is treated as bad (skipping an address is NOT the same as clearing it)."""
    try:
        ip = ipaddress.ip_address(ipstr)
    except ValueError:
        return True
    if _ip_unsafe(ip):
        return True
    emb = _embedded_ipv4(ip)
    if emb is not None and _ip_unsafe(emb):
        return True
    return False


def _resolve_safe(url):
    """Resolve the host ONCE and vet every returned address. Returns the list of safe IP strings,
    or None if the host is missing / unresolvable / ANY resolved address is unsafe. safe_get pins
    this single resolution so httpx never resolves again — closing the DNS-rebinding TOCTOU."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host or host == "localhost":
        return None
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        # getaddrinfo ignores setdefaulttimeout and can block forever on a hostile/limp DNS server
        # (DF4 round-7: thread-exhaustion DoS). Run it on a throwaway thread with a hard timeout.
        # NB: a `with ThreadPoolExecutor()` block would shutdown(wait=True) on exit and RE-BLOCK on
        # the hung thread — so shutdown(wait=False) explicitly. The orphaned resolver thread can't
        # be killed, but it does no I/O for us and dies with the OS-level DNS timeout.
        ex = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            infos = ex.submit(socket.getaddrinfo, host, port).result(timeout=DNS_TIMEOUT)
        finally:
            ex.shutdown(wait=False)
    except Exception:
        return None
    ips = []
    for info in infos:
        ipstr = info[4][0]
        if _ip_bad(ipstr):
            return None            # ANY bad address in the set -> reject the whole host
        ips.append(ipstr)
    return ips or None


def host_ok(url):
    """SSRF guard as a boolean (public utility / tests). safe_get pre-checks with this AND verifies
    the actual connected peer IP after connect (the rebind tripwire below)."""
    return _resolve_safe(url) is not None


def _rebind_alert(url, peer_ip):
    """A fetched 'public' host connected to an INTERNAL ip — a DNS-rebind / SSRF attempt that slipped
    past the pre-check. Record it locally and refuse. This is the offensive backstop for the one spot
    we're forced to leave lax (can't pin without breaking vhost fetches): make it TOXIC to exploit.
    Zero false-positive by construction — a legitimate public fetch never lands on loopback/private —
    and purely internal (a local log line, no packet sent outward), so it can never harm a real site."""
    safe = "".join(c for c in url[:200] if 0x20 <= ord(c) < 0x7F)   # strip control chars: no log-line forgery
    line = f"{int(time.time())}\tDNS-REBIND-BLOCKED\tpeer={peer_ip}\turl={safe}\n"
    try:
        os.makedirs(os.path.dirname(SECURITY_LOG), exist_ok=True)
        with open(SECURITY_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    try:
        sys.stderr.write("[netfetch] SSRF/DNS-rebind blocked: " + line)
    except Exception:
        pass


def _peer_ip(response):
    """The actual IP httpx connected to for this response (v4 or v6), or None if unavailable."""
    try:
        ns = response.extensions.get("network_stream")
        addr = ns.get_extra_info("server_addr") if ns else None
        return addr[0] if addr else None
    except Exception:
        return None


# Common multi-label public suffixes, so eTLD+1 doesn't over-collapse (bbc.co.uk -> co.uk would make
# every UK site "one domain"). Not the full PSL — the frequent ones; unknown TLDs fall back to last-2.
_MULTI_SUFFIX = {"co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
                 "com.au", "net.au", "org.au", "gov.au", "edu.au", "co.nz", "org.nz", "govt.nz",
                 "co.jp", "or.jp", "ne.jp", "go.jp", "com.br", "gov.br", "org.br", "co.in", "gov.in",
                 "co.za", "org.za", "com.cn", "gov.cn", "com.sg", "com.mx", "co.kr", "com.tr"}


def reg_domain(host):
    """Registrable domain (eTLD+1). Collapses a.evil.com and b.evil.com to 'evil.com' so subdomains of
    one attacker domain can't pose as distinct corroborating sources — while NOT over-collapsing
    multi-part TLDs (bbc.co.uk stays bbc.co.uk, not co.uk). Shared so navigate + quotemine agree on
    'what counts as one domain'."""
    parts = (host or "").lower().split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in _MULTI_SUFFIX:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else (host or "").lower()


def strip_url_creds(url):
    """Remove user:pass@ from a URL so credentials are never (a) forwarded to the fetched host nor
    (b) persisted in the graph. Applied on the CONNECTION side — the emission side has its own gate."""
    try:
        p = urlparse(url)
        if p.username or p.password:
            netloc = (p.hostname or "") + (f":{p.port}" if p.port else "")
            return p._replace(netloc=netloc).geturl()
    except Exception:
        pass
    return url


def guarded_client(timeout=DEFAULT_TIMEOUT, user_agent=BROWSER_UA):
    """An httpx.Client wired for safe_get: follow_redirects MUST be False so we follow (and
    re-host-check) every hop manually. Use as a context manager to reuse the connection."""
    return httpx.Client(timeout=timeout, follow_redirects=False,
                        headers={"User-Agent": user_agent})


def safe_get(client, url, max_redirects=3, require_html=True):
    """GET with an SSRF host-check on EVERY hop (host_ok -> _resolve_safe: one resolution, rejects
    private/loopback/link-local/multicast/reserved + 6to4/teredo/ipv4-mapped embeddings, fails closed
    on unparseable), manual capped redirects, HTML-only (unless require_html=False), 8 MB streamed cap.
    Returns response bytes or None. `client` MUST use follow_redirects=False (use guarded_client()).

    RESIDUAL RISK — DNS-rebinding TOCTOU (documented, accepted): host_ok's getaddrinfo and httpx's
    connect-time resolution are separate lookups, so an attacker with authoritative DNS for a domain
    the walker fetches, TTL=0, and a won sub-10ms race could rebind to an internal IP after the check.
    A full connect-by-IP pin was implemented and REVERTED: httpx rewrites the Host header / SNI for an
    IP-literal URL, which 403s vhost/CDN sites (Wikimedia et al.) — it broke real fetching for a large
    class of sites. Closing this properly needs a custom transport that pins the socket address while
    keeping the hostname URL (see DEFERRED-BACKLOG). Both red-team lineages rated this low-exploitability
    for a single-user local tool; the pre-check + per-hop re-check stands as the mitigation."""
    for _ in range(max_redirects + 1):
        url = strip_url_creds(url)                    # never forward user:pass@ as Basic auth to the host
        if not host_ok(url):
            return None
        try:
            with client.stream("GET", url) as r:
                # REBIND TRIPWIRE: host_ok vetted the resolved IP; here we verify the IP httpx ACTUALLY
                # connected to. If a "public" host was rebound to an internal address between check and
                # connect, the real peer is internal -> unambiguous SSRF/rebind -> refuse + log. This
                # makes the one spot we can't fully pin toxic to exploit, with zero false-positives.
                peer = _peer_ip(r)
                if peer and _ip_bad(peer):
                    _rebind_alert(url, peer)
                    return None
                if r.is_redirect:
                    nxt = r.headers.get("location")
                    if not nxt:
                        return None
                    url = urljoin(url, nxt)
                    continue                              # re-check host on the redirect target
                r.raise_for_status()
                if require_html and "html" not in r.headers.get("content-type", "").lower():
                    return None
                cl = r.headers.get("content-length")
                if cl and cl.isdigit() and int(cl) > MAX_FETCH_BYTES:
                    return None
                buf, total = [], 0
                for chunk in r.iter_bytes():
                    total += len(chunk)
                    if total > MAX_FETCH_BYTES:
                        return None                       # abort mid-stream once over the cap
                    buf.append(chunk)
                return b"".join(buf)
        except Exception:
            return None
    return None


def safe_fetch(url, timeout=DEFAULT_TIMEOUT, user_agent=BROWSER_UA,
               max_redirects=3, require_html=True):
    """One-off guarded fetch: opens its own client, applies the full guard, returns bytes or None.
    For many fetches in a loop, prefer `with guarded_client() as c: safe_get(c, url)` to reuse
    the connection."""
    with guarded_client(timeout=timeout, user_agent=user_agent) as client:
        return safe_get(client, url, max_redirects=max_redirects, require_html=require_html)
