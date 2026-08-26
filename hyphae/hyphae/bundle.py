"""Hyphae L1 — the Bundle: a sovereign, signed, content-addressed message.

A bundle is fully self-contained and medium-agnostic. It carries the source's
public key so it is *self-verifying*: any relay can check the signature and
confirm ``address_of(src_pubkey) == src`` with no registry. The payload is
sealed to the recipient (see ``sealedbox``), so intermediaries carry opaque
ciphertext.

Wire layout (big-endian), signature covers every byte before ``sig``:

    magic        4    b"HYF1"
    dest         16   destination address
    src          16   source address  (== address_of(src_pubkey))
    src_pubkey   32   raw Ed25519 public key of the source
    msg_id       16   = sha256(src || payload)[:16]  (content address)
    created_at   8    uint64 seconds since epoch
    deadline_s   4    uint32 seconds after created_at; 0 = no expiry
    priority     1    uint8  0 bulk .. 255 emergency
    det_budget   1    uint8  max detectability * 100
    flags        1    uint8  bit0 = receipt requested
    _reserved    1    uint8
    payload_len  4    uint32
    payload      N    sealed bytes
    sig          64   Ed25519 signature
"""
from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field

from .identity import Identity, address_of, verify
from .sealedbox import seal

MAGIC = b"HYF1"
FLAG_RECEIPT = 0x01
_HEADER = struct.Struct(">4s16s16s32s16sQIBBBBI")  # up to payload_len
SIG_LEN = 64


@dataclass
class Bundle:
    dest: bytes
    src: bytes
    src_pubkey: bytes
    payload: bytes  # sealed ciphertext
    created_at: int
    deadline_s: int = 0
    priority: int = 0
    det_budget: int = 100  # 0..100; default = allow anything up to fully overt
    flags: int = FLAG_RECEIPT
    msg_id: bytes = field(default=b"")
    _sig: bytes = field(default=b"", repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.msg_id:
            self.msg_id = hashlib.sha256(self.src + self.payload).digest()[:16]

    # ---- construction --------------------------------------------------
    @classmethod
    def create(
        cls,
        sender: Identity,
        dest: bytes,
        recipient_x_pub: bytes,
        plaintext: bytes,
        created_at: int,
        deadline_s: int = 0,
        priority: int = 0,
        det_budget: int = 100,
        request_receipt: bool = True,
    ) -> "Bundle":
        payload = seal(recipient_x_pub, plaintext)
        return cls(
            dest=dest,
            src=sender.address,
            src_pubkey=sender.public_bytes,
            payload=payload,
            created_at=created_at,
            deadline_s=deadline_s,
            priority=priority,
            det_budget=det_budget,
            flags=FLAG_RECEIPT if request_receipt else 0,
        )

    # ---- serialization -------------------------------------------------
    def _signable(self) -> bytes:
        return _HEADER.pack(
            MAGIC, self.dest, self.src, self.src_pubkey, self.msg_id,
            self.created_at, self.deadline_s, self.priority, self.det_budget,
            self.flags, 0, len(self.payload),
        ) + self.payload

    def to_bytes(self, sender: Identity) -> bytes:
        body = self._signable()
        return body + sender.sign(body)

    @classmethod
    def from_bytes(cls, raw: bytes) -> "Bundle":
        head = _HEADER.unpack_from(raw, 0)
        (magic, dest, src, src_pubkey, msg_id, created_at, deadline_s,
         priority, det_budget, flags, _res, payload_len) = head
        if magic != MAGIC:
            raise ValueError("bad magic")
        off = _HEADER.size
        payload = raw[off:off + payload_len]
        b = cls(dest, src, src_pubkey, payload, created_at, deadline_s,
                priority, det_budget, flags, msg_id)
        b._sig = raw[off + payload_len:off + payload_len + SIG_LEN]
        return b

    # ---- verification --------------------------------------------------
    def verify(self) -> bool:
        """Signature valid AND src address consistent with the carried pubkey."""
        if address_of(self.src_pubkey) != self.src:
            return False
        if not getattr(self, "_sig", b""):
            return False
        return verify(self.src_pubkey, self._sig, self._signable())

    def wants_receipt(self) -> bool:
        return bool(self.flags & FLAG_RECEIPT)

    def is_expired(self, now: int) -> bool:
        return self.deadline_s != 0 and now > self.created_at + self.deadline_s
