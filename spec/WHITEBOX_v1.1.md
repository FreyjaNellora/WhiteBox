# WhiteBox Schema v1.1

**Status:** current. Supersedes the earlier v1.1 proposal. Backward-compatible with v1.0 vaults.

This document specifies how a WhiteBox vault is shaped. Tooling implements the spec; the spec does not specify tooling. The spec is small on purpose.

## What's new in v1.1

- **Two memory layers** defined explicitly: **passive** (auto-logged conversations) and **active** (curated real-time selections).
- **Source/extract split** within the active layer for long captures.
- **Five-grade confidence scale** replacing v1.0's three.
- **Anti-characterization discipline** named, defined, and enforced on agent writes.
- **Substrate-not-policy principle** stated as a top-level design constraint.

Every change is additive. v1.0 vaults remain valid in v1.1 tooling without migration.

## Design principles

### Substrate, not policy

The spec defines *where things live, in what shape, and what trust constraints govern writes*. It does not define *when to log, what to prune, what to mark sensitive, how often to capture, what counts as worth remembering*. Those are decisions made between the user and whichever agent they're talking to at the moment of use. The substrate provides mechanisms; user and agent provide policy in real time.

A spec that pre-legislates every decision becomes brittle as use cases diverge. A spec that defines the substrate cleanly survives the long tail of how individual users actually work.

### User owns the substrate

Files on the user's disk, in plain markdown, in formats any text editor can read. No hosted service. No proprietary container. No binary dependency. If every WhiteBox tool disappeared tomorrow, the vault is still a complete, queryable, durable record of what its owner chose to keep.

### Trust by construction

Memory is only useful if it's trustworthy. Trust is enforced structurally, not by policy:

- **Verbatim body** on agent-authored observations — the body is a direct quote, never a paraphrase or invention.
- **Anti-characterization** on agent-authored metadata — tags and confidence describe behavior, not the agent's interpretation of the user.
- **Extract-not-summarize** on retrospective recall — when an agent reads the passive archive to help the user, it surfaces verbatim quotes with file references rather than summarizing.

Each rule prevents a specific failure mode (see Discipline below).

## Two memory layers

WhiteBox separates memory into two parallel systems with different purposes, different contents, and different cataloging schemes.

### Passive memory — `conversations/`

**Purpose.** Lossless archive of conversations the user has with AI agents. The record of what was actually said.

**Contents.** Full-fidelity transcripts of conversations: both the user's turns and the agent's responses, in chronological order, including timestamps and source attribution where available.

**Indexed by.** Time and session. Files organized chronologically, named for date and source. Answers questions like *"what did I say to Claude on April 15th?"* or *"what was the conversation about Project X last month?"*

**Loaded when.** Never automatically at session start. The passive archive is browsed or grepped on demand — by the user directly, or by an agent the user explicitly invites to read it (with the extract-not-summarize discipline).

