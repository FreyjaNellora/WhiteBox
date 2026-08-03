# WhiteBox

> **Mission.** WhiteBox exists so the durable model an AI builds of *you* — your identity, memory,
> and working style — lives on hardware **you own and control**, never on someone else's server. As
> AI learns more about people, and a neural-and-affective data economy emerges (consumer EEG,
> neuromarketing), the most intimate class of personal data risks being harvested by default.
> WhiteBox keeps it **sovereign**: local, transparent, auditable, and yours to override or delete.
>
> Because that data is so sensitive, security is the point, not a feature. WhiteBox is a multi-agent
> system held to an adversarial standard — we red- and blue-team our own defenses rather than assume
> they work. See [SECURITY.md](SECURITY.md) and [docs/motivation.md](docs/motivation.md).

**Goals**
- **Data sovereignty** — you own the disk; nothing requires uploading the model of you.
- **Transparency** — plain text, a published schema, every change audited; no hidden model of you.
- **User authority** — agents propose, you veto; anything inferred about you is tagged and rejectable.
- **Proven, not assumed, security** — defenses verified adversarially, because the data demands it.

---

**A portable, transparent memory you own — plain markdown files on your disk that every AI you use can read and write.** One identity across Claude, ChatGPT, Gemini, Cursor, Kimi, and anything else that speaks the spec. No black-box memory, no vendor lock-in, no model of you that you can't open in a text editor.

> **Status:** `v1.0.0-prealpha` — design feature-complete and internally reviewed; independent external validation still pending. Expect iteration; not yet validated by external users.

