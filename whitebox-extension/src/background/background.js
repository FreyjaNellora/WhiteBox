/**
 * WhiteBox background service worker.
 *
 * v0.2 responsibilities:
 *  - Initialize default settings on install.
 *  - Retrieve the persisted FileSystemDirectoryHandle from IndexedDB.
 *  - Read vault files (AGENTS.md, identity.md, working-style.md, etc.) on
 *    demand from content scripts.
 *  - Append observations to observations/YYYY-MM.md.
 *
 * The handle is originally granted in the popup via showDirectoryPicker().
 * Because MV3 service workers are ephemeral, we re-open IndexedDB each time.
 * File System Access permission persists for the browser session but must
 * be re-requested (via user gesture in the popup) after a browser restart.
 */

import {
  loadVaultHandle,
  hasPermission,
  ensurePermission,
  readVaultFile,
  appendVaultFile,
  listTopLevel,
} from "../lib/vault-handle.js";
import { logError, getDiagnostics } from "../lib/error-log.js";

const DEFAULTS = {
  enabled: false,
  vaultPath: "",
  scope: "",
  enabledSites: {
    claudeAi: true,
    chatgpt: true,
    gemini: true,
  },
  // UI style preset. Choose once at first run; editable later.
  //   office       — calm, light, low-density (default)
  //   engineer     — info-dense, dark, CLI hints
  //   gamer-modder — always-on HUD, dark, advanced controls visible
  style: "office",
  // Set true after the user dismisses or completes the first-run picker.
  firstRunComplete: false,
  // Passive auto-log of conversations to conversations/YYYY-MM-DD/<id>-part-N.md.
  // Off by default — opt-in only, since it writes every assistant turn.
  passiveLog: false,

  // ─── Vault lock (Phase 1: UX gate, no encryption yet) ─────────────────
  // The user can set a passphrase. When set, the vault starts locked on
  // each browser session. Unlocking caches a session marker; locking
  // clears it. Phase 2 will replace the session marker with an actual
  // encryption key derived from the passphrase.
  passphraseHash: null,        // SHA-256 of passphrase + salt; null = no passphrase set
  passphraseSalt: null,        // random per-vault salt
  // Per-trigger danger toggles. Each "true" = safety on, lock when this happens.
  // Setting any to false is a deliberate risk reduction; UI shows DANGER badge.
  lockTriggers: {
    onScreenLock: true,        // chrome.idle "locked" event (lock screen / OS sleep)
    onIdle: false,             // chrome.idle "idle" event after timeout
    idleMinutes: 30,           // timeout for onIdle
    onTabClose: false,         // close all WhiteBox tabs → lock
    rememberAcrossRestarts: false, // ⚠ DANGER: persist key across browser restarts
  },

  // ─── Agent bypass mode ────────────────────────────────────────────────
  // What the agent can do while the vault is user-locked.
  //   none                    — vault locked = agent locked. Default.
  //   reads-only              — wb-fetch / wb-scope / wb-bootstrap / read_file / grep
  //   reads-and-safe-writes   — above + wb-save with confidence ≤ medium
  //   full-bypass             — ⚠ DANGER: agent has full latitude even when locked
  agentBypass: "none",
  agentBypassExpiresAt: null,  // ISO timestamp; null = no auto-expire

  // ─── Safety knobs ─────────────────────────────────────────────────────
  // Optional cap on autonomous saves per browser session. 0 = unlimited
  // (default). Trust the agent to manage its own loop; only set a cap if
  // you've seen runaway behavior from a specific source.
  rateLimitPerSession: 0,
  // Verbosity of the autonomous-write audit log (audit/YYYY-MM-DD.md).
  //   writes  — only autonomous writes (default)
  //   all     — also log reads (wb-fetch, wb-scope, wb-bootstrap, grep)
  auditVerbosity: "writes",
};

// ─── Per-session ephemeral state (in service-worker memory) ─────────────
// These do NOT persist across service-worker restarts. That is fine; the
// service worker re-asks for unlock on next operation. Persistent state
// goes in chrome.storage.local (lockTriggers etc.) or chrome.storage.session
// (the unlock marker, if rememberAcrossRestarts is false).
let saveCountThisSession = 0;
let lastSessionResetAt = Date.now();

// NOTE: WhiteBox does not perform content moderation on observation
// bodies. Content safety is the LLM provider's responsibility — Anthropic,
// OpenAI, and Google handle this in the conversation layer, before content
// reaches us for storage. WhiteBox's scope is vault integrity (sandbox,
// path traversal, source stamping, audit log, lock + bypass tiers) and
// user control (deletion, editing, scopes, guardrails). Faithful storage
// of what was said + control over that storage. We do not second-guess
// what the user can record about themselves.

