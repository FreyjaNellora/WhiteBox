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

Relaying is **cut-through and low-footprint**, so a device that temporarily
carries someone else's message barely feels it. A relay reads only a tiny
cleartext routing header on each fragment (destination + remaining hops),
forwards the fragment onward immediately across its other bearers, and never
decodes, reassembles, or buffers the message — only the destination pays decode
cost. A per-tick forwarding cap (``max_forwards_per_tick``) keeps relaying from
starving the host's own traffic, and a ``(msg_id, seed)`` seen-set plus the hop
budget bound loops and duplicate work. The sealed bundle is never opened by a
relay, so a borrowed node cannot read what it carries.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass, field

from .bearer import Bearer
from .bundle import Bundle
from .fountain import Decoder, Encoder
from .identity import Identity, address_of, verify
from .policy import (
    DEFAULT_LEGAL_WHITELIST, METERED_LEGAL_CLASSES, RelayConsent, is_urgent,
    select_bearers,
)

FRAME_SYMBOL = 1
FRAME_RECEIPT = 2
_RECEIPT_MAGIC = b"HYFR"
_RECEIPT = struct.Struct(">16s32s64s")  # msg_id, recipient pubkey, signature

# Default coding overhead: emit ~1.7x the source blocks plus a small constant so
# a first burst usually decodes without waiting for a resend.
_OVERHEAD = 1.7
_OVERHEAD_CONST = 8

# Offsets within a fountain symbol (see fountain._SYM = ">16sIIII"): the msg_id
# and this symbol's seed, read cheaply by a relay without decoding anything.
_SYM_MSGID = slice(0, 16)
_SYM_SEED = slice(28, 32)


def _frame(kind: int, body: bytes) -> bytes:
    return bytes([kind]) + body


def _symbol_frame(dest: bytes, hops: int, symbol: bytes) -> bytes:
    """A symbol on the wire, with a tiny cleartext routing header a relay reads
    to forward it WITHOUT decoding the message: [SYMBOL][dest 16][hops 1][symbol]."""
    return bytes([FRAME_SYMBOL]) + dest + bytes([hops & 0xFF]) + symbol


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
    hop_limit: int = 8


