/**
 * Shared helpers loaded into every content script.
 *
 * Content scripts in MV3 don't share a module context; this file is loaded
 * before each per-site script via the manifest's `js` array, populating
 * `window.__whitebox` with utilities the per-site scripts use.
 *
 * All vault I/O is proxied through the background service worker because
 * content scripts cannot directly use the File System Access API handle
 * that was granted in the popup.
 */

(() => {
  if (window.__whitebox) return;

  const SEND_TIMEOUT_MS = 5000;

  // send() resolves with a normal response on success. On failure
  // (timeout, runtime error, exception) it REJECTS with an Error shaped
  // like { message, code, isError: true }. Callers must use .catch() or
  // try/catch to handle failures — a missing service worker is never a
  // silent success.
  function send(type, extra = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn(
            `[whitebox] send(${type}) timed out after ${SEND_TIMEOUT_MS}ms — service worker unresponsive`,
          );
          const err = new Error("Service worker unresponsive");
          err.code = "TIMEOUT";
          err.isError = true;
          reject(err);
        }
      }, SEND_TIMEOUT_MS);

      try {
        chrome.runtime.sendMessage({ type, ...extra }, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const err = new Error(chrome.runtime.lastError.message);
            err.code = "RUNTIME_ERROR";
            err.isError = true;
            reject(err);
            return;
          }
          resolve(response || {});
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const wrapped = new Error(err.message || String(err));
          wrapped.code = "EXCEPTION";
          wrapped.isError = true;
          reject(wrapped);
        }
      }
    });
  }

  async function getSettings() {
    return send("wb:get-settings").catch(() => ({}));
  }

  async function vaultStatus() {
    return send("wb:vault-status").catch(() => ({ granted: false }));
  }

  async function readBootstrap() {
    return send("wb:read-bootstrap").catch((err) => ({
      error: err.message,
      code: err.code || "RUNTIME_ERROR",
    }));
  }

  async function readFile(path) {
    return send("wb:read-file", { path }).catch((err) => ({
      error: err.message,
      code: err.code || "RUNTIME_ERROR",
    }));
  }

  async function appendObservation(payload) {
    const result = await send("wb:append-observation", { payload }).catch(
      (err) => ({ error: err.message, code: err.code || "RUNTIME_ERROR" }),
    );
    if (result?.ok && window.__wbPillFlash) window.__wbPillFlash("active");
    return result;
  }

  async function listConflictsCount() {
    return send("wb:list-conflicts-count").catch(() => ({
      ok: false,
      count: 0,
    }));
  }

  async function appendConversationTurns(payload) {
    const result = await send("wb:append-conversation-turns", {
      payload,
    }).catch((err) => ({ error: err.message, code: err.code || "RUNTIME_ERROR" }));
    if (result?.ok && window.__wbPillFlash) window.__wbPillFlash("passive");
    return result;
  }

  async function lockState() {
    return send("wb:lock-state").catch(() => null);
  }

  async function writeSource(payload) {
    return send("wb:write-source", { payload }).catch((err) => ({
      error: err.message,
      code: err.code || "RUNTIME_ERROR",
    }));
  }

  /**
   * Build a single bootstrap string to prepend to a user's first message.
   * Wraps vault content in marker comments so agents can identify the
   * boundary and the user can strip it later if they want.
   */
  function buildBootstrapText(files, posture) {
    const parts = [
      "<!-- whitebox-context: start -->",
      "This block is from my WhiteBox vault — portable user memory that travels with me across agents and platforms. It was attached automatically by the browser extension before this message reached you.",
      "",
    ];

    // If the user has reduced-safety posture (danger toggles off, or full-
    // bypass enabled), tell the agent so it can be more cautious about
    // autonomous writes.
    if (posture && (posture.anyDanger || posture.bypass === "full-bypass")) {
      parts.push(
        "**Reduced-safety posture in effect.** The user has turned off one or more vault safeties or enabled an elevated agent-bypass tier. Be more cautious than default about autonomous writes; prefer to surface candidate observations and let the user confirm rather than saving silently. Active reductions:",
      );
      const bullets = [];
      if (posture.danger?.onScreenLock)
        bullets.push("- screen-lock auto-relock is OFF");
      if (posture.danger?.rememberAcrossRestarts)
        bullets.push("- vault stays unlocked across browser restarts");
      if (posture.bypass === "full-bypass")
        bullets.push("- agent has full latitude even when the vault is locked");
      else if (posture.bypass === "reads-and-safe-writes")
        bullets.push("- agent can write low/medium-confidence saves while locked");
      else if (posture.bypass === "reads-only")
        bullets.push("- agent can read while locked (writes blocked)");
      parts.push(...bullets);
      parts.push("");
    }

    parts.push(
      "## How to use this",
      "",
      "You own your context-management loop. This block is a starter pack, not a contract. Use what serves the conversation; ignore what doesn't. Two paths are legitimate:",
      "",
      "1. **Use the bootstrap.** Read identity / working-style / recent observations and treat them as ground truth about me. Default behavior; cheapest.",
      "2. **Discover on your own.** Set this block aside and ask for what you need as the conversation evolves. The markers below are how you do that.",
      "",
      "Pick deliberately, turn by turn. Self-audit periodically — *do I have what I need? am I missing something obvious? am I about to confidently say something the vault would correct?* If yes, fetch.",
      "",
      "## Tools available to you in this browser session",
      "",
      "Emit any of these in your reply. The extension reads them, performs the action, and the result will appear at the top of my next message (for read tools) or be written to the vault immediately (for the write tool). There is a one-turn latency on read tools — that's the cost of the browser channel. (In MCP-connected sessions, you have direct tool calls instead and there is no latency.)",
      "",
      "**Read tools (pull data into the conversation):**",
      "",
      "- `{wb-fetch: <vault-relative-path>}` — pull a specific vault file. Example: `{wb-fetch: projects/odin.md}`.",
      "- `{wb-scope: <name>}` — switch working set per `scopes.md`. Returns a manifest of files in that scope so you can fetch from it.",
      "- `{wb-bootstrap}` — re-deliver this orientation pack mid-conversation. Useful if you set it aside earlier and want it now.",
      "",
      "**Write tool (commit something to the vault):**",
      "",
      "- `{wb-save}…{/wb-save}` — append an observation. Required format inside the fence:",
      "",
      "  ```",
      "  {wb-save}",
      "  tags: working-style, preference",
      "  confidence: high",
      "  context: coding-conversations    (optional)",
      "  ---",
      "  Verbatim quote of what the user said, or your own words the user affirmed.",
      "  {/wb-save}",
      "  ```",
      "",
      "  The `---` separator is required. Body must be verbatim per AGENTS.md (never paraphrase or invent). Confidence is one of very-low / low / medium / high / very-high. Use this when you'd otherwise have to ask the user to write the observation themselves. The pill turns from green-pulsing (saving) to neutral (saved) when it lands; on success it acts like an MCP-driven save.",
      "",
      "**Telemetry / acknowledgment markers:**",
      "",
      "- `{wb-context: <short note>}` — narrate a workflow shift. Render-only, no side effect. Example: `{wb-context: switching from coding to writing}`.",
      "- `{saved memory: <path> time:HH:MM}` — acknowledge a save that happened through MCP (only relevant if you're also connected via MCP). For browser-only saves, the `{wb-save}` pill above replaces this.",
      "",
      "Each marker becomes a clickable pill in the UI so I can see what you pulled or wrote and audit it. There are no hardcoded caps on how often you can use these; the user sets policy via guardrails per source. Default: trust the agent.",
      "",
      "## The orientation pack",
      "",
      "The `recent observations` block at the end is verbatim entries other agents have appended over time — preferences, corrections, and patterns they noticed. If anything below contradicts what you would otherwise assume, the observations win.",
      "",
    );

    // Prefer a stable order so the agent reads identity/working-style first
    // and observations last (closest to the user's message).
    const order = [
      "AGENTS.md",
      "identity.md",
      "working-style.md",
      "tags.md",
    ];
    const seen = new Set();
    for (const name of order) {
      if (files[name]) {
        parts.push(`## From ${name}`, "", String(files[name]).trim(), "");
        seen.add(name);
      }
    }
    for (const [name, content] of Object.entries(files)) {
      if (seen.has(name)) continue;
      if (!content) continue;
      parts.push(`## From ${name}`, "", String(content).trim(), "");
    }

    parts.push(
      "<!-- whitebox-context: end -->",
      "",
      "My message follows:",
      "",
    );
    return parts.join("\n");
  }

  function log(siteName, ...rest) {
    console.log(
      `%c[whitebox]%c ${siteName}`,
      "color: #888; font-weight: bold",
      "color: inherit",
      ...rest,
    );
  }

  // --- Settings-change listener infrastructure ---
  const _settingsCallbacks = [];

  function onSettingsChanged(callback) {
    _settingsCallbacks.push(callback);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.enabled && !changes.enabledSites && !changes.passiveLog) return;
    for (const cb of _settingsCallbacks) {
      try { cb(changes); } catch { /* swallow — don't let one bad callback break others */ }
    }
  });

  window.__whitebox = {
    getSettings,
    vaultStatus,
    readBootstrap,
    readFile,
    appendObservation,
    listConflictsCount,
    appendConversationTurns,
    lockState,
    writeSource,
    buildBootstrapText,
    log,
    onSettingsChanged,
  };
})();
