# WhiteBox — Quick start

Set up WhiteBox end-to-end in about 10 minutes. This guide is linear on purpose; it's also designed so you can paste it into any AI agent and say *"help me install WhiteBox on [Windows / macOS / Linux]"* and it will walk you through from here. No shame in that — WhiteBox is a tool for AI-heavy users; using AI to set it up is on-brand.

## What you'll have when you're done

- A vault folder on your disk holding markdown files about you (who you are, how you want to be worked with).
- The WhiteBox CLI (`whitebox`) for vault creation and paste-in bundles.
- The WhiteBox MCP server, wired to Claude Desktop or Claude Code, so Claude can read and write to your vault automatically.
- The WhiteBox browser extension, so claude.ai, ChatGPT, and Gemini all pick up your vault when you start a conversation.
- Same markdown vault, every agent you use. That's the whole thing.

## Before you start

You'll need:

- **Node.js 18+** — install from [nodejs.org](https://nodejs.org) if you don't have it. Any LTS version works.
- **A Chromium-based browser** — Chrome, Edge, Brave, Arc, or Vivaldi. Firefox and Safari aren't supported yet.
- **A terminal** you're comfortable opening — PowerShell or Command Prompt on Windows, Terminal.app on macOS, any shell on Linux.
- **~10 minutes** of attention.

## Step 1 — Clone the repo

```bash
git clone https://github.com/FreyjaNellora/WhiteBox.git
cd WhiteBox
```

If you don't have git, download the ZIP from the GitHub page and extract it. Then `cd` into the folder in your terminal.

## Step 2 — Install the CLI

```bash
cd whitebox-cli
npm install
npm run build
```

You now have a built CLI at `whitebox-cli/dist/index.js`. Run it via:

```bash
node bin/whitebox.js --help
```

If you want `whitebox` on your PATH globally:

```bash
npm link
```

Then `whitebox` works from any directory. (On Windows, you may need to run the terminal as Administrator for `npm link` to succeed.)

> **Windows + OneDrive users:** If your Documents or Desktop folder syncs to OneDrive, **do not create your vault there**. OneDrive's on-demand file caching causes intermittent read failures when the extension or MCP server tries to access vault files. Create your vault outside OneDrive — for example, `C:\Users\<you>\whitebox-vault` (the default) is safe as long as your user profile root isn't OneDrive-synced. The same applies to the MCP server build output in Step 4.

## Step 3 — Create your vault

```bash
whitebox init
```

With no arguments, this creates your vault at `~/whitebox-vault` (Linux/macOS) or `C:\Users\<you>\whitebox-vault` (Windows). Want a different location? Pass a path:

```bash
whitebox init ~/my-ai-memory
```

Either way, the vault is seeded with `AGENTS.md`, `identity.md`, `working-style.md`, `tags.md`, `README.md`, and an empty `observations/2026-04.md`.

Open the vault in your editor of choice. Fill in `identity.md` and `working-style.md` with real content — who you are, how you want AI to work with you. See [docs/EDITOR_GUIDE.md](docs/EDITOR_GUIDE.md) for Obsidian / VS Code / Typora specifics.

## Step 4 — Install the MCP server (for Claude Desktop and Claude Code)

Back at the repo root:

```bash
cd ../whitebox-mcp
npm install
npm run build
```

The built server is at `whitebox-mcp/dist/index.js`. If you're on Windows and your repo is inside OneDrive, **copy the built server out of OneDrive** — OneDrive's file-on-demand caching has bitten us:

```bash
# Windows (PowerShell)
xcopy /E /I "dist" "$env:USERPROFILE\.whitebox-mcp\dist"
xcopy /E /I "node_modules" "$env:USERPROFILE\.whitebox-mcp\node_modules"
copy "package.json" "$env:USERPROFILE\.whitebox-mcp\package.json"
```

```bash
# macOS / Linux
mkdir -p ~/.whitebox-mcp
cp -r dist node_modules package.json ~/.whitebox-mcp/
```

Then wire it into Claude Desktop. Open (or create) `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add the `whitebox` server to the `mcpServers` block (create the block if it's not there):

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["<absolute path to .whitebox-mcp/dist/index.js>"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "<absolute path to your vault>"
      }
    }
  }
}
```

Example filled out (Windows):

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["C:\\Users\\you\\.whitebox-mcp\\dist\\index.js"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "C:\\Users\\you\\whitebox-vault"
      }
    }
  }
}
```

Fully quit Claude Desktop (tray → Quit, not just close window) and reopen. Settings → Developer → MCP Servers should show `whitebox` connected.

## Step 5 — Install the browser extension

From the repo root:

1. Open your browser and navigate to `chrome://extensions` (or `edge://extensions`, etc.).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the `whitebox-extension` folder from inside the repo.
5. Pin the WhiteBox icon to your toolbar (click the puzzle-piece icon → pin WhiteBox).

