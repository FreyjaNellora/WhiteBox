"""Hyphae opportunity scanner — find and take every path the device can use.

The device is meant to be fluid: whenever it needs to move a message, it grabs
*any* connection available to it, with no manual setup. This module is that
engine. On hardware, live scans (Wi-Fi scan, BLE/Wi-Fi-Aware discovery, mesh
announces, modem status) feed it a list of ``LinkOpportunity`` objects; the
scanner returns the ones the device can actually use right now, ranked, ready to
become bearers.

"Usable" is not a moral test — it is simply whether the link can carry our bytes:

* **Reachable** — in range / associated / a live interface.
* **Open-access kinds** — open/public networks, and connectionless radio that
  needs no association at all (BLE advertising, Wi-Fi Aware, Wi-Fi Direct,
  optical, acoustic), and consenting mesh peers (a node running Hyphae relays by
  running it). These need no credentials: you use them by broadcasting your own
  data with your own radio, or by riding infrastructure offered for use.
* **Credentialed kinds** — links that require authentication (a cellular modem
  with a SIM, a network you hold the key for). Usable only when we hold our own
  credentials.

A locked link we hold no key for is simply *not usable* — unreachable to us, the
same as a tower out of range — so the scanner skips it. Nothing to crack, nothing
to borrow: the device takes every path open to it and ignores the rest.
"""
from __future__ import annotations

from dataclasses import dataclass

from .bearer import Capabilities
from .policy import DEFAULT_LEGAL_WHITELIST

# Kinds usable with no one else's credentials: open/public infrastructure,
# connectionless device-to-device radio, and consenting mesh peers.
OPEN_ACCESS_KINDS = frozenset({
    "wifi-open",     # an open / public network, offered for use
    "ble-broadcast", # BLE advertising/scanning — no pairing, no connection
    "wifi-aware",    # Wi-Fi Aware (NAN) — peer discovery, no access point
    "wifi-direct",   # Wi-Fi Direct — peer-to-peer, no access point
    "mesh-peer",     # another Hyphae node (it consents by running the protocol)
    "optical",       # free-space light — your own emitter
    "acoustic",      # sound / ultrasonic — your own emitter
})

# Kinds that carry our own credentials when we choose to use them.
CREDENTIALED_KINDS = frozenset({
    "cellular",      # a modem with our SIM/eSIM — we are the subscriber
    "wifi-known",    # a network we hold the key for (our own / one we're entitled to)
})


@dataclass
class LinkOpportunity:
    """One path the device has discovered it might use to move a message."""

    name: str
    kind: str
    caps: Capabilities
    reachable: bool = True
    have_credentials: bool = False  # relevant only for CREDENTIALED_KINDS

    def open_access(self) -> bool:
        return self.kind in OPEN_ACCESS_KINDS

    def usable(self) -> bool:
        if not self.reachable:
            return False
        if self.open_access():
            return True
        if self.kind in CREDENTIALED_KINDS:
            return self.have_credentials
        return False  # unknown kind, or a locked link we hold no key for


@dataclass
class OpportunityScanner:
    """Turns a pile of discovered opportunities into the ranked set to use now."""

    legal_whitelist: frozenset = DEFAULT_LEGAL_WHITELIST

    def _permitted(self, o: LinkOpportunity) -> bool:
        return o.usable() and o.caps.legal_class in self.legal_whitelist

    def take(
        self, opportunities: list[LinkOpportunity], urgent: bool = False
    ) -> list[LinkOpportunity]:
        """Every path we can use right now, ranked. Quietest-first by default;
        fastest-first when urgent (delivery beats stealth)."""
        usable = [o for o in opportunities if self._permitted(o)]
        if urgent:
            usable.sort(key=lambda o: (o.caps.latency_s, -o.caps.rate_bps))
        else:
            usable.sort(key=lambda o: (o.caps.detectability, o.caps.error_rate))
        return usable

    def skipped(
        self, opportunities: list[LinkOpportunity]
    ) -> list[tuple[str, str]]:
        """Auditable reasons for every path we did NOT take."""
        out: list[tuple[str, str]] = []
        for o in opportunities:
            if not o.reachable:
                out.append((o.name, "unreachable"))
            elif not o.usable():
                out.append((o.name, "locked: no consent or credentials of our own"))
            elif o.caps.legal_class not in self.legal_whitelist:
                out.append((o.name, f"legal_class {o.caps.legal_class!r} not permitted"))
        return out
