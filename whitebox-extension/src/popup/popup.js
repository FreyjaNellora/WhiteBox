import {
  loadVaultHandle,
  clearVaultHandle,
  hasPermission,
  listTopLevel,
  wipeIdb,
} from "../lib/vault-handle.js";

const fields = {
  enabled: document.getElementById("enabled"),
  scope: document.getElementById("scope"),
  style: document.getElementById("style"),
  passiveLog: document.getElementById("passive-log"),
  siteClaudeAi: document.getElementById("site-claudeAi"),
  siteChatgpt: document.getElementById("site-chatgpt"),
  siteGemini: document.getElementById("site-gemini"),
};

const firstRunSection = document.getElementById("first-run");
const firstRunConfirmBtn = document.getElementById("first-run-confirm");
const firstRunSkipBtn = document.getElementById("first-run-skip");

const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const savedIndicator = document.getElementById("saved-indicator");
const grantBtn = document.getElementById("grant-vault");
const clearBtn = document.getElementById("clear-vault");
const vaultSummary = document.getElementById("vault-summary");

function paintStatus(enabled) {
  statusEl.textContent = enabled ? "on" : "off";
  statusEl.classList.toggle("on", enabled);
  statusEl.classList.toggle("off", !enabled);
}

async function loadSettings() {
  const s = await chrome.runtime.sendMessage({ type: "wb:get-settings" });
  fields.enabled.checked = !!s.enabled;
  fields.scope.value = s.scope || "";
  fields.style.value = s.style || "office";
  fields.passiveLog.checked = !!s.passiveLog;
  fields.siteClaudeAi.checked = !!s.enabledSites?.claudeAi;
  fields.siteChatgpt.checked = !!s.enabledSites?.chatgpt;
  fields.siteGemini.checked = !!s.enabledSites?.gemini;
  paintStatus(s.enabled);

  // Show the first-run style picker once. Pre-select the picker radio
  // matching the saved style so a re-open doesn't reset the user's pick.
  if (!s.firstRunComplete) {
    const radios = firstRunSection.querySelectorAll(
      'input[name="first-run-style"]',
    );
    radios.forEach((r) => {
      r.checked = r.value === (s.style || "office");
    });
    firstRunSection.hidden = false;
  } else {
    firstRunSection.hidden = true;
  }
}

async function saveSettings() {
  const payload = {
    enabled: fields.enabled.checked,
    scope: fields.scope.value.trim(),
    style: fields.style.value,
    passiveLog: fields.passiveLog.checked,
    enabledSites: {
      claudeAi: fields.siteClaudeAi.checked,
      chatgpt: fields.siteChatgpt.checked,
      gemini: fields.siteGemini.checked,
    },
  };
  const result = await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload,
  });
  if (result?.error) {
    alert(`Save failed: ${result.error}`);
    return;
  }
  paintStatus(payload.enabled);
  savedIndicator.hidden = false;
  clearTimeout(savedIndicator._timer);
  savedIndicator._timer = setTimeout(
    () => (savedIndicator.hidden = true),
    1200,
  );
}

// Debounce auto-saves so a flurry of keystrokes / clicks coalesces.
let autosaveTimer = null;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveSettings(), 150);
}

async function confirmFirstRunStyle() {
  const picked =
    firstRunSection.querySelector(
      'input[name="first-run-style"]:checked',
    )?.value || "office";
  fields.style.value = picked;
  const result = await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { style: picked, firstRunComplete: true },
  });
  if (result?.error) {
    alert(`Save failed: ${result.error}`);
    return;
  }
  firstRunSection.hidden = true;
}

async function skipFirstRun() {
  const result = await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { firstRunComplete: true },
  });
  if (result?.error) {
    alert(`Save failed: ${result.error}`);
    return;
  }
  firstRunSection.hidden = true;
}

