"""Hyphae routing envelope — the message's own carried routing state.

A bundle (L1) is the sealed, signed message; it is *immutable* end to end, so it
cannot hold anything a relay needs to change. The **envelope** is the mutable
wrapper that travels around it and makes the message self-piloting:

* ``hops_remaining`` — the message's own search budget. Every relay decrements
  it; at zero the message stops spreading. A river that can't flow forever.
* ``trail`` — the addresses the message has already passed through. Every relay
  appends itself; a node that finds itself already on the trail drops its copy.
  This is the message's memory: it never flows in a circle, and it fans out
  across every branch it has *not* yet tried.

The envelope is what gets fountain-coded and put on a bearer. Relays rewrite the
envelope (never the sealed bundle inside it), so the message re-routes itself at
every hop against whatever paths are live right then — the path it arrived on
being closed just means a different copy, on a different branch, gets there
first. The sealed bundle within is untouched, so no relay can read or alter it.

Wire layout (big-endian):

    magic         4    b"HYE1"
    hops          2    uint16 hops_remaining
    trail_len     2    uint16 number of 16-byte addresses
    trail         trail_len * 16
    inner_len     4    uint32
    inner         signed bundle bytes (see bundle.py)
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

MAGIC = b"HYE1"
_HEAD = struct.Struct(">4sHH")


@dataclass
class Envelope:
    inner: bytes            # the signed bundle bytes, untouched by relays
    hops_remaining: int
    trail: list[bytes]      # 16-byte node addresses already visited

    def to_bytes(self) -> bytes:
        out = _HEAD.pack(MAGIC, self.hops_remaining, len(self.trail))
        out += b"".join(self.trail)
        out += struct.pack(">I", len(self.inner)) + self.inner
        return out

    @classmethod
    def from_bytes(cls, raw: bytes) -> "Envelope":
        magic, hops, tlen = _HEAD.unpack_from(raw, 0)
        if magic != MAGIC:
            raise ValueError("bad envelope magic")
        off = _HEAD.size
        trail = [raw[off + i * 16: off + i * 16 + 16] for i in range(tlen)]
        off += tlen * 16
        (inner_len,) = struct.unpack_from(">I", raw, off)
        off += 4
        inner = raw[off:off + inner_len]
        return cls(inner=inner, hops_remaining=hops, trail=trail)

    def forwarded_by(self, address: bytes) -> "Envelope":
        """The envelope as a relay should re-emit it: one less hop, self on the
        trail. The sealed inner bundle is carried through unchanged."""
        return Envelope(inner=self.inner, hops_remaining=self.hops_remaining - 1,
                        trail=self.trail + [address])
