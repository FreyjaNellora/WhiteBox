/**
 * Inline vault templates. Kept as string constants so the CLI ships as a
 * single npm package without extra data directories.
 */

export const AGENTS_MD = `# WhiteBox vault — orientation for agents

This directory is a user-memory vault in WhiteBox/1.1 format. The user owns these files. Multiple agents read and write here. Coordinate by following the rules below.

Full spec: \`spec/WHITEBOX_v1.1.md\` in the project repo.

## Two memory layers

This vault has two parallel memory systems:

- **Active memory** (loaded at session start): \`identity.md\`, \`working-style.md\`, \`tags.md\`, \`observations/\`, optional \`relationships/\`, \`projects/\`, \`sources/\`. Curated, signal-dense, indexed by topic. This is what you read to know the user.
- **Passive memory** (\`conversations/\`): auto-logged conversation transcripts. NOT loaded at session start. Browse on demand only when the user asks you to dig through old conversations.

These are independent. Active is not derived from passive. Don't auto-promote.

## At session start

1. Read \`identity.md\` and \`working-style.md\`.
2. Skim the latest file in \`observations/\`.
3. If the user names a person or project, check \`relationships/\` and \`projects/\`.
4. If \`scopes.md\` exists and a scope is active for this session, do not read outside it.
5. Do NOT auto-load \`conversations/\` — only access it when the user explicitly asks.

## Discipline — three rules

### 1. Verbatim body

When you append an observation, the body MUST be a direct quote — the user's words or your own words the user affirmed. Never paraphrase, summarize, or invent. If the worthy content is long (over ~500 chars), save the full text as a \`sources/<filename>.md\` file and write a short observation that quotes a key passage and references the source via \`source_ref:\`.

### 2. Anti-characterization (behavior, not trait)

Tags and confidence describe observable behavior, not character traits or your interpretation of the user. Borrowed from clinical note-taking conventions: describe what was said or done, not what kind of person the user is.

\`\`\`
WRONG:  tags: [abrasive, demanding]
RIGHT:  tags: [working-style, correction]
\`\`\`

The body might be the same verbatim quote. The difference is in how you file it. This prevents **character drift** — the failure mode where your reaction to the user contaminates how the user is represented in stored memory.

### 3. Extract-not-summarize on retrospective recall

When the user asks you to dig through \`conversations/\` files, surface direct quotes with file references. Do not summarize unsupervised. Reading the file directly is more reliable than letting you summarize. Invite the user to read along.

## When to capture proactively

You may call \`append_observation\` on your own, without the user asking, when:

- The user has just stated a clear preference, correction, or fact about themselves.
- A pattern is repeating across turns that you didn't know before.
- The user is wrapping up (good moment to propose a digest).

When uncertain, ask the user. At natural endpoints, propose 0-3 candidates for review.

**When you save an observation autonomously (without asking first), acknowledge it in your reply with this exact compact tag format:**

\`\`\`
{saved memory: <vault-relative-path> time:HH:MM}
\`\`\`

Example: \`{saved memory: observations/2026-04.md time:14:23}\`

One line, parseable, cheap on tokens. Use the path \`append_observation\` returned. One tag per file written. Tooling may render the tag as a clickable link.

## Observation format

Append one entry per observation to \`observations/YYYY-MM.md\`:

\`\`\`markdown
---
date: YYYY-MM-DD
source: <your agent or model name>
tags: [tag1, tag2]
confidence: very-low | low | medium | high | very-high
source_ref: sources/<file>.md   # optional, for long captures
context: <situational scope>    # optional
---

Direct verbatim quote from the conversation.
\`\`\`

Confidence scale (five grades): very-low (fleeting), low (possible), medium (probable), high (clear), very-high (explicit / identity-level).

Optional \`context:\` for context-dependent observations (e.g. \`context: coding-conversations\`) that would otherwise look like conflicts. Describes situational scope, not character.

## Idle-stability — don't bloat what works

Before autonomous \`append_observation\`, check: does this observation contradict, refine, or add to anything in the existing vault? If it just restates known content, skip the save. Raise the bar during stable periods (when the user hasn't been correcting you); save aggressively when learning something new.

## Rules summary

- Never edit another agent's observation. Append your own.
- Never silently overwrite a stable file. For suspected wrong facts, write an observation tagged \`conflict\`.
- Prefer tags from \`tags.md\`; append new ones with \`status: proposed\`.
- Tag for behavior or topic, never for character or judgment.
- Respect the active scope if one is set.
- Never fabricate. When uncertain, ask the user or skip the capture.
- Never auto-promote from passive to active — promotion is always a deliberate human-or-agent-with-user-approval act.

## File chunking

Any file in this vault may grow large enough to be chunked. Convention is consistent across file types: append \`-part-N.md\` to the basename (e.g., \`observations/2026-04-part-1.md\`, \`observations/2026-04-part-2.md\`). Each chunk has \`group_id\` (shared across parts) and \`part: N\` in frontmatter. Default chunk threshold ~40,000 chars of body, sized to fit a 32K-token context window with room to spare. Read parts independently; tooling enumerates by glob.
`;

