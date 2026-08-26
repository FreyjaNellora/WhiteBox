"""Hyphae L3 — a node: send, receive, reassemble, confirm.

A node owns an identity and a set of bearers. It sends a message by building a
sovereign :class:`Bundle`, fountain-coding it, and spraying the coded symbols
across whichever bearers the L4 policy permits. It receives by polling all
bearers, feeding symbols to per-bundle decoders, and — once a bundle
reassembles and its signature verifies — delivering the payload and returning a
**signed receipt**.

The sender keeps every receipt-requested bundle **in flight**: on each tick it
re-sprays more symbols across the eligible bearers until either the receipt
comes back (proof of delivery) or the deadline passes (honest failure). That is
the whole delivery contract — "delivered, or a truthful failure," never a silent
drop.

This reference implements direct delivery over the bearers a node holds.
Multi-hop relaying and mailbox nodes (described in THEORY.md §L3) layer on top of
this same symbol/receipt machinery and are the next implementation step.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

from .bearer import Bearer
from .bundle import Bundle
from .fountain import Decoder, Encoder
from .identity import Identity, address_of, verify
from .policy import DEFAULT_LEGAL_WHITELIST, is_urgent, select_bearers

FRAME_SYMBOL = 1
FRAME_RECEIPT = 2
_RECEIPT_MAGIC = b"HYFR"
_RECEIPT = struct.Struct(">16s32s64s")  # msg_id, recipient pubkey, signature

# Default coding overhead: emit ~1.7x the source blocks plus a small constant so
# a first burst usually decodes without waiting for a resend.
_OVERHEAD = 1.7
_OVERHEAD_CONST = 8


def _frame(kind: int, body: bytes) -> bytes:
    return bytes([kind]) + body


def make_receipt(identity: Identity, msg_id: bytes) -> bytes:
    sig = identity.sign(_RECEIPT_MAGIC + msg_id)
    return _RECEIPT.pack(msg_id, identity.public_bytes, sig)


def verify_receipt(raw: bytes, expected_dest: bytes) -> bytes | None:
    """Return the receipted msg_id if valid and from the expected recipient."""
    try:
        msg_id, pub, sig = _RECEIPT.unpack(raw)
    except struct.error:
        return None
    if address_of(pub) != expected_dest:
        return None
    if not verify(pub, sig, _RECEIPT_MAGIC + msg_id):
        return None
    return msg_id


@dataclass
class _InFlight:
    bundle: Bundle
    encoder: Encoder
    delivered: bool = False
    width: int = 1  # how many bearers (quietest-first) this send is currently using


@dataclass
class Node:
    identity: Identity
    bearers: list[Bearer] = field(default_factory=list)
    legal_whitelist: frozenset = DEFAULT_LEGAL_WHITELIST

    def __post_init__(self) -> None:
        self._decoders: dict[bytes, Decoder] = {}
        self._inflight: dict[bytes, _InFlight] = {}
        self._delivered_in: set[bytes] = set()   # msg_ids delivered to us
        self._confirmed_out: set[bytes] = set()  # our sends proven delivered
        self._failed_out: set[bytes] = set()     # our sends that expired
        self.inbox: list[tuple[bytes, bytes]] = []  # (src address, plaintext)

    @property
    def address(self) -> bytes:
        return self.identity.address

    def add_bearer(self, bearer: Bearer) -> None:
        self.bearers.append(bearer)

    # ---- sending -------------------------------------------------------
    def send(
        self,
        dest: bytes,
        dest_x_pub: bytes,
        plaintext: bytes,
        created_at: int,
        deadline_s: int = 0,
        priority: int = 0,
        det_budget: int = 100,
        request_receipt: bool = True,
        block_size: int = 256,
    ) -> bytes:
        bundle = Bundle.create(
            self.identity, dest, dest_x_pub, plaintext, created_at,
            deadline_s=deadline_s, priority=priority, det_budget=det_budget,
            request_receipt=request_receipt,
        )
        raw = bundle.to_bytes(self.identity)
        encoder = Encoder(bundle.msg_id, raw, block_size=block_size)
        # Stealth by default: a non-urgent send starts on the single quietest
        # eligible bearer. An urgent send starts wide (all eligible), since there
        # the deadline outranks stealth.
        ordered = self._ordered(bundle)
        start_width = len(ordered) if is_urgent(bundle) else 1
        self._inflight[bundle.msg_id] = _InFlight(bundle, encoder, width=start_width)
        n = int(encoder.k * _OVERHEAD) + _OVERHEAD_CONST
        self._spray(bundle, encoder, n, start_width)
        if not request_receipt:
            self._inflight.pop(bundle.msg_id, None)
        return bundle.msg_id

    def _ordered(self, bundle: Bundle) -> list[Bearer]:
        """Eligible bearers, quietest-first (or fastest-first if urgent)."""
        return select_bearers(self.bearers, bundle, self.legal_whitelist)

    def _spray(self, bundle: Bundle, encoder: Encoder, n: int, width: int) -> None:
        ordered = self._ordered(bundle)
        chosen = ordered[:max(1, width)]  # only the quietest `width` bearers
        if not chosen:
            return
        symbols = encoder.stream(n)
        for i, sym in enumerate(symbols):
            chosen[i % len(chosen)].send(_frame(FRAME_SYMBOL, sym))

    # ---- receiving / servicing ----------------------------------------
    def tick(self, now: int) -> None:
        """Poll every bearer, process arrivals, and service in-flight bundles."""
        for bearer in self.bearers:
            for frame in bearer.poll():
                if not frame:
                    continue
                kind, body = frame[0], frame[1:]
                if kind == FRAME_SYMBOL:
                    self._on_symbol(body)
                elif kind == FRAME_RECEIPT:
                    self._on_receipt(body)
        self._service_inflight(now)

    def _on_symbol(self, symbol: bytes) -> None:
        msg_id = symbol[:16]
        if msg_id in self._delivered_in:
            return  # already have this bundle; ignore late symbols
        dec = self._decoders.get(msg_id)
        if dec is None:
            dec = self._decoders[msg_id] = Decoder()
        if dec.add(symbol):
            self._on_bundle_complete(dec)

    def _on_bundle_complete(self, dec: Decoder) -> None:
        try:
            bundle = Bundle.from_bytes(dec.result())
        except (ValueError, struct.error):
            self._decoders.pop(dec.msg_id, None)
            return
        if not bundle.verify():
            self._decoders.pop(bundle.msg_id, None)
            return
        self._decoders.pop(bundle.msg_id, None)
        if bundle.dest != self.address:
            return  # not for us (relaying is the next implementation step)
        if bundle.msg_id not in self._delivered_in:
            self._delivered_in.add(bundle.msg_id)
            try:
                plaintext = self.identity.open_sealed(bundle.payload)
            except Exception:
                return
            self.inbox.append((bundle.src, plaintext))
        if bundle.wants_receipt():
            self._broadcast(_frame(FRAME_RECEIPT,
                                   make_receipt(self.identity, bundle.msg_id)))

    def _on_receipt(self, body: bytes) -> None:
        for msg_id, inflight in self._inflight.items():
            if verify_receipt(body, inflight.bundle.dest) == msg_id:
                inflight.delivered = True

    def _broadcast(self, frame: bytes) -> None:
        for bearer in self.bearers:
            bearer.send(frame)

    def _service_inflight(self, now: int) -> None:
        done = []
        for msg_id, inflight in self._inflight.items():
            if inflight.delivered:
                self._confirmed_out.add(msg_id)
                done.append(msg_id)
                continue
            if inflight.bundle.is_expired(now):
                self._failed_out.add(msg_id)
                done.append(msg_id)
                continue
            # Not yet confirmed: escalate detectability by exactly one step —
            # add the next-quietest bearer — then re-spray a top-up burst. A
            # louder bearer is thus recruited only because delivery required it.
            ordered = self._ordered(inflight.bundle)
            inflight.width = min(inflight.width + 1, len(ordered)) if ordered else inflight.width
            self._spray(inflight.bundle, inflight.encoder,
                        max(2, inflight.encoder.k), inflight.width)
        for msg_id in done:
            self._inflight.pop(msg_id, None)

    # ---- status --------------------------------------------------------
    def is_delivered(self, msg_id: bytes) -> bool:
        """True only once a signed receipt for this send has been verified."""
        if msg_id in self._confirmed_out:
            return True
        inflight = self._inflight.get(msg_id)
        return bool(inflight and inflight.delivered)

    def is_failed(self, msg_id: bytes) -> bool:
        """True if this send's deadline passed with no receipt."""
        return msg_id in self._failed_out

    def pending(self) -> list[bytes]:
        return [m for m, f in self._inflight.items() if not f.delivered]
