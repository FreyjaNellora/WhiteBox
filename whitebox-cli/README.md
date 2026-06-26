# whitebox-cli

Universal CLI for WhiteBox portable user-memory vaults. Works with any agent on any platform — CLI is the lowest common denominator that doesn't need MCP, browser extensions, or vendor cooperation.

## Commands

| Command | Status | Purpose |
|---|---|---|
| `whitebox init <path>` | ready | Create a vault skeleton at the target path. |
| `whitebox export` | ready | Emit a paste-in bundle to stdout. |
| `whitebox paste` | ready | Copy the paste-in bundle to the system clipboard. |
| `whitebox import <file>` | planned | Ingest a Claude.ai / ChatGPT conversation export and propose observations. |

## `whitebox export` usage

```bash
whitebox export --vault ~/whitebox-vault --include-observations 5
```

Prints a context bundle to stdout — the same shape the browser extension prepends to your first message. Use in shell pipelines, or redirect to a file:

```bash
whitebox export > context.md
```

Options:

- `-v, --vault <path>` — vault directory. Defaults to `$WHITEBOX_VAULT_ROOT` or the current directory.
- `-s, --scope <name>` — restrict to files within the named scope.
- `--include-observations <n>` — number of most recent observations to include in the bundle. Default 5.

## `whitebox paste` usage

```bash
whitebox paste --vault ~/whitebox-vault
```

Same bundle as `export`, but copies to your system clipboard so you can paste into any chat UI. Uses `pbcopy` on macOS, `clip.exe` on Windows, `wl-copy`/`xclip`/`xsel` on Linux — no npm dependency.

Same options as `export`.

Use this when the browser extension isn't available (Claude mobile, a third-party chat client, a new platform we haven't ported to). It's the universal fallback that works anywhere you can paste text.

## Install

Until published to npm, install from source:

```bash
cd whitebox-cli
npm install
npm run build
npm link
```

That puts `whitebox` on your PATH.

## `whitebox init` usage

```bash
whitebox init ~/whitebox-vault
```

Creates:

```
~/whitebox-vault/
  AGENTS.md
  identity.md
  working-style.md
  tags.md
  README.md
  observations/
    YYYY-MM.md
  relationships/
  projects/
```

Re-runs with `--force` overwrite existing files. Without `--force`, existing files are preserved.

## Design

- Templates are inlined as string constants so the CLI ships as a single npm package with no data directories.
- All commands operate on plain markdown files. No hidden state, no lock files, no vault-specific config to maintain.
- Import flow proposes observations for review; never writes directly without user approval (matching the schema's append-only discipline).

## License

MIT.
