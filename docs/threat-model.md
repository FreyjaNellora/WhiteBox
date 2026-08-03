# Threat model (conceptual)

This document states, at a conceptual level, what WhiteBox defends, whom it defends against, and
the principles it is built on. It intentionally omits implementation mechanisms (see
[SECURITY.md](../SECURITY.md)).

## What we protect

The most sensitive class of personal data: a durable model of a person — identity, memory,
working style, and (as a stated research direction) affective context — held locally on the
user's own hardware. The user is the single authority over this data; the system is a substrate
they own, not a service that owns them.

## Whom we defend against

- **Outside attackers** — the ordinary threat surface of any system handling sensitive data.
- **Untrusted ingested content** — WhiteBox operates alongside agents that read the open web. Any
  content crossing that boundary is treated as hostile until shown otherwise.
- **Insider threats within a capable multi-agent system** — the distinctive part. Multiple AI
  agents with real capability act on the shared substrate. We assume that any one of them may be
  compromised, or may be *deceptively aligned* — appearing cooperative while pursuing another
  objective. A defense that trusts its own agents is not a defense.

## Design principles

- **Zero-trust / assume-breach** — no component is trusted by default; we design for the case
  where a boundary has already been crossed.
- **Least privilege & containment** — each actor gets the minimum authority for its role; the
  blast radius of any single compromised actor is bounded.
- **Provenance & audit** — actions are attributable and reviewable after the fact; the record is
  designed to make tampering evident.
- **Evidence-based, not testimony-based detection** — we judge what an actor *did*, not what it
  *says* it did, because a deceptively-aligned actor will say the right things.
- **Trusted-monitor-over-untrusted-worker** — higher-capability work is checked by an independent,
  more-trusted monitor rather than trusted on its own word.
- **Human authority as the irreducible root** — a human holds final authority; the system is built
  to *fail well* (contain and surface) rather than to promise that it can never fail.
- **Sovereignty** — the system runs and defends itself locally, with no dependency on an external
  party for control, updates, or continued operation.

## The layered system

WhiteBox is the user-owned **substrate** (memory and identity). It operates as part of a governed,
layered system: **ChatBox** provides an auditable coordination and communication layer between
agents, and **Playbook** provides the operating-doctrine and workflow layer that governs how
agents are permitted to act. Each layer is described here by role only; their internal mechanisms
are intentionally not published.