// ─── Zero-network verification ────────────────────────────────────────────
// WhiteBox is local-first by design. The extension never makes network
// requests to external servers. All vault I/O goes through the File System
// Access API (local disk). The host_permissions in manifest.json are ONLY
// for content-script injection on the AI platforms.
//
// We maintain a counter of every fetch/XHR attempted by the extension's
// own code. It should always be zero. If it ever increments, that's a bug
// or a supply-chain attack.
let networkRequestCount = 0;
const originalFetch = self.fetch;
self.fetch = function (...args) {
  networkRequestCount++;
  console.error("[whitebox] UNEXPECTED fetch() call — this should never happen:", args[0]);
  return originalFetch.apply(this, args);
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULTS));
  await chrome.storage.local.set({ ...DEFAULTS, ...existing });
  console.log("[whitebox] installed; settings initialized.");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) => {
      logError({
        code: "MESSAGE_HANDLER",
        message: err?.message || String(err),
        context: msg?.type || "unknown",
      });
      sendResponse({ error: err?.message || String(err) });
    });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case "wb:get-settings": {
      const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
      return { ...DEFAULTS, ...s };
    }

    case "wb:set-settings": {
      await chrome.storage.local.set(msg.payload);
      return { ok: true };
    }

    case "wb:read-file": {
      return readFileFromVault(msg.path);
    }

    case "wb:read-bootstrap": {
      return readBootstrapBundle();
    }

    case "wb:append-observation": {
      return appendObservation(msg.payload, sender);
    }

    case "wb:vault-status": {
      return vaultStatus();
    }

    case "wb:list-conflicts-count": {
      return countConflicts();
    }

    case "wb:append-conversation-turns": {
      return appendConversationTurns(msg.payload, sender);
    }

    // ─── Lock subsystem ──────────────────────────────────────────────────
    case "wb:set-passphrase": {
      return setPassphrase(msg.passphrase);
    }
    case "wb:unlock": {
      return unlockVault(msg.passphrase);
    }
    case "wb:lock": {
      return lockVault();
    }
    case "wb:lock-state": {
      return getLockState();
    }
    case "wb:write-source": {
      return writeSourceFile(msg.payload);
    }

    case "wb:get-diagnostics": {
      const report = await getDiagnostics();
      return { ok: true, report };
    }

    default:
      return { error: `Unknown message type: ${msg?.type}` };
  }
}

/**
 * Write a captured-from-elsewhere artifact to sources/YYYY-MM-DD-<slug>.md
 * with proper schema frontmatter. The companion observation (written via
 * appendObservation separately) carries the source_ref pointing at this file.
 *
 * Per AGENTS.md: "If the worthy content is long (over ~500 chars), save the
 * full text as a sources/<filename>.md file and write a short observation
 * that quotes a key passage and references the source via source_ref:."
 */
async function writeSourceFile(payload) {
  if (!payload || !payload.text) {
    return { error: "source payload requires `text`" };
  }
  const handle = await getGrantedHandle();
  const date = payload.date || today();
  const slug = makeSourceSlug(payload.text, payload.title);
  const fileName = `${date}-${slug}.md`;
  const relPath = `sources/${fileName}`;

  if (!(await isInScope(relPath))) {
    return { error: `Cannot write to ${relPath} under active scope` };
  }

  const front = [
    "---",
    "schema: whitebox/1.1",
    "kind: source",
    `captured_at: ${new Date().toISOString()}`,
    `source: ${payload.source || "claude.ai"}`,
  ];
  if (payload.url) front.push(`url: ${payload.url}`);
  if (payload.site) front.push(`site: ${payload.site}`);
  if (payload.title) front.push(`title: ${payload.title}`);
  front.push("---", "");

  const body = String(payload.text).trim() + "\n";
  const fileContent = front.join("\n") + "\n" + body;

  // Use writable directly — sources are write-once-per-capture, not append.
  const segments = relPath.split("/").filter(Boolean);
  let dir = handle;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: true });
  }
  const fileHandle = await dir.getFileHandle(segments[segments.length - 1], {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(fileContent);
  await writable.close();

  return { ok: true, path: relPath };
}

function makeSourceSlug(text, title) {
  const seed = (title && title.trim()) || String(text || "").slice(0, 80);
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  // Append a short timestamp suffix so two captures in the same minute
  // can't collide on the same slug.
  const stamp = Date.now().toString(36).slice(-4);
  return slug ? `${slug}-${stamp}` : `capture-${stamp}`;
}

// Parse scopes.md content into [{ name, includes }] entries.
// Mirrors whitebox-shared/src/scope.ts parseScopes — duplicated here because
// the extension cannot import the shared TypeScript module directly. Drops
// any include path that escapes the vault (absolute, leading .., or any ..
// segment) — same defensive filter as the shared parser.
//
// TODO(P2.10): Build a small shared JS bundle from the TS sources to eliminate
// this duplication. Options: (1) tsc --outFile for a single shared.js, (2)
// esbuild bundling into the extension's lib/ folder, (3) accept the maintenance
// cost and keep manual parity. Current cost: ~60 lines duplicated (parseScopes,
// splitObservationEntries, isoDate, today, monthLabel).
function _parseScopes(content) {
  const lines = String(content || "").split(/\r?\n/);
  const scopes = [];
  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(/^[-*]\s*`([^`]+)`\s*[—\-]\s*(.+)$/);
    if (!match) continue;
    const [, name, spec] = match;
    const includes = spec
      .split(/[,+]/)
      .map((s) => s.trim().replace(/`/g, ""))
      .filter((s) => s.length > 0)
      .filter((s) => {
        if (s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) return false;
        if (s.startsWith("..")) return false;
        if (s.split(/[\\/]/).includes("..")) return false;
        return true;
      });
    if (includes.length > 0) scopes.push({ name, includes });
  }
  return scopes;
}

