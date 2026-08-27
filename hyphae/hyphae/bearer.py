"""Hyphae L0 — the bearer interface, the impedance match of the whole system.

Every channel, however exotic, implements the same three-method contract so the
layers above never learn what medium they are riding. A new channel discovered
in the wild becomes a plugin implementing ``Bearer`` and the network gains a
medium with no other change — that open-endedness is the design's moat.

This module ships two reference bearers used by the tests:

* ``LoopbackBearer`` — an in-memory point-to-point link (paired via
  ``loopback_pair``); stands in for any live radio/socket.
* ``FileBearer`` — "sneakernet": frames are files dropped in an outbox directory
  and picked up from an inbox directory. Proves the store-carry-forward model
  with a bearer that has effectively infinite latency and needs no network at
  all.

The two are deliberately different in every ``Capabilities`` dimension so the
delivery tests exercise reassembly across genuinely dissimilar threads.
"""
from __future__ import annotations

import os
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass

# Legal classes a bearer can declare. The selection policy (see policy.py) uses
# these to keep operation inside a lawful whitelist by construction.
LEGAL_CLASSES = frozenset({
    "unlicensed-ism",       # e.g. Part 15 ISM-band radio (LoRa, Wi-Fi, BLE)
    "license-by-rule",      # e.g. GMRS/MURS — authorized in advance
    "licensed-carrier",     # ride a service whose operator holds the license
    "unregulated-physical", # optical / acoustic — not an RF emitter at all
    "public-substrate",     # permissionless public store you may lawfully post to
    "local-only",           # in-process / on-device (loopback, files you own)
})


@dataclass(frozen=True)
class Capabilities:
    name: str
    rate_bps: float
    mtu: int
    latency_s: float
    reach_m: float
    error_rate: float
    directionality: str      # "simplex" | "half" | "full"
    legal_class: str
    detectability: float     # 0 (ambient/indistinguishable) .. 1 (loud, obvious)

    def __post_init__(self) -> None:
        if self.legal_class not in LEGAL_CLASSES:
            raise ValueError(f"unknown legal_class {self.legal_class!r}")
        if not 0.0 <= self.detectability <= 1.0:
            raise ValueError("detectability must be in [0, 1]")


class Bearer(ABC):
    """The uniform socket every channel implements."""

    @abstractmethod
    def capabilities(self) -> Capabilities: ...

    @abstractmethod
    def send(self, frame: bytes) -> None: ...

    @abstractmethod
    def poll(self) -> list[bytes]:
        """Return frames that have arrived since the last poll (may be empty)."""


class LoopbackBearer(Bearer):
    """In-memory link. Frames sent here surface on the paired bearer's poll()."""

    def __init__(self, caps: Capabilities):
        self._caps = caps
        self._inbox: list[bytes] = []
        self._peer: "LoopbackBearer | None" = None

    def capabilities(self) -> Capabilities:
        return self._caps

    def send(self, frame: bytes) -> None:
        if self._peer is None:
            raise RuntimeError("loopback bearer not paired")
        self._peer._inbox.append(frame)

    def poll(self) -> list[bytes]:
        out, self._inbox = self._inbox, []
        return out


def loopback_pair(caps: Capabilities) -> tuple[LoopbackBearer, LoopbackBearer]:
    a, b = LoopbackBearer(caps), LoopbackBearer(caps)
    a._peer, b._peer = b, a
    return a, b


class FileBearer(Bearer):
    """Sneakernet bearer: outbox/inbox directories on disk.

    Node A's outbox is Node B's inbox and vice-versa, so this models carrying a
    USB stick between two machines that never share a network.
    """

    def __init__(self, caps: Capabilities, outbox: str, inbox: str):
        self._caps = caps
        self.outbox, self.inbox = outbox, inbox
        os.makedirs(outbox, exist_ok=True)
        os.makedirs(inbox, exist_ok=True)
        self._seen: set[str] = set()

    def capabilities(self) -> Capabilities:
        return self._caps

    def send(self, frame: bytes) -> None:
        path = os.path.join(self.outbox, f"{uuid.uuid4().hex}.hyf")
        tmp = path + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(frame)
        os.replace(tmp, path)  # atomic: a reader never sees a partial frame

    def poll(self) -> list[bytes]:
        out = []
        for fname in sorted(os.listdir(self.inbox)):
            if not fname.endswith(".hyf") or fname in self._seen:
                continue
            self._seen.add(fname)
            with open(os.path.join(self.inbox, fname), "rb") as fh:
                out.append(fh.read())
        return out
