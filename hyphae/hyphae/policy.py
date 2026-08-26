"""Hyphae L4 — bearer selection policy.

Given the bearers a node can currently see and a bundle's requirements, decide
which bearers to spray across. This is where the three invariants from THEORY.md
are enforced *before a single symbol is emitted*:

* **Legality** — a bearer is eligible only if its ``legal_class`` is in the
  operator's lawful whitelist.
* **Detectability budget** — a bearer is eligible only if its detectability is
  at or below the bundle's ``det_budget``.
* **Deadline / priority** — eligible bearers are ordered so urgent traffic
  prefers the fastest threads and bulk traffic prefers the quietest ones.

Ineligible bearers are *refused*, and ``explain`` reports why, so the refusal is
auditable rather than silent.
"""
from __future__ import annotations

from dataclasses import dataclass

from .bearer import Bearer
from .bundle import Bundle

# A conservative default: only channels that need no license, ride a carrier
# that holds one, or are not RF emitters at all. Operators widen/narrow this.
DEFAULT_LEGAL_WHITELIST = frozenset({
    "unlicensed-ism",
    "license-by-rule",
    "licensed-carrier",
    "unregulated-physical",
    "public-substrate",
    "local-only",
})

URGENT_PRIORITY = 128  # priority at/above this is treated as deadline-driven


@dataclass
class Decision:
    chosen: list[Bearer]
    refused: list[tuple[str, str]]  # (bearer name, reason)


def evaluate(
    bearers: list[Bearer],
    bundle: Bundle,
    legal_whitelist: frozenset[str] = DEFAULT_LEGAL_WHITELIST,
) -> Decision:
    eligible: list[Bearer] = []
    refused: list[tuple[str, str]] = []
    for b in bearers:
        caps = b.capabilities()
        if caps.legal_class not in legal_whitelist:
            refused.append((caps.name, f"legal_class {caps.legal_class!r} not permitted"))
            continue
        if round(caps.detectability * 100) > bundle.det_budget:
            refused.append((caps.name, f"detectability {caps.detectability} exceeds budget {bundle.det_budget}"))
            continue
        eligible.append(b)

    urgent = bundle.priority >= URGENT_PRIORITY or (
        bundle.deadline_s != 0 and bundle.deadline_s <= 60
    )
    if urgent:
        # Fastest first: low latency, then high rate.
        eligible.sort(key=lambda b: (b.capabilities().latency_s, -b.capabilities().rate_bps))
    else:
        # Quietest, most reliable first: low detectability, then low error rate.
        eligible.sort(key=lambda b: (b.capabilities().detectability, b.capabilities().error_rate))
    return Decision(chosen=eligible, refused=refused)


def select_bearers(
    bearers: list[Bearer],
    bundle: Bundle,
    legal_whitelist: frozenset[str] = DEFAULT_LEGAL_WHITELIST,
) -> list[Bearer]:
    return evaluate(bearers, bundle, legal_whitelist).chosen
