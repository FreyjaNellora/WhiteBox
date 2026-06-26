# whitebox-mcp

MCP server for the [WhiteBox](../README.md) portable user-memory vault. Exposes four tools that let any MCP client (Claude Desktop, Claude Code, Cursor, and others) read and write to a WhiteBox vault on the user's local disk.

## What it does

- `read_file` — load any markdown file from the vault by relative path.
- `list_files` — enumerate vault contents, optionally scoped to a subdirectory.
- `append_observation` — append a single, properly-formatted observation to the current month's `observations/YYYY-MM.md`. Creates the file if it doesn't exist.
- `propose_stable_edit` — write a proposal to `proposed/` for the user to review and apply manually. Stable files are never silently overwritten.

Also exposes every vault markdown file as an MCP resource under `whitebox://<relative-path>` so clients that support resource attachment can pin files into agent context.

## Guarantees

- **Path-safety.** Absolute paths and `..` traversals are rejected before any filesystem call.
- **Append-only observations.** The server never rewrites existing observations in monthly files.
- **Stable files are not clobbered.** Proposed edits go to a separate `proposed/` folder the user reviews.
- **Scope-aware.** If the vault has a `scopes.md` and `WHITEBOX_SCOPE` is set, reads and writes outside the active scope are refused.

## Install

```bash
cd whitebox-mcp
npm install
npm run build
```

The build produces `dist/index.js`. You can run it directly:

```bash
WHITEBOX_VAULT_ROOT=/absolute/path/to/vault node dist/index.js
```

## Configuration

Two environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `WHITEBOX_VAULT_ROOT` | yes | Absolute path to the vault directory (contains `AGENTS.md`, `identity.md`, etc.) |
| `WHITEBOX_SCOPE` | no | Name of the active scope for this session. Must match a scope declared in `scopes.md` if that file exists. |

## Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add this to the `mcpServers` block:

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["C:\\path\\to\\whitebox-mcp\\dist\\index.js"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "C:\\path\\to\\your\\vault"
      }
    }
  }
}
```

On macOS / Linux, use forward-slash paths and leave `\\` as single `/`.

Restart Claude Desktop. Confirm connection by checking Settings → Developer → MCP Servers. The server should be listed and connected.

## Claude Code

Two options:

### Option A — project-local (per repo)

Add a `.mcp.json` file at your repo root:

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["C:\\path\\to\\whitebox-mcp\\dist\\index.js"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "C:\\path\\to\\your\\vault"
      }
    }
  }
}
```

### Option B — global (all sessions everywhere)

Use the `claude mcp add` CLI:

```bash
claude mcp add whitebox node C:\\path\\to\\whitebox-mcp\\dist\\index.js \
  -e WHITEBOX_VAULT_ROOT=C:\\path\\to\\your\\vault
```

## Bootstrapping the agent

For maximum value, also add one line to `~/.claude/CLAUDE.md` (or your platform's equivalent global instruction file):

```markdown
Before responding, read `AGENTS.md` from the WhiteBox vault via the `whitebox` MCP server for user context that applies across all projects.
```

This makes every new Claude session start with the vault oriented. Project-level `CLAUDE.md` files are untouched.

## Verifying

Smoke-test against the reference vault in this repo:

```bash
cd whitebox-mcp
node smoketest.mjs
```

The test exercises every tool, verifies the path-traversal and absolute-path guards, and cleans up after itself. It should print `All smoke tests passed.` at the end.

## Troubleshooting

- **"WHITEBOX_VAULT_ROOT environment variable is required"** — set the env var in your MCP client config's `env` block.
- **"Vault root does not exist"** — the path in `WHITEBOX_VAULT_ROOT` doesn't exist on disk. Create the directory and at minimum place an `AGENTS.md` inside it. See `vault-example/` in this repo for a minimal layout.
- **"Unknown scope"** — you set `WHITEBOX_SCOPE` but the vault's `scopes.md` doesn't define that scope. Check the scope name, or remove `WHITEBOX_SCOPE` to run without scope restriction.
- **Windows paths in JSON** — double-backslash every separator (`C:\\path\\to\\thing`) in JSON config files, or use forward slashes (`C:/path/to/thing`) which work fine in Node.
- **Server "connected" but tools don't appear** — restart the MCP client. Claude Desktop in particular caches tool lists at session start.

## What's deliberately not here (yet)

- No promotion-of-observations logic — that's the inspector's job (v0.3 Obsidian plugin).
- No conflict detection across stable files — v0.3.
- No tag curation UI — edit `tags.md` by hand for now.
- No browser extension or non-MCP transport — see main README roadmap.

## License

MIT.
