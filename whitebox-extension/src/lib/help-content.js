/**
 * Help bubble content. Structured as a flat array of pages so it can
 * render as a wikibook-style sidebar + content pane.
 *
 * Each page: { id, category, title, body }
 * - body uses a tiny markdown-ish syntax (rendered by formatHelpBody in
 *   the bubble): paragraphs separated by blank lines, ## headings,
 *   - or * for bullet lists, `code` inline, ``` fenced blocks, [link](url).
 *
 * No external dependencies — content lives inline so the extension ships
 * with no extra fetch.
 */

export const HELP_CATEGORIES = [
  { id: "start", label: "Get started" },
  { id: "vault", label: "Vault" },
  { id: "agents", label: "Agents & tools" },
  { id: "safety", label: "Lock & safety" },
  { id: "ui", label: "Interface" },
  { id: "tools", label: "Other tools" },
  { id: "trouble", label: "Troubleshooting" },
];

export const HELP_PAGES = [
  // ─── Get started ─────────────────────────────────────────────────────
  {
    id: "what-is-whitebox",
    category: "start",
    title: "What is WhiteBox?",
    body: `WhiteBox is portable user memory for AI agents. Plain markdown files on your disk that any agent — Claude, ChatGPT, Gemini, Cursor — can read and write to. Your memory is yours, lives on your machine, and travels with you across every AI you use.

The whole product is built around a small spec. Anything that speaks the spec can read your memory. Anything that doesn't, can be made to with a thin adapter.

## Why it exists

Every AI agent builds its own model of you, locked inside its own vendor's system. Switch from ChatGPT to Claude, you start over. WhiteBox breaks that — your memory follows you.`,
  },
  {
    id: "first-time-setup",
    category: "start",
    title: "First-time setup",
    body: `1. Install the WhiteBox browser extension (you've done this).
2. Click the WhiteBox icon → "Open setup…" → choose a folder on your disk to be your vault. The folder needs an \`AGENTS.md\` file (use \`whitebox init\` from the CLI to create one with the right files).
3. Pick a style: Office (calm, light) / Engineer (dense, dark) / Gamer-Modder (always-on HUD).
4. Open \`identity.md\` and \`working-style.md\` in your text editor. Fill them in with a few sentences about who you are and how you want agents to work with you.
5. Open a new chat on claude.ai. The extension automatically prepends your vault context to the first message. The agent now knows you.

That's it. From there, when you say something durable about yourself, the agent can save it to your vault and any other agent on any other platform will see it next time.`,
  },
  {
    id: "two-memory-layers",
    category: "start",
    title: "Active vs passive memory",
    body: `Your vault has two parallel memory systems:

## Active memory
Loaded at session start. \`identity.md\`, \`working-style.md\`, \`tags.md\`, \`observations/\`, optional \`relationships/\`, \`projects/\`, \`sources/\`. This is curated, signal-dense, indexed by topic. It's what agents read to know you.

## Passive memory
\`conversations/\` — auto-logged conversation transcripts. NOT loaded at session start. Agents only browse this when you explicitly ask them to dig through old conversations. Off by default; opt-in via popup.

These layers are independent. Active is not derived from passive. Promotion from passive → active is always a deliberate act.`,
  },

  // ─── Vault ───────────────────────────────────────────────────────────
  {
    id: "vault-layout",
    category: "vault",
    title: "Vault layout",
    body: `Your vault folder contains:

- **AGENTS.md** — instructions any AI reads first. House rules.
- **identity.md** — stable facts about you (name, pronouns, what you do).
- **working-style.md** — how you want agents to work with you.
- **tags.md** — vocabulary for categorizing observations.
- **observations/** — append-only monthly logs. \`2026-04.md\`, \`2026-05.md\`, etc. Each entry is a short fenced block with date, source agent, tags, confidence, and a verbatim quote.
- **relationships/** — optional, one file per significant person.
- **projects/** — optional, one file per active project.
- **sources/** — optional, longer captures with short observation extracts.
- **scopes.md** — optional, defines named scopes for selective vault access.
- **conversations/** — passive auto-log (only if enabled). Date-organized, chunked at 40K chars.
- **audit/** — autonomous-write log. One file per day showing what agents wrote.
- **proposed/** — pending edits to stable files awaiting your manual review.`,
  },
  {
    id: "verbatim-rule",
    category: "vault",
    title: "The verbatim rule",
    body: `The most important discipline rule in the spec.

When an agent writes an observation, the body must be a **direct quote** — your words, or the agent's own words you affirmed. Never paraphrased, summarized, or invented.

If the worthy content is long (over ~500 chars), the full text gets saved as a \`sources/<filename>.md\` file and a short observation in the monthly file references it via \`source_ref:\`.

This rule prevents **character drift** — the failure mode where the agent's reaction to you contaminates how you're represented in stored memory. If every observation is a quote you can recognize, you can audit it. If they're paraphrases, you can't.`,
  },
  {
    id: "anti-characterization",
    category: "vault",
    title: "Anti-characterization (BIRP)",
    body: `Tags and confidence describe observable **behavior**, not character traits or interpretations of you.

Borrowed from clinical note-taking conventions (BIRP — Behavior, Intervention, Response, Plan): describe what was said or done, not what kind of person someone is.

\`\`\`
WRONG:  tags: [abrasive, demanding]
RIGHT:  tags: [working-style, correction]
\`\`\`

The body might be the same verbatim quote. The difference is in how it's filed. This rule is the second line of defense against character drift — the first is verbatim bodies.`,
  },
  {
    id: "confidence-scale",
    category: "vault",
    title: "Confidence scale",
    body: `Five grades, additive and bidirectional:

- **very-low** — fleeting impression, weak evidence
- **low** — possibly true, one data point, matches a pattern
- **medium** — probably true, consistent across moments
- **high** — clearly stated by you or observed repeatedly
- **very-high** — explicitly confirmed or identity-level claim

Pick honestly. \`very-high\` is rare. The agent should err on the lower end when uncertain — easier to promote later than to recall a confident-but-wrong observation.`,
  },

  // ─── Agents & tools ──────────────────────────────────────────────────
  {
    id: "marker-protocol",
    category: "agents",
    title: "The marker protocol",
    body: `In a browser session (claude.ai), the agent doesn't have direct tool calls. Instead it emits **markers** in its replies — special-format tags the WhiteBox extension reads and acts on. Each marker becomes a clickable pill in the UI so you can audit what happened.

## Read markers (pull data into the conversation)
- \`{wb-fetch: <vault-relative-path>}\` — pull a specific file. Example: \`{wb-fetch: projects/odin.md}\`.
- \`{wb-scope: <name>}\` — switch to a scope from \`scopes.md\`; returns a manifest of files in that scope.
- \`{wb-bootstrap}\` — re-deliver the orientation pack mid-conversation.

## Write marker (commit to the vault)
- \`{wb-save}…{/wb-save}\` — append an observation. Body inside is YAML frontmatter (tags, confidence, optional context) + \`---\` separator + verbatim quote.

## Telemetry
- \`{wb-context: <text>}\` — narrate a workflow shift, render-only.
- \`{saved memory: <path> time:HH:MM}\` — acknowledge a save that happened through MCP.

There is a one-turn latency on read markers — the result appears at the top of your next message. The browser channel is what you're paying for.`,
  },
  {
    id: "self-automation",
    category: "agents",
    title: "Self-automation pattern",
    body: `The agent owns its own context-management loop. WhiteBox provides the substrate (markers in browser, MCP tools elsewhere); the agent decides policy in real time.

Each turn the agent should briefly self-audit:
1. Do I have what I need? If not, fetch.
2. Am I missing something obvious? If yes, fetch.
3. Did the user just teach me something durable? If yes, save.

The bootstrap is a starter pack, not a contract. The agent can use it OR set it aside and discover what it needs on its own. Both paths are legitimate.

This is borrowed from "lights-out factory" thinking — the system supplies what's needed, collects what's needed, builds the product, with context window to spare. The agent runs the line; you set the policy.`,
  },
  {
    id: "mcp-tools",
    category: "agents",
    title: "MCP tools (Desktop, Code, Cursor)",
    body: `For agents connected via MCP (Claude Desktop, Claude Code, Cursor, Gemini CLI), the WhiteBox MCP server exposes direct tool calls — no marker round-trip needed.

- \`bootstrap(include_observations?)\` — orientation pack
- \`read_file(path)\` — read a specific vault file
- \`list_files(subdir?)\` — enumerate \`.md\` files
- \`grep(pattern, scope?, ignore_case?, context?, max_results?)\` — regex search across observations and/or conversations
- \`append_observation(source, tags, confidence, body, date?)\` — write
- \`propose_stable_edit(target, edit)\` — propose a change to a stable file (goes to \`proposed/\` for manual review)
- \`list_conflicts()\` — list observations tagged \`conflict\`

Install the Claude Code skill at \`claude-code-skills/whitebox/\` for skill-based packaging.`,
  },

  // ─── Lock & safety ───────────────────────────────────────────────────
  {
    id: "vault-lock",
    category: "safety",
    title: "Session gate & passphrase",
    body: `Set a passphrase to gate your session. Once set, the session gates on browser close (and on lock-screen events, if enabled).

## Auto-gate triggers
Each is independently toggleable in popup → Session Gate:
- **Gate when I lock my screen** (default ON)
- **Gate after idle for N minutes** (default OFF; configurable)
- **Gate when all WhiteBox tabs close** (default OFF)
- **Remember open across browser restarts** (default OFF, ⚠ DANGER)

Toggling any safety off requires confirmation. The popup header and the floating HUD show a red ⚠ DANGER badge whenever any safety is reduced.

## Phase 1 vs Phase 2
Phase 1 (now) is a UX gate — files stay plaintext on disk, lock blocks operations. Phase 2 (later) will add AES-GCM encryption underneath the same primitive without changing the UX.`,
  },
  {
    id: "agent-bypass",
    category: "safety",
    title: "Agent bypass tiers",
    body: `What the agent can still do while the session is gated from your perspective. Set in popup → Agent bypass.

Tiers (least to most permissive):
- **none** (default) — session gated = agent locked.
- **reads-only** — agent can fetch / scope / bootstrap / read_file / grep, but no writes.
- **reads-and-safe-writes** — above + \`{wb-save}\` with confidence ≤ medium.
- **full-bypass** ⚠ — agent has full latitude even when gated. Marked DANGER.

Auto-expire timer: optional (1h / 4h / 8h / 24h / never). Resets to \`none\` after the window. Bypass changes require the session to currently be open.

The HUD shows a purple \`BYPASS: <tier>\` badge whenever bypass is anything other than \`none\` (red for full-bypass).

## Use case
You're going to bed. You want Claude Code to keep working autonomously through the night, writing low-confidence saves as it goes, but you don't want it doing anything identity-shaping while you're not watching. Set bypass to \`reads-and-safe-writes\` with a 8-hour auto-expire. Wake up to an audit log of what happened.`,
  },
  {
    id: "scope-of-safety",
    category: "safety",
    title: "What WhiteBox protects (and what it doesn't)",
    body: `WhiteBox is responsible for **vault integrity** and **user control**. We are explicitly NOT responsible for content moderation.

## In scope
- Path traversal blocked (agent can't write outside vault)
- Stable files protected (\`identity.md\`, \`working-style.md\` etc. require user review via \`proposed/\`)
- Append-only observation writes (no overwriting other agents' entries)
- Source stamping (extension and MCP override agent-declared source with the authoritative platform)
- Session gate + agent bypass tiers (you decide what the agent can do when the session is gated)
- Per-trigger danger toggles (you decide what auto-locks the vault)
- Audit log (every autonomous write is logged for review)
- Optional rate limit (default unlimited)

## Not in scope
**Content moderation.** What you say to your AI is between you and the LLM provider (Anthropic, OpenAI, Google). Their safety layers handle the conversation; by the time content reaches WhiteBox for storage, those decisions have already been made. We don't second-guess what you record about yourself — that would override your right to your own data.

If something doesn't belong in your vault, delete it. The files are plain markdown; you control them.`,
  },
  {
    id: "audit-log",
    category: "safety",
    title: "Audit log",
    body: `Every successful autonomous write appends one line to \`audit/YYYY-MM-DD.md\` in your vault. Format:

\`\`\`
2026-04-22T03:14:11Z kind=wb-save source=claude.ai tags=[working-style,preference] confidence=high target=observations/2026-04.md via=bypass(reads-and-safe-writes) safety=reduced
\`\`\`

The \`via=bypass(...)\` annotation appears when the operation only succeeded because of an elevated bypass tier. \`safety=reduced\` annotates writes that happened while any safety toggle was below default.

Optional verbose mode (popup → Safety → Audit log verbosity) also logs reads.

Use this for weekly review: open today's audit file in your editor and skim what agents did. If anything looks off, find the corresponding observation and edit / delete.`,
  },
  {
    id: "rate-limit",
    category: "safety",
    title: "Save rate limit (optional)",
    body: `Per-browser-session cap on autonomous saves. Default: **unlimited**.

The principle is to trust the agent and rely on tier-based guardrails (lock + bypass), not arbitrary numerical caps. A cap is opt-in only — set one if a specific source has shown runaway behavior.

Configure in popup → Safety. Options: unlimited / 5 / 10 / 25 / 50.`,
  },

  // ─── Interface ───────────────────────────────────────────────────────
  {
    id: "style-presets",
    category: "ui",
    title: "Style presets",
    body: `Pick once on first run; editable later in popup → Style.

- **Office** (default) — calm, light, low-density. HUD only appears as a brief toast when something is saved.
- **Engineer** — info-dense, dark, CLI hints. Slim persistent HUD.
- **Gamer / Modder** — always-on HUD, dark, advanced controls expanded by default.

The style affects HUD density and theme but not vault behavior. Switching is non-destructive.`,
  },
  {
    id: "hud",
    category: "ui",
    title: "Floating HUD on claude.ai",
    body: `Draggable position, persisted across reloads. States:
- **idle** — gray dot, no activity
- **recording** — orange pulsing, passive log is on
- **saved** — green flash, just wrote an observation
- **warn** — amber, something failed (rate limit, crisis block, etc.)

Badges that may appear:
- 🔒 LOCKED — vault is currently locked
- BYPASS: \`<tier>\` — agent has elevated permissions while locked (purple, red for full-bypass)
- ⚠ DANGER — one or more safety toggles reduced
- "N conflicts" — unresolved conflict-tagged observations in vault

Click the toggle to collapse/expand the detail panel. Click "Setup" to open the vault grant flow. Click "Capture" to manually save the last assistant response.`,
  },
  {
    id: "marker-pills",
    category: "ui",
    title: "Marker pills in claude's replies",
    body: `When the agent emits a marker, it's rendered inline as a clickable pill:

- **Neutral** — \`{saved memory:}\` — already-saved acknowledgment
- **Blue** — \`{wb-fetch:}\` — file pulled into next message
- **Purple** — \`{wb-scope:}\` — scope brief queued for next message
- **Amber** — \`{wb-bootstrap}\` — bootstrap re-pulled
- **Green pulsing** — \`{wb-save}\` in flight; turns neutral when the write lands
- **Red** — save failed (lock, rate limit, crisis block, bad payload)
- **Dashed** — \`{wb-context:}\` — render-only narration, no action

Click any pill (except dashed/red) to preview what was loaded or saved.`,
  },

  // ─── Other tools ─────────────────────────────────────────────────────
  {
    id: "cli",
    category: "tools",
    title: "Command-line tool",
    body: `\`whitebox\` CLI — universal vault interaction.

\`\`\`
whitebox init [path]              create a new vault skeleton
whitebox export                    print paste-in bundle to stdout
whitebox paste                     copy paste-in bundle to clipboard
whitebox conflicts                 list unresolved conflict-tagged observations
whitebox log [--recent N]          recent passive-memory conversation files
whitebox grep <pattern>            regex search across conversations
whitebox import <file>             (stub) import vendor conversation export
\`\`\`

Use \`--vault <path>\` on any command to override the vault root, or set \`WHITEBOX_VAULT_ROOT\` env var. \`--json\` available where applicable.`,
  },
  {
    id: "passive-log",
    category: "tools",
    title: "Passive auto-log",
    body: `Optional. Off by default. Enable in popup → Passive log.

When enabled, the conversation is snapshotted every 30s and on tab-hide / browser-close. Writes to \`conversations/YYYY-MM-DD/<id>-part-N.md\` in 40K-char chunks per the v1.1 chunking convention. Each part has \`group_id\`, \`part\`, \`conversation_id\`, \`site\`, \`started_at\` frontmatter.

Per-conversation state in \`chrome.storage.local\` tracks which turns are already written, so each flush is incremental.

Use \`whitebox log\` and \`whitebox grep\` to browse. Active memory (observations) stays independent — passive is never auto-promoted.`,
  },
  {
    id: "claude-code-skill",
    category: "tools",
    title: "Claude Code skill",
    body: `WhiteBox ships as a Claude Code skill at \`claude-code-skills/whitebox/\`.

Install:
\`\`\`
mkdir -p ~/.claude/skills
cp -r claude-code-skills/whitebox ~/.claude/skills/
\`\`\`

The skill teaches Claude Code about the WhiteBox tool surface, the self-automation pattern, the discipline rules, the five-grade confidence scale, and the autonomous-save acknowledgment format. Drop in once; Claude Code knows what to do.

Requires the WhiteBox MCP server to be configured in your Claude Code MCP config.`,
  },

  // ─── Troubleshooting ─────────────────────────────────────────────────
  {
    id: "agent-cant-see-vault",
    category: "trouble",
    title: "Agent says it can't see my vault",
    body: `Likely causes:

1. **Vault grant expired.** Browser File System Access permission decays on browser restart. Open the popup; if it says "Permission expired," click "Re-grant access."
2. **Bootstrap is empty.** If \`identity.md\`, \`working-style.md\`, and \`observations/\` are all empty, there's nothing to inject. Open them in your editor and add real content.
3. **Vault is locked.** Check the popup. If it says LOCKED, unlock with your passphrase.
4. **Extension is disabled.** Check the popup toggle. Per-site toggles for claude.ai/chatgpt/gemini also exist.
5. **Stale extension.** Reload at \`chrome://extensions\` → WhiteBox → reload icon. Refresh the claude.ai tab.`,
  },
  {
    id: "settings-not-saving",
    category: "trouble",
    title: "Settings don't persist",
    body: `Settings auto-save on every change as of v0.4. If you're seeing them reset:

1. Reload the extension (\`chrome://extensions\` → WhiteBox → reload icon). You're probably on an old build.
2. Check that \`chrome.storage.local\` isn't blocked by your browser profile. Try in an Incognito window with the extension allowed.
3. If "Remember across restarts" is off and you restart the browser, the vault re-locks. That's expected.`,
  },
  {
    id: "agent-doesnt-use-markers",
    category: "trouble",
    title: "Agent doesn't use the markers",
    body: `If the agent never emits \`{wb-fetch:}\` / \`{wb-save}\` / etc., either:

1. **It didn't see the bootstrap.** First message of a fresh \`/new\` chat should have the bootstrap injected. If not, check popup status, vault grant, and content-script log in DevTools (F12 → Console).
2. **It read the bootstrap but doesn't recognize the tools.** Some smaller models don't follow tool-style framing well. Try a frontier model (Opus, Sonnet 4.5).
3. **It's MCP-connected.** MCP-aware agents prefer direct tool calls over markers. That's fine — same result, no latency.`,
  },
];

export function findHelpPage(id) {
  return HELP_PAGES.find((p) => p.id === id);
}