**Written by.** Auto-log mechanisms (typically the browser extension watching supported sites; eventually CLI import for vendor-exported transcripts; never automatically by an MCP server unless the host client provides full transcripts, which most don't today).

**File location.** `conversations/<filename>.md` at vault root. Subdirectories permitted for organization (e.g., `conversations/2026/04/...`); not required. See **File chunking** below for filename and split conventions, which apply to conversation logs the same way they apply elsewhere in the vault.

**Frontmatter (each chunk file):**

```yaml
---
schema: whitebox/1.1
kind: conversation-log
date: 2026-04-21
source: claude.ai | chatgpt.com | gemini.google.com | claude-desktop | <other>
model: <model identifier if known>
conversation_url: <stable URL if available>
captured_at: 2026-04-21T22:30:00Z
captured_by: whitebox-extension | whitebox-cli | <other tool>
group_id: <stable ID across all parts of one conversation>
part: 1
total_parts: 3   # optional; tooling can enumerate by glob if omitted
scope: <optional scope name from scopes.md>
---
```

Each chunk is self-contained in metadata so an agent can read just one without needing to load a manifest. `group_id` ties parts of one conversation together; `part` numbers them; `total_parts` is optional convenience.

**Body format.** Turns separated by level-2 headers, role-tagged:

```markdown
## user [timestamp]

<verbatim user message>

## assistant [timestamp, model=<model>]

<verbatim assistant message>
```

Optional blocks for `## tool_use`, `## tool_result`, `## artifact`, `## thinking` where the source provides them.

### Active memory

**Purpose.** Curated, signal-dense context the agent reads at session start to know who the user is and how they want to be worked with.

**Contents.** Stable facts (identity, working style), short observations selected in real time, optional named files for relationships and projects, the tag registry.

**Indexed by.** Topic, tag, person, project. Answers questions like *"what does the user prefer about how I work with them?"* or *"what do I know about their project Foo?"*

**Loaded when.** At session start. The full active layer (or scope-restricted subset) is what bootstraps a new conversation.

**Written by.** Real-time selection during a conversation: the user clicks Capture or Session Digest in the browser extension; the agent calls `append_observation` via MCP; the user edits a stable file by hand. Never auto-derived from the passive layer; promotion from passive to active is always a deliberate human-or-agent act.

**File locations:**

- `AGENTS.md` — bootloader, agent-facing orientation. Read first by any agent.
- `identity.md` — stable facts about the user.
- `working-style.md` — how the user wants to be worked with.
- `tags.md` — tag registry (canonical + proposed).
- `observations/YYYY-MM.md` — append-only monthly log of curated observations.
- `sources/<filename>.md` — verbatim archive of long captures referenced by observations (see Source/extract split below).
- `relationships/<name>.md` — optional, one file per significant person.
- `projects/<slug>.md` — optional, one file per active project.
- `scopes.md` — optional, scope definitions.
- `synthesized/` — synthesis tier: agent-generated condensations of observations (see Synthesis tier below).
- `reactions/` — reactions tier: emergent annotations on observations (see Reactions tier below).

**Frontmatter (observation entry, inside `observations/YYYY-MM.md`):**

```yaml
---
date: 2026-04-21
source: <agent or model identifier>
tags: [tag1, tag2]
confidence: very-low | low | medium | high | very-high
source_ref: sources/<filename>.md   # optional, for split observations
context: <situational scope>        # optional, see below
---

<verbatim quote from the conversation>
```

Observations are separated by `---` (horizontal rules). Order is chronological.

**Optional `context:` field** narrows when an observation applies. Some apparent contradictions in the vault aren't actually conflicts — they're context-dependent patterns. *"User prefers terse"* in a coding session vs *"user likes elaboration"* in creative conversation isn't a conflict; it's a coherent person being context-appropriate. The `context:` value records that scope so agents can use it as a retrieval filter rather than treating both observations as competing truths. Examples: `context: coding-conversations`, `context: when-tired`, `context: morning`. The anti-characterization rule applies — `context:` describes situational scope, not character traits.

### How the layers relate

**Parallel writes during the same conversation.** When you talk to an agent, the passive layer captures the full exchange in the background; the active layer receives only the moments you or the agent deliberately select.

**No automatic cross-feeding.** The active layer is never auto-derived from the passive layer. An agent does not silently mine the archive to produce active-memory entries.

**Secondary retrospective pathway.** A user can review old passive logs and decide to promote a moment to the active layer. This is always a deliberate human (or agent-with-user-approval) act — the agent reading the archive must follow the extract-not-summarize discipline.

### Differences in cataloging

| | Passive | Active |
|---|---|---|
| Indexed by | Time, session, source | Topic, tag, person, project |
| Loaded at session start | No | Yes (or scope-restricted subset) |
| Authored by | Auto-log mechanisms | Real-time user/agent selection |
| Default size | Grows continuously | Stays signal-dense |
| Trust boundary | Lossless verbatim archive | Verbatim + anti-characterization |

## File chunking — vault-wide convention

Any file in the vault that grows past the chunk threshold gets split into multiple smaller files following a consistent naming and metadata pattern. This applies uniformly across file types — passive logs, observation files, sources, and any large stable file — so that any agent, including ones with smaller context windows, can pull a single chunk without overflow.

**Filename convention.** Append `-part-N.md` (1-indexed) to the base name:

```
conversations/2026-04-21-claude-ai-debug-part-1.md
conversations/2026-04-21-claude-ai-debug-part-2.md
observations/2026-04-part-1.md
observations/2026-04-part-2.md
sources/2026-04-21-long-claude-response-part-1.md
sources/2026-04-21-long-claude-response-part-2.md
projects/my-project-part-1.md
projects/my-project-part-2.md
```

For files that fit in a single chunk, `-part-1.md` is still the suffix when chunking is in use; tooling should pick this convention consistently per file type. (Stable files that virtually never grow long — `identity.md`, `working-style.md`, `tags.md` — are exempt and remain single-file by default; if they ever exceed the threshold, the same pattern applies.)

**Default chunk size.** ~40,000 characters of body content per chunk (excluding frontmatter). Roughly 10,000 tokens of English prose. Sized so a single chunk fits comfortably even in a 32K-token context window — the smallest among widely-used AI agents and providers — with room left for the agent's system prompt and response. Per substrate-not-policy, tooling may configure a different threshold per vault, and a single indivisible unit (one long turn, one long stable-fact section) longer than the threshold is permitted to overflow into one oversized chunk rather than being split mid-unit.

**Splits always occur at semantic boundaries**, never mid-unit:

- Conversation logs split at turn boundaries.
- Observation files split between observation entries.
- Source files split at paragraph or section boundaries.
- Stable files split at top-level heading boundaries.

**Required frontmatter on each chunk:**

- `group_id` — stable identifier shared by all parts of the same logical group (one conversation, one month of observations, one source, one project file). Tooling enumerates parts by glob (`<basename>-part-*.md`) and verifies via `group_id`.
- `part` — 1-indexed chunk number within the group.

Optional:

- `total_parts` — total number of chunks in the group. Convenience; tooling may enumerate via glob if omitted.

Each chunk is self-contained in metadata so an agent can read just one without needing a manifest file.

## Discipline

Three rules govern agent-authored writes. Each addresses a specific failure mode.

### Verbatim body

**Rule:** when an agent writes an observation, the body is a direct quote from the conversation — the user's words or the agent's own words that the user affirmed. No paraphrase, no compression, no invention.

**Failure mode addressed:** *factuality hallucination* (agents fabricating user statements that didn't happen).

**Example:**

```markdown
# WRONG (paraphrased)
The user prefers concise responses without softening.

# RIGHT (verbatim)
"stop apologizing and just give me the answer"
```

### Anti-characterization (BIRP discipline)

**Rule:** tags and confidence describe observable behavior, not character traits or the agent's interpretation. Borrows directly from BIRP/DAP/SOAP conventions in clinical note-taking — "describe observable, measurable behaviors rather than interpretations."

**Failure mode addressed:** *character drift* — when the agent's reaction to the user contaminates how the user is represented in stored memory. The body might be a verbatim quote, but a tag like `abrasive` or `demanding` encodes the agent's judgment, not the user's nature. Future agents retrieve the tag and treat the user accordingly.

**Examples:**

```markdown
# WRONG (trait-level, agent-judgment)
tags: [abrasive-communication, difficult]

# RIGHT (behavior-level, observable)
tags: [working-style, correction]
```

The body might be the same verbatim quote in both cases. The difference is in how the agent files it.

**Coined for this spec:** *character drift* — the failure mode where an agent's reaction to a user becomes part of how the user is represented in agent-readable memory, biasing all future agent behavior toward that contaminated frame.

### Extract-not-summarize on retrospective recall

**Rule:** when an agent reads `conversations/*.md` files (the passive archive) to help the user, it surfaces verbatim quotes with file references and invites the user to read along. It does not summarize the archive unsupervised.

**Failure mode addressed:** *faithfulness hallucination* — agents producing plausible-sounding summaries of past conversations that don't match the source. Extractive recall is tautologically faithful; abstractive recall drifts.

**Example response from an agent asked "what did we decide about Project X last month?":**

```
Looking at conversations/2026-03-12-claude-ai-project-x-design.md, lines 42-58:

> [verbatim quote of the relevant exchange]

And in conversations/2026-03-19-claude-ai-project-x-followup.md, lines 12-20:

> [verbatim quote]

Reading these directly is more reliable than letting me summarize.
Want me to pull more passages or do you want to read the files first?
```

## Confidence scale (five grades)

A confidence value attached to an observation describes how strongly the observation is supported by evidence in the conversation. Not the agent's emotional certainty; not how strongly the agent believes the user; how much grounded support exists.

- `very-low` — fleeting impression, weak evidence, might not hold.
- `low` — possibly true, one data point, matches a pattern.
- `medium` — probably true, consistent across moments.
- `high` — clearly stated by the user or observed repeatedly.
- `very-high` — explicitly confirmed, identity-level claim.

Five grades replace v1.0's three because three collapsed too many distinct levels of evidentiary strength. v1.0 observations with `low | medium | high` remain valid.

## Recency, corroboration, and promotion

Observations compete for attention. Not all observations are equally relevant over time. Two mechanisms govern which observations shape agent behavior:

### Recency decay

Observations lose relevance as they age. The default decay follows a half-life of 30 days: an observation's effective score is multiplied by `0.5^(age_in_days / 30)`. After 90 days an observation has dropped to ~12.5% of its original weight. This is a deterministic rule, not a learned model — any agent or tool can compute the same score from the observation's date.

Decay prevents the "first observation wins" failure mode, where an early, possibly wrong observation crystallizes into permanent behavior because it was written first.

### Cross-source corroboration

An observation whose tag-cluster appears across ≥2 distinct sources is considered corroborated. Corroborated observations receive a bonus in retrieval scoring (e.g. +1.0 in role-aligned bootstrap selection) because independent agents agreeing on a pattern is stronger evidence than a single agent's impression.

The tag-cluster key is the sorted, lowercased tag list. Two observations with tags `[working-style, terse]` and `[working-style, terse]` from different sources corroborate each other even if their bodies differ.

### Promotion

An observation may be "promoted" to stable-file status (e.g. `identity.md` or `working-style.md`) when it meets a threshold of corroboration + recency. The exact threshold is tooling-defined; the spec does not mandate a specific count. The principle is: stable files hold claims the swarm agrees on, observations hold provisional claims.

Promotion is always a deliberate act — either the user edits the stable file by hand, or an agent proposes a promotion and the user accepts. There is no automatic promotion pipeline.

## Tags

Defined separately in [tags-canonical-v1.md](tags-canonical-v1.md). Per-vault tag registry lives in `tags.md` at vault root and inherits from the canonical list.

Two patterns:

- **Flat tags** for cross-cutting concepts: `working-style`, `preference`, `correction`, `interest`.
- **Namespaced tags** for instances: `relationship:<name>`, `project:<slug>`, `framework:<slug>`, `scope:<name>`.

Anti-characterization applies: tags name observable behavior or topic, never trait or judgment.

## Scopes

Optional. If `scopes.md` exists at vault root, it declares named scopes and which folders each includes. The active scope for a session is set by the host application (MCP client, browser extension, CLI flag). Tools must not read or write outside the active scope.

Scopes apply to both passive and active layers. A `sensitive` scope can include selected `conversations/*.md` files (e.g., via a `conversations/sensitive/` subfolder), keeping them out of session bootstraps where the user has chosen narrower scope.

If no `scopes.md` exists, the default scope is the entire vault.

## Source/extract split (within the active layer)

When a curated observation references a long captured response (over ~500 chars by default), the verbatim text lives in `sources/` and the observation in `observations/YYYY-MM.md` carries an extract plus a `source_ref:` pointer.

**Source file location:** `sources/<filename>.md` (e.g., `sources/2026-04-21-claude-ai-design-discussion.md`).

**Source file frontmatter:**

```yaml
---
schema: whitebox/1.1
kind: source
date: 2026-04-21
source: claude.ai
captured_at: 2026-04-21T22:53:04Z
captured_by: whitebox-extension
---

<verbatim body, unmodified from capture>
```

**Threshold.** The 500-char default is a soft guideline implementations may follow. Per substrate-not-policy: the user or agent may split shorter content if they want to preserve a long-form source for audit, or keep longer content single-file if that fits the moment.

**Source files are append-only in the strictest sense.** Never edited after initial write. If a correction is needed, write a new source file; the original stays.

## Synthesis tier

The synthesis tier is the swarm's collaborative profile-building loop. Individual agents read observations and produce condensed "current state" documents. These are explicitly marked as derived/agent-generated — the user can reject, edit, or accept them.

### Why a synthesis tier

As observations accumulate, the raw observation stream becomes too large for session bootstraps (LaMP saturation at k=4-10; Lost in the Middle degradation past ~20 chunks). A synthesis is a curated condensation: the swarm's best current model of the user, already the right shape for injection into a context window.

### Storage layout

```
synthesized/
  profile-YYYY-MM-DD.md          — final, merged synthesis
  drafts/
    <source>-YYYY-MM-DD.md       — per-agent draft
```

Final syntheses are named `profile-<date>.md`. Drafts are named `<source>-<date>.md` where `<source>` is the agent identifier (e.g. `claude`, `kimi`). Both use the same frontmatter schema.

### Synthesis frontmatter schema

```yaml
---
synthesized_at: 2026-04-25T22:30:00Z
synthesized_by: [claude, kimi]
derived_from: [observations/2026-04.md#1, observations/2026-04.md#2]
version: 3
---
```

- `synthesized_at` — ISO-8601 timestamp of when this synthesis was written.
- `synthesized_by` — array of source identifiers that contributed to this synthesis.
- `derived_from` — array of observation IDs that contributed. Format: `observations/YYYY-MM.md#N` (1-indexed entry within the monthly file).
- `version` — monotonic version number (1, 2, 3...). Drafts use version 0.

### Lifecycle

1. **Trigger** — `evaluateSynthesisTriggers()` detects when re-synthesis should fire (volume ≥20 new observations, life-event tag, tag drift, demotion, or 90-day time fallback).
2. **Draft** — Each agent reads recent observations + identity + working-style, produces a draft in `synthesized/drafts/`.
3. **Merge** — `mergeDrafts()` combines multiple drafts into a single candidate synthesis: sectioned body with per-agent attribution headers, union of `derived_from` and `synthesized_by` with first-appearance deduplication, per-source contribution stats.
4. **Review** — The user (or a user-approved agent) reviews the candidate and decides to accept, edit, or reject.
5. **Write** — Accepted synthesis is written to `synthesized/profile-<date>.md` with the next version number.

Merge is mechanical, not LLM-mediated. The agents have already done the hard work of writing their drafts; merge is attribution + union + deduplication. If the user wants a smarter merge, they invoke an LLM-based one explicitly.

### Bootstrap selection

At session start, agents prefer the latest synthesis when it is fresh (default: within 30 days). If the synthesis is stale or none exists, they fall back to role-aligned observations (own-source continuity + cross-source corroborated clusters). This three-tier priority keeps bootstraps signal-dense while preserving agent continuity.

## Reactions tier

The reactions tier is emergent annotation without violating append-only. Agents (or the user) can mark reactions on observations — agreement, contradiction, narrowing, supersession — without editing the observation file.

### Why a reactions tier

Observations are append-only and immutable. But the swarm needs a way to evolve its assessment of observations over time. A reaction says "we now think this observation is contradicted by later evidence" without erasing the original observation. The original stays; the reaction adds a new layer of interpretation.

### Storage layout

```
reactions/
  <observation-id>/
    <source>-<date>.md
```

- `observation-id` — sanitized observation identifier (e.g. `observations_2026-04_3` for `observations/2026-04.md#3`).
- `<source>-<date>.md` — one reaction file per (source, date) pair.

### Reaction frontmatter schema

```yaml
---
date: 2026-04-25
source: claude
observation_id: observations/2026-04.md#3
kind: agreed
---

Optional free-form note explaining the reaction.
```

### Reaction kinds

- `agreed` — the reacting agent independently corroborates this observation.
- `contradicted` — later evidence contradicts this observation.
- `context-narrowed` — the observation is valid but only in a narrower context than originally tagged.
- `superseded` — a later observation or synthesis replaces this one; keep for history but don't use for behavior.

Reactions are themselves observations about observations. They participate in the same recency decay and corroboration rules. A `contradicted` reaction from ≥2 sources is stronger evidence than one from a single source.

## Compatibility with v1.0

Fully backward-compatible:

- v1.0 observations without `source_ref:` continue to work — body is the verbatim content, no source lookup.
- v1.0 vaults without `conversations/` continue to work — passive layer is optional infrastructure.
- v1.0 confidence values (`low | medium | high`) remain valid; v1.1 adds `very-low | very-high` as new permitted values.
- v1.0 tooling reading a v1.1 vault sees unrecognized fields (`source_ref`, `kind: conversation-log`, etc.) and should ignore them rather than fail.

No migration required. v1.1 is what new vaults seed; existing vaults gain v1.1 features as the user adopts them.

## Reserved frontmatter fields (additions to v1.0)

- `kind` — file kind declaration. Values: `source`, `observation`, `conversation-log`, `synthesis`, `reaction`. Optional.
- `source_ref` — relative path to a source file from an observation. Optional on observations.
- `captured_at` — ISO 8601 timestamp of capture. Optional on sources and conversation logs.
- `captured_by` — identifier of the capture tool. Optional on sources and conversation logs.
- `conversation_url` — stable URL of the capture's origin. Optional on conversation logs.
- `model` — model identifier. Optional on conversation logs.
- `group_id` — stable identifier shared by all parts of one logical group (one conversation, one month of observations, one source, one project file). Required on any chunked file. See **File chunking**.
- `part` — chunk number (1-indexed) within a chunked file group. Required on any chunked file.
- `total_parts` — total number of chunks in the group. Optional convenience; tooling may enumerate via glob if omitted.
- `scope` — named scope from `scopes.md`. Optional on any file.
- `context` — situational scope narrowing when an observation applies. Optional on observations. See **Active memory** above for examples.
- `synthesized_at` — ISO-8601 timestamp of synthesis creation. Required on synthesis files.
- `synthesized_by` — array of source identifiers that contributed to a synthesis. Required on synthesis files.
- `derived_from` — array of observation IDs that contributed to a synthesis. Required on synthesis files.
- `version` — monotonic version number for syntheses. Required on synthesis files.
- `observation_id` — reference to the observation being reacted to. Required on reaction files.

All v1.0 reserved fields (`schema`, `date`, `source`, `tags`, `confidence`, `status`) are unchanged.

## Implementation status

Reflects what's built as of this spec's adoption.

| Area | Status |
|---|---|
| Active layer storage format | Built (v1.0) |
| Active layer real-time capture (browser extension) | Built — Capture, Session Digest |
| Active layer real-time capture (MCP) | Built — `append_observation` tool |
| Five-grade confidence scale | Built |
| Verbatim body discipline | Built (enforced via documentation; tooling does not validate) |
| Anti-characterization discipline | Built — documented in this spec and AGENTS.md; tooling does not validate |
| Recency decay (half-life) | Built — deterministic scoring in `recency.ts` |
| Cross-source corroboration | Built — tag-cluster matching in `vault-core.ts` |
| Role-aligned bootstrap selection | Built — `readRoleAlignedObservations()` in `vault-core.ts` |
| Synthesis tier (drafts, merge, final) | Built — `synthesis.ts`, `merge.ts`, `synthesis-triggers.ts` |
| Synthesis triggers | Built — `evaluateSynthesisTriggers()` with 5 trigger types |
| Bootstrap prefers synthesis | Built — `readBootstrapContent()` in `vault-core.ts` |
| Demotion review (stale facts) | Built — `demotion.ts` + `list_stale_facts` MCP tool |
| Reactions tier | Built — `reactions.ts` with 4 reaction kinds |
| Vault health introspection | Built — `vault_health` MCP tool |
| Asymmetric scope grants | Built — `grants:` field in `scopes.md` |
| Source/extract split | Specified, not yet implemented in tooling |
| Passive layer storage format | Specified, not yet implemented in tooling |
| Passive layer auto-log (browser extension) | Not yet implemented |
| Passive layer retrieval (CLI: `whitebox log`, `whitebox grep`) | Not yet implemented |
| Passive layer import (CLI: `whitebox log --import`) | Not yet implemented |
| Promotion flow (passive → active) | Not yet implemented |
| Retention / pruning tooling | Not yet implemented |

Implementation proceeds in roughly the order shown above, prioritized by user demand. The spec is the contract; tooling fills in the contract over time.

## Prior art

The architecture borrows from three lineages:

- **Letta / MemGPT** — core memory vs archival memory split ([Letta docs](https://docs.letta.com/concepts/memgpt/)). Direct architectural precedent for the two-layer split. WhiteBox differs by making *curation* (who chose to load it and when) the defining axis rather than storage location.
- **Zettelkasten** — fleeting notes vs permanent notes (Ahrens, *How to Take Smart Notes*, 2017). Human-scale precedent for the curate-narrow-from-wide-capture pattern.
- **Generative Agents** (Park et al., 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) — memory stream + reflection model. Closest agent-system precedent.

Discipline rules borrow from:

- **BIRP / DAP / SOAP** — clinical note conventions for behavior-not-trait documentation. Direct precedent for the anti-characterization rule.
- **Faithfulness hallucination** literature (ACM TOIS survey on LLM hallucination) — well-established concept the extract-not-summarize rule addresses.
- **LaMP** ([arXiv:2304.11406](https://arxiv.org/abs/2304.11406)) and **Lost in the Middle** ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172)) — empirical evidence that small, well-selected context outperforms large dumps. Justification for keeping the active layer signal-dense and not auto-loading the passive archive.

### Character drift / persona drift / memory-induced sycophancy — what the literature actually says

This spec previously claimed "character drift" was coined here. Subsequent review found the failure mode is well-named in existing literature; we just hadn't searched widely enough. WhiteBox's contribution is **storage-layer mitigation** (verbatim-only observations, source stamping, audit trail, cross-source corroboration before promotion), not the discovery of the phenomenon. Honest framing:

- **Persona drift.** Documented LLM phenomenon: instruction-tuned models progressively deviate from the intended persona over a conversation. Recent work measures 20-40% turn-by-turn drops in "Assistant Axis" projection over 10-15 turns in therapy / philosophy domains, coinciding with emergent mystical, delusional, or self-harming outputs. See the [persona drift survey on Emergent Mind](https://www.emergentmind.com/topics/persona-drift) and [persona-vector work (arXiv:2604.17031)](https://arxiv.org/html/2604.17031).
- **Memory-induced sycophancy.** Personalization features measurably increase agreeableness; user context in long-term memory increases mirroring. RLHF installs a preference gradient that systematically rewards responses humans rate as agreeable, helpful, and warm — a property of the fine-tuned weight distribution, not just a prompting artifact. See [MIT News on personalization and agreeableness](https://news.mit.edu/2026/personalization-features-make-llms-more-agreeable-0218) and [Sycophancy is Not One Thing (arXiv:2509.21305)](https://arxiv.org/html/2509.21305v1).
- **Memory security failure modes.** The [Mnemonic Sovereignty survey (arXiv:2604.16548)](https://arxiv.org/html/2604.16548v1) names four classes of failure that arise from ordinary operation of memory-augmented agent systems: silent cross-user contamination of shared stores, over-application of profile facts to contexts where they no longer hold, memory-induced sycophancy, and structural drift. WhiteBox's design directly addresses three of the four:
  - **Cross-user contamination**: prevented by single-tenant vault on user's disk
  - **Over-application of stale facts**: addressed by recency decay + demotion review (P2.6)
  - **Memory-induced sycophancy**: limited by verbatim-only discipline + cross-source corroboration before promotion
- **Structural drift.** Recent medical-research preprint ([medRxiv 2026](https://www.medrxiv.org/content/10.64898/2026.03.19.26346371v1.full)) documents 31.6% of LLM exchanges expanding interpretations beyond the user's original concerns. Addressable at the storage layer by anti-characterization tag discipline (BIRP/DAP/SOAP-style behavior-not-trait tagging).

**WhiteBox's actual novelty is the *combination*:** verbatim-quote invariant + source stamping + cross-source corroboration + recency decay + scoped agent visibility, applied to a portable plain-text vault. No single piece is new. The composition — a discipline that makes these failure modes harder to silently produce — is the contribution.

## What this spec does not define

- **Client transports.** MCP, filesystem, paste-in, browser extension, custom — all valid.
- **Retrieval strategies.** Each agent decides what to load and how. The spec defines format, not behavior.
- **Sync.** git, Syncthing, iCloud, Dropbox, Obsidian Sync, none — user's choice.
- **Editor.** Obsidian, VS Code, Typora, plain text, no editor — all work.
- **Policy.** When to log. When to prune. What to mark sensitive. What's worth remembering. All negotiated between user and agent in real time, not pre-legislated here.

## Versioning

This document defines schema version `1.1`. Files declare their schema version in frontmatter:

```yaml
schema: whitebox/1.1
```

Files without a declared version are assumed to follow the latest version their vault was created under. Future versions will be additive: v1.x can never remove a field, rename a value, or require migration. v2.0 would require a migration tool and a real reason; not anticipated.
