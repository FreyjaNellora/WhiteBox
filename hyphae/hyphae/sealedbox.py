"""Recipient-only payload encryption for Hyphae bundles.

A bundle's payload is sealed to the recipient so that every relay along the way
carries opaque ciphertext — the "encrypted, recipient-only" property that makes
intermediaries structurally unable to read (or filter on) content.

Uses libsodium's sealed box (``crypto_box_seal``) via PyNaCl: an anonymous
ephemeral-static Curve25519 box. The sender needs only the recipient's public
key; the recipient needs only its own secret. No handshake, no forward channel.
"""
from __future__ import annotations

from nacl.public import PublicKey, SealedBox


def seal(recipient_x_pub: bytes, plaintext: bytes) -> bytes:
    """Encrypt ``plaintext`` to a recipient's raw Curve25519 public key."""
    return SealedBox(PublicKey(recipient_x_pub)).encrypt(plaintext)