async function refreshVaultSummary() {
  const handle = await loadVaultHandle();
  if (!handle) {
    vaultSummary.innerHTML =
      '<span class="muted">No vault folder granted yet.</span>';
    grantBtn.textContent = "Grant vault folder";
    clearBtn.hidden = true;
    return;
  }

  const granted = await hasPermission(handle, "readwrite");
  const name = handle.name || "(unnamed)";

  if (!granted) {
    vaultSummary.innerHTML = `
      <div class="vault-name">${escapeHtml(name)}</div>
      <div class="muted warn">Permission expired after browser restart. Click below to re-grant.</div>
    `;
    grantBtn.textContent = "Re-grant access";
    clearBtn.hidden = false;
    return;
  }

  let entries = [];
  try {
    entries = await listTopLevel(handle);
  } catch {}

  const hasAgents = entries.some((e) => e.name === "AGENTS.md");
  const warn = hasAgents
    ? ""
    : '<div class="muted warn">This folder has no AGENTS.md. Is it actually a WhiteBox vault? Use <code>whitebox init</code> from the CLI to set one up.</div>';

  vaultSummary.innerHTML = `
    <div class="vault-name">${escapeHtml(name)}</div>
    <div class="muted">${entries.length} top-level entries${hasAgents ? ", AGENTS.md present" : ""}.</div>
    ${warn}
  `;
  grantBtn.textContent = "Change vault folder";
  clearBtn.hidden = false;
}

async function grantVault() {
  // showDirectoryPicker in the popup is unreliable because Chrome closes the
  // popup when focus moves to the OS file dialog, killing the IndexedDB save
  // mid-transaction. Open a dedicated setup tab instead; tabs stay alive
  // across focus changes.
  const url = chrome.runtime.getURL("src/setup/setup.html");
  await chrome.tabs.create({ url });
  window.close();
}

async function clearVault() {
  if (!confirm("Clear the vault grant? WhiteBox will stop reading or writing until you re-grant.")) {
    return;
  }
  await clearVaultHandle();
  await refreshVaultSummary();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const captureBtn = document.getElementById("capture");
const captureStatus = document.getElementById("capture-status");

async function captureLastResponse() {
  captureStatus.hidden = false;
  captureStatus.textContent = "Looking for last assistant response…";
  captureStatus.classList.remove("warn");

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    captureStatus.textContent = "No active tab found.";
    captureStatus.classList.add("warn");
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "wb:extract-last-assistant",
    });
  } catch (err) {
    captureStatus.textContent =
      "No WhiteBox content script on this tab. Open claude.ai, chatgpt.com, or gemini.google.com.";
    captureStatus.classList.add("warn");
    return;
  }

  if (!response?.ok) {
    captureStatus.textContent = `Couldn't find an assistant response: ${response?.error || "no matches in DOM"}.`;
    captureStatus.classList.add("warn");
    return;
  }

  await chrome.storage.session.set({
    pendingProposal: {
      source: deriveSource(response.site),
      text: response.text,
      url: response.url,
      site: response.site,
      capturedAt: new Date().toISOString(),
    },
  });

  const proposeUrl = chrome.runtime.getURL("src/propose/propose.html");
  await chrome.tabs.create({ url: proposeUrl });
  window.close();
}

function deriveSource(site) {
  switch (site) {
    case "claude.ai":
      return "claude.ai";
    case "chatgpt.com":
      return "chatgpt.com";
    case "gemini.google.com":
      return "gemini.google.com";
    default:
      return site || "whitebox-extension";
  }
}

const digestBtn = document.getElementById("digest");

async function captureSessionDigest() {
  captureStatus.hidden = false;
  captureStatus.textContent = "Extracting full conversation…";
  captureStatus.classList.remove("warn");

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    captureStatus.textContent = "No active tab found.";
    captureStatus.classList.add("warn");
    return;
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "wb:extract-conversation",
    });
  } catch {
    captureStatus.textContent =
      "No WhiteBox content script on this tab. Open claude.ai, chatgpt.com, or gemini.google.com.";
    captureStatus.classList.add("warn");
    return;
  }

  if (!response?.ok || !response.turns?.length) {
    captureStatus.textContent = `Couldn't extract a conversation: ${response?.error || "no messages in DOM"}.`;
    captureStatus.classList.add("warn");
    return;
  }

  await chrome.storage.session.set({
    pendingDigest: {
      source: deriveSource(response.site),
      turns: response.turns,
      url: response.url,
      site: response.site,
      capturedAt: new Date().toISOString(),
    },
  });

  const digestUrl = chrome.runtime.getURL("src/digest/digest.html");
  await chrome.tabs.create({ url: digestUrl });
  window.close();
}

const helpLink = document.getElementById("help-link");

