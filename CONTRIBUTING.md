# Contributing to WhiteBox

WhiteBox is a portable user-memory layer for AI agents. It succeeds only if the schema and tools are trusted by multiple independent contributors. Community contribution is welcome across every layer.

This doc tells you what we want, how to propose it, and what the review bar looks like.

## What we want

### High-value, easy to accept

- **Per-site DOM selectors for the browser extension.** When claude.ai, chatgpt.com, or gemini.google.com ships a UI change and the extension stops injecting, the fastest fix is a PR from whoever hits it first. Look in `whitebox-extension/src/content/`. Update `findComposer()`, `isSendButton()`, or `isNewConversation()` for the affected site. Test locally by loading unpacked and confirming `[whitebox] ... injected N chars of vault context` fires.
- **Integration recipes.** "Here's how I wired WhiteBox into Cursor / Cline / Zed / emacs." A markdown file under `docs/integrations/<tool>.md` with install steps and screenshots. These compound as the ecosystem grows.
- **Translations** of QUICKSTART.md or AGENTS.md into other languages. Put under `docs/i18n/<lang>/`.
- **Bug reports** with reproduction steps. Log under Issues.

### Medium-stakes, needs discussion first

- **Canonical tag proposals.** Before opening a PR, start a GitHub Discussion in the `Tag proposals` category. See [spec/tags-canonical-v1.md](spec/tags-canonical-v1.md) for criteria.
- **New CLI subcommands.** Open an issue describing the command, its flags, and the problem it solves. Get maintainer agreement before writing code.
- **Obsidian / VS Code / Logseq plugins.** Scaffold in a `whitebox-obsidian/` (etc.) top-level folder. Coordinate with maintainers to avoid duplicate work.

### Schema-level changes (high bar)

- **Schema additions.** Propose via a new `spec/WHITEBOX_v<next>-proposal.md` file. Discussion first, then a draft, then a review period, then ratification (the proposal file gets renamed to `spec/WHITEBOX_v<next>.md` on ratification, replacing the proposal). See [spec/WHITEBOX_v1.1.md](spec/WHITEBOX_v1.1.md) for an example of a ratified spec.
- **Schema breaking changes.** Will effectively never happen. v1.x is additive-only; v2.0 would require a migration tool and a real reason.
- **Governance changes.** Currently BDFL; any shift (adding maintainers, forming a council) is a separate proposal in `docs/GOVERNANCE.md` (not yet written, write it if you have a proposal).

## How to propose

- **Quick fix** (selector update, typo, small bug) → PR directly against `main`. Reference any relevant issue. Describe what you tested.
- **New feature or recipe** → open an issue first. Maintainer confirms scope. Then PR.
- **Canonical tag proposal** → GitHub Discussion in `Tag proposals` category. See [spec/tags-canonical-v1.md](spec/tags-canonical-v1.md#proposing-new-canonical-tags).
- **Schema proposal** → PR a new `spec/WHITEBOX_v<next>-proposal.md` file. Don't touch existing frozen spec docs.
- **Governance proposal** → open an issue, discuss in public.

## What we won't merge

- **Telemetry, analytics, or phone-home code.** WhiteBox runs locally. This is non-negotiable. No crash reporters, no usage stats, nothing that sends data to any server the user didn't explicitly connect to.
- **Vendor-specific lock-in.** No code that makes WhiteBox work better with one AI vendor at the cost of working with others. Cross-vendor is the point.
- **Embeddings or training as core architecture.** A learned model sitting on top of the vault as a derived artifact is fine; a learned model as the storage layer isn't. See [docs/DESIGN.md](docs/DESIGN.md).
- **Closed-source dependencies for core functionality.** OK for optional integrations (e.g. a paid sync service); not OK for the CLI, MCP server, extension core, or schema.
- **Features that require a hosted WhiteBox service to work at all.** Paid-tier convenience features are fine; the free core stays self-contained.

## Code standards

- **TypeScript** for the MCP server and CLI. Plain JavaScript (Manifest V3 friendly) for the browser extension content scripts.
- **No npm dependencies you don't need.** Each added dep is reviewed for necessity and maintenance status.
- **Fail safe.** Code that touches user data or modifies conversations must never break the user's workflow silently. Log the error; pass through unchanged.
- **Path safety.** Any filesystem access needs path-traversal and absolute-path guards. See `whitebox-mcp/src/vault.ts` for the pattern.
- **Verbatim-only rule for agent writes.** Any agent-facing code that writes to the vault must write verbatim content, never summaries or inventions. See [vault-example/AGENTS.md](vault-example/AGENTS.md).

## Review bar

- **Selector updates** — merged within hours if they plausibly work, tested by next user.
- **Bug fixes** — maintainer reviews within a week, merged if it passes smoke tests.
- **Features** — reviewed after an issue-first discussion has happened. Maintainer response within a week.
- **Schema proposals** — held for at least a 2-week review window. Ratification requires no unaddressed concerns.

Maintainer (FreyjaNellora) reviews at indie-developer cadence, not enterprise cadence. If something's been sitting a week with no response, ping on the issue.

## Conduct

Be honest, be direct, don't waste people's time. Don't make contributors feel stupid for being new. Don't make maintainers feel unappreciated. Contributions are accepted or rejected on merit and fit, not on the contributor's identity or tone.

No code of conduct document yet. If the project grows to need one, we adopt [Contributor Covenant](https://www.contributor-covenant.org/) as the default.

## Development setup

See [QUICKSTART.md](QUICKSTART.md) for end-user install. For development:

```bash
git clone https://github.com/FreyjaNellora/WhiteBox.git
cd WhiteBox

# CLI
cd whitebox-cli && npm install && npm run build

# MCP server
cd ../whitebox-mcp && npm install && npm run build

# Browser extension — load unpacked from whitebox-extension/
```

Test changes against `vault-example/` or a throwaway vault at `~/test-vault` via `whitebox init ~/test-vault`.

## First contributions worth picking up

See [docs/COMMUNITY.md](docs/COMMUNITY.md) for a maintained list of "good first contributions" ranked by scope. Selectors and recipes are the easiest wins.

## Questions

Open an issue or a Discussion. Direct questions to maintainers are fine but public threads are better — someone else probably has the same question.

## License

MIT. Contributions are licensed the same way. By opening a PR you agree your contribution is MIT-licensed.