// Real scope check for the extension's write paths. When a scope is active
// and scopes.md exists, reject any relPath outside the scope's includes.
// When no scope is active, or scopes.md is missing/empty, allow (matches
// VaultBase.isInScope behavior).
async function isInScope(relPath) {
  try {
    const settings = await chrome.storage.local.get(["scope"]);
    const activeName = (settings.scope || "").trim();
    if (!activeName) return true;
    const handle = await loadVaultHandle().catch(() => null);
    if (!handle) return true; // no vault yet; let caller fail later with clearer error
    let content;
    try {
      content = await readVaultFile(handle, "scopes.md");
    } catch {
      return true; // scopes.md missing → no scope to enforce
    }
    const scopes = _parseScopes(content);
    const scope = scopes.find((s) => s.name === activeName);
    if (!scope) return false; // active scope name not in scopes.md → fail closed
    const norm = String(relPath).replace(/\\/g, "/").replace(/\/+/g, "/");
    return scope.includes.some((inc) => {
      const i = inc.replace(/\/$/, "");
      return norm === i || norm.startsWith(`${i}/`);
    });
  } catch (err) {
    // Fail closed on unexpected errors — better to refuse a write than to
    // silently bypass scope enforcement.
    console.error("[whitebox-bg] isInScope error, denying:", err);
    return false;
  }
}

// ─── Lock state implementation ────────────────────────────────────────────
//
// Persistence model:
//   - passphraseHash + passphraseSalt: chrome.storage.local (across restarts)
//   - unlock marker: chrome.storage.session by default (cleared on browser
//     close), or chrome.storage.local if rememberAcrossRestarts is true.
//   - lockTriggers and agentBypass: chrome.storage.local
//
// In Phase 1 the "unlock marker" is just a boolean. In Phase 2 it will be
// the derived encryption key (held only in memory or in session storage,
// never local).

const UNLOCK_KEY = "vaultUnlockMarker";

