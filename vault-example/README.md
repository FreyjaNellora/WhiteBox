# My WhiteBox vault

This folder is your portable user memory for AI agents. It's a set of plain markdown files that any AI you use — Claude, ChatGPT, Gemini, Cursor, whatever — can read at the start of a session and write to when you or it decide something is worth remembering. Your memory is on your disk, in files you can open in any text editor. Nothing leaves your machine unless you explicitly sync it.

## What's in here

- **`AGENTS.md`** — a set of instructions any AI reads first. Tells it what this folder is, how to write observations, what the rules are (notably: verbatim only, never paraphrase or invent). You probably never need to touch this unless you're tuning how agents behave around your vault.
- **`identity.md`** — stable facts about who you are. Name, pronouns, what you do, who matters to you, what you're working on. Edit this freely. Short is better than long — agents read it every session.
- **`working-style.md`** — how you want agents to work with you. Pace, register, pushback, what you find unhelpful. Also edit freely; also short is better.
- **`tags.md`** — list of tags agents use to categorize observations. Comes seeded with a handful of useful ones. Add your own when agents propose new ones under Proposed.
- **`observations/`** — append-only monthly logs (`2026-04.md`, `2026-05.md`, etc.). Each entry is a short fenced block with a date, which agent wrote it, tags, confidence, and the observation body. This is where your vault grows as you use AI.
- **`relationships/`** — optional. One file per significant person in your life. Helps agents give context-aware answers when you mention someone by name.
- **`projects/`** — optional. One file per active project. Same idea — ambient context so agents don't need re-explaining.
- **`sources/`** — optional, v1.1. Longer verbatim captures (full assistant responses) live here; a short extract in `observations/` links back via `source_ref`.

## How it actually works

When you start a conversation with any AI that WhiteBox is connected to:

1. The agent reads `AGENTS.md`, `identity.md`, and `working-style.md` before responding, so it knows who you are and how you want to be worked with.
2. It skims the latest `observations/YYYY-MM.md` file for recent context other agents have captured.
3. When you say something worth remembering — or when the agent notices something worth remembering about you — a new entry gets appended to `observations/`.

There are three ways to write entries:

- **You edit by hand.** Open any file in your editor. Type. Save. Done.
- **You click Capture in the browser extension.** On a supported site (claude.ai, chatgpt.com, gemini.google.com), click the WhiteBox icon → **Capture last response** or **Session digest…**. Review what gets saved, pick tags, hit Save.
- **The AI writes directly.** If the AI is connected via MCP (Claude Desktop, Claude Code, Cursor, Gemini CLI), it can call the `append_observation` tool on its own when it hears something memorable. It will usually ask first.

## How to use it

**Step one, today:** open `identity.md` and `working-style.md` in your editor and fill them in with actual content about you. A paragraph or two each is plenty. These get read every session; keep them dense.

**Step two, as you use AI:** when a conversation produces a moment worth keeping — a correction, a stated preference, a useful synthesis — capture it via the WhiteBox extension (if you're on a browser) or ask the AI to save it (if you're on Claude Desktop or similar). Don't try to capture everything; let the vault grow from moments that actually matter.

**Step three, occasionally:** open `observations/<current-month>.md` and skim. Agents may have written things you want to edit, re-tag, or delete. The vault is yours; edit freely.

**Step four, when your life changes:** update `identity.md` and `working-style.md`. New job, new city, new project, new habit. Stale stable facts are worse than missing ones.

## A note on privacy

Nothing in this folder is shared with any AI vendor by default. The files are on your disk. Agents read them when you explicitly connect them (via MCP, the browser extension, or a paste-in). They never sync to a remote server unless you set that up yourself (git, Syncthing, iCloud, Obsidian Sync — pick one).

If you want parts of the vault kept out of certain agents, use scopes. Create a `scopes.md` file and a `sensitive/` folder (or similar named folder per scope). Agents given a session scope of `public` won't read outside the public scope.

## If something feels wrong

- An observation is wrong? Edit it. It's your file.
- An agent keeps referencing something outdated? Update `identity.md` or `working-style.md` to override.
- An agent made something up? That violates the verbatim-only rule. Delete the entry and flag it in a conversation — the agent should correct its pattern.
- You want to start fresh? Delete everything. Run `whitebox init` again. No state outside this folder.

## Where to go for help

- The project repo has a QUICKSTART, CONTRIBUTING, COMMUNITY guide, and FAQ-style docs.
- The schema for how all this works is at `spec/WHITEBOX_v1.md` in the project repo.
- If you're stuck, paste this README plus your question into any AI you trust and it will walk you through the specific step.

You own this. Go use it.
