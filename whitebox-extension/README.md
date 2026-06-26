# whitebox-extension

WhiteBox browser extension. Brings portable user memory to consumer chat platforms (Claude.ai, ChatGPT, Gemini) where MCP doesn't reach.

## v0.3 scope (this build)

- **Vault grant flow** via File System Access API. Dedicated setup tab (not popup) so the directory picker doesn't race popup teardown. Handle persists in IndexedDB; re-grant on browser restart.
- **Bootstrap injection validated on all three consumer platforms:** claude.ai, chatgpt.com, gemini.google.com. See [docs/VALIDATION.md](../docs/VALIDATION.md) for the test log.
- **Observation capture.** Popup has a "Capture last response" button. One click grabs the most recent assistant reply from the active tab, opens a review page in a new tab where you edit the body, assign tags (with suggestions pulled from your vault's `tags.md`), pick a confidence level, and save. Observations append to `observations/YYYY-MM.md` via the File System Access API.
- **Background service worker** routes: `wb:read-bootstrap`, `wb:read-file`, `wb:append-observation`, `wb:vault-status`, plus relays extraction requests to content scripts.
- **Popup UI.** Vault block, master toggle, scope selector, per-site toggles, capture button.

## Future improvements

- Scope enforcement when reading bootstrap (only include files within the active scope).
- Selectors loaded from a community-maintained `selectors.json` so per-site DOM fixes don't require a new extension release.
- Automatic fact-extraction pass before the review page shows up (optional; user can opt out).
- Floating "Capture" button injected into each site so the user doesn't have to open the popup.
- Cross-device sync of the vault handle (not needed if the vault itself is already synced, but useful for browser-profile portability).

## Install (sideload)

1. Clone this repo and `cd whitebox-extension/`.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select the `whitebox-extension/` directory.
5. Pin the WhiteBox icon to the toolbar (puzzle-piece menu → pin).
6. Click the icon, then **Grant vault folder**. Pick your vault directory (the one with `AGENTS.md` in it — or run `whitebox init` first to create one).
7. Flip the master toggle on. Save.

## Verifying

1. Visit `https://claude.ai/new`.
2. Open DevTools (F12) → Console. You should see:
   - `[whitebox] claude.ai content script v0.2 live`
   - `[whitebox] claude.ai vault ready: <folder-name>`
3. Type a short first message and hit Enter. Before the message sends, console logs:
   - `[whitebox] claude.ai injected <N> chars of vault context`
4. Claude's response should reflect your identity/working-style (terse, direct, whatever you wrote).

If injection doesn't happen:

- `vault not accessible (permission_lost)` → re-grant via the popup.
- `vault not accessible (no_handle)` → grant for the first time.
- No `injected` log on send → claude.ai's DOM may have changed. Selectors in `src/content/claude-ai.js` need an update. PRs welcome.

## How the permission model works

The File System Access API gates folder access behind a user gesture (click). That means:

- You grant once, in the popup, via `Grant vault folder`.
- The handle is saved to IndexedDB; background worker and popup both retrieve it from there.
- Permission lasts for the browser session. After a full browser restart, Chrome downgrades the permission to "prompt," and the extension surfaces a **Re-grant** affordance in the popup.
- The extension cannot silently access anything outside the folder you picked. It also cannot access anything at all until you grant.

## Per-site selector strategy

Each site's DOM is volatile. claude.ai specifically:

- Composer: `div[contenteditable="true"]` (ProseMirror-based).
- Send detection: buttons whose `aria-label` or text includes "send".
- New-conversation signal: URL contains `/new`.

These are best-effort and will break when claude.ai ships UI changes. v0.3 will move selectors to a `selectors.json` the community can update without releasing a new extension.

## What this channel gets you that MCP doesn't

- **Works on consumer ChatGPT and Gemini** where MCP isn't available.
- **No vendor cooperation required.** Uses only user-gated browser APIs.
- **Fragile by design.** Vendors change DOM structure periodically; selectors break. The CLI's `whitebox paste` command is the always-works fallback when an extension release catches up to the vendor's UI change.

## Security model

- The extension never phones home. No analytics, no telemetry, no external requests beyond the host permissions needed to run content scripts on the three AI sites.
- Vault read/write happens entirely inside the browser via File System Access API.
- Settings live in `chrome.storage.local`; the directory handle lives in the extension's IndexedDB. Neither leaves the machine.

## License

MIT.