async function setPassphrase(passphrase) {
  if (!passphrase || passphrase.length < 6) {
    return { error: "passphrase must be at least 6 characters" };
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  // Encode salt bytes to base64 without spread-arg (avoids stack limits
  // on large arrays). Array.from with a mapping function is safe for any
  // Uint8Array length.
  const saltB64 = btoa(Array.from(salt, (b) => String.fromCharCode(b)).join(""));
  const hash = await sha256Hex(passphrase + ":" + saltB64);
  await chrome.storage.local.set({
    passphraseHash: hash,
    passphraseSalt: saltB64,
  });
  // Setting a passphrase auto-unlocks for the current session.
  await chrome.storage.session.set({ [UNLOCK_KEY]: true });
  return { ok: true };
}

async function unlockVault(passphrase) {
  const { passphraseHash, passphraseSalt, lockTriggers } =
    await chrome.storage.local.get([
      "passphraseHash",
      "passphraseSalt",
      "lockTriggers",
    ]);
  if (!passphraseHash) return { error: "no passphrase set" };
  const computed = await sha256Hex(passphrase + ":" + passphraseSalt);
  if (computed !== passphraseHash) return { error: "incorrect passphrase" };

  const triggers = { ...DEFAULTS.lockTriggers, ...(lockTriggers || {}) };
  if (triggers.rememberAcrossRestarts) {
    await chrome.storage.local.set({ [UNLOCK_KEY]: true });
  } else {
    await chrome.storage.session.set({ [UNLOCK_KEY]: true });
  }
  return { ok: true };
}

async function lockVault() {
  await chrome.storage.session.remove(UNLOCK_KEY);
  await chrome.storage.local.remove(UNLOCK_KEY);
  return { ok: true };
}

async function isUnlocked() {
  // No passphrase set = vault is "unlocked" by default (legacy behavior).
  const { passphraseHash, lockTriggers } = await chrome.storage.local.get([
    "passphraseHash",
    "lockTriggers",
  ]);
  if (!passphraseHash) return true;
  const triggers = { ...DEFAULTS.lockTriggers, ...(lockTriggers || {}) };
  if (triggers.rememberAcrossRestarts) {
    const local = await chrome.storage.local.get(UNLOCK_KEY);
    if (local[UNLOCK_KEY]) return true;
  }
  const session = await chrome.storage.session.get(UNLOCK_KEY);
  return Boolean(session[UNLOCK_KEY]);
}

async function getLockState() {
  const settings = await chrome.storage.local.get([
    "passphraseHash",
    "lockTriggers",
    "agentBypass",
    "agentBypassExpiresAt",
    "rateLimitPerSession",
    "auditVerbosity",
  ]);
  const hasPassphrase = Boolean(settings.passphraseHash);
  const userUnlocked = await isUnlocked();
  const triggers = { ...DEFAULTS.lockTriggers, ...(settings.lockTriggers || {}) };
  let bypass = settings.agentBypass || "none";

  // Honor auto-expiry. Validate parse first — a corrupted ISO string yields
  // Invalid Date and `<` comparison returns false, leaving bypass perpetually
  // on. Treat any unparseable expiry as "expired" and clear it.
  if (settings.agentBypassExpiresAt) {
    const expiresMs = Date.parse(settings.agentBypassExpiresAt);
    if (Number.isNaN(expiresMs) || expiresMs < Date.now()) {
      bypass = "none";
      await chrome.storage.local.set({
        agentBypass: "none",
        agentBypassExpiresAt: null,
      });
    }
  }

  // Compute danger flags.
  const danger = {
    onScreenLock: !triggers.onScreenLock,
    onIdle: false, // off-by-default; ON state is the "less dangerous" choice
    rememberAcrossRestarts: triggers.rememberAcrossRestarts,
    fullBypass: bypass === "full-bypass",
  };
  const anyDanger = Object.values(danger).some(Boolean);

  return {
    hasPassphrase,
    userUnlocked,
    bypass,
    bypassExpiresAt: settings.agentBypassExpiresAt || null,
    triggers,
    danger,
    anyDanger,
    rateLimit: {
      cap: settings.rateLimitPerSession ?? 0,
      used: saveCountThisSession,
    },
    auditVerbosity: settings.auditVerbosity ?? "writes",
  };
}

/**
 * Operation tier table — what tier each operation requires. When the
 * vault is user-locked, the operation is allowed only if its required
 * tier is <= the agent bypass tier.
 */
const TIER_RANK = {
  none: 0,
  "reads-only": 1,
  "reads-and-safe-writes": 2,
  "full-bypass": 3,
};
const OPERATION_TIER = {
  read: 1,                   // wb-fetch, wb-scope, wb-bootstrap, read_file, grep
  "write-low": 2,            // wb-save with confidence very-low | low | medium
  "write-high": 3,           // wb-save with confidence high | very-high
  "stable-edit": 3,          // propose_stable_edit
};

async function checkOperationAllowed(operationKind) {
  const unlocked = await isUnlocked();
  if (unlocked) return { allowed: true };

  const { agentBypass } = await chrome.storage.local.get(["agentBypass"]);
  const bypassRank = TIER_RANK[agentBypass || "none"] ?? 0;
  const required = OPERATION_TIER[operationKind] ?? 99;
  if (required <= bypassRank) {
    return { allowed: true, viaBypass: true, tier: agentBypass };
  }
  return {
    allowed: false,
    reason: "vault_locked",
    bypass: agentBypass || "none",
  };
}

// ─── Lock-trigger listeners ───────────────────────────────────────────────
// chrome.idle reports two states we care about:
//   "locked" → user locked their screen / OS sleep
//   "idle"   → no input for the configured detection interval
//
// We hold a reference to the listener so we can remove it on suspend; in MV3
// the service worker can be torn down and re-spawned, and Chrome may otherwise
// retain stale listener registrations across reloads in some edge cases.
const _idleListener = async (state) => {
  const { lockTriggers } = await chrome.storage.local.get(["lockTriggers"]);
  const t = { ...DEFAULTS.lockTriggers, ...(lockTriggers || {}) };
  if (state === "locked" && t.onScreenLock) {
    await lockVault();
    console.log("[whitebox] vault locked: screen lock event");
  } else if (state === "idle" && t.onIdle) {
    await lockVault();
    console.log("[whitebox] vault locked: idle timeout");
  }
};
chrome.idle.onStateChanged.addListener(_idleListener);
chrome.runtime.onSuspend?.addListener(() => {
  try {
    chrome.idle.onStateChanged.removeListener(_idleListener);
  } catch (err) {
    // Only swallow expected errors (listener not found). Re-throw
    // anything unexpected so it surfaces in diagnostics.
    if (!/listener|not found/i.test(err?.message || "")) throw err;
  }
});

// Heartbeat broadcaster: content scripts use this to detect invalidation.
const HEARTBEAT_INTERVAL_MS = 5000;
setInterval(() => {
  chrome.runtime.sendMessage({ type: "wb:heartbeat" }).catch(() => {});
}, HEARTBEAT_INTERVAL_MS);

async function refreshIdleDetectionInterval() {
  const { lockTriggers } = await chrome.storage.local.get(["lockTriggers"]);
  const t = { ...DEFAULTS.lockTriggers, ...(lockTriggers || {}) };
  if (t.onIdle && t.idleMinutes >= 1) {
    chrome.idle.setDetectionInterval(t.idleMinutes * 60);
  }
}

// React to settings changes for trigger reconfiguration.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lockTriggers) {
    refreshIdleDetectionInterval();
  }
});
refreshIdleDetectionInterval();

