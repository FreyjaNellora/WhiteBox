"""Hyphae L4 — bearer selection policy.

Given the bearers a node can currently see and a bundle's requirements, decide
which bearers to spray across.

**Legality and detectability are independent axes.** Legality is the hard gate:
a bearer is eligible only if its ``legal_class`` is in the operator's lawful
whitelist. Detectability is *not* a legal constraint — being detectable is never
required by law, only sometimes by physics (the only bearer that reaches, or the
only one fast enough). So detectability is minimized by default and spent only
where delivery requires it:

* **Legality (hard gate)** — a bearer is eligible only if its ``legal_class`` is
  whitelisted. Ineligible bearers are *refused*, and ``evaluate`` reports why.
* **Detectability budget (optional hard cap)** — if the operator sets one, a
  bearer above the bundle's ``det_budget`` is refused. The default budget allows
  anything, because the *ordering* below, plus the node's stealth-by-default
  escalation (see node.py), already keep transit as quiet as delivery permits.
* **Ordering** — non-urgent bundles list the quietest bearers first; urgent
  bundles (``is_urgent``) list the fastest first, because there stealth yields
  to the deadline.

The node starts each non-urgent send on the single quietest eligible bearer and
climbs this ordered list only when a receipt has not come back in time — so a
louder bearer is used strictly where required, never by default.
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

# Bearers whose use costs the volunteer money / a metered plan (cellular). A
# relay only forwards onto these when the volunteer has explicitly allowed it.
METERED_LEGAL_CLASSES = frozenset({"licensed-carrier"})


@dataclass
class RelayConsent:
    """A volunteer's opt-in terms for carrying other people's sealed messages.

    Off by default; the app turns it on. Every field is a limit the volunteer
    controls, so donating connectivity never surprises them:

    * ``enabled`` — relay for others at all.
    * ``allow_metered`` — may also forward over metered cellular (the "use my
      cellular service" switch). Default False: free/Wi-Fi links only.
    * ``data_budget_bytes`` — stop relaying once this much has been carried
      (None = no cap). Protects the data plan.
    * ``battery_floor_pct`` — stop relaying when battery drops below this.
    """

    enabled: bool = False
    allow_metered: bool = False
    data_budget_bytes: int | None = None
    battery_floor_pct: int = 0


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

    if is_urgent(bundle):
        # Fastest first: low latency, then high rate.
        eligible.sort(key=lambda b: (b.capabilities().latency_s, -b.capabilities().rate_bps))
    else:
        # Quietest, most reliable first: low detectability, then low error rate.
        eligible.sort(key=lambda b: (b.capabilities().detectability, b.capabilities().error_rate))
    return Decision(chosen=eligible, refused=refused)


def is_urgent(bundle: Bundle) -> bool:
    """A bundle is urgent (delivery beats stealth) if it is high priority or has
    a tight deadline. Urgent bundles start on the fastest bearers; everything
    else starts on the quietest and only escalates if delivery is not confirmed.
    """
    return bundle.priority >= URGENT_PRIORITY or (
        bundle.deadline_s != 0 and bundle.deadline_s <= 60
    )


def select_bearers(
    bearers: list[Bearer],
    bundle: Bundle,
    legal_whitelist: frozenset[str] = DEFAULT_LEGAL_WHITELIST,
) -> list[Bearer]:
    return evaluate(bearers, bundle, legal_whitelist).chosen
