# WhiteBox canonical tags — v1

A small, opinionated, community-curated list of tags that most WhiteBox vaults will use. Opt-in. Versioned. Additive-only like the schema.

## Why a canonical list

Tags only deliver value when they mean the same thing across vaults and agents. If your `working-style` means something different from mine, cross-vault analysis breaks, agents trained on WhiteBox-shaped data drift, and future tooling (dashboards, analytics, the eventual Obsidian inspector plugin) can't reason about tags semantically.

The canonical list gives us a shared vocabulary. Your local `tags.md` inherits from it and adds anything specific to your life. You stay in control; the community provides a baseline so you don't have to invent every tag from scratch.

## How your local `tags.md` relates to this file

- Your local `tags.md` is still the source of truth *for your vault.*
- By convention, the Active section of your `tags.md` starts with (a subset of) the canonical tags below.
- You add personal tags in your own Active section as needed.
- You can omit any canonical tag you don't find useful — this isn't a mandate.

## v1 tag list

### Always canonical (the small hard core)

- `working-style` — how the user wants to be worked with (pace, register, pushback, tone)
- `preference` — stated likes and dislikes on topics other than working style
- `correction` — the user corrected the agent
- `conflict` — the observation contradicts an existing stable fact or other observation
- `interest` — things the user is curious about or actively engaged with

### Namespaced tags (colon-separated)

Namespaces extend a single concept to many instances without polluting the flat tag list.

- `relationship:<name>` — observations specific to a named person (e.g. `relationship:alex`)
- `project:<slug>` — observations tied to a named project (e.g. `project:my-project`)
- `framework:<slug>` — observations about a specific intellectual framework (e.g. `framework:vector-bias`)
- `scope:<name>` — pins an observation to a named scope from `scopes.md`

### Contextual tags (optional, broadly useful)

- `health` — medical, sleep, energy, mood as it affects capacity
- `emotional-state` — temporary mood, stress, conversational context
- `goals` — stated long-term goals, intentions, aspirations
- `skill` — demonstrated or stated capability
- `knowledge` — domain expertise the agent should be aware of

### Agent-interaction tags

- `verbatim-rule` — observation relates to how agents should write to the vault
- `about-ai` — user's stance on AI systems, their limitations, their behavior

## Proposing new canonical tags

A tag belongs in the canonical list if:

- **Generality.** At least three different WhiteBox users would plausibly use it, not just one person's niche.
- **Semantic distinctness.** It isn't already covered by an existing canonical tag.
- **Stability.** It names a concept that won't need renaming in six months.

To propose:

1. Open a GitHub Discussion in the `Tag proposals` category with:
   - The tag name.
   - A one-sentence description.
   - Three example observations that would use it (hypothetical is fine).
   - Why existing tags don't cover it.
2. Discussion collects feedback. Maintainers or a small council approves or refines.
3. Approved tags are added in the next minor version (v1.1, v1.2, etc.).

Users don't need to wait for canonicalization — your local `tags.md` can have whatever tags you want. The canonical list just captures what the community has converged on.

## Namespacing conventions

- Use `<namespace>:<value>` — colon-separated, lowercase, kebab-case on both sides.
- Prefer namespaces over flat tags when you'd otherwise have many variants of a concept (e.g. use `project:my-project` not `my-project-engine` + `my-project-docs` + `my-project-work`).
- Common namespaces in this spec: `relationship:`, `project:`, `framework:`, `scope:`. Others may emerge; propose via the same process.

## Deprecation

Tags in the canonical list are additive-only. v1.x will never remove a tag. If a tag turns out to be a bad idea, it gets marked deprecated in a future version but kept in the list so old vaults don't break. Users gradually migrate; the canonical list documents the migration path.

## Versioning

This document defines `tags-canonical/1.0`. A user's `tags.md` may optionally declare which version it inherits from:

```yaml
---
schema: whitebox/1.0
tags_canonical: tags-canonical/1.0
---
```

Tooling can use this to detect when a canonical-list update is available and offer to sync.

## Relationship to the schema

The schema (WHITEBOX_v1.0 / v1.1) specifies *how tags are stored and used.* This document specifies *which tags mean what.* They evolve independently — new canonical tags don't require a schema version bump.

## Governance (as of v1.0)

- Maintainer: FreyjaNellora (BDFL for now).
- Decisions made in public GitHub Discussions.
- Changes batched into minor versions.
- No private approval; all proposals visible to all users.

When the community is large enough to warrant it, governance evolves to a small council. Documented here when it changes.