async function openHelp(ev) {
  ev?.preventDefault();
  // Try to spawn the in-page wikibook bubble on the active tab so the user
  // doesn't lose context. Only works if the active tab has the WhiteBox
  // content script (claude.ai etc.). Falls back to the static help.html.
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab?.id) {
      const compatible =
        /^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\b/.test(
          tab.url || "",
        );
      if (compatible) {
        await chrome.tabs.sendMessage(tab.id, {
          type: "wb:open-help-bubble",
          pageId: "what-is-whitebox",
        });
        window.close();
        return;
      }
    }
  } catch {}
  // Fallback: open the static help page in a new tab.
  const url = chrome.runtime.getURL("src/help/help.html");
  await chrome.tabs.create({ url });
  window.close();
}

saveBtn.addEventListener("click", saveSettings);
grantBtn.addEventListener("click", grantVault);
clearBtn.addEventListener("click", clearVault);
captureBtn.addEventListener("click", captureLastResponse);
digestBtn.addEventListener("click", captureSessionDigest);
helpLink.addEventListener("click", openHelp);
firstRunConfirmBtn.addEventListener("click", confirmFirstRunStyle);
firstRunSkipBtn.addEventListener("click", skipFirstRun);

// Auto-save on every field change. The "Save settings" button is now just
// a manual confirmation; nothing the user does in this popup goes
// unsaved.
fields.enabled.addEventListener("change", () => {
  paintStatus(fields.enabled.checked);
  autosave();
});
fields.scope.addEventListener("input", autosave);
fields.style.addEventListener("change", autosave);
fields.passiveLog.addEventListener("change", autosave);
fields.siteClaudeAi.addEventListener("change", autosave);
fields.siteChatgpt.addEventListener("change", autosave);
fields.siteGemini.addEventListener("change", autosave);

loadSettings();
refreshVaultSummary();

// ─── Session gate / agent bypass / safety section ────────────────────────
const lockSection = document.getElementById("lock-section");
const lockSummary = document.getElementById("lock-summary");
const dangerBadge = document.getElementById("danger-badge");
const setPassphraseBtn = document.getElementById("set-passphrase-btn");
const unlockBtn = document.getElementById("unlock-btn");
const lockNowBtn = document.getElementById("lock-now-btn");

const trigScreenLock = document.getElementById("trig-screen-lock");
const trigIdle = document.getElementById("trig-idle");
const trigIdleMinsRow = document.getElementById("trig-idle-mins-row");
const trigIdleMins = document.getElementById("trig-idle-mins");
const trigTabClose = document.getElementById("trig-tab-close");
const trigRememberRestart = document.getElementById("trig-remember-restart");

const bypassTier = document.getElementById("bypass-tier");
const bypassExpire = document.getElementById("bypass-expire");
const bypassExpireRow = document.getElementById("bypass-expire-row");
const bypassExpiresAtEl = document.getElementById("bypass-expires-at");

const rateLimit = document.getElementById("rate-limit");
const rateUsedDisplay = document.getElementById("rate-used-display");
const auditVerbosity = document.getElementById("audit-verbosity");

async function refreshLockUi() {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "wb:lock-state" });
  } catch (err) {
    // Service worker crashed or not yet registered — gracefully no-op.
    console.warn("[whitebox] lock-state fetch failed:", err?.message || err);
    return;
  }
  if (!state || state.error) return;
  // Defensive defaults so missing fields from an older background build
  // don't crash the popup.
  state.triggers = state.triggers || {};
  state.danger = state.danger || {};
  state.rateLimit = state.rateLimit || { cap: 0, used: 0 };

  // Lock summary
  if (!state.hasPassphrase) {
    lockSummary.innerHTML =
      '<span class="muted">No passphrase set. Session is always open.</span>';
    setPassphraseBtn.hidden = false;
    unlockBtn.hidden = true;
    lockNowBtn.hidden = true;
    lockSection.classList.remove("is-locked", "is-unlocked");
  } else if (state.userUnlocked) {
    lockSummary.innerHTML =
      '<span class="lock-badge unlocked">open</span><span class="muted">Session is open.</span>';
    setPassphraseBtn.hidden = true;
    unlockBtn.hidden = true;
    lockNowBtn.hidden = false;
    lockSection.classList.add("is-unlocked");
    lockSection.classList.remove("is-locked");
  } else {
    lockSummary.innerHTML =
      '<span class="lock-badge locked">gated</span><span class="muted">Enter passphrase to open session.</span>';
    setPassphraseBtn.hidden = true;
    unlockBtn.hidden = false;
    lockNowBtn.hidden = true;
    lockSection.classList.add("is-locked");
    lockSection.classList.remove("is-unlocked");
  }

  // Triggers
  trigScreenLock.checked = state.triggers.onScreenLock;
  trigIdle.checked = state.triggers.onIdle;
  trigIdleMins.value = String(state.triggers.idleMinutes ?? 30);
  trigIdleMinsRow.hidden = !state.triggers.onIdle;
  trigTabClose.checked = state.triggers.onTabClose;
  trigRememberRestart.checked = state.triggers.rememberAcrossRestarts;

  // Bypass
  bypassTier.value = state.bypass;
  bypassExpireRow.hidden = state.bypass === "none";
  if (state.bypassExpiresAt) {
    bypassExpiresAtEl.textContent =
      "Auto-reverts at " + new Date(state.bypassExpiresAt).toLocaleString();
    bypassExpiresAtEl.hidden = false;
  } else {
    bypassExpiresAtEl.hidden = true;
  }

  // Safety
  rateLimit.value = String(state.rateLimit.cap);
  rateUsedDisplay.textContent =
    state.rateLimit.cap > 0
      ? `Used ${state.rateLimit.used} / ${state.rateLimit.cap} this session.`
      : `${state.rateLimit.used} autonomous saves this session (unlimited).`;
  auditVerbosity.value = state.auditVerbosity;

  // Danger badge
  dangerBadge.hidden = !state.anyDanger;
  if (state.anyDanger) {
    const reasons = Object.entries(state.danger)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");
    dangerBadge.title = "Reduced safety: " + reasons;
  }
}

