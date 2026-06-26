# WhiteBox Schema v1.0

The canonical specification for a WhiteBox memory vault. Any agent implementing this spec can read and write to a vault produced by any other agent that implements it.

This spec is the moat. It is intentionally small and intentionally frozen. Schema v2 may add fields; it will never remove or rename them.

## Design principles

1. **Plain markdown + YAML frontmatter.** No binary formats, no databases, no embeddings as source of truth.
2. **Human-readable first.** Any file in a WhiteBox vault must be meaningful to a user opening it in a text editor.
3. **Additive evolution.** Schema versions only add. A v1 vault remains valid in a v2 world.
4. **Inspectable always.** Derived indexes (search caches, graph databases, learned policies) are recomputable from the markdown and never canonical.
5. **No required tooling.** Every operation in this spec can be performed by hand in a text editor.

## Two entry types

### Stable facts

Long-lived, resolved truths about the user. One truth per claim. Contradictions need resolution.

- Live in: top-level files (`identity.md`, `working-style.md`) or named subfolders (`relationships/<name>.md`, `projects/<slug>.md`).
- Format: normal markdown with optional YAML frontmatter.
- Editing: the user edits freely. Agents may propose edits but should not silently overwrite. To dispute a stable fact, an agent writes an observation tagged `conflict`.

### Observations

Append-only notes from agents about the user. Contextual; contradictions are preserved, not resolved.

- Live in: `observations/YYYY-MM.md` (one file per month).
- Append only. Never edit another agent's observation.
- Patterns emerge from accumulation. The "truth" of a contextual claim is whatever falls out of reading the observation log over time.

Required frontmatter on each observation:

```yaml
---
date: YYYY-MM-DD
source: <agent or model name>
tags: [<tag>, ...]
confidence: low | medium | high
---
```

Body: one paragraph. What was learned, in what context. Aim for under 100 words per observation.

Observations within a monthly file are separated by `---` (horizontal rules). Order is chronological.

## Tags

A `tags.md` file at the vault root is the canonical tag registry.

```markdown
# Tags

## Active
- `tag-name` — short description of what this tag is for

## Proposed
- `agent-suggested-tag` — description (status: proposed)
```

Rules for agents:

- Prefer tags from the Active list.
- If no existing tag fits, append the new tag to Proposed with `status: proposed` and a one-line description.
- Do not delete or rename tags in other agents' observations. The user curates.

Tag values may include namespaces with `:`, e.g. `relationship:alex` or `project:my-project`.

## Scopes

Optional. If `scopes.md` exists at vault root, it declares named scopes and which folders each scope includes.

```markdown
# Scopes

- `public` — root files only
- `work` — root + `projects/`
- `personal` — root + `relationships/`
- `sensitive` — `sensitive/` (never served by default)
```

The active scope for a session is set by the host application (MCP client, system prompt, CLI flag). Agents must not read or write files outside the active scope.

If no `scopes.md` exists, the default scope is the entire vault.

## Promotion

When several observations of consistent content and matching tags accumulate, an agent may propose promoting them to a stable fact.

- Default threshold: three matching observations of `confidence: medium` or higher.
- Promotion requires user approval unless the vault's `scopes.md` (or a separate `promotion.md`) explicitly authorizes auto-promotion within named scopes.
- A promoted fact is written to the appropriate stable file. The originating observations remain in place — they are not deleted.

## File layout

A minimal valid vault:

```
vault/
  AGENTS.md              ← bootloader, read first by any agent
  identity.md            ← stable facts about the user
  working-style.md       ← how the user wants to be worked with
  tags.md                ← tag registry
  observations/
    YYYY-MM.md           ← append-only monthly logs
```

Optional additions:

```
vault/
  relationships/<name>.md
  projects/<slug>.md
  scopes.md
  sensitive/             ← scope-restricted folder
```

## What this spec does not define

- The user's editor or app — vaults work in Obsidian, VS Code, plain text editors, or no editor at all.
- The transport between agent and vault — MCP, filesystem, paste-in, browser extension, all valid.
- Retrieval strategy — each agent decides what to load and when. The spec defines format, not behavior.
- Wikilinks or graph structure — `[[wikilink]]` and standard markdown links are both supported, neither required.
- Versioning of vault contents — git, Syncthing, iCloud, none. User's choice.

## Versioning

This document defines schema version `1.0`. Each markdown file in a vault may declare its schema version in frontmatter:

```yaml
schema: whitebox/1.0
```

Files without a declared version are assumed to be the latest version the vault was created under. A `whitebox.toml` or similar at vault root may set the default.

## Reserved frontmatter fields

The following frontmatter keys are reserved by the spec and should not be used for other purposes by tools:

- `schema` — schema version declaration
- `date` — observation timestamp
- `source` — observation author (agent/model identifier)
- `tags` — observation or stable-fact tags
- `confidence` — observation confidence level
- `status` — used in `tags.md` for tag lifecycle (`active`, `proposed`, `deprecated`)
- `scope` — restricts a file to a specific scope

All other frontmatter keys are free for tools and users to define.
