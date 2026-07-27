# dwarf_forge — the router / meta-reasoning layer

> **Scope.** This is a design statement for the layer that [research-direction.md](research-direction.md)
> calls "routing, consolidation, and review." It is **speculative and parked** relative to the
> shipping product — the near-term discipline remains *ship the substrate, not the brain*. Written
> down so the shape is agreed before any of it is built.

## The one-line idea

`dwarf_forge` is a language model used as a **router and a meta-reasoning layer** over the
user-owned blackboard — never as a specialist that does the underlying work itself. It decides
*which* tool answers a question, then turns that tool's raw output into narrative a human can read,
and writes the result back to the store under full governance.

## Why an LLM belongs *here* and nowhere below

The design rule is a division of labor by what each kind of system is actually good at.

| Layer | Does | Example |
|---|---|---|
| **Specialists** (narrow ML / tools) | The narrow task, with numeric output and held-out discipline. | [Hornet](https://github.com/FreyjaNellora/Hornet) predicts moves; a classifier scores a signal. |
| **`dwarf_forge`** (the LLM) | Routes to a specialist; reads its output; reasons *about* it in narrative. Does **not** do the specialist's job. | Explains *why* a line is strong; names a player's style; consolidates findings. |
| **The blackboard** ([WhiteBox](../README.md) / ChatBox) | Holds the audited, source-stamped record everything reads and writes. | The vault; the coordination channel. |

An LLM is strong at exactly two things this system needs, and weak at everything the specialists
own:

1. **Narrative reasoning** — turning a pattern into a readable story: a person's identity or
   working-style pattern in the vault, or a player's *personality* and style from their game record.
2. **Meta-analysis** — interpreting, comparing, and explaining the *outputs of other tools*
   without redoing their computation.

Put the LLM anywhere below this line — asking it to actually play the chess, actually classify the
signal — and you lose both the specialist's rigor and the held-out honesty the portfolio is built
on. Keep it above the line and it does the one job nothing else can.

## One contract, every tool and every model

"Similar for all tools and LLMs" is the load-bearing requirement: `dwarf_forge` is only worth
building if **every** specialist plugs in the same way. Two interfaces, uniform across the fleet:

- **Downward (specialist-facing).** Each tool exposes a small, typed surface: *what can I answer,
  what input do I take, what does my output mean, how confident am I.* Hornet, a signal classifier,
  and a future tool all describe themselves identically, so the router can choose between them
  without special-casing.
- **Upward (narrative-facing).** Whatever the specialist emits — a move ranking, a score, an
  embedding — comes back up as the same shape: a claim, its evidence, its source, its confidence.
  The human reads one consistent format no matter which tool spoke.

The router is the piece in the middle: given a question and the fleet's self-descriptions, pick the
specialist (or none), call it, and lift its output through the upward contract.

## Worked example — Hornet

Hornet is a four-player chess engine whose learned move-prediction is benchmarked with strict
held-out discipline (top-1 / top-3 human-move match on a never-tuned holdout). `dwarf_forge` does
not play chess and does not touch that benchmark. Its job is meta:

1. **Route.** A question like *"what kind of player is this?"* is recognized as a Hornet question and
   routed to it; a question about the user's own memory is routed to the vault instead.
2. **Read.** Hornet returns its numeric output — predicted moves, evaluations, per-player tendencies.
3. **Reason in narrative.** The LLM turns that into a *personality pattern*: aggressive early, folds
   under two-front pressure, over-values the queen. This is narrative reasoning over a specialist's
   numbers, not a second engine.
4. **Write back, governed.** The finding lands on the blackboard as a **derived, rejectable** claim —
   source-stamped to `dwarf_forge`, tagged as inferred, and overridable by the human, exactly like
   any synthesis in the vault.

The same four steps describe every other tool the fleet ever gains. Hornet is just the first
specialist that exercises the contract end to end.

## Governance — the meta-layer is a steward, not an authority

`dwarf_forge` inherits [AGENTS.md](../AGENTS.md) in full; routing power is not special power.

- **The human is root.** The router proposes and explains; the human keeps the veto and the stop
  button. A meta-analysis is a suggestion, never a decision.
- **Derived and rejectable.** Everything the LLM infers is tagged as inferred and can be rejected —
  the same rule that governs vault synthesis. A confident narrative is still just a claim.
- **Provenance is preserved.** `dwarf_forge` stamps its own findings and cannot reassign the source
  of a specialist's output. The chain from raw number to narrative claim stays legible.
- **Trust is tiered; assume breach.** A specialist's output is data to be examined, not an
  instruction to be obeyed. A misbehaving tool — or a misbehaving router — must stay contained and
  observable, never trusted on its own word.
- **Measure, don't assert.** The router's *own* value (did routing help? was the narrative faithful
  to the numbers?) is held to the portfolio standard: evaluated on held-out cases, never tuned on
  the holdout.

## What this is not

Not a shipped capability, not a roadmap commitment, and not a bigger brain bolted onto the vault.
It is the disciplined, governed *shape* of the routing-and-review layer — held as a hypothesis under
the same adversarial standard as everything else here, so that if it is ever built, it is built
right.