setPassphraseBtn.addEventListener("click", async () => {
  const p1 = prompt("Set a vault passphrase (min 6 chars):");
  if (!p1) return;
  const p2 = prompt("Confirm passphrase:");
  if (p1 !== p2) {
    alert("Passphrases do not match.");
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: "wb:set-passphrase",
    passphrase: p1,
  });
  if (res?.error) {
    alert("Could not set passphrase: " + res.error);
    return;
  }
  await refreshLockUi();
});

unlockBtn.addEventListener("click", async () => {
  const p = prompt("Enter session passphrase:");
  if (!p) return;
  const res = await chrome.runtime.sendMessage({
    type: "wb:unlock",
    passphrase: p,
  });
  if (res?.error) {
    alert(res.error);
    return;
  }
  await refreshLockUi();
});

lockNowBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "wb:lock" });
  await refreshLockUi();
});

async function saveLockTriggers() {
  // Confirm danger toggles on first off-flip.
  if (!trigScreenLock.checked) {
    if (!confirm(
      "Turning OFF \"gate when I lock my screen\" means anyone with access to your open browser can read your vault while you're away. Continue?",
    )) {
      trigScreenLock.checked = true;
      return;
    }
  }
  if (trigRememberRestart.checked) {
    if (!confirm(
      "⚠ DANGER: \"Remember open across browser restarts\" means anyone who opens your browser can read your vault forever, no passphrase needed. Use only on devices you alone access. Continue?",
    )) {
      trigRememberRestart.checked = false;
      return;
    }
  }
  const triggers = {
    onScreenLock: trigScreenLock.checked,
    onIdle: trigIdle.checked,
    idleMinutes: parseInt(trigIdleMins.value, 10) || 30,
    onTabClose: trigTabClose.checked,
    rememberAcrossRestarts: trigRememberRestart.checked,
  };
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { lockTriggers: triggers },
  });
  await refreshLockUi();
}
trigScreenLock.addEventListener("change", saveLockTriggers);
trigIdle.addEventListener("change", () => {
  trigIdleMinsRow.hidden = !trigIdle.checked;
  saveLockTriggers();
});
trigIdleMins.addEventListener("change", saveLockTriggers);
trigTabClose.addEventListener("change", saveLockTriggers);
trigRememberRestart.addEventListener("change", saveLockTriggers);

bypassTier.addEventListener("change", async () => {
  const tier = bypassTier.value;
  if (tier === "full-bypass") {
    if (!confirm(
      "⚠ DANGER: full-bypass lets the agent do anything (read + write + scope-switch) even when your session is gated from your perspective. Use only with agents you fully trust. Continue?",
    )) {
      await refreshLockUi();
      return;
    }
  }
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { agentBypass: tier },
  });
  await refreshLockUi();
});

bypassExpire.addEventListener("change", async () => {
  const hours = parseInt(bypassExpire.value, 10);
  const expiresAt = hours > 0
    ? new Date(Date.now() + hours * 3600_000).toISOString()
    : null;
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { agentBypassExpiresAt: expiresAt },
  });
  await refreshLockUi();
});