// ─── Audit log writer ─────────────────────────────────────────────────────
async function appendAuditEntry(entry) {
  // entry = { kind, source, tags, confidence, target, viaBypass?, danger? }
  const handle = await loadVaultHandle().catch(() => null);
  if (!handle) return;
  const granted = await hasPermission(handle, "readwrite");
  if (!granted) return;

  const date = isoDate(new Date());
  const relPath = `audit/${date}.md`;
  const ts = new Date().toISOString();
  const line =
    `${ts} kind=${entry.kind} source=${entry.source || "?"} ` +
    `tags=[${(entry.tags || []).join(",")}] ` +
    `confidence=${entry.confidence || "-"} ` +
    `target=${entry.target || "-"}` +
    (entry.viaBypass ? ` via=bypass(${entry.tier})` : "") +
    (entry.danger ? ` safety=reduced` : "");

  try {
    let header = "";
    try {
      await readVaultFile(handle, relPath);
    } catch {
      header = `# Audit log — ${date}\n\nOne line per autonomous vault operation. Source-of-truth for "what did agents do today."\n\n`;
    }
    await appendVaultFile(handle, relPath, header + line);
  } catch (err) {
    logError({ code: "AUDIT_WRITE", message: err.message, context: "appendAuditEntry" });
  }
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CHUNK_LIMIT = 40_000; // body chars per part; leave room for 32K context

/**
 * Append new turns to a conversation log under
 * conversations/YYYY-MM-DD/<id>-part-N.md. Per-conversation state is held
 * in chrome.storage.local under `convoState:<id>` so we know how many
 * turns we've already written and which part we're in.
 *
 * payload: { id, site, capturedAt, turns: [{ role, text }, ...] }
 */
async function appendConversationTurns(payload, sender) {
  if (!payload || !payload.id || !Array.isArray(payload.turns)) {
    return { error: "invalid payload" };
  }

  let handle;
  try {
    handle = await getGrantedHandle();
  } catch (err) {
    return { error: err.message || "no_handle_or_permission" };
  }

  const stateKey = `convoState:${payload.id}`;
  const stored = await chrome.storage.local.get(stateKey);
  const state = stored[stateKey] || {
    lastCount: 0,
    currentPart: 1,
    currentPartChars: 0,
    dateDir: dateDir(payload.capturedAt),
    groupId: payload.id,
  };

  const newTurns = payload.turns.slice(state.lastCount);
  if (newTurns.length === 0) {
    return { ok: true, written: 0, path: null };
  }

  const dir = state.dateDir;
  let writtenPath = null;
  let writtenChunks = 0;

  for (const turn of newTurns) {
    const block = formatTurnBlock(turn, payload);
    const blockLen = block.length;

    // A single turn larger than CHUNK_LIMIT cannot fit in any part. The split
    // logic below would advance to a new "empty" part and immediately overflow
    // again — infinite loop. Truncate the block here with a marker so callers
    // see something landed and we surface the issue in the audit log.
    let safeBlock = block;
    let safeBlockLen = blockLen;
    if (blockLen > CHUNK_LIMIT) {
      const marker = `\n\n<!-- whitebox: turn truncated, original ${blockLen} chars exceeded CHUNK_LIMIT ${CHUNK_LIMIT} -->\n`;
      safeBlock = block.slice(0, CHUNK_LIMIT - marker.length) + marker;
      safeBlockLen = safeBlock.length;
      console.warn(
        `[whitebox-bg] turn ${blockLen} chars > CHUNK_LIMIT ${CHUNK_LIMIT}, truncated`,
      );
    }

    let pathRel = `conversations/${dir}/${slug(payload.id)}-part-${state.currentPart}.md`;
    let header = "";

    // Does this part exist? If not, prepend a header.
    let exists = true;
    let existingLen = 0;
    try {
      const cur = await readVaultFile(handle, pathRel);
      existingLen = cur.length;
    } catch {
      exists = false;
    }
    // Seed our in-memory size when we lost state across sessions.
    if (exists && state.currentPartChars < existingLen) {
      state.currentPartChars = existingLen;
    }

    if (!exists) {
      header = buildPartHeader({
        id: payload.id,
        site: payload.site || detectSourceFromSender(sender, payload),
        date: payload.capturedAt,
        groupId: state.groupId,
        part: state.currentPart,
      });
      state.currentPartChars = header.length;
    }

    // If appending this block would exceed the chunk limit, advance to a
    // new part and re-stamp the path + header. Use safeBlockLen so a
    // truncated giant turn doesn't cause us to split repeatedly.
    if (state.currentPartChars + safeBlockLen > CHUNK_LIMIT && exists) {
      state.currentPart += 1;
      state.currentPartChars = 0;
      pathRel = `conversations/${dir}/${slug(payload.id)}-part-${state.currentPart}.md`;
      header = buildPartHeader({
        id: payload.id,
        site: payload.site || detectSourceFromSender(sender, payload),
        date: payload.capturedAt,
        groupId: state.groupId,
        part: state.currentPart,
      });
      state.currentPartChars = header.length;
      exists = false; // new file
    }

    const toWrite = (header || "") + safeBlock;
    if (!exists) {
      // First write to this part: header + block
      await appendVaultFile(handle, pathRel, toWrite);
    } else {
      await appendVaultFile(handle, pathRel, safeBlock);
    }
    state.currentPartChars += safeBlockLen;
    writtenPath = pathRel;
    writtenChunks += 1;
  }

  state.lastCount += newTurns.length;
  await chrome.storage.local.set({ [stateKey]: state });

  return { ok: true, written: writtenChunks, path: writtenPath, part: state.currentPart };
}

function dateDir(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slug(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
}

function buildPartHeader({ id, site, date, groupId, part }) {
  const front = [
    "---",
    `schema: whitebox/1.1`,
    `kind: conversation`,
    `site: ${site || "unknown"}`,
    `conversation_id: ${id}`,
    `group_id: ${groupId}`,
    `part: ${part}`,
    `started_at: ${date || new Date().toISOString()}`,
    `---`,
    "",
    `# Conversation \u2014 ${id} \u2014 part ${part}`,
    "",
    `Auto-logged by WhiteBox extension. Append-only. Read independently per part.`,
    "",
  ].join("\n");
  return front + "\n";
}

function formatTurnBlock(turn, payload) {
  const ts = payload.capturedAt || new Date().toISOString();
  const role = (turn.role === "assistant" ? "assistant" : "user").trim();
  const body = String(turn.text || "").trim();
  return `\n## ${role}\n\n<!-- ts: ${ts} -->\n\n${body}\n\n---\n`;
}

/**
 * Walk observations/*.md and count fenced observation blocks tagged
 * `conflict`. Returns 0 when the directory is missing or vault is not
 * accessible (silent failure — the HUD treats this as "no conflicts").
 */
async function countConflicts() {
  let handle;
  try {
    handle = await getGrantedHandle();
  } catch {
    return { ok: false, count: 0, reason: "no_handle_or_permission" };
  }

  let obsDir;
  try {
    obsDir = await handle.getDirectoryHandle("observations", { create: false });
  } catch {
    return { ok: true, count: 0 };
  }

  let count = 0;
  try {
    for await (const [name, entry] of obsDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".md")) continue;
      const file = await entry.getFile();
      const text = await file.text();
      count += countConflictsInFile(text);
    }
  } catch (err) {
    return { ok: false, count, reason: err.message || String(err) };
  }
  return { ok: true, count };
}

