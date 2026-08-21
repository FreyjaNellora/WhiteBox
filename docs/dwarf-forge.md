# dwarf_forge — the verification / routing / review layer

> **Scope.** This is a design statement for the layer that [research-direction.md](research-direction.md)
> calls "routing, consolidation, and review." It is **speculative and parked** relative to the
> shipping product — the near-term discipline remains *ship the substrate, not the brain*. Written
> down so the shape is agreed before any of it is built, and updated as the direction sharpens.

## The one-line idea

`dwarf_forge` is a **verification-and-review layer** over the user-owned blackboard: a set of small
models and executable checks used to *route* a question to the right tool, *verify* what comes back,
and *narrate* it for a human — never a specialist that does the underlying work itself. The load-bearing
bet, sharpened since the first draft, is that **verification, not generation, is the moat**: the durable
advantage is a cheap, honest way to tell a right answer from a plausible one, and everything else is
built around that.

## Why verification is the center

Generation is a commodity — models get cheaper and better on someone else's schedule. What compounds,
and what you can own, is the ability to *check*. Three commitments follow:

1. **Execution is the gate.** Wherever a claim can be settled by *running something* rather than asking
   a model to judge, it is. A candidate answer is checked against a reference behavior over a bounded
   input domain — an executable oracle — not accepted on a model's say-so. Where an answer can be
   *executed*, execution outranks any amount of confident narration.
2. **A ladder of decorrelated checks.** No single test is trusted. A claim runs a stack of independent
   proof obligations — worked examples, invariants/properties, relational (metamorphic) consistency,
   and cross-implementation differential agreement — that fail in *different* ways. Passing one is weak
   evidence; surviving several decorrelated frames is strong. Agreement between checks that share a
   blind spot is worth little, so the checks are chosen to *not* share blind spots.
3. **Decorrelation beats count.** A committee of near-identical models is barely better than one — they
   are wrong on the same inputs. The lever is **decorrelation** (a genuinely different mode, or
   different weights, or an execution-grounded check), not headcount. Adding more of the same buys
   almost nothing; adding one truly different perspective can recover what the whole pool missed.

These are held to the portfolio's evidence standard — *measure it, don't assert it; never tune on the
holdout* — and validated on **real small local models** (the kind that run on a normal PC), because a
lever that only shows up with a frontier model isn't a lever you own.

## Why an LLM belongs *here* and nowhere below

The division of labor by what each kind of system is actually good at is unchanged:

| Layer | Does | Example |
|---|---|---|
| **Specialists** (narrow ML / tools) | The narrow task, with numeric output and held-out discipline. | [Hornet](https://github.com/FreyjaNellora/Hornet) predicts moves; [Mycelium](../mycelium/README.md) walks a link-graph; a classifier scores a signal. |
| **`dwarf_forge`** (small models + checks) | Routes to a specialist; **verifies** its output; reasons *about* it in narrative. Does **not** do the specialist's job. | Confirms a result survives the check ladder; explains *why* a line is strong; consolidates findings. |
| **The blackboard** ([WhiteBox](../README.md) / ChatBox) | Holds the audited, source-stamped record everything reads and writes. | The vault; the coordination channel. |

An LLM is strong at exactly the things this layer needs — **routing** (pick the right tool), **meta-analysis
and verification** (interpret and *check* other tools' outputs without redoing their work), and **narrative
reasoning** (turn a verified pattern into a readable story) — and weak at everything the specialists own.
Put it below this line — asking it to actually play the chess, actually classify the signal — and you lose
both the specialist's rigor and the held-out honesty the portfolio is built on. Keep it above the line, with
execution as the tie-breaker, and it does the one job nothing else can.

## Where this is heading — the owned asset

The long game is **not a bigger model**. It is a *compounding, user-owned pair*: a sharpening **verifier**
(the check ladder) and a growing **corpus** of verified episodes. Given those two, a modest open model can
be **post-trained** — on hardware you own — to internalize what the verifier already knows, learning from
its *verified failures* as much as its wins. The moat is the verifier and the corpus; the model is
replaceable. That ordering — earn the verifier first, train second — is deliberate: an optimizer pointed at
a verifier you haven't hardened will learn to fool it, so the check ladder is stress-tested *before* it is
ever used as a training signal.

## Governance — the meta-layer is a steward, not an authority

`dwarf_forge` inherits [AGENTS.md](../AGENTS.md) in full; routing and verification power is not special power.

- **The human is root.** The layer proposes, verifies, and explains; the human keeps the veto and the stop
  button. A verdict is a suggestion with evidence attached, never a decision.
- **Derived and rejectable.** Everything inferred is tagged as inferred and can be rejected — the same rule
  that governs vault synthesis. A passing check ladder raises confidence; it does not confer authority.
- **Provenance is preserved.** The layer stamps its own findings and cannot reassign the source of a
  specialist's output. The chain from raw number, through the checks it survived, to narrative claim stays
  legible.
- **Trust is tiered; assume breach.** A specialist's output — and a model's verdict — is data to be examined,
  not an instruction to be obeyed. A misbehaving tool, model, or check must stay contained and observable.
  This is exactly why verification is decorrelated: so no single compromised component is believed on its
  own word.
- **Measure, don't assert.** The layer's *own* value (did routing help? did the checks catch what they
  should? was the narrative faithful to the verified result?) is held to the portfolio standard: evaluated
  on held-out cases, never tuned on the holdout.

## What this is not

Not a shipped capability, not a roadmap commitment, and not a bigger brain bolted onto the vault. It is the
disciplined, governed *shape* of the verification-and-review layer — held as a hypothesis under the same
adversarial standard as everything else here, so that if it is ever built, it is built right.