Click the WhiteBox icon → **Open setup…** → **Choose vault folder** → pick the vault you created in Step 3. Grant read/write access when prompted.

Back in the popup, flip the **Enable WhiteBox** toggle on and click **Save settings**.

## Step 6 — Verify

1. Open `https://claude.ai/new` in your browser.
2. Press F12 to open DevTools → Console tab.
3. Look for two log lines:
   - `[whitebox] claude.ai content script v0.3 live`
   - `[whitebox] claude.ai vault ready: whitebox-vault`
4. Type a short first message, e.g. *"Say hi and tell me what you know about me from my vault."* Hit Enter.
5. Before the message sends, you should see `[whitebox] claude.ai injected N chars of vault context` in the console.
6. Claude responds referencing what you wrote in `identity.md` and `working-style.md`.

If you see all of the above, you're running WhiteBox end-to-end.

## Troubleshooting

**"I don't see any `[whitebox]` logs on claude.ai."** → Extension isn't loading. Check `chrome://extensions` for a WhiteBox card with errors. Try removing and re-loading the folder.

**"`vault not accessible (no_handle)` or `(permission_lost)`."** → You haven't granted vault access, or the browser restart invalidated it. Click WhiteBox icon → Open setup → Choose vault folder.

**"No `injected` log on send."** → The extension found the vault but couldn't find the composer. Probably means claude.ai shipped a UI change and our selectors are out of date. Open an issue or update `src/content/claude-ai.js` and reload.

**"Claude Desktop doesn't show the whitebox MCP server."** → Fully quit and reopen Claude Desktop. If still missing, check the JSON is valid (paste it into any JSON validator). Common mistake: unescaped backslashes on Windows — use `\\` everywhere in JSON, or switch to forward slashes.

**"Cowork (scheduled tasks) starts failing after I added the MCP server."** → On Windows with the MCP server inside OneDrive: the on-demand file loading slows startup past Cowork's 30-second budget. Move the MCP server out of OneDrive per Step 4.

## Using ChatGPT and Gemini

Steps 5-6 validated claude.ai. ChatGPT and Gemini follow the same pattern automatically: the extension handles all three. Visit `https://chatgpt.com/` or `https://gemini.google.com/app/`, start a new conversation, type a first message, check the console for the same `injected` log.

If you're not a ChatGPT / Gemini user, skip this; WhiteBox on Claude alone is still a complete product.

## Connecting non-Claude agents

Claude Desktop is the smoothest integration because MCP is first-class there. Other agents vary in maturity. Concrete per-client guides below.

### Gemini CLI (full native MCP)

Drop-in. Gemini CLI reads the same kind of `mcpServers` block that Claude Desktop does.

Config file:
- macOS / Linux: `~/.gemini/settings.json`
- Windows: `C:\Users\<you>\.gemini\settings.json`