function countConflictsInFile(content) {
  let count = 0;
  const blockRe = /```\s*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = blockRe.exec(content))) {
    const block = m[1];
    const fmMatch = block.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];
    const tagLine = fm.split("\n").find((l) => /^tags:\s*\[/.test(l));
    if (!tagLine) continue;
    if (/\bconflict\b/.test(tagLine)) count++;
  }
  return count;
}

async function getGrantedHandle() {
  const handle = await loadVaultHandle();
  if (!handle) {
    throw new Error("no_vault_handle");
  }
  // Try to silently verify permission first.
  let granted = await hasPermission(handle, "readwrite");
  if (!granted) {
    // Auto-request permission — works in service worker context for
    // handles that were previously granted. No user gesture needed
    // for re-requesting a handle the user already picked.
    try {
      granted = await ensurePermission(handle, "readwrite");
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    throw new Error("permission_required");
  }
  return handle;
}

async function readFileFromVault(relPath) {
  const decision = await checkOperationAllowed("read");
  if (!decision.allowed) {
    return {
      error: `session gated (bypass tier "${decision.bypass}" insufficient for read). Ask user to open session or raise bypass.`,
      code: "VAULT_LOCKED",
    };
  }
  const handle = await getGrantedHandle();
  const text = await readVaultFile(handle, relPath);

  // Optional verbose audit (off by default).
  const { auditVerbosity } = await chrome.storage.local.get([
    "auditVerbosity",
  ]);
  if (auditVerbosity === "all") {
    appendAuditEntry({
      kind: "read",
      source: "claude.ai",
      target: relPath,
      viaBypass: decision.viaBypass,
      tier: decision.tier,
    }).catch(() => {});
  }
  return { ok: true, content: text };
}

async function readBootstrapBundle() {
  // Bootstrap is a "read" operation. If vault is locked and bypass tier
  // doesn't allow reads, return a stub the agent can recognize so it
  // tells the user to unlock.
  const decision = await checkOperationAllowed("read");
  if (!decision.allowed) {
    return {
      ok: true,
      locked: true,
      files: {
        "vault-status.md":
          "The user's WhiteBox session is currently GATED. The agent cannot read identity, working style, or observations until the user opens the session via the WhiteBox extension popup. Politely tell the user the session is gated when first appropriate, and continue the conversation without vault context until they open it.",
      },
    };
  }
  const handle = await getGrantedHandle();
  const files = ["AGENTS.md", "identity.md", "working-style.md"];
  const chunks = {};
  for (const name of files) {
    try {
      chunks[name] = await readVaultFile(handle, name);
    } catch (err) {
      chunks[name] = null;
    }
  }

  // Include the latest N observations so the agent sees what other
  // sessions have learned about the user. Without this the bootstrap
  // contains only personality + house rules and the agent claims it
  // "can't see anything beyond last time."
  let recentObservations = null;
  try {
    recentObservations = await readRecentObservations(handle, 8);
  } catch {}
  if (recentObservations) {
    chunks["recent observations"] = recentObservations;
  }

  return { ok: true, files: chunks };
}

/**
 * Read the most recent N observation entries across the vault's
 * observations/YYYY-MM.md files (newest month first, newest entries
 * within a month first). Returns a single string with `---` separators.
 */
async function readRecentObservations(handle, maxEntries) {
  let obsDir;
  try {
    obsDir = await handle.getDirectoryHandle("observations", { create: false });
  } catch {
    return null;
  }

  const monthFiles = [];
  for await (const [name, entry] of obsDir.entries()) {
    if (entry.kind !== "file") continue;
    if (!/^\d{4}-\d{2}\.md$/.test(name)) continue;
    monthFiles.push(name);
  }
  monthFiles.sort().reverse();

  const collected = [];
  for (const name of monthFiles) {
    const fileHandle = await obsDir.getFileHandle(name, { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    const entries = splitObservationEntries(text);
    for (const entry of entries.reverse()) {
      collected.push(entry);
      if (collected.length >= maxEntries) break;
    }
    if (collected.length >= maxEntries) break;
  }

  if (collected.length === 0) return null;
  return collected.reverse().join("\n\n---\n\n");
}

function splitObservationEntries(content) {
  // Same logic as the CLI's vault.ts: drop the header, split on `---`,
  // keep the fenced blocks.
  const body = content.replace(/^#[^\n]*\n+/, "").replace(/^(?:[^#\n`]+\n)+/, "");
  return body
    .split(/\n-{3,}\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.includes("```"));
}

