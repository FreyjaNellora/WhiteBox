"""Hyphae — a transport-agnostic, censorship-resistant messaging layer.

See ../THEORY.md for the model. Public surface:

    Identity           Ed25519 + X25519 node identity ("keys, not accounts")
    Bundle             the sovereign, signed, content-addressed message (L1)
    Encoder / Decoder  LT fountain coding (L2)
    Bearer / Capabilities   the uniform channel interface (L0)
    LoopbackBearer / FileBearer / loopback_pair   reference bearers
    select_bearers / evaluate   the L4 selection policy
    Node               send / receive / reassemble / confirm (L3)
"""
from .identity import Identity, address_of, verify
from .bundle import Bundle
from .fountain import Encoder, Decoder
from .bearer import (
    Bearer,
    Capabilities,
    LoopbackBearer,
    FileBearer,
    loopback_pair,
    LEGAL_CLASSES,
)
from .policy import evaluate, select_bearers, Decision, DEFAULT_LEGAL_WHITELIST
from .node import Node, make_receipt, verify_receipt

__all__ = [
    "Identity", "address_of", "verify", "Bundle", "Encoder", "Decoder",
    "Bearer", "Capabilities", "LoopbackBearer", "FileBearer", "loopback_pair",
    "LEGAL_CLASSES", "evaluate", "select_bearers", "Decision",
    "DEFAULT_LEGAL_WHITELIST", "Node", "make_receipt", "verify_receipt",
]
