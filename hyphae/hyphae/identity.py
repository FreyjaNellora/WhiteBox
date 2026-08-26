"""Hyphae L1 identity — Ed25519 keypairs and content-addressed node addresses.

An identity is a keypair. A node's *address* is the first 16 bytes of
SHA-256(public_key) — self-certifying: anyone holding the public key can verify
that traffic claiming to come from an address really does, with no registry and
no authority issuing names. This is the "keys, not accounts" property: identity
is a cryptographic fact you hold, not a grant someone can revoke.

Ed25519 is used for signatures. The same 32-byte seed also yields the node's
Curve25519 key, so payloads can be sealed *to* a node with no prior handshake
(see ``sealedbox``). Backed by libsodium via PyNaCl.
"""
from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

from nacl.signing import SigningKey, VerifyKey
from nacl.public import SealedBox
from nacl.exceptions import BadSignatureError, CryptoError

ADDRESS_LEN = 16


def address_of(public_key_bytes: bytes) -> bytes:
    """Derive the 16-byte Hyphae address from a raw Ed25519 public key."""
    return hashlib.sha256(public_key_bytes).digest()[:ADDRESS_LEN]


@dataclass
class Identity:
    """A local identity that can sign and receive sealed payloads.

    Built from a 32-byte seed so that one seed deterministically yields both the
    Ed25519 signing key and the Curve25519 encryption key for this node.
    """

    seed: bytes

    def __post_init__(self) -> None:
        if len(self.seed) != 32:
            raise ValueError("seed must be exactly 32 bytes")
        self._sk = SigningKey(self.seed)
        self._x_priv = self._sk.to_curve25519_private_key()

    @classmethod
    def generate(cls) -> "Identity":
        return cls(os.urandom(32))

    @classmethod
    def from_seed(cls, seed: bytes) -> "Identity":
        """Deterministic identity from a 32-byte seed (used in tests)."""
        return cls(seed)

    @property
    def public_bytes(self) -> bytes:
        return self._sk.verify_key.encode()

    @property
    def x_public_bytes(self) -> bytes:
        """Raw Curve25519 public key that payloads are sealed to."""
        return self._x_priv.public_key.encode()

    @property
    def address(self) -> bytes:
        return address_of(self.public_bytes)

    def sign(self, message: bytes) -> bytes:
        return self._sk.sign(message).signature

    def open_sealed(self, sealed: bytes) -> bytes:
        """Decrypt a payload sealed to this identity's Curve25519 key."""
        return SealedBox(self._x_priv).decrypt(sealed)


def verify(public_key_bytes: bytes, signature: bytes, message: bytes) -> bool:
    """Verify a signature given a raw Ed25519 public key. Never raises."""
    try:
        VerifyKey(public_key_bytes).verify(message, signature)
        return True
    except (BadSignatureError, CryptoError, ValueError):
        return False