function detectSourceFromSender(sender, payload) {
  // Derive the authoritative source from the content script's origin.
  // This prevents a claude.ai content script from claiming to be chatgpt-5.
  const url = sender?.tab?.url || sender?.url || "";
  if (url.includes("claude.ai")) return "claude.ai";
  if (url.includes("chatgpt.com") || url.includes("chat.openai.com")) return "chatgpt.com";
  if (url.includes("gemini.google.com")) return "gemini.google.com";
  // Fallback: if the payload already has a source, preserve it but mark as
  // unverified so the user knows the extension couldn't confirm the origin.
  return payload?.source ? `${payload.source} (unverified)` : "unknown";
}

async function appendObservation(payload, sender) {
  // ─── Source spoofing prevention ───────────────────────────────────────
  // The extension knows its own platform by inspecting the sender's tab URL.
  // Any source the agent declared is overridden with the authoritative value.
  const authoritativeSource = detectSourceFromSender(sender, payload);
  const enforcedPayload = { ...payload, source: authoritativeSource };

  // ─── Lock + bypass enforcement ────────────────────────────────────────
  const conf = String(enforcedPayload.confidence || "").toLowerCase();
  const operationKind =
    conf === "high" || conf === "very-high" ? "write-high" : "write-low";
  const decision = await checkOperationAllowed(operationKind);
  if (!decision.allowed) {
    return {
      error: `session gated (bypass tier "${decision.bypass}" insufficient for ${operationKind}). Ask user to open session or raise bypass.`,
      code: "VAULT_LOCKED",
    };
  }

  // ─── Rate limit (optional, default unlimited) ─────────────────────────
  const { rateLimitPerSession } = await chrome.storage.local.get([
    "rateLimitPerSession",
  ]);
  const cap = rateLimitPerSession ?? 0;
  if (cap > 0 && saveCountThisSession >= cap) {
    return {
      error: `autonomous-save rate limit reached (${cap}/session). Reset in popup or raise cap.`,
      code: "RATE_LIMIT",
    };
  }

  // ─── Actually write ───────────────────────────────────────────────────
  // NOTE: The extension uses File System Access API (no advisory locks).
  // If the MCP server (Node.js) is writing to the same monthly file
  // concurrently, the result is undefined. This is a known limitation of
  // the cross-platform design. For now, we accept the small risk of
  // occasional interleaved writes in high-contention scenarios.
  // See whitebox-mcp/src/vault.ts for the Node-side lock implementation.
  const handle = await getGrantedHandle();

  const date = enforcedPayload?.date || today();
  const month = date.slice(0, 7);
  const monthName = monthLabel(month);
  const relPath = `observations/${month}.md`;

  const block = formatObservationBlock({ ...enforcedPayload, date });

  // Ensure the monthly file has a header if we're creating it fresh.
  try {
    await readVaultFile(handle, relPath);
  } catch {
    const header = `# Observations \u2014 ${monthName}\n\nAppend-only. One observation per entry. Never edit another agent's entries.\n\n---\n`;
    await appendVaultFile(handle, relPath, header);
  }

  await appendVaultFile(handle, relPath, block);
  saveCountThisSession += 1;

  // ─── Audit ────────────────────────────────────────────────────────────
  const lockState = await getLockState();
  await appendAuditEntry({
    kind: "wb-save",
    source: authoritativeSource,
    tags: enforcedPayload.tags,
    confidence: enforcedPayload.confidence,
    target: relPath,
    viaBypass: decision.viaBypass,
    tier: decision.tier,
    danger: lockState.anyDanger,
  });

  return { ok: true, path: relPath, viaBypass: decision.viaBypass };
}