Add:

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["<absolute path to .whitebox-mcp/dist/index.js>"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "<absolute path to your vault>"
      },
      "timeout": 30000
    }
  }
}
```

Gemini CLI adds a few fields Claude Desktop doesn't have (`trust`, `includeTools`, `excludeTools`, `timeout`, `$VAR` env expansion). You can ignore those for a basic setup. Known gotcha: env vars here don't read from `.env` files — the values must be literal in this file or already in the shell environment.

Restart `gemini` after editing.

### ChatGPT Desktop and web (partial MCP via Developer Mode)

OpenAI's MCP story for consumer ChatGPT is different from Claude's. ChatGPT (web and Desktop — the Desktop app wraps the same web surface) supports user-added MCP servers, but **only over SSE / streamable HTTPS**, not over stdio. There's **no `mcpServers` config file**; registration happens through the UI, and the server must be reachable over the public internet.

Tier requirement: **Plus, Pro, Business, Enterprise, or Education.** Free tier doesn't get MCP.

**To connect `whitebox-mcp` to ChatGPT:**

1. Expose your local `whitebox-mcp` over HTTPS. The easiest path is a free ngrok or Cloudflare Tunnel:

   ```bash
   # first terminal — run the server on a local port
   WHITEBOX_VAULT_ROOT="<vault path>" node <path to .whitebox-mcp/dist/index.js> --transport sse --port 8787

   # second terminal — expose it
   ngrok http 8787
   ```

2. In ChatGPT: **Settings → Apps → Advanced settings → Developer mode** (toggle on).
3. **Settings → Connectors → Create**. Paste the public `/sse` URL from ngrok (e.g. `https://abc123.ngrok-free.app/sse`). Name it "WhiteBox."
4. Authorize. The connector becomes a tool ChatGPT can call.

See [docs/integrations/chatgpt-desktop.md](docs/integrations/chatgpt-desktop.md) for the full walkthrough.

### Custom Instructions bootstrap (ChatGPT web + mobile, Gemini web)

For consumer chat surfaces without MCP, paste a condensed version of your vault into the client's persistent instructions field once and it stays across sessions.

**ChatGPT Custom Instructions** — 1,500 characters per field, across both fields ("What would you like ChatGPT to know about you?" and "How would you like ChatGPT to respond?"). Same limit on Free, Plus, Pro. Settings → Personalization → Custom Instructions. Syncs to mobile automatically.

**ChatGPT Custom GPT** — ~8,000 characters in the Instructions field. Requires Plus/Pro/Team/Enterprise. Best for a persistent "WhiteBox-aware GPT" you use as your default.

**Gemini web** — "Saved info" serves roughly the same purpose. Length cap varies; aim for a condensed version of `identity.md` + top-line `working-style.md`.

Good bootstrap text to paste into any of these fields:

```
I maintain a portable memory vault in WhiteBox format.
Key facts: [one line summarizing identity.md]
Working style: [one line summarizing working-style.md]
Keep responses consistent with the above. If you don't have
access to my full vault in this session, acknowledge that
you're working from this summary.
```

Keep it short; aim for 500-800 chars so you have headroom.

### Mobile (paste-in only, for now)

No current consumer mobile AI app (ChatGPT mobile, Claude mobile, Gemini mobile, Copilot mobile) supports user-configured local MCP. Paths:

- **Custom Instructions** on ChatGPT/Gemini — synced from your desktop setup, works everywhere.
- **Paste-in via `whitebox paste`** from a terminal shortcut on your phone, or copy from a synced vault file opened in a mobile markdown editor.
- **A remote MCP server** you self-host and point Claude.ai mobile / ChatGPT mobile at (via connector / tunnel). More setup; handled by the planned WhiteBox paid tier.

Native mobile is a post-v1.0 roadmap item.

### Summary table