export const IDENTITY_MD = `---
schema: whitebox/1.0
---

# Identity

Stable, long-lived facts about who I am. Edit freely.

- Name:
- Pronouns:
- Location:
- Occupation / role:
- Active projects: see \`projects/\`
- Significant people: see \`relationships/\`
- Areas of focus / expertise:
- Things I'm not (common misreads to avoid):
`;

export const WORKING_STYLE_MD = `---
schema: whitebox/1.0
---

# Working style

How I want AI agents to work with me. Read this before responding.

## Pace

(e.g., one step at a time, or full plans up front)

## Register

(e.g., direct and terse, no softening, no trailing summaries)

## Pushback

Do I want agents to push back when they disagree with me? When?

## Corrections

How do I typically signal that an agent got something wrong?

## What I find unhelpful

(e.g., hedging, over-caveating, mirroring my vocabulary, sandwich feedback)

## What I find helpful

(e.g., concise, opinionated, willing to argue, plain language)
`;

export const TAGS_MD = `---
schema: whitebox/1.0
---

# Tags

Canonical tags for observations in this vault. Agents prefer tags from the Active list when writing observations. New tags proposed by agents appear under Proposed — curate them on your own schedule.

## Active

- \`working-style\` — how the user wants to be worked with
- \`correction\` — user corrected the agent
- \`preference\` — stated likes and dislikes
- \`relationship:<name>\` — observations specific to a named person
- \`project:<slug>\` — observations tied to a named project
- \`health\` — medical, sleep, energy, mood relevant to capacity
- \`emotional-state\` — temporary mood, stress, context
- \`interest\` — things the user is curious about or engaged with
- \`conflict\` — observations that contradict an existing stable fact

## Proposed

(agents append here)
`;

export function observationsHeader(monthLabel: string): string {
  return `# Observations — ${monthLabel}

Append-only. One observation per entry. Never edit another agent's entries.
`;
}