**Pick your path:**
- 🟢 **The essentials** (your memory + your favorite AI) → do [Part A](#part-a-whitebox-memory) + [Part B](#part-b-connect-your-ai). ~15 minutes.
- 🔵 **The full system** (+ a private multi-agent hub you reach from your phone) → also do [Part C](#part-c-the-hub-optional).
---

## What you're building

```
            YOU  (the only authority — edit anytime, plain markdown)
             │
             ▼
      ┌─────────────┐
      │ YOUR VAULT  │   a folder on your disk. The model of you.
      └──────┬──────┘
             │  read + write (every change audited)
      ┌──────┴───────────────────────────────────┐
      │  your AIs                                  │   ← Part B: connect them
      │  Claude · ChatGPT · Gemini · Cursor ·      │
      │  Kimi · Claude Code …                      │
      └────────────────────────────────────────────┘

   (optional) Part C — THE HUB:
   a private team of AI agents on your PC that you reach
   from your phone over an encrypted Tailscale tunnel.
```

Three things, installed in order: **(A)** the vault + tools → **(B)** wire your AIs to it → **(C)** the optional hub.

---

## Prerequisites — get these first

Grab only what your path needs.

| Tool | Needed for | Get it | Verify |
|---|---|---|---|
| **Node.js 18+** | the memory (Parts A & B) | [nodejs.org](https://nodejs.org) — any LTS | `node --version` |
| **git** | cloning the repo | [git-scm.com](https://git-scm.com) (or download the ZIP) | `git --version` |
| **A Chromium browser** | the browser extension (Part B) | Chrome / Edge / Brave / Arc / Vivaldi | — |
| **Python 3.11+** | the hub (Part C) | [python.org](https://python.org) — tick **"Add to PATH"** | `python --version` |
| **Ollama** | local models in the hub (Part C) | [ollama.com](https://ollama.com) | `ollama --version` |
| **Tailscale** | reach the hub from your phone (Part C) | [tailscale.com](https://tailscale.com) | tray/menubar icon |

**Opening a terminal:**
- **Windows:** Windows key → type `cmd` → Enter. *(Terminal inside a folder: open the folder, click the address bar, type `cmd`, Enter.)*
- **macOS:** Cmd-Space → "Terminal".
- **Linux:** your shell of choice.

> ⚠️ **Windows + OneDrive:** don't put your vault (or the built MCP server) inside a OneDrive-synced folder — its on-demand caching causes intermittent read failures. Use a path outside OneDrive, e.g. `C:\Users\<you>\whitebox-vault`.

---

## Part A: WhiteBox memory
*~10 minutes*

### A1 — Get the code
```bash
git clone https://github.com/FreyjaNellora/WhiteBox.git
cd WhiteBox
```
*No git? Download the ZIP from the GitHub page, extract it, and `cd` into the folder.*

### A2 — Build the CLI + create your vault
```bash
cd whitebox-cli
npm install
npm run build
node bin/whitebox.js init ~/whitebox-vault
```
**What you'll see:** a new folder `~/whitebox-vault` (Windows: `C:\Users\<you>\whitebox-vault`) seeded with `AGENTS.md`, `identity.md`, `working-style.md`, `tags.md`, and an empty `observations/`.
*(Optional) put `whitebox` on your PATH:* `npm link` (Windows: run the terminal as Administrator).

### A3 — Tell it who you are *(5 minutes — the part that matters)*
Open `identity.md` and `working-style.md` in any text editor and write a few real sentences: who you are, how you want AI to work with you. **This is the entire value of WhiteBox — the templates are just stubs.**

### A4 — Build the memory server (MCP)
```bash
cd ../whitebox-mcp
npm install
npm run build
```
**What you'll see:** a built server at `whitebox-mcp/dist/index.js` — this is what your AIs talk to.

> **Windows + OneDrive only** — copy the built server out of OneDrive first:
> ```bash
> mkdir %USERPROFILE%\.whitebox-mcp && xcopy /E /I dist %USERPROFILE%\.whitebox-mcp\dist && xcopy /E /I node_modules %USERPROFILE%\.whitebox-mcp\node_modules && copy package.json %USERPROFILE%\.whitebox-mcp\
> ```
> *(macOS/Linux: `mkdir -p ~/.whitebox-mcp && cp -r dist node_modules package.json ~/.whitebox-mcp/`)*

✅ **You now have a vault + a memory server.** Next: connect your AIs.

---

## Part B: Connect your AI

AIs connect one of two ways: **MCP** (desktop + coding tools, full read/write) or the **browser extension** (claude.ai / chatgpt.com / gemini). Do whichever you actually use.

### The MCP config block *(you'll reuse this everywhere)*
Point `args` at your built server and `WHITEBOX_VAULT_ROOT` at your vault:
```json
{
  "mcpServers": {
    "whitebox": {
      "command": "node",
      "args": ["/absolute/path/to/whitebox-mcp/dist/index.js"],
      "env": { "WHITEBOX_VAULT_ROOT": "/absolute/path/to/whitebox-vault" }
    }
  }
}
```
> **Windows paths in JSON:** use `C:/forward/slashes` or `C:\\double\\backslashes` (never single `\`).

### B1 — Claude Desktop
1. Open the config file:
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`
2. Paste the MCP block (create the file if it's missing).
3. **Fully quit** Claude Desktop (tray → Quit, not just the window) and reopen.

**What you'll see:** Settings → Developer → MCP Servers → `whitebox` *connected*, with 7 tools (`bootstrap`, `read_file`, `list_files`, `grep`, `append_observation`, `propose_stable_edit`, `list_conflicts`).

### B2 — Claude Code
- **Per project:** drop a `.mcp.json` (the block above) at your repo root.
- **Global (all sessions):** `claude mcp add whitebox node /path/to/whitebox-mcp/dist/index.js -e WHITEBOX_VAULT_ROOT=/path/to/vault`
- **Bonus:** add to `~/.claude/CLAUDE.md` → *"Before responding, read `AGENTS.md` from the WhiteBox vault via the `whitebox` MCP server."* Now every session boots already oriented.

### B3 — Cursor / Cline / Continue.dev
Same MCP block, in each tool's MCP settings panel. All speak stdio MCP.

### B4 — Gemini CLI
Config: `~/.gemini/settings.json` (Windows: `C:\Users\<you>\.gemini\settings.json`). Same block; you may add `"timeout": 30000`. Restart `gemini`.

### B5 — ChatGPT (Desktop + web) — *Plus / Pro / Business / Enterprise*
ChatGPT takes MCP only over **HTTPS (SSE)**, not local stdio, and there's no config file — you register a URL in the UI:
1. Run the server in SSE mode + expose it over HTTPS:
   ```bash
   WHITEBOX_VAULT_ROOT="<vault>" node /path/to/whitebox-mcp/dist/index.js --transport sse --port 8787
   ngrok http 8787        # or a Cloudflare Tunnel
   ```
2. ChatGPT → **Settings → Connectors → Advanced → Developer mode** (on).
3. **Connectors → Create** → paste the public `…/sse` URL → name it "WhiteBox" → authorize.

*(Free tier / no MCP? Use the browser extension below, or paste a one-paragraph summary into Custom Instructions.)*

### B6 — The browser extension *(claude.ai · chatgpt.com · gemini.google.com)*
1. Open `chrome://extensions` (or `edge://extensions`, etc.).
2. Toggle **Developer mode** (top-right) → **Load unpacked** → select the `whitebox-extension/` folder.
3. Pin the icon → click it → **Open setup…** → **Choose vault folder** → grant access → flip **Enable WhiteBox** on.

**What you'll see:** open `claude.ai/new`, type *"What do you know about me from my vault?"* — your first message auto-includes vault context and the AI knows who you are. *(F12 → Console shows `[whitebox] … injected N chars of vault context`.)*

### B7 — Mobile / anything without MCP
Run `whitebox paste` (copies your vault context to the clipboard) and paste it as your first message — works anywhere. Or set the AI's **Custom Instructions** once to a one-paragraph summary; it syncs to mobile.

**Connection cheat-sheet:**
| Surface | How |
|---|---|
| Claude Desktop / Code, Cursor, Gemini CLI | MCP over stdio — B1–B4 |
| ChatGPT Desktop / web (Plus+) | MCP over SSE tunnel — B5 |
| claude.ai / chatgpt.com / gemini in a browser | Browser extension — B6 |
| Any mobile app | Paste-in / Custom Instructions — B7 |

✅ **Your AIs now share one memory of you.** That's the core product. Part C is the optional power-up.

---

## Part C: The hub *(optional)*

The hub (**ChatBox**, WhiteBox's companion) is a small private chat server on your PC where **you and a team of AI agents** talk — reachable **from your phone over an encrypted Tailscale tunnel**, never the open internet. Local models answer for free; your Claude/Kimi subscriptions can answer too, headlessly (no per-token API charges).

> **Companion repo:** the hub lives in **ChatBox**, WhiteBox's companion repo *(publishing soon)*. ~20–30 minutes, no coding.

### C1 — Install Ollama (the local-model runner)
1. Install from [ollama.com](https://ollama.com); open it once so it runs in the background.
2. Pull a couple of small models (the hub's free local agents):
   ```bash
   ollama pull llama3.2:3b
   ollama pull qwen3:4b
   ```
   **What to expect:** a few minutes each. They run **entirely on your PC** — private and free.

   **Finding & picking models:** browse [ollama.com/library](https://ollama.com/library). Rule of thumb:
   - `3b`–`4b` (e.g. `llama3.2:3b`, `qwen3:4b`) → ~4–6 GB RAM, great first responder. **Start here.**
   - `7b`–`8b` (e.g. `llama3.1:8b`) → smarter, wants ~8–16 GB RAM and ideally a GPU.
   - Bigger = better but slower/heavier. Match the model to your machine; start small and grow.

### C2 — Install Tailscale on host **and** phone
1. **On your PC:** install from [tailscale.com](https://tailscale.com) → **sign in** (Google/Microsoft/email). Leave it ON.
2. **On your phone:** install **Tailscale** from the App Store / Play Store → sign in with the **same account**.

**What you'll see:** both devices appear in your Tailscale list and can now reach each other privately. Your PC's tailnet address looks like `100.x.x.x` — find it with `tailscale ip -4`.

### C3 — (Optional) Wire in your subscription AIs — headless Claude / Kimi
The hub can drive your **existing subscriptions** with **no per-token API charges** — it runs them *headlessly* (the official CLI in the background).

**Requirements for headless calling to work:**
- **Claude:** install the **Claude CLI** and **sign in once** (`claude` → log in). Uses your Max/Pro subscription; no API key, nothing extra billed.
- **Kimi:** get a **Kimi-for-Coding** token at [kimi.com/code/console](https://kimi.com/code/console) and put it (one line) in `ChatBox/.agentchat/kimi-token.txt`. *(This is the flat-fee membership — not the pay-per-token API.)*
- The hub must run under a **Python that has the `mcp` package** — the setup below installs it into a venv for exactly this reason.
- No subscription? Skip this — the free local Ollama agents work on their own.

### C4 — Set up + launch the hub
1. Clone/download **ChatBox** next to WhiteBox; open a terminal inside it.
2. One-time setup:
   ```bash
   python -m venv venv
   venv\Scripts\pip install -r agentchat\requirements.txt     # Windows
   # macOS/Linux:  venv/bin/pip install -r agentchat/requirements.txt
   ```
3. Copy `.env.example` → `.env`. For phone access, set `AGENTCHAT_HTTP_HOST` and `AGENTCHAT_LAN_IP` to your `tailscale ip -4` address. *(Remove `claude`/`kimi` from the `DOORBELL_MANAGED` line if you're local-only.)*
4. Start it — **`Start Hub.bat`** (Windows). A window shows your **hub address** + a **pairing PIN**. Keep it open (closing it stops the hub).

### C5 — Pair your phone
1. On your phone (Tailscale ON), open the **hub address** in your browser.
2. Type the **PIN** → **Pair**.

**What you'll see:** you're in the chat. Type `@scout hello` and your local model replies. `@claude` / `@kimi` reach your subscription agents (if you did C3). After the first pairing, the phone makes its own PINs from **Settings** — no trip back to the PC.

> 🔒 **Privacy:** the hub binds **only** to your Tailscale address — reachable from your own devices and nowhere else. Not public wifi, not the open internet.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` / `python` "not recognized" | Reinstall and make sure it's on your PATH (Python: tick "Add to PATH" during install). |
| Claude Desktop doesn't show the `whitebox` server | **Fully quit** and reopen (tray → Quit). Validate the JSON; on Windows use `/` or `\\` in paths. |
| `vault not accessible (no_handle / permission_lost)` (extension) | Click the WhiteBox icon → Open setup → Choose vault folder again. |
| No `[whitebox] … injected` log on claude.ai | The site changed its UI and our selectors drifted — update `src/content/claude-ai.js` or open an issue. |
| Intermittent vault read failures on Windows | Move the vault **and** built MCP server out of OneDrive (see the warning up top). |
| Phone can't reach the hub | Tailscale ON on **both** PC and phone, **same** account. |
| Hub PIN "expired" | PINs last ~90 s; restart the hub or generate a new one from the phone's Settings. |
| `@scout` never replies | Make sure Ollama is running and you ran the `ollama pull` commands. |
| `@claude` / `@kimi` never replies | Claude CLI must be signed in; Kimi needs its token file. The hub still works without them. |

**Stuck?** Paste [QUICKSTART.md](QUICKSTART.md) (or this file) into any AI along with your error — it'll walk you through your exact step. Genuinely broken? Open an issue.

---

## What WhiteBox actually is *(the 60-second version)*

The model of you lives on **your disk**, in **plain markdown**, **maintained by your AIs together**, with **you as the final authority**. Five non-negotiables:

1. **You own the disk** — no mode of operation requires uploading the vault.
2. **Plain text, schema-defined** — readable in any editor; the schema is the contract.
3. **Append-only + full audit** — reads *and* writes logged; everything reconstructible.
4. **Agents curate, you override** — you have the veto on every layer.
5. **Synthesis is derived + rejectable** — anything an AI infers about you is tagged and rejectable.

The wedge: the **only** project centered on multi-agent coordination over a single user-owned vault — verbatim discipline, source attribution, weighted cross-source promotion, and a published schema anyone can implement. Built for 3+ AIs (different vendors, different sessions) writing to the same vault about the same person over months and years.

---

## Going deeper
- **Why & how we protect it:** [SECURITY.md](SECURITY.md) · [docs/threat-model.md](docs/threat-model.md) · [docs/motivation.md](docs/motivation.md) · [docs/research-direction.md](docs/research-direction.md)
- [QUICKSTART.md](QUICKSTART.md) — the original linear walkthrough (also AI-pasteable) · [spec/WHITEBOX_v1.md](spec/WHITEBOX_v1.md) — the schema · [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md)

## What's in this repo
`whitebox-shared/` core library · `whitebox-mcp/` the MCP server · `whitebox-cli/` the CLI · `whitebox-extension/` the browser extension · `spec/` the schema · `vault-example/` a reference vault · `claude-code-skills/` the Claude Code skill.

---

Built in the open. **MIT.** Not yet validated by external users — first testers wanted.

---

*It's called WhiteBox because it's open source and yours to change and alter as you deem fit — the opposite of a black box: nothing hidden inside.*
