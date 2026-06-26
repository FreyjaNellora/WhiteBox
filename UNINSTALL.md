# Uninstalling WhiteBox

> **Your vault folder is yours. WhiteBox never deletes user data.**
>
> Uninstall removes WhiteBox software (the browser extension, the MCP server, the CLI, the Claude Code skill, and the browser's record of which folder is your vault). Your vault folder on disk — your `identity.md`, `working-style.md`, `observations/`, `audit/`, `conversations/`, everything — stays exactly where it is. You can open it in any text editor any time. If you ever want to delete it, you do that manually.

There are between one and four things to remove, depending on how much you installed. Skip the steps for things you didn't install.

---

## Step 1 — Reset the browser extension state (recommended before removing the extension)

This clears everything WhiteBox stored inside your browser: the vault grant, all settings, passphrase hash, lock state, danger toggles, bypass tier, conversation cache. It does **not** touch your vault folder.

1. Click the WhiteBox icon in your browser toolbar.
2. Scroll to the bottom of the popup → **Reset / uninstall** section.
3. Click **Reset extension state…**.
4. Confirm.

The popup will close. The extension is now in a clean-slate state.

> Skipping this step before removing the extension just means the IndexedDB and chrome.storage entries linger until Chrome's general garbage-collection runs (or until you reinstall the extension and they get reused). Not a big deal, but cleaner if you do it.

## Step 2 — Remove the browser extension

1. Open `chrome://extensions` in your browser (works in Chrome, Edge, Brave, Arc, Vivaldi, etc.).
2. Find **WhiteBox** in the list.
3. Click **Remove**.
4. Confirm.

Done. The extension is gone.

## Step 3 — Remove the MCP server (only if you installed it)

If you installed WhiteBox in Claude Desktop / Claude Code / Cursor / Gemini CLI via MCP, remove the entry from your client's config:

### Claude Desktop

Open the config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Find the `whitebox` entry inside `mcpServers` and remove it. The file should look like this **before** removal:

```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["/absolute/path/to/WhiteBox/whitebox-mcp/dist/index.js"],
      "env": {
        "WHITEBOX_VAULT_ROOT": "/absolute/path/to/whitebox-vault"
      }
    },
    "other-server": { ... }
  }
}
```

After removal:

```json
{
  "mcpServers": {
    "other-server": { ... }
  }
}
```

If WhiteBox was the only entry, you can remove the entire `mcpServers` object or leave it empty (`"mcpServers": {}`).

Save the file. Restart Claude Desktop.

### Cursor

Cursor stores MCP config in `~/.cursor/mcp.json`. Same pattern: remove the `whitebox` entry, save, restart Cursor.

### Claude Code

Claude Code reads its MCP config from your project's `.claude/mcp.json` or your global `~/.claude/mcp.json`. Same pattern.

### Gemini CLI

Gemini CLI's MCP config is in `~/.config/gemini-cli/mcp.json` (or similar). Same pattern.

## Step 4 — Remove the Claude Code skill (only if you installed it)

```bash
# macOS / Linux
rm -rf ~/.claude/skills/whitebox

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\skills\whitebox"
```

## Step 5 — Remove the repo and built artifacts

If you cloned the repo or downloaded the ZIP, the folder still exists on your disk with built CLI and MCP artifacts inside. To remove cleanly:

### One-shot uninstall script (recommended)

From the repo root:

```bash
# macOS / Linux
bash uninstall.sh

# Windows
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

The script asks for confirmation before removing built artifacts and the Claude Code skill, then prints what manual steps remain.

### Or do it manually

```bash
# macOS / Linux
rm -rf ~/path/to/WhiteBox

# Windows (PowerShell)
Remove-Item -Recurse -Force "C:\path\to\WhiteBox"
```

If the repo is the only thing left and your vault is in a different folder (e.g. `~/whitebox-vault`), removing the repo doesn't touch the vault.

## Step 6 — Your vault folder (only if you want to)

This is the part most uninstallers get wrong. WhiteBox treats your vault as **your data**, not part of the software. It survives uninstall by design.

If you want to keep it:

- Open it in any text editor any time.
- It's plain markdown — no proprietary format.
- Reinstall WhiteBox later and reconnect to the same folder; everything you saved will still be there.
- Sync it (git, Dropbox, iCloud, Syncthing, whatever) and use it across devices.

If you want to delete it:

```bash
# macOS / Linux
rm -rf ~/whitebox-vault   # or wherever yours lives

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\whitebox-vault"
```

That last command is the only one in this entire walkthrough that destroys data. WhiteBox itself never runs it.

---

## What's left behind?

After all of the above, the following may still exist depending on your platform:

- **Chrome's extension storage area** — Chrome's general housekeeping eventually clears this, but if you ran Step 1 (Reset extension state) before removing the extension, it's already empty.
- **Browser cache for the extension's resources** — irrelevant; cleared on next browser cleanup cycle.
- **Node.js itself** — installed independently; we don't touch it.
- **Anthropic / OpenAI / Google account-side data** — anything you said in your conversations with Claude / ChatGPT / Gemini lives in those vendors' systems, governed by their privacy policies. WhiteBox can't reach into vendor servers; that's between you and them.

---

## Coming back later?

Re-installing WhiteBox is the same as installing for the first time:

1. Get the repo (clone or ZIP).
2. Load the extension via `chrome://extensions` → Load unpacked.
3. Click the icon → **Open setup…** and pick your vault folder again. If you kept the vault folder, the wizard will detect the existing files and connect; nothing is lost.

See [INSTALL_FOR_FRIENDS.md](INSTALL_FOR_FRIENDS.md) for the friendly install walkthrough.

---

## If something goes wrong

If `Reset extension state…` errors out, just remove the extension via `chrome://extensions` directly. Chrome will handle cleanup. The IndexedDB and chrome.storage entries are scoped to the extension; once it's removed, they're orphaned and eventually cleaned up.

If you can't find your Claude Desktop config file path, the [official Claude Desktop docs](https://docs.claude.com/en/docs/claude-code/mcp) have the latest locations per platform.

If you want to keep WhiteBox but disconnect it from a specific vault, use the popup's **Clear** button next to the vault name (in the Vault section) instead of doing a full reset.