rateLimit.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { rateLimitPerSession: parseInt(rateLimit.value, 10) || 0 },
  });
  await refreshLockUi();
});
auditVerbosity.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: { auditVerbosity: auditVerbosity.value },
  });
});

dangerBadge.addEventListener("click", () => {
  alert(
    "Reduced safety. Hover the badge for which safeties are off, or open Session Gate / Agent Bypass to review.",
  );
});

// ─── Reset extension state ─────────────────────────────────────────────
// Clears all WhiteBox state inside the browser. Vault folder on disk
// stays untouched — that's the user's data, not ours to delete.
const resetBtn = document.getElementById("reset-extension-state");
if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    const confirmed = confirm(
      "Reset all WhiteBox extension state?\n\n" +
      "This clears:\n" +
      "  • Vault grant (the browser's record of which folder is your vault)\n" +
      "  • All settings (style, scope, gate, bypass, danger toggles)\n" +
      "  • Passphrase hash and lock state\n" +
      "  • Any cached conversation snapshots\n\n" +
      "This does NOT touch your vault folder on disk. Your files, " +
      "observations, audit log, conversations — all stay where they are. " +
      "You can reconnect them later or open them in any text editor.\n\n" +
      "Continue?",
    );
    if (!confirmed) return;

    try {
      // 1. IndexedDB (vault handle)
      await wipeIdb().catch(() => {});
      // 2. chrome.storage.local
      await chrome.storage.local.clear();
      // 3. chrome.storage.session
      await chrome.storage.session.clear();
    } catch (err) {
      alert("Reset partially failed: " + (err.message || err) + "\nClose and remove the extension manually via chrome://extensions.");
      return;
    }

    alert(
      "Extension state cleared.\n\n" +
      "Your vault folder is untouched. To fully uninstall WhiteBox: " +
      "open chrome://extensions and click Remove on the WhiteBox card.\n\n" +
      "See UNINSTALL.md on the GitHub repo for MCP server cleanup if you also installed that.",
    );
    window.close();
  });
}

refreshLockUi();
setInterval(refreshLockUi, 5000); // keep rate-limit counter and bypass-expiry fresh

// Mount hover-help so any data-wb-help element in the popup gets a
// description tooltip. Click "Open full page →" inside the bubble to
// spawn the wikibook on the active tab (or fall back to help.html).
import("../lib/help-hover.js").then(({ mountHelpHover }) => {
  mountHelpHover({
    openWikibook: async (pageId) => {
      try {
        const tabs = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const tab = tabs[0];
        if (tab?.id) {
          const compatible =
            /^https:\/\/(claude\.ai|chatgpt\.com|chat\.openai\.com|gemini\.google\.com)\b/.test(
              tab.url || "",
            );
          if (compatible) {
            await chrome.tabs.sendMessage(tab.id, {
              type: "wb:open-help-bubble",
              pageId,
            });
            window.close();
            return;
          }
        }
      } catch {}
      const url = chrome.runtime.getURL(
        "src/help/help.html#" + encodeURIComponent(pageId),
      );
      await chrome.tabs.create({ url });
      window.close();
    },
  });
}).catch((err) => console.warn("[whitebox] help-hover mount failed:", err));

// ─── Diagnostics ──────────────────────────────────────────────────────────
const copyDiagBtn = document.getElementById("copy-diagnostics");
const toastEl = document.getElementById("toast");

function showToast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => {
    toastEl.classList.add("show");
    setTimeout(() => {
      toastEl.classList.remove("show");
      setTimeout(() => { toastEl.hidden = true; }, 200);
    }, ms);
  });
}

if (copyDiagBtn) {
  copyDiagBtn.addEventListener("click", async () => {
    copyDiagBtn.disabled = true;
    copyDiagBtn.textContent = "Collecting…";
    try {
      const res = await chrome.runtime.sendMessage({ type: "wb:get-diagnostics" });
      if (res?.report) {
        await navigator.clipboard.writeText(res.report);
        showToast("Copied to clipboard!");
      } else {
        showToast("Could not collect diagnostics.");
      }
    } catch (err) {
      showToast("Error: " + (err.message || err));
    }
    copyDiagBtn.disabled = false;
    copyDiagBtn.textContent = "Copy diagnostics to clipboard";
  });
}
