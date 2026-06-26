# WhiteBox

[![CI](https://github.com/FreyjaNellora/WhiteBox/actions/workflows/ci.yml/badge.svg)](https://github.com/FreyjaNellora/WhiteBox/actions/workflows/ci.yml)

**A portable, transparent, multi-agent identity substrate for AI.** Plain markdown files on your disk that your AIs read, write to, and collaboratively maintain — across Claude, ChatGPT, Gemini, Cursor, Kimi, and anything else that speaks the spec. One identity, every session, every vendor. No black-box memory. No vendor lock-in. No model of you that you can't read.

> **Status:** `v1.0.0-prealpha.6` — v1 design feature-complete and audited (30+ security and correctness fixes landed in April 2026). v1.1 design (synthesis tier, weighted promotion, swarm coordination, search) in active development. Expect breakage and iteration; not yet validated by external users.

> **Just want to install it?** If you're not a developer, the friendliest path is **[INSTALL_FOR_FRIENDS.md](INSTALL_FOR_FRIENDS.md)** — five minutes, no terminal, no Node.js, no command-line. Just download a folder, load the browser extension, and walk through a wizard.

---

## The problem

Every AI agent builds its own model of you, locked inside its own walled system. Switch from ChatGPT to Claude — start over. Use Gemini at work and Claude at home — they don't share. Your "AI memory" is split across N vendors, each carrying a partial, opaque, vendor-owned representation of who you are. The longer you use AI, the more locked-in you become — not to one agent, but to every one of them, separately.

WhiteBox breaks that pattern. The model of you lives on **your disk**, in **plain markdown**, **maintained by your AIs together**, with **you as the final authority** at every layer.

## How it works (the river-and-ants frame)

The architecture has a useful natural metaphor:

- **The river** = the flow of observations into your vault over time. Every conversation drops more water. The river only flows forward (append-only). Each AI agent is a tributary.
- **The watersheds** = vaults. Separate folders on disk that don't mix unless you explicitly grant access. Personal here, work-acme there, client-12345 in its own basin.
- **The ants** = the agents. They forage (read), they build (write observations), they leave pheromone trails on what proves useful (access reinforcement), other ants follow strong trails. They never talk directly — they coordinate through what they leave for each other in the shared environment.
- **Periodic reorganization** = the swarm steps back from foraging to rebuild a coherent map of "what we collectively know about this person." That map (the **synthesis**) is what new agents boot from.

This is technically a stigmergic system — the same pattern that drives Wikipedia, ant colonies, and other decentralized collective-intelligence systems. WhiteBox is its application to AI memory.

## The five invariants (the discipline)

Every design choice in WhiteBox tests against *"is this what the sloppy vendors do?"* If yes, do the opposite. These five are non-negotiable:

1. **You own the disk.** No mode of operation requires uploading the vault. Cloud features (if they ever ship) are optional adapters, never core.
2. **Plain text, schema-defined.** Every file in the vault is markdown / YAML readable in any editor. The schema is the contract — anything implementing it can read your vault.
3. **Append-only with full audit.** Both writes AND reads are audited. Any change is reconstructible from the log; any agent decision can be traced to the state it was reading.
4. **Multi-agent collaborative, single-authority override.** Agents do the curation. You have the veto on every layer (observations, syntheses, scopes, source trust).
5. **Synthesis is derived and rejectable.** Anything an agent infers or condenses about you lives in its own tier with `derived_from` provenance. You can reject, edit, or accept it into your own curated files.

## What we explicitly don't do (that other vendors do)

| Sloppy pattern | Our discipline |
|---|---|
| Memory in vendor walls (ChatGPT memory, Claude projects, Gemini memory) | Vault on **your** disk; vendor reads, never owns |
| Each vendor builds a siloed model of you | One shared vault all agents read and contribute to |
| Silent memory edits — discover later | Append-only + audit log; every change recoverable |
| Sycophancy amplified by personalization | Verbatim quotes only on observations; cross-source corroboration before promotion |
| "I remember you mentioned X" with no provenance | Every entry has `source`, `date`, `confidence` — agent can cite chapter and verse |
| Multi-tenant memory cross-leaks | Single-tenant by design; plain files; no shared backend |
| Memory grows forever; no demotion when you change | Recency decay + demotion loop + staleness review |
| Vendor-specific opaque schema | Published spec; plain markdown; anyone can implement |
| Summaries silently replace what you said | Verbatim invariant on observations; synthesis is a separate tier you can reject |
| One bucket — work AI sees personal context | Scopes are first-class; agents see only what their scope grants |
| Privacy = vendor promise | Privacy = you control the disk |
| Profile drift never corrected | Periodic synthesis with explicit user override |
| Export is theater (broken format, undocumented) | Export IS the format — the disk file is the export |

This table is the project's reviewer checklist. Every PR has to land on the right side of it.

---

## Where WhiteBox fits in the landscape

The "user-owned markdown + AI reads it" design space is now crowded with serious players. Where each diverges:

- **[Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)** — Markdown knowledge base about *the world*. WhiteBox is complementary: LLM Wiki for knowledge, WhiteBox for identity.
- **[OpenBrain (OB1)](https://github.com/NateBJones-Projects/OB1)** — PostgreSQL + pgvector + MCP. Database-backed memory with semantic search. Different storage philosophy. WhiteBox wins when you want zero infrastructure and files you can open in any editor.
- **Anthropic's Import Memory + Claude Code `memory.md`** — Markdown memory inside the Claude ecosystem. Official and well-integrated, but Claude-only. WhiteBox is cross-vendor from day one.
- **[Letta (formerly MemGPT)](https://docs.letta.com/concepts/memgpt/)** — Closest architectural cousin: agent self-edits memory tiers via function calls. WhiteBox uses the same self-edit philosophy but stores in your filesystem rather than Letta's hosted DB.
- **mem0 / ChatGPT Memory / Claude Memory / Rewind** — Vendor-owned or service-hosted memory with embeddings + opaque extraction. [docs/COMPARISON.md](docs/COMPARISON.md) has the full breakdown.

**WhiteBox's specific wedge:** the **only** project centered on multi-agent coordination over a single user-owned vault, with verbatim discipline, source attribution, weighted cross-source promotion, and a published schema other tools can implement. Optimized for the case where 3+ AI agents (different vendors, different sessions, different time horizons) write to the same vault about the same person over months and years.

---

## Quick install

WhiteBox has three independent components. Install whichever you'll actually use; they all read/write the same vault folder.

### 1. Create your vault (always do this first)

```bash
git clone https://github.com/FreyjaNellora/WhiteBox.git
cd WhiteBox/whitebox-cli
npm install && npm run build
node bin/whitebox.js init ~/whitebox-vault
```

This creates `~/whitebox-vault` with `AGENTS.md`, `identity.md`, `working-style.md`, `tags.md`, and an empty `observations/` folder. Open `identity.md` and `working-style.md` in your text editor and add a few sentences about who you are. Five minutes is enough.

### 2. Install the MCP server (for Claude Desktop / Claude Code / Cursor / Gemini CLI)

```bash
cd ../whitebox-mcp
npm install && npm run build
```

Then add to your MCP client config (e.g. `~/.config/Claude/claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["/absolute/path/to/WhiteBox/whitebox-mcp/dist/index.js"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "/absolute/path/to/whitebox-vault"
      }
    }
  }
}
```

Restart your MCP client. You should see seven WhiteBox tools available: `bootstrap`, `read_file`, `list_files`, `grep`, `append_observation`, `propose_stable_edit`, `list_conflicts`.

### 3. Install the browser extension (for claude.ai, chatgpt.com, gemini.google.com)

Open `chrome://extensions` (or the equivalent in your Chromium browser):
1. Toggle **Developer mode** on (top right).
2. Click **Load unpacked** and select the `whitebox-extension/` folder from this repo.
3. Pin the WhiteBox icon to your toolbar.
4. Click the icon → **Open setup…** and grant access to your vault folder.

Pick a style on first run (Office / Engineer / Gamer-Modder). Open `claude.ai/new` — your first message will automatically include vault context, and the agent will know who you are.

### 4. (Optional) Install the Claude Code skill

```bash
mkdir -p ~/.claude/skills
cp -r claude-code-skills/whitebox ~/.claude/skills/
```

Teaches Claude Code about the WhiteBox tool surface, the discipline rules, and the self-automation pattern.

---

## Use cases — the purgability principle

Real users layer multiple vaults by **ownership and lifespan**, separated at the folder level so cleanup is a single physical action (`rm -rf`), not a fuzzy query. A typical layout:

```
~/whitebox/
  personal/                    ← yours forever
  work/
    company-acme/              ← bounded to that employer; rm -rf when you leave
      projects/odin/           ← bounded to that project
  clients/
    case-12345/                ← per-case privilege boundary (lawyers)
```

**Lawyer.** One vault per matter. Privilege boundaries are *physical*: there is no path by which client A's AI can read client B's data, because it's a different folder it has no handle to. Personal vault holds your professional identity (specialization, brief style, courtroom voice). Survives every matter closure.

**Engineer.** Per-employer vault for codebase knowledge, internal jargon, deployment lore. Personal vault for your professional self ("prefers TypeScript", "burned out in 2024 — watch for early signs"). Job change = `rm -rf work/company-acme/`. Your professional identity survives every employer.

**Executive Assistant / Secretary.** Per-principal vault for the executive you support. The principal's medical/family info lives in *their* vault, with you granted scoped read. New boss = swap principal vault. Your own continuity persists.

**Project work.** The project gets its own vault, owned collectively by the team (possibly synced via git). Multiple agents read it, contribute observations. Synthesis tier produces the "current state of the project" any new team member or new agent boots from.

The architecture makes the right thing easy and the wrong thing impossible — your work AI was never granted access to your personal vault, so it can't accidentally leak personal context. Quitting a job doesn't reset your personal AI.

---

## What you get after install

- **A vault** of markdown files you own, on your disk, openable in any text editor.
- **The same vault read by every AI you use** — Claude Desktop, Claude Code, Cursor, Gemini CLI via MCP; claude.ai / chatgpt.com / gemini.google.com via browser extension.
- **A marker protocol** the agent emits in browser chats (`{wb-fetch:}`, `{wb-scope:}`, `{wb-bootstrap}`, `{wb-save}…{/wb-save}`, `{wb-context:}`) that becomes clickable pills in the UI so every action is auditable.
- **A floating HUD** showing vault state, conflicts, lock status, agent bypass tier, danger badges.
- **In-page help bubble** with a 24-page wikibook + hover tooltips. Press the popup's `Help` link to open on any page.
- **A vault lock with passphrase** (UX gate today; AES-GCM encryption planned).
- **Per-trigger danger toggles** — lock on screen lock / idle / tab close / browser exit, each independently configurable.
- **Agent bypass tiers** for what the agent can do while the vault is locked.
- **An autonomous-write audit log** at `audit/YYYY-MM-DD.md`. Every save is one line; bypass-permitted writes are annotated.
- **Source-stamping** so agents can't lie about which platform they came from.
- **Optional passive auto-log** of full conversations to `conversations/YYYY-MM-DD/<id>-part-N.md`, chunked at 40K chars.

For the full setup walkthrough see [QUICKSTART.md](QUICKSTART.md). For everything WhiteBox does and doesn't do, see [docs/GUARDRAILS.md](docs/GUARDRAILS.md). To uninstall (your vault folder is never touched), see [UNINSTALL.md](UNINSTALL.md).

---

## Architecture in three layers

The vault has observations + identity files + scopes + audit log today. The full design adds three layers on top:

- **Layer 1 — Aggregation primitives.** Weighted promotion (`Σ confidence × source_trust × recency_decay`), recency decay (30-day half-life default), cross-source corroboration (≥2 distinct sources required for stable-fact promotion), demotion of stale facts. *Pure functions in `whitebox-shared` — landed in v1.1 development.*
- **Layer 2 — Swarm coordination.** Access pheromones (read-side audit reinforcing useful items), role-aligned per-agent bootstrap, reactions tier (agents annotate observations without violating append-only), `vault_health` introspection, asymmetric scope grants (the foundation of the purgability principle), `vault_search` (BM25 + tags + recency + pheromone composer). *In active development.*
- **Layer 3 — Synthesis tier.** Multi-agent collaborative profile-building. Agents periodically generate condensed "current state of the user" syntheses to `synthesized/profile-YYYY-MM-DD.md`. Triggered by new-observation volume, fact demotion, life-event tags, or tag-distribution shifts — not by schedule. Bootstrap injects the latest synthesis once one exists. *Designed; implementation queued.*

Full design with research citations: [docs/DESIGN.md](docs/DESIGN.md).

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the bar and [docs/COMMUNITY.md](docs/COMMUNITY.md) for the softer welcome and good-first-contribution list. Selector updates for the browser extension, integration recipes for new tools, canonical tag proposals, and spec implementations in other languages are the easiest first PRs.

---

## What's in this repo

### Specs

- [spec/WHITEBOX_v1.md](spec/WHITEBOX_v1.md) — frozen schema 1.0
- [spec/WHITEBOX_v1.1.md](spec/WHITEBOX_v1.1.md) — current spec (passive + active memory layers, source/extract split, vault-wide chunking)
- [spec/tags-canonical-v1.md](spec/tags-canonical-v1.md) — shared tag vocabulary

### Reference content

- [vault-example/](vault-example/) — reference vault showing the format in practice
- [vault-example/AGENTS.md](vault-example/AGENTS.md) — the bootloader any agent reads first

### Tools

- [whitebox-shared/](whitebox-shared/) — Shared TypeScript library: vault core, path security, scope parser, observation parser, recency decay, weighted promotion (cross-source corroboration).
- [whitebox-mcp/](whitebox-mcp/) — MCP server. Tools: `bootstrap`, `read_file`, `list_files`, `grep`, `append_observation`, `propose_stable_edit`, `list_conflicts`.
- [whitebox-cli/](whitebox-cli/) — CLI. Commands: `init`, `export`, `paste`, `conflicts`, `log`, `grep`, `diagnostics`.
- [whitebox-extension/](whitebox-extension/) — Chromium browser extension. Bootstrap injection, marker protocol with clickable pills, floating HUD with style presets, vault lock + agent bypass + danger toggles, in-page help wikibook, opt-in passive auto-log, observation capture, session digest.
- [claude-code-skills/whitebox/](claude-code-skills/whitebox/) — Claude Code skill packaging.

### Documentation

- [QUICKSTART.md](QUICKSTART.md) — end-to-end setup walkthrough (also AI-parseable)
- [docs/GUARDRAILS.md](docs/GUARDRAILS.md) — what WhiteBox protects, per-source permission tiers, lock + bypass semantics
- [docs/PITCH.md](docs/PITCH.md) — product pitch
- [docs/DESIGN.md](docs/DESIGN.md) — design rationale + research citations
- [docs/COMPARISON.md](docs/COMPARISON.md) — WhiteBox vs mem0 / Letta / ChatGPT Memory / Claude Memory / Rewind
- [docs/EDITOR_GUIDE.md](docs/EDITOR_GUIDE.md) — using the vault with Obsidian / VS Code / Typora
- [docs/STRATEGY.md](docs/STRATEGY.md) — adversarial resilience
- [docs/ADOPTION.md](docs/ADOPTION.md) — GTM sequencing
- [docs/PRICING.md](docs/PRICING.md) — freemium split
- [docs/MARKETING.md](docs/MARKETING.md) — recruitment + launch plan
- [docs/COMMUNITY.md](docs/COMMUNITY.md) — contributor welcome + good-first list
- [docs/VALIDATION.md](docs/VALIDATION.md) — end-to-end test log
- [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md) — what still needs user validation
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution bar
- [CHANGELOG.md](CHANGELOG.md) — release history

### Archive

- [_old-design/](_old-design/) — earlier exploratory drafts, kept for reference

---

## Roadmap

### Shipped

- **v0.1–v0.3** — Schema, MCP server, CLI, browser extension scaffold, community infrastructure.
- **v1.0.0-prealpha** (current, `.6`) — Marker protocol, MCP bootstrap/grep, vault lock + per-trigger danger toggles, agent bypass tiers, source stamping, audit log, in-page help wikibook, passive auto-log (browser, opt-in), observation capture with source-ref discipline, Claude Code skill packaging.
- **April 2026 audit pass** — 30+ security and correctness fixes across MCP, CLI, shared library, and extension. Symlink TOCTOU closed, scope bypass closed, atomic audit ordering, observation race fixed, manifest hardening, etc. 126/126 tests passing.

### In active development (v1.1 design)

- **Layer 1: Aggregation primitives** — weighted promotion (✅ landed in `whitebox-shared/src/promotion.ts`), recency decay (✅ landed in `whitebox-shared/src/recency.ts`), cross-source corroboration (✅), demotion / staleness review (queued).
- **Layer 2: Swarm coordination** — access pheromones, role-aligned bootstrap, `vault_health`, asymmetric scope grants, `vault_search` (BM25 + tags + recency + pheromone composer).
- **Layer 3: Synthesis tier** — multi-agent collaborative profile-building, trigger-based re-synthesis, demotion review.

### Next milestones

- **v1.0.0-alpha** — v1.1 design layer 1+2 implemented. First external testers. *Target: Summer 2026.*
- **v1.0.0-beta** — Synthesis tier shipped. Chrome Web Store listing. Per-source guardrails enforced. *Target: Late 2026.*
- **v1.0.0** — Production-ready. Vault encryption (AES-GCM for `sensitive/`). Obsidian inspector plugin.

### Post-v1.0

- **v1.1+** — SSE transport for MCP (unlocks ChatGPT Desktop), DXT extension package for Claude Desktop, VS Code / Logseq plugins, mobile companion app, optional sync infrastructure (clearly opt-in, vault stays canonical).

---

## Why now

- AI agents are proliferating. Users are using several at once. Memory lock-in is the next moat providers will build, and most users won't notice until they want to leave.
- Model Context Protocol gives a standard transport for the Claude ecosystem, with Gemini CLI native and ChatGPT Desktop adding partial support.
- Obsidian and similar markdown-vault tools have made user-owned local files mainstream enough to build on.
- No existing product owns this space — mem0, Letta, Rewind, Personal.ai all ship vendor silos with "portable" only as marketing language. [docs/COMPARISON.md](docs/COMPARISON.md) has the receipts.

---

## Status

**Pre-alpha (`v1.0.0-prealpha.6`).** Cross-vendor injection works on claude.ai, chatgpt.com, gemini.google.com from the same local vault. MCP server serves reads and writes live in Claude Desktop / Code / Cursor / Gemini CLI. Browser extension shipping marker protocol, floating HUD, vault lock, agent bypass tiers, audit log, in-page help. CLI commands working. Claude Code skill packaged. April 2026 audit pass closed 30+ security and correctness findings; v1.1 design layers in active development.

Validated by the maintainer. **Not yet validated by external users.** Actively seeking first testers — see [docs/MARKETING.md](docs/MARKETING.md).