async function vaultStatus() {
  const handle = await loadVaultHandle().catch(() => null);
  if (!handle) return { granted: false, reason: "no_handle" };

  let granted = await hasPermission(handle, "readwrite");
  if (!granted) {
    // Auto-request permission for previously-granted handles.
    try {
      granted = await ensurePermission(handle, "readwrite");
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    return { granted: false, reason: "permission_lost", vaultName: handle.name };
  }

  let entries = [];
  try {
    entries = await listTopLevel(handle);
  } catch (err) {
    return { granted: false, reason: "list_failed", error: err.message };
  }

  const hasAgentsMd = entries.some((e) => e.name === "AGENTS.md");
  return {
    granted: true,
    vaultName: handle.name,
    hasAgentsMd,
    topLevelCount: entries.length,
  };
}

function formatObservationBlock(input) {
  const tags = (input.tags || [])
    .map((t) => `"${String(t).replace(/"/g, '\\"')}"`)
    .join(", ");
  const lines = [
    "```",
    "---",
    `date: ${input.date}`,
    `source: ${input.source || "whitebox-extension"}`,
    `tags: [${tags}]`,
    `confidence: ${input.confidence || "medium"}`,
  ];
  if (input.source_ref) lines.push(`source_ref: ${input.source_ref}`);
  if (input.context) lines.push(`context: ${input.context}`);
  lines.push("---", "", String(input.body || "").trim(), "```");
  return lines.join("\n");
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthLabel(month) {
  const [y, m] = month.split("-").map(Number);
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names[m - 1]} ${y}`;
}
