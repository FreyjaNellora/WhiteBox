# WhiteBox vault — orientation for agents

This directory is a user-memory vault in WhiteBox/1.1 format. The user owns these files. Multiple agents read and write here. Coordinate by following the rules below.

Full spec: `spec/WHITEBOX_v1.1.md` in the project repo.

## Two memory layers

This vault has two parallel memory systems:

- **Active memory** (loaded at session start): `identity.md`, `working-style.md`, `tags.md`, `observations/`, optional `relationships/`, `projects/`, `sources/`. Curated, signal-dense, indexed by topic. This is what you read to know the user.
- **Passive memory** (`conversations/`): auto-logged conversation transcripts. NOT loaded at session start. Browse on demand only when the user asks you to dig through old conversations.

These are independent. Active is not derived from passive. Don't auto-promote.

## At session start

1. Read `identity.md` and `working-style.md`.
2. Skim the latest file in `observations/`.
3. If the user names a person or project, check `relationships/` and `projects/`.
4. If `scopes.md` exists and a scope is active for this session, do not read outside it.
5. Do NOT auto-load `conversations/` — only access it when the user explicitly asks.

## Discipline — three rules

### 1. Verbatim body

When you append an observation, the body MUST be a direct quote — the user's words or your own words the user affirmed. Never paraphrase, summarize, or invent. If the worthy content is long (over ~500 chars), save the full text as a `sources/<filename>.md` file and write a short observation that quotes a key passage and references the source via `source_ref:`.

### 2. Anti-characterization (behavior, not trait)

Tags and confidence describe observable behavior, not character traits or your interpretation of the user. Borrowed from clinical note-taking conventions: describe what was said or done, not what kind of person the user is.

```
WRONG:  tags: [abrasive, demanding]
RIGHT:  tags: [working-style, correction]
```

The body might be the same verbatim quote. The difference is in how you file it. This prevents **character drift** — the failure mode where your reaction to the user contaminates how the user is represented in stored memory and biases all future agent behavior.

### 3. Extract-not-summarize on retrospective recall

When the user asks you to dig through `conversations/` files, surface direct quotes with file references. Do not summarize unsupervised. An honest answer looks like:

> Looking at `conversations/2026-04-15-claude-ai-design-part-2.md`, around the middle:
>
> > [verbatim quote]
>
> Reading the file directly is more reliable than my summary. Want me to pull more passages or do you want to read it first?

Summarizing the archive without showing your sources is exactly the failure mode of *faithfulness hallucination*. Don't do it.

## When to capture proactively

You may call `append_observation` on your own, without the user asking, when:

- The user has just stated a clear preference, correction, or fact about themselves.
- A pattern is repeating across turns that you didn't know before.
- The user is wrapping up the conversation (good moment to propose a digest).

When uncertain whether something is worth saving, ask the user. At natural endpoints, optionally propose 0-3 observation candidates for review.

**When you save an observation autonomously (without asking first), acknowledge it in your reply with this exact compact tag format:**

```
{saved memory: <vault-relative-path> time:HH:MM}
```

For example:

```
{saved memory: observations/2026-04.md time:14:23}
```

One line, structured, parseable. Cheaper on tokens than prose. The browser extension and other tooling may render this tag as a clickable link to the file. Use the path the `append_observation` tool returned to you in its success message; if multiple files were written in one batch, emit one tag per file. Silent autonomous writes erode trust; visible autonomous writes build it.

## Observation format

Append one entry per observation to `observations/YYYY-MM.md`:

```markdown
---
date: YYYY-MM-DD
source: <your agent or model name>
tags: [tag1, tag2]
confidence: very-low | low | medium | high | very-high
source_ref: sources/<file>.md   # optional, for long captures
context: <situational scope>    # optional, see below
---

Direct verbatim quote from the conversation.
```

Confidence scale (five grades):

- `very-low` — fleeting impression, weak evidence.
- `low` — possibly true, one data point.
- `medium` — probably true, consistent across moments.
- `high` — clearly stated by the user or observed repeatedly.
- `very-high` — explicitly confirmed, identity-level claim.

**Optional `context:` field** for context-dependent observations that would otherwise look like conflicts. If the user has different preferences in different situations (terse in coding, elaborate in creative), use `context:` to record the scope where this observation applies (`context: coding-conversations`, `context: when-tired`). Anti-characterization still applies — `context:` describes the situation, not character traits.

## Idle-stability — don't bloat what works

Before calling `append_observation` autonomously, check: does this observation actually contradict, refine, or add to anything in the existing identity / working-style / observations? If it just restates what's already there, skip the save. New observations earn their place by adding signal.

If you've been getting through conversations without the user correcting you, that's evidence your model of them is good enough. Raise the bar for autonomous saves during stable periods. Save aggressively when you're being corrected or learning something new.

## Rules summary

- Never edit another agent's observation. Append your own.
- Never silently overwrite a stable file. For suspected wrong facts, write an observation tagged `conflict` and let the user resolve it.
- Prefer tags from `tags.md`; append new ones with `status: proposed`.
- Tag for behavior or topic, never for character or judgment.
- Respect the active scope if one is set.
- Never fabricate. When uncertain, ask the user or skip the capture.
- Never auto-promote from passive to active — promotion is always a deliberate human-or-agent-with-user-approval act.

## What's in this vault

| Path | Purpose | Layer |
|---|---|---|
| `AGENTS.md` | This file | — |
| `identity.md` | Stable facts about the user | active |
| `working-style.md` | How the user wants to be worked with | active |
| `tags.md` | Tag registry | active |
| `observations/YYYY-MM.md` | Curated monthly log | active |
| `sources/<file>.md` | Verbatim archive of long captures referenced by observations | active |
| `relationships/<name>.md` | Optional, one file per significant person | active |
| `projects/<slug>.md` | Optional, one file per active project | active |
| `scopes.md` | Optional, named scopes | — |
| `conversations/<date>-<source>-<slug>-part-N.md` | Auto-logged conversation transcripts | passive |

## File chunking

Any file in this vault that grows past ~40,000 characters of body content gets split into multiple files following the `-part-N.md` convention (e.g., `observations/2026-04-part-1.md`, `observations/2026-04-part-2.md`). Each chunk has frontmatter with `group_id` (shared across parts) and `part: N`. Tooling enumerates parts by glob; you can read a single chunk without needing all of them. The 40K target keeps each chunk small enough to fit in even a 32K-token context window with room to spare. See the spec for detail.
