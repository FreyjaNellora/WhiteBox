# Changelog

All notable changes to WhiteBox. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) shape and [Semantic Versioning](https://semver.org/) once it starts tagging releases.

Currently pre-alpha. Version labels below describe roadmap milestones rather than shipped tags.

## v1.0.0-prealpha.6 — Capture flow now honors the spec's own ~500-char rule

Surfaced by a real-vault audit from a connected agent, who correctly flagged that the recent observations in the maintainer's vault read more like pasted conversation excerpts than verbatim quotes — long blocks of back-and-forth saved as observation bodies, well over the spec's `~500 char` "verbatim quote" guideline. The tool was encouraging the discipline failure it was meant to help follow. Same agent noted that the AGENTS.md spec already prescribes the right path: long content goes to `sources/<filename>.md` and the observation references it via `source_ref:`.

### Added

- **`source_ref` and `context` fields** in observation schemas everywhere they're written: `whitebox-mcp/src/schema.ts`, `whitebox-mcp/src/vault.ts` `formatObservation`, `whitebox-extension/src/background/background.js` `formatObservationBlock`. Both fields are optional and emit only when set; vaults without them stay schema-clean.
- **`wb:write-source` background message + `writeSourceFile`** writer that creates `sources/YYYY-MM-DD-<slug>.md` with proper schema/1.1 frontmatter (`kind: source`, `captured_at:`, `source:`, `url:`, `site:`, `title:`). Slug derived from first 80 chars of content + a 4-char timestamp suffix to avoid collisions in the same minute. Exposed to content scripts via `wb.writeSource()` in `_shared.js`.
- **Adaptive long-capture UI in `propose.html` / `propose.js` / `propose.css`.** When the captured text exceeds 500 chars: amber long-capture banner explains the spec's verbatim rule, a read-only reference panel shows the full text with "copy all to body" affordance, body textarea starts empty so the user is prompted to extract a key passage, and a "Save full text as `sources/<file>.md`" checkbox (default checked) routes the long content to a source file with `source_ref:` injected into the observation. Body length hint shows live char count, turns amber over 500. Confirmation dialog if the user explicitly saves an over-length body anyway. New `context:` field added to the form.
- **Same discipline applied to session digest** (`digest.html` / `digest.js` / `digest.css`). New "Auto-source long turns (>500 chars)" checkbox at the top, default checked. Each turn now shows a length badge (amber when over 500). On bulk save, long turns route through `wb:write-source` and get a ~400-char excerpt + " […]" body with `source_ref:` back-link. Result line reports how many sources were created alongside the observation count.

### Changed

- Versions bumped 1.0.0-prealpha.5 → 1.0.0-prealpha.6 across all surfaces.

### Note

Earlier-shipped observations that violate the new flow remain in vaults as they were. The new flow only affects future captures; nothing is rewritten retroactively. Cleanup of long historical entries is a manual editorial pass the user does on their own schedule. The spec discipline rule has always existed; the tooling just stopped fighting it.

## v1.0.0-prealpha.5 — service-worker hotfix

Three cascading errors reported after loading prealpha.4 in Chrome:
`Service worker registration failed. Status code: 15`, `SyntaxError: Unexpected token ']'`, `Cannot read properties of undefined (reading 'log' / 'onScreenLock' / 'onStateChanged')`. Single-commit fix covering all three.

### Fixed

- **`_shared.js` had a mismatched bracket** on the `buildBootstrapText` function (`];` where it should have been `);` — leftover from an earlier edit that converted a `const parts = [...]` literal into a `parts.push(...)` call without updating the closing punctuation). The syntax error cascaded: content scripts never populated `window.__whitebox`, so `wb.log` in `claude-ai.js` threw `undefined is not a function`, and the popup's `state.triggers.onScreenLock` access threw because the background-side response never came back.
- **`manifest.json` was missing the `idle` permission.** `background.js` calls `chrome.idle.onStateChanged.addListener(...)` and `chrome.idle.setDetectionInterval(...)` for the auto-lock triggers. Without the permission in the manifest, Chrome returns `chrome.idle` as `undefined`, and the service worker crashes on registration — which is why Chrome was reporting registration failure with status code 15. Added `"idle"` to `permissions`.
- **Defensive guards in `popup.js` `refreshLockUi()`** so a future service-worker failure degrades gracefully: wrapped `chrome.runtime.sendMessage` in try/catch, filled in default empty objects for `state.triggers`, `state.danger`, `state.rateLimit` before destructuring.
- **Defensive guard in `claude-ai.js`** for the case where `_shared.js` somehow fails to populate `window.__whitebox` — logs a clear console warning and aborts the content script instead of throwing.

All three fixes ship together because they're the same incident: syntax error → cascade of undefined-property accesses. Version bumped to 1.0.0-prealpha.5 across all surfaces.

## v1.0.0-prealpha.4 — uninstall path (your vault stays yours)

WhiteBox now has a clean uninstall story. Three layers, all with the same invariant: **your vault folder is never touched**. Files, observations, audit log, conversations, identity — all stay where they are. WhiteBox treats your vault as your data, not part of the software.

### Added

- **Reset extension state button in popup** (under new "Reset / uninstall" section). One click clears IndexedDB (the browser's record of which folder is your vault), all `chrome.storage.local` settings (style, scope, lock, bypass, danger toggles, passphrase hash), and `chrome.storage.session` (lock state, conversation cache). Confirmation dialog spells out exactly what gets cleared and explicitly states the vault folder on disk is untouched. Wired via new `wipeIdb()` helper in `src/lib/vault-handle.js`.
- **`uninstall.sh` (macOS/Linux) and `uninstall.ps1` (Windows).** Mirror the install scripts. Interactive: prompts before removing built CLI/MCP artifacts, prompts before removing Claude Code skill. Prints exact manual steps remaining (extension via chrome://extensions, MCP entry to remove from Claude Desktop config, vault folder is yours). Color-coded output. Never deletes the vault folder, never deletes the repo, never auto-edits user JSON config files.
- **`UNINSTALL.md`** — complete walkthrough. Six steps: reset extension state → remove extension → remove MCP server config (with examples for Claude Desktop / Cursor / Claude Code / Gemini CLI) → remove Claude Code skill → remove repo and built artifacts → optional vault deletion. Opens with a callout that the vault is not touched. Closes with re-install instructions and "if something goes wrong" troubleshooting.
- **INSTALL_FOR_FRIENDS.md** gains an "How to uninstall" section pointing to the popup reset button + chrome://extensions Remove flow, with the same "your vault stays yours" reassurance.
- **README.md** gains a pointer to UNINSTALL.md alongside QUICKSTART and GUARDRAILS.

### Changed

- Versions bumped 1.0.0-prealpha.3 → 1.0.0-prealpha.4 across manifest.json, both package.json files, MCP server constructor, CLI Commander.version(), popup footer, setup wizard footer, README status lines.

## v1.0.0-prealpha.3 — friend-grade install path

The install story before this release was developer-grade: clone the repo, install Node, build three packages, hand-edit Claude Desktop's JSON config, sideload the extension. This release closes the gap to "as easy as installing any browser extension."

### Added

- **Real setup wizard inside the browser extension** (`src/setup/setup.html` + `setup.js` + `setup.css`). Six-step flow: welcome → pick vault folder → fill in identity → fill in working style → pick visual style → done. The wizard auto-scaffolds a complete vault (`AGENTS.md`, `identity.md`, `working-style.md`, `tags.md`, `README.md`, empty `observations/<month>.md`) when the user picks an empty folder, so non-developer users never need to touch the CLI to bootstrap a vault. Identity and working-style answers are written to the vault as proper markdown files (skipped if the user leaves fields blank). Visual-style choice is persisted via `wb:set-settings` and also flips `enabled` and `firstRunComplete` so the extension is ready to use immediately on completion.
- **`INSTALL_FOR_FRIENDS.md`** — non-developer install guide. ZIP download → load extension → run wizard → done in five minutes. No terminal, no Node.js required for the browser-only path. Linked from the README at the top.
- **`install.sh`** (macOS/Linux) and **`install.ps1`** (Windows) — one-command installers for the developer path. Build CLI + MCP, print exact MCP-config JSON to paste into Claude Desktop, point to extension Load Unpacked. Both scripts print step-by-step next instructions so users don't need to remember the sequence.
- **README rewrite** — opens with a non-developer-install pointer, then the developer-grade Quick Install with all three components and config snippets, then everything-else-you-get summary, scope statement, what's-in-the-repo, roadmap, status. Matches v1.0.0-prealpha.3 reality including the new wizard.

### Changed

- README, popup footer, setup wizard footer, all package.json files, MCP server constructor, CLI Commander.version() bumped to `1.0.0-prealpha.3`.

### Fixed

- Test-pollution observations from earlier prealpha smoke tests removed from the maintainer's vault. Vault back to user content only. (Doesn't affect external users; logged here for traceability.)

## v1.0.0-prealpha.2 — scope correction

### Removed

- **Crisis-keyword soft block.** Pulled. The list of self-harm patterns checked against observation bodies before save was the wrong layer for that responsibility. Content safety is the LLM provider's job (Anthropic, OpenAI, Google handle this in the conversation layer, before content reaches WhiteBox for storage); filtering at storage time would override the user's right to record their own words and duplicate work already done. WhiteBox's scope is vault integrity (sandbox, source stamping, audit log, lock + bypass) plus user control (deletion, editing, scopes, guardrails) — not moderation. Removed: `CRISIS_PATTERNS` and `isCrisisContent` in `background.js`, same in `whitebox-mcp/src/vault.ts`, the `wb:confirm-crisis-write` message handler, the `crisisKeywordBlock` setting, the popup crisis-modal HTML/CSS/JS, the crisis-block error code in `claude-ai.js` save error framing, the help page, the GUARDRAILS.md section. Replaced with a scope-of-responsibility note in GUARDRAILS.md and help.

### Added

- `docs/GUARDRAILS.md` now opens with an explicit "Scope of responsibility" section drawing the line between what WhiteBox handles (vault integrity, user control) and what it doesn't (content moderation, mental health intervention). Same framing surfaces in the help wikibook under Lock & safety → "What WhiteBox protects (and what it doesn't)".

## v1.0.0-prealpha.1 — overnight comprehensive build

First version label on the project. Everything in the Unreleased block below shipped in one focused overnight push covering: marker protocol (read/write/scope/bootstrap/context), MCP bootstrap+grep tools, Claude Code skill packaging, vault lock + per-trigger danger toggles, agent bypass tiers, source-spoofing prevention, crisis-keyword soft block, autonomous-write audit log, in-page help wikibook + hover tooltips. Versions bumped from `0.x` to `1.0.0-prealpha.1` across MCP server, CLI, browser extension. Pre-alpha = "feature-complete for the v1 design but unvalidated by external users; expect breakage and iteration."

## [Unreleased]

### Added

- **In-page help bubble system (wikibook + hover tooltips).** Help no longer takes you away from the conversation. Two layers:
  - *Wikibook overlay* — draggable bubble on the current claude.ai tab with a sidebar of categorized pages (Get started / Vault / Agents & tools / Lock & safety / Interface / Other tools / Troubleshooting) and a content pane. 24 pages covering everything from "what is WhiteBox" to "agent doesn't use the markers" troubleshooting.
  - *Hover bubble* — any UI element with `data-wb-help="<page-id>"` shows a small description bubble next to it on hover. Bubble persists for 250ms after mouse-out so you can mouse onto it; mousing onto the bubble cancels dismiss; clicking "Open full page →" launches the wikibook scrolled to that page. Mounted in popup (toggles, sections) and content scripts (HUD badges).
  - Popup `Help` link no longer opens a new tab — sends a message to the active claude.ai/chatgpt/gemini tab to spawn the wikibook in-page. Falls back to the static help.html if the active tab isn't compatible.
  - Help content is shipped inline as a JS module (`src/lib/help-content.js`); no extra fetch.

- **Vault lock subsystem (Phase 1).** Passphrase-protected vault with session-bound unlock. Lock state persists across the service worker but auto-clears on browser close (or `chrome.storage.local` if "Remember across restarts" is enabled). Lock-now button in popup, lock-state badge on the floating HUD on claude.ai. Phase 1 is a UX gate — files stay plaintext on disk. Phase 2 will add AES-GCM body encryption underneath the same primitive without changing the UX.
- **Per-trigger danger toggles.** Each auto-lock trigger is independently toggleable: `onScreenLock` (default ON, fires on `chrome.idle.onStateChanged` "locked"), `onIdle` (default OFF, configurable 5/15/30/60 min via `chrome.idle.setDetectionInterval`), `onTabClose` (default OFF), `rememberAcrossRestarts` (default OFF, marked DANGER). Toggling any safety off requires explicit confirmation; reduced posture surfaces a red ⚠ DANGER badge on popup header and HUD, plus an addendum in the bootstrap framing telling the agent to be more cautious.
- **Agent bypass tiers.** What the agent can still do while the vault is user-locked, set by the user as a separate dropdown in popup. Tiers: `none` (default), `reads-only`, `reads-and-safe-writes`, `full-bypass` (DANGER). Auto-expire timer optional (1h / 4h / 8h / 24h / never). Bypass changes require the vault to currently be unlocked. HUD shows a purple `BYPASS: <tier>` badge whenever bypass is anything other than `none`.
- **Source-spoofing prevention.** Browser extension overrides any agent-declared `source:` in observation payloads with the authoritative platform name (`claude.ai`). MCP server prefixes incoming sources with `mcp:` so observation files never contain unstamped agent-declared sources. Closes a small but real spoofing hole in the per-source audit trail.
- ~~**Crisis-keyword soft block.**~~ **Removed in prealpha.2** — wrong layer for that responsibility. Content moderation is the LLM provider's job; WhiteBox handles vault integrity, not moderation. See prealpha.2 entry for details.
- **Autonomous-write audit log.** Every successful `wb-save` (browser) or `append_observation` (MCP) appends one line to `audit/YYYY-MM-DD.md` in the vault. Format records timestamp, source, tags, confidence, target file, optional `via=bypass(<tier>)` annotation when an elevated tier permitted the write, and `safety=reduced` annotation when any safety toggle was below default. Optional verbose mode (popup Safety section) also logs reads. Default verbosity = writes only.
- **Optional autonomous-save rate limit.** Per-browser-session cap dropdown in popup (5 / 10 / 25 / 50 / unlimited). **Default is unlimited** — principle is to trust the agent and rely on tier-based guardrails, not arbitrary numerical caps. Set a cap only if a specific source has shown runaway behavior.
- **HUD badge family.** New badges on the floating HUD on claude.ai: 🔒 LOCKED (when vault locked), `BYPASS: <tier>` (purple, red if full-bypass), ⚠ DANGER (red, animated, when any safety toggle is reduced). Badges auto-refresh every 5s.
- **Locked-vault stub bootstrap.** When the agent requests bootstrap and the vault is locked beyond the bypass tier's read permission, the response is a stub telling the agent the vault is locked and asking it to wait for the user to unlock rather than retrying.
- **Self-automation surface for the agent.** WhiteBox now treats the agent as the orchestrator of its own context loop, not as a passive recipient of injected text. Two paths are first-class:
  - *Structured (markers in browser sessions):* `{wb-fetch: <path>}`, `{wb-scope: <name>}`, `{wb-bootstrap}`, `{wb-context: <text>}`, plus the existing `{saved memory: ...}`. Agent emits, extension reads, side effect runs (read file / read scope / re-pull bootstrap / no-op narration), result lands at the top of the user's next message. Each is a clickable pill in the UI for full audit.
  - *Direct (MCP-connected sessions):* new `bootstrap` and `grep` MCP tools so MCP-aware agents (Claude Desktop, Claude Code, Cursor, Gemini CLI) call them with no marker round-trip. `bootstrap(include_observations?)` returns the orientation pack identical to what the browser injects; `grep(pattern, scope?, ignore_case?, context?, max_results?)` regex-searches active and/or passive memory.
- **`claude-code-skills/whitebox/`** — Claude Code skill packaging. `skill.md` teaches Claude Code when to use the WhiteBox tools, the self-automation pattern, the discipline rules (verbatim bodies, anti-characterization, idle-stability, autonomous-save acknowledgment format), and the five-grade confidence scale. `README.md` covers install. Drop the folder into `~/.claude/skills/`.
- **`docs/GUARDRAILS.md`** — design sketch for per-source permission tiers (`read-bootstrap-only` / `read-on-request` / `read-anywhere` / `read-and-write` / `read-write-and-edit`), sub-agent inheritance rules, the planned `guardrails.md` vault file, and where each surface (MCP, extension, CLI) enforces. Vocabulary is committed; enforcement plumbing is planned for v1.0.0-beta.
- **Bootstrap framing rewrite (`whitebox-extension/src/content/_shared.js`).** The extension's first-message inject now teaches the agent its role as a context manager rather than just attaching files. Explicitly tells the agent: this is a starter pack, not a contract — use it or set it aside and discover what you need on your own. Documents all five markers inline. Frames `recent observations` as ground truth that beats the agent's defaults.
- **Pending-prepend buffer + generalized send interception.** The browser content script's keydown / send-button listeners now intercept on either condition (first message of `/new` OR pending content from a marker the agent emitted). `injectAndSubmit` builds the prefix from bootstrap + pending and sends. One-turn latency for agent-requested content is the cost of the browser channel; marker pills make it transparent.
- **MCP `list_conflicts` tool** in `whitebox-mcp`: agents can fetch the list of unresolved observations tagged `conflict` at session start to surface pending issues for the user. Mirrors the CLI `whitebox conflicts` command. Wired into `vault.ts` with shared parser helpers and registered in the tool list / call handler.
- **CLI `whitebox conflicts`** command: list unresolved observations tagged `conflict` with file path, position, frontmatter, and trimmed body. `--json` for machine-readable output.
- **CLI `whitebox log [--recent N]`** command: list recent passive-memory conversation files under `conversations/`, sorted by mtime descending. Shows date, conversation id, part number, size, and a snippet from the first user turn so the session is recognizable. `--json` supported.
- **CLI `whitebox grep <pattern>`** command: regex search across all `conversations/*.md` files. Flags: `-i / --ignore-case`, `-C / --context N` for surrounding lines, `--turn` to return whole conversation turns instead of single lines, `--json`.
- **Browser extension: `{saved memory: ...}` tag detection** on claude.ai. The content script's MutationObserver finds inline memory-save acknowledgments in assistant responses and rewrites them into clickable pills. Clicking opens a modal that previews the file contents pulled from the vault via the persisted FSA handle. Theme-aware (light + dark).
- **Browser extension: first-run style picker** in the popup. Three presets — Office (calm, light, low-density; default), Engineer (info-dense, dark, CLI hints), Gamer / Modder (always-on HUD, dark, advanced). Persisted as `style` setting; editable later via a dropdown row in the popup. `firstRunComplete` flag prevents re-prompting.
- **Browser extension: floating HUD** on claude.ai. Draggable, position persisted in `chrome.storage.local`. States: `idle`, `recording`, `saved`, `warn`. Shows vault name, conflict badge (auto-refreshed every 60s), Capture and Setup quick-actions. Office mode reduces it to a transient toast that appears only when something saves; Engineer mode shows a slim persistent HUD; Gamer/Modder shows the expanded HUD.
- **Browser extension: passive auto-log** on claude.ai (opt-in). When enabled, the conversation is snapshotted every 30s and written to `conversations/YYYY-MM-DD/<id>-part-N.md`. Files are auto-chunked at 40K body chars per the v1.1 chunking convention; each part has `group_id`, `part`, `conversation_id`, `site`, `started_at` frontmatter. Per-conversation state in `chrome.storage.local` tracks `lastCount` so each flush is incremental. Flushes also fire on visibility-hidden and beforeunload, plus a manual "Flush" button on the HUD.
- **Background message types:** `wb:list-conflicts-count` (counts conflict-tagged observations across `observations/*.md` for HUD badge) and `wb:append-conversation-turns` (the passive-log writer).- In-extension help menu at `src/help/help.html`. Accessible from the popup footer. Covers what WhiteBox is, how the vault works, how injection/capture/digest flow, the verbatim-only rule, tags, the 5-grade confidence scale, scopes, supported sites, troubleshooting, privacy model.
- GitHub issue templates (`.github/ISSUE_TEMPLATE/`): bug report, selector update, integration recipe, feature request, plus a `config.yml` routing tag/schema proposals into Discussions.
- GitHub pull request template (`.github/pull_request_template.md`).

### Changed

- AGENTS.md (vault-example + CLI template) gained an optional `context:` frontmatter field for context-dependent observations and a new "Idle-stability — don't bloat what works" section instructing agents to skip autonomous saves that just restate known content.

### Fixed

- `whitebox-extension/src/content/claude-ai.js` now logs `content script v0.3 live` instead of stale `v0.2`. Cosmetic.

## v0.3 — Validated end-to-end across three consumer platforms

### Added

- **Session digest** (browser extension): pulls the full conversation from the active tab, opens a batch-review page where the user picks which turns to save as observations, sets bulk tags + confidence once, saves all selected turns as separate observations.
- **Observation capture** (browser extension): popup button + dedicated review page for saving a single assistant response verbatim to the vault.
- **Bootstrap injection** on all three major consumer platforms: claude.ai, chatgpt.com, gemini.google.com. Prepends vault context to the first message of a new conversation.
- **MCP server** (`whitebox-mcp`): four tools — `read_file`, `list_files`, `append_observation`, `propose_stable_edit`. Exposes vault files as MCP resources under `whitebox://`.
- **CLI** (`whitebox-cli`): `init` (vault skeleton, zero-arg defaults to `~/whitebox-vault`), `export` (paste-in bundle to stdout), `paste` (bundle to system clipboard, platform-native). `import` still stubbed.
- **Five-grade confidence scale** (`very-low` → `very-high`) replacing the earlier three-grade. Additive; existing observations with `low | medium | high` stay valid.
- **Verbatim-only rule** in AGENTS.md: agents writing to the vault must use direct quotes only, never summaries or inventions.
- **Proactive capture instructions** in AGENTS.md: agents may call `append_observation` on their own when the user states a clear preference, a pattern repeats, or a session is wrapping up.
- **Canonical tag registry** at `spec/tags-canonical-v1.md` — shared vocabulary for WhiteBox vaults, versioned and additive-only.
- **Contribution infrastructure**: `CONTRIBUTING.md`, `docs/COMMUNITY.md`, good-first-contribution list.
- **Schema v1.1** at [spec/WHITEBOX_v1.1.md](spec/WHITEBOX_v1.1.md) — ratified. Defines passive (auto-logged conversations) and active (curated real-time selections) memory layers, source/extract split, vault-wide file chunking convention, anti-characterization discipline, and the *substrate-not-policy* principle.
- **Research-backed design docs**: DESIGN.md cites LaMP (profile-size saturation), Lost in the Middle (retrieval-chunk ceiling), Persona-Chat (small persona sufficiency).
- **Documentation full set**: PITCH, DESIGN, STRATEGY, ADOPTION, PRICING, MARKETING, COMPARISON, EDITOR_GUIDE, VALIDATION, TEST_CHECKLIST, COMMUNITY, BACKLOG.
- **QUICKSTART.md** at repo root — linear ~10-minute setup walkthrough, AI-parseable.
- **`sources/` folder support in AGENTS.md** anticipating the v1.1 split (proposal still pending).

### Validated

- Cross-vendor injection on claude.ai, chatgpt.com, gemini.google.com, same vault, three independently-trained foundation models. Documented in `docs/VALIDATION.md`.
- Observation capture writing verbatim entries to the monthly observations file from all three platforms.
- MCP read + write end-to-end via Claude Desktop and Claude Code on the same vault as the browser extension.

### Privacy

- Repo sanitized of personal identifiers on 2026-04-21. `_old-design/` folder (earlier exploratory drafts containing personal project and relationship references) removed entirely. Example values in spec and docs changed from identifying names/projects to generic placeholders.
- Git history rewritten (force-push) to drop all pre-sanitization commits from `origin/main`. Old commits may persist in GitHub's unreferenced-object storage for some time; contact GitHub support for full purge if needed.

## v0.2 — Core tooling

- Schema v1.0 frozen.
- Reference vault (`vault-example/`).
- MCP server first working version.
- CLI `init` command.
- Browser extension scaffold (loads on the three sites, shows popup, no injection yet).

## v0.1 — Concept and spec

- Initial schema draft.
- Architecture principles documented.
- Pitch and design rationale.

## Milestone definitions

- **pre-alpha** — Feature-complete for the v1 design, validated only by the maintainer. Expect breakage.
- **alpha** — Stabilized, tested, documented honestly. First external testers. Breaking changes possible but communicated.
- **beta** — External feedback incorporated. Published on Chrome Web Store. Breaking changes unlikely.
- **stable (v1.0.0)** — Production-ready for daily use. Schema frozen. No breaking changes without a v2 migration path.

## Format notes

- **Added / Changed / Fixed / Validated / Privacy / Removed** subsections follow Keep a Changelog conventions where applicable.
- Once the project tags its first release (likely when the first external alpha tester is onboarded), entries will migrate from `[Unreleased]` to versioned blocks with dates.
- Schema-version changes are tracked separately in the `spec/` folder — see `spec/WHITEBOX_v1.md` (frozen) and `spec/WHITEBOX_v1.1.md` (current).
