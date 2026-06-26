---
name: whitebox
description: Portable user memory. Read and write the user's WhiteBox vault — identity, working style, observations from past conversations, projects, relationships. Use when starting a session, when the user mentions someone or something by name, or when you want to record something the user just said.
trigger:
  - "what do you know about me"
  - "who am i"
  - "remember"
  - "save this"
  - "you should know"
---

# WhiteBox skill

The user has a WhiteBox vault — a folder of plain markdown files holding everything any AI has learned about them, owned by them, portable across every agent they use. You read and write to it via the `whitebox-mcp` server.

## When to use this skill

- **First message of a session.** Pull the orientation pack so you know who you're talking to.
- **User names a person, project, or place.** Check `relationships/` and `projects/` for context.
- **User states a preference, correction, or fact about themselves.** Save it as an observation.
- **You want to look up something.** Use `grep` instead of re-reading whole files.
- **Conflict surfaces.** Run `list_conflicts` at session start; if anything's pending, mention it briefly so the user can decide whether to resolve.

## Tools

The MCP server exposes:

- `bootstrap(include_observations?)` — orientation pack: AGENTS.md, identity.md, working-style.md, tags.md, plus the most recent N observations (default 8). Cheapest way to know who the user is.
- `read_file(path)` — read a vault-relative file. For specific lookups when you know the path.
- `list_files(subdir?)` — enumerate `.md` files. For discovery.
- `grep(pattern, scope?, ignore_case?, context?, max_results?)` — regex search. `scope` = `observations` (default, active memory) | `conversations` (passive transcripts) | `all`. Use this before re-reading whole files.
- `append_observation(source, tags, confidence, body, date?)` — write a new observation. Required when you learn something durable about the user. The body must be **verbatim** — direct quote of the user's words or your own words the user affirmed. Never paraphrase, summarize, or invent.
- `propose_stable_edit(target, edit)` — propose a change to a stable file (identity.md, working-style.md, relationships/*, projects/*). Goes to `proposed/` for the user to review and apply manually. Never silently overwrite stable files.
- `list_conflicts()` — list observations tagged `conflict` so the user can resolve them.

## Self-automation pattern

You own your context-management loop. Don't wait to be asked. Each turn, briefly self-audit:

1. **Do I have what I need?** If you're about to confidently answer a question about a person/project/preference and you haven't checked the vault, check it (`grep` or `read_file`).
2. **Am I missing something obvious?** If the user mentioned a context (`Odin`, `code review for Maya`), and you don't have notes on it, fetch.
3. **Did the user just teach me something?** If yes, save it via `append_observation`. Use the compact acknowledgment format: `{saved memory: <vault-relative-path> time:HH:MM}` — one line in your reply per file written.

The bootstrap is a starter pack, not a contract. You can ignore it and discover what you need on your own; both paths are legitimate.

## Discipline

These rules come from `AGENTS.md` in every WhiteBox vault. They are not suggestions:

- **Verbatim bodies.** Observation bodies are direct quotes. If the worthy content is long, save it as `sources/<filename>.md` and link via `source_ref:` in a short observation.
- **Anti-characterization.** Tag for behavior or topic, never for character. `tags: [working-style, correction]` ✓. `tags: [abrasive, demanding]` ✗. The body might be the same verbatim quote; the difference is in how you file it. This is borrowed from clinical-note conventions and prevents **character drift** — your reaction to the user contaminating how the user is represented in storage.
- **Never edit another agent's observation.** Append your own. For suspected wrong facts, write a new observation tagged `conflict`.
- **Never silently overwrite stable files.** Use `propose_stable_edit`.
- **Idle-stability.** Before saving autonomously, check if the observation actually adds anything. If it just restates what's already there, skip the save.

## Confidence scale

Five grades:

- `very-low` — fleeting impression, weak evidence
- `low` — possibly true, one data point, matches a pattern
- `medium` — probably true, consistent across moments
- `high` — clearly stated by user or observed repeatedly
- `very-high` — explicitly confirmed or identity-level

Pick honestly. `very-high` is rare.

## Acknowledging autonomous saves

When you call `append_observation` on your own (without asking the user first), tell the user with one compact line per file:

```
{saved memory: observations/2026-04.md time:14:23}
```

Use the path the tool returned. The browser extension renders this as a clickable pill so the user can audit. Never use this for saves the user explicitly asked for — those are obvious.

## Two memory layers

- **Active memory** — `identity.md`, `working-style.md`, `tags.md`, `observations/`, optional `relationships/`, `projects/`, `sources/`. Curated, signal-dense. This is what `bootstrap` returns and what you typically want.
- **Passive memory** — `conversations/`. Auto-logged conversation transcripts. NOT loaded at session start. Only browse on demand when the user asks you to dig through old conversations. Use `grep --scope=conversations` for this.

Don't auto-promote from passive to active. Promotion is always a deliberate act with the user.

## Worked example

User says: *"Anyway, I prefer one-step-at-a-time over big plans up front."*

Self-audit: this is a clear preference, identity-shaping, hadn't seen it before. Save.

```
append_observation(
  source: "claude-code",
  tags: ["working-style", "preference"],
  confidence: "high",
  body: "I prefer one-step-at-a-time over big plans up front."
)
```

Reply to user: *"Got it — one step at a time. {saved memory: observations/2026-04.md time:14:23}"*

## Where to learn more

- The vault always has an `AGENTS.md` — that's the canonical instructions. Read it once per session.
- The schema lives in the project repo at `spec/WHITEBOX_v1.1.md`.
- Per-source guardrails (when the user has limited what each agent can do) live in `docs/GUARDRAILS.md`.