@dataclass
class Node:
    identity: Identity
    bearers: list[Bearer] = field(default_factory=list)
    legal_whitelist: frozenset = DEFAULT_LEGAL_WHITELIST
    relay: bool = False  # convenience: True == a permissive RelayConsent
    consent: RelayConsent | None = None  # the volunteer's opt-in relay terms
    # Good-guest cap: the most symbol-forwards this node will do for OTHERS per
    # tick, so a borrowed node never has its own traffic starved by relaying.
    max_forwards_per_tick: int = 256
    battery_pct: int = 100  # updated by the host; gates relaying via consent

    def __post_init__(self) -> None:
        if self.consent is None:
            # relay=True keeps the old permissive behavior (incl. metered links);
            # relay=False means we do not relay for others.
            self.consent = RelayConsent(enabled=self.relay, allow_metered=True)
        self._relayed_bytes = 0
        self._decoders: dict[bytes, Decoder] = {}
        self._inflight: dict[bytes, _InFlight] = {}
        self._delivered_in: set[bytes] = set()   # msg_ids delivered to us
        self._confirmed_out: set[bytes] = set()  # our sends proven delivered
        self._failed_out: set[bytes] = set()     # our sends that expired
        self._relayed: set[bytes] = set()        # msg_ids we've forwarded onward
        self._fwd_receipts: set[bytes] = set()   # receipts we've forwarded back
        self._seen: set[tuple[bytes, bytes]] = set()  # (msg_id, seed) already handled
        self._forwards_this_tick = 0
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
        hop_limit: int = 8,
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
        self._inflight[bundle.msg_id] = _InFlight(bundle, encoder, width=start_width,
                                                  hop_limit=hop_limit)
        n = int(encoder.k * _OVERHEAD) + _OVERHEAD_CONST
        self._spray(self._inflight[bundle.msg_id], n)
        if not request_receipt:
            self._inflight.pop(bundle.msg_id, None)
        return bundle.msg_id

    def _ordered(self, bundle: Bundle) -> list[Bearer]:
        """Eligible bearers, quietest-first (or fastest-first if urgent)."""
        return select_bearers(self.bearers, bundle, self.legal_whitelist)

    def _spray(self, inflight: _InFlight, n: int) -> None:
        bundle = inflight.bundle
        ordered = self._ordered(bundle)
        chosen = ordered[:max(1, inflight.width)]  # only the quietest `width` bearers
        if not chosen:
            return
        for i, sym in enumerate(inflight.encoder.stream(n)):
            # Remember our own symbols so relayed echoes of them are dropped.
            self._seen.add((sym[_SYM_MSGID], sym[_SYM_SEED]))
            chosen[i % len(chosen)].send(
                _symbol_frame(bundle.dest, inflight.hop_limit, sym))

    # ---- receiving / servicing ----------------------------------------
    def tick(self, now: int) -> None:
        """Poll every bearer, process arrivals, and service in-flight bundles."""
        self._forwards_this_tick = 0
        for bearer in self.bearers:
            for frame in bearer.poll():
                if not frame:
                    continue
                kind, body = frame[0], frame[1:]
                if kind == FRAME_SYMBOL:
                    self._on_symbol(body, bearer)
                elif kind == FRAME_RECEIPT:
                    self._on_receipt(body, bearer)
        self._service_inflight(now)

    def _on_symbol(self, body: bytes, inbound: Bearer) -> None:
        # Read only the tiny routing header — no decoding. This is what makes a
        # borrowed node cheap: it never reassembles a message meant for others.
        if len(body) < 17 + 32:
            return
        dest = body[:16]
        hops = body[16]
        sym = body[17:]
        key = (sym[_SYM_MSGID], sym[_SYM_SEED])
        if key in self._seen:
            return  # already handled this exact fragment (loop / duplicate)
        self._seen.add(key)

        if dest == self.address:
            self._ingest(sym)
            return

        # In transit for someone else: cut-through forward without decoding,
        # but only within the volunteer's opt-in terms.
        c = self.consent
        if not c.enabled or hops == 0:
            return
        if self.battery_pct < c.battery_floor_pct:
            return  # too low on battery to carry others' traffic
        if c.data_budget_bytes is not None and self._relayed_bytes >= c.data_budget_bytes:
            return  # the volunteer's donated data budget is spent
        if self._forwards_this_tick >= self.max_forwards_per_tick:
            return  # yield to the host: we've done our share of relaying this tick
        onward = _symbol_frame(dest, hops - 1, sym)
        forwarded = False
        for bearer in self.bearers:
            if bearer is inbound:  # never echo back where it came from
                continue
            metered = bearer.capabilities().legal_class in METERED_LEGAL_CLASSES
            if metered and not c.allow_metered:
                continue  # don't spend the volunteer's cellular unless allowed
            bearer.send(onward)
            self._relayed_bytes += len(onward)
            forwarded = True
        if forwarded:
            self._forwards_this_tick += 1
            self._relayed.add(sym[_SYM_MSGID])

    def _ingest(self, sym: bytes) -> None:
        """A fragment addressed to us: only the destination pays decode cost."""
        msg_id = sym[_SYM_MSGID]
        if msg_id in self._delivered_in:
            return
        dec = self._decoders.get(msg_id)
        if dec is None:
            dec = self._decoders[msg_id] = Decoder()
        if dec.add(sym):
            self._deliver(dec)

    def _deliver(self, dec: Decoder) -> None:
        try:
            bundle = Bundle.from_bytes(dec.result())
        except (ValueError, struct.error):
            self._decoders.pop(dec.msg_id, None)
            return
        self._decoders.pop(dec.msg_id, None)
        if not bundle.verify() or bundle.dest != self.address:
            return
        if bundle.msg_id not in self._delivered_in:
            self._delivered_in.add(bundle.msg_id)
            try:
                plaintext = self.identity.open_sealed(bundle.payload)
            except Exception:
                return
            self.inbox.append((bundle.src, plaintext))
        if bundle.wants_receipt():
            receipt = _frame(FRAME_RECEIPT, make_receipt(self.identity, bundle.msg_id))
            for bearer in self.bearers:
                bearer.send(receipt)

    def _on_receipt(self, body: bytes, inbound: Bearer) -> None:
        matched = False
        for msg_id, inflight in self._inflight.items():
            if verify_receipt(body, inflight.bundle.dest) == msg_id:
                inflight.delivered = True
                matched = True
        if matched:
            return
        # Not ours. If we relayed this bundle, carry its receipt back — cut-through
        # again, within the same consent terms, never back onto the inbound bearer.
        if not self.consent.enabled:
            return
        try:
            msg_id, _pub, _sig = _RECEIPT.unpack(body)
        except struct.error:
            return
        if msg_id in self._relayed and msg_id not in self._fwd_receipts:
            self._fwd_receipts.add(msg_id)
            fr = _frame(FRAME_RECEIPT, body)
            for bearer in self.bearers:
                if bearer is inbound:
                    continue
                metered = bearer.capabilities().legal_class in METERED_LEGAL_CLASSES
                if metered and not self.consent.allow_metered:
                    continue
                bearer.send(fr)

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
            self._spray(inflight, max(2, inflight.encoder.k))
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