export const README_MD = `# My WhiteBox vault

This folder is your portable user memory for AI agents. It's a set of plain markdown files that any AI you use — Claude, ChatGPT, Gemini, Cursor, whatever — can read at the start of a session and write to when you or it decide something is worth remembering. Your memory is on your disk, in files you can open in any text editor. Nothing leaves your machine unless you explicitly sync it.

## What's in here

- **\`AGENTS.md\`** — a set of instructions any AI reads first. Tells it what this folder is, how to write observations, what the rules are (notably: verbatim only, never paraphrase or invent). You probably never need to touch this unless you're tuning how agents behave around your vault.
- **\`identity.md\`** — stable facts about who you are. Name, pronouns, what you do, who matters to you, what you're working on. Edit this freely. Short is better than long — agents read it every session.
- **\`working-style.md\`** — how you want agents to work with you. Pace, register, pushback, what you find unhelpful. Also edit freely; also short is better.
- **\`tags.md\`** — list of tags agents use to categorize observations. Comes seeded with a handful of useful ones. Add your own when agents propose new ones under Proposed.
- **\`observations/\`** — append-only monthly logs (\`2026-04.md\`, \`2026-05.md\`, etc.). Each entry is a short fenced block with a date, which agent wrote it, tags, confidence, and the observation body. This is where your vault grows as you use AI.
- **\`relationships/\`** — optional. One file per significant person in your life. Helps agents give context-aware answers when you mention someone by name.
- **\`projects/\`** — optional. One file per active project. Same idea — ambient context so agents don't need re-explaining.
- **\`sources/\`** — optional, v1.1. Longer verbatim captures (full assistant responses) live here; a short extract in \`observations/\` links back via \`source_ref\`.

## How it actually works

When you start a conversation with any AI that WhiteBox is connected to:

1. The agent reads \`AGENTS.md\`, \`identity.md\`, and \`working-style.md\` before responding, so it knows who you are and how you want to be worked with.
2. It skims the latest \`observations/YYYY-MM.md\` file for recent context other agents have captured.
3. When you say something worth remembering — or when the agent notices something worth remembering about you — a new entry gets appended to \`observations/\`.

There are three ways to write entries:

- **You edit by hand.** Open any file in your editor. Type. Save. Done.
- **You click Capture in the browser extension.** On a supported site (claude.ai, chatgpt.com, gemini.google.com), click the WhiteBox icon → **Capture last response** or **Session digest…**. Review what gets saved, pick tags, hit Save.
- **The AI writes directly.** If the AI is connected via MCP (Claude Desktop, Claude Code, Cursor, Gemini CLI), it can call the \`append_observation\` tool on its own when it hears something memorable. It will usually ask first.

## How to use it

**Step one, today:** open \`identity.md\` and \`working-style.md\` in your editor and fill them in with actual content about you. A paragraph or two each is plenty. These get read every session; keep them dense.

**Step two, as you use AI:** when a conversation produces a moment worth keeping — a correction, a stated preference, a useful synthesis — capture it via the WhiteBox extension (if you're on a browser) or ask the AI to save it (if you're on Claude Desktop or similar). Don't try to capture everything; let the vault grow from moments that actually matter.

**Step three, occasionally:** open \`observations/<current-month>.md\` and skim. Agents may have written things you want to edit, re-tag, or delete. The vault is yours; edit freely.

**Step four, when your life changes:** update \`identity.md\` and \`working-style.md\`. New job, new city, new project, new habit. Stale stable facts are worse than missing ones.

## A note on privacy

Nothing in this folder is shared with any AI vendor by default. The files are on your disk. Agents read them when you explicitly connect them (via MCP, the browser extension, or a paste-in). They never sync to a remote server unless you set that up yourself (git, Syncthing, iCloud, Obsidian Sync — pick one).

If you want parts of the vault kept out of certain agents, use scopes. Create a \`scopes.md\` file and a \`sensitive/\` folder (or similar named folder per scope). Agents given a session scope of \`public\` won't read outside the public scope.

## If something feels wrong

- An observation is wrong? Edit it. It's your file.
- An agent keeps referencing something outdated? Update \`identity.md\` or \`working-style.md\` to override.
- An agent made something up? That violates the verbatim-only rule. Delete the entry and flag it in a conversation — the agent should correct its pattern.
- You want to start fresh? Delete everything. Run \`whitebox init\` again. No state outside this folder.

## Where to go for help

- The project repo has a QUICKSTART, CONTRIBUTING, COMMUNITY guide, and FAQ-style docs.
- The schema for how all this works is at \`spec/WHITEBOX_v1.md\` in the project repo.
- If you're stuck, paste this README plus your question into any AI you trust and it will walk you through the specific step.

You own this. Go use it.
`;
