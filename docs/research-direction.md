# Research direction (high-level)

This is a deliberately high-level statement of where the work points. It is **speculative and
parked** relative to the shipping product; the near-term discipline is to *ship the substrate, not
the brain*.

The long-range direction treats the user-owned substrate as the coordination hub of a **blackboard
architecture**: independent agents contribute to and draw from a shared, audited store, with
routing, consolidation, and review layered around it (the routing/review layer is sketched in
[dwarf-forge.md](dwarf-forge.md)). The interesting research questions are about
*governance and verification* of such a system — how independent, possibly non-aligned components
can be composed so that the whole remains trustworthy and its failures are contained and
observable — rather than about raw capability. We hold this direction honestly: it is a hypothesis
under disciplined scoping, not a roadmap commitment.

## Methodological rigor (portfolio)

Our approach to evidence-based evaluation is visible in related work — for example the
[Hornet four-player chess engine](https://github.com/FreyjaNellora/Hornet), whose learned
move-prediction is benchmarked with strict held-out discipline (top-1/top-3 human-move match
against a never-tuned holdout). We apply the same standard to security claims: *measure it, don't
assert it; never tune on the holdout.*