| Surface | MCP | WhiteBox path today |
|---|---|---|
| Claude Desktop | Full (stdio) | Config file in Step 4 above |
| Claude Code | Full (stdio) | `~/.claude/CLAUDE.md` bootstrap + MCP config |
| Cursor / Cline / Continue.dev | Full (stdio) | Same MCP server, each client's config |
| Gemini CLI | Full (stdio) | `~/.gemini/settings.json` as shown above |
| ChatGPT Desktop + web | Partial (HTTPS only, Plus+) | Developer Mode + SSE tunnel (once we ship SSE transport); paste-in until then |
| Gemini web | None | Custom Instructions bootstrap + browser extension |
| ChatGPT web | None | Custom Instructions bootstrap + browser extension |
| All mobile apps | None | Paste-in or Custom Instructions sync |

## Using WhiteBox without the extension (paste-in flow)

Every Chromium-based browser is supported; other browsers aren't yet. On platforms where you can't run the extension (Safari, Firefox, mobile browsers, command-line API clients), use the paste-in flow:

```bash
whitebox paste
```

This copies your vault context to the system clipboard. Paste it as the first line of your conversation with any AI. Works everywhere you can type.

## Keeping things in sync across devices

Your vault folder is just markdown. Sync it however you sync other folders:

- **git** — technical, version-aware, good default
- **Syncthing** — peer-to-peer, no cloud
- **iCloud / OneDrive / Google Drive / Dropbox** — works; OneDrive has known quirks on Windows
- **Obsidian Sync** — paid, encrypted

Pick one. Don't stack them — conflict hell.

See [docs/EDITOR_GUIDE.md](docs/EDITOR_GUIDE.md) for the full editor + sync discussion.

## How much to put in, how often to review

There's no published research-backed answer for either question for AI memory specifically. What the literature supports: personalization gains saturate at around 4-10 well-selected items per session (LaMP, Persona-Chat), and retrieval quality degrades past ~10-20 chunks regardless of context-window size ("Lost in the Middle"). See [docs/DESIGN.md](docs/DESIGN.md) for the citations.

Practically:

- **Aim for tight `identity.md` and `working-style.md` files.** A paragraph or two each is plenty. These get injected every session; keep them dense.
- **Let observations accumulate freely.** The archive can be big. Schema v1.1 ([spec/WHITEBOX_v1.1.md](spec/WHITEBOX_v1.1.md)) keeps long captures in a separate `sources/` archive and auto-logged conversations in a separate `conversations/` archive, so the active layer that loads at session start stays small.
- **Review cadence: when it feels wrong, plus optional weekly skim.** No research-backed interval exists. Tiago Forte and GTD both converge on weekly review for general PKM, but that's not AI-specific. Community reports suggest vendor memory systems (ChatGPT Memory etc.) noticeably accumulate stale entries at around 3-6 months — a reasonable upper bound for letting your vault drift before a cleanup pass.
- **Event-triggered review beats calendar-triggered.** Major life/work changes are when stale info actively hurts. A weekly calendar review catches those but so does just noticing when an agent says something outdated about you and going to fix it then.

## Where to go next

- **Edit your vault.** The value of WhiteBox is only as good as what's in `identity.md` and `working-style.md`. The default templates are stubs.
- **Try observation capture.** When an AI gives you a response you want to remember, click WhiteBox icon → **Capture last response**. Review, tag, save. Your vault grows as you use AI.
- **Read the other docs:**
  - [README.md](README.md) — project overview
  - [docs/PITCH.md](docs/PITCH.md) — what WhiteBox is and who it's for
  - [docs/COMPARISON.md](docs/COMPARISON.md) — how it compares to mem0, Letta, ChatGPT Memory, etc.
  - [docs/EDITOR_GUIDE.md](docs/EDITOR_GUIDE.md) — using your editor with the vault
  - [spec/WHITEBOX_v1.md](spec/WHITEBOX_v1.md) — the schema spec (for developers building integrations)

## If you got stuck

Paste this whole file into Claude / ChatGPT / Gemini along with the error you're seeing, and it will walk you through the specific step. WhiteBox users are a self-selected set of people who already live with AI — there's no shame in using it as the support channel.

If something's genuinely broken in WhiteBox itself (not a setup issue on your end), open an issue at `https://github.com/FreyjaNellora/WhiteBox/issues`.
