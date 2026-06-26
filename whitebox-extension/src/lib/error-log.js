/**
 * Persistent error logger for the WhiteBox browser extension.
 *
 * Dual storage strategy:
 *   1. chrome.storage.session — ring buffer of the last 50 errors. Survives
 *      service worker restarts within a browser session. Fast to read.
 *   2. Vault errors/YYYY-MM-DD.md — persistent, same format as the MCP/CLI
 *      error log. Best-effort (skipped if vault handle is unavailable).
 *
 * All methods are no-throw. If logging itself fails, a console.warn is the
 * last resort.
 */

import {
  loadVaultHandle,
  hasPermission,
  appendVaultFile,
} from "./vault-handle.js";

const RING_KEY = "errorRingBuffer";
const RING_MAX = 50;

/**
 * Log an error to the ring buffer and (best-effort) to the vault.
 */
export async function logError(entry) {
  const ts = new Date().toISOString();
  const line =
    `${ts} component=extension` +
    ` code=${entry.code || "UNKNOWN"}` +
    (entry.context ? ` context=${entry.context}` : "") +
    ` message="${(entry.message || "").replace(/"/g, '\\"')}"`;

  // 1. Ring buffer in chrome.storage.session.
  try {
    const data = await chrome.storage.session.get([RING_KEY]);
    const ring = data[RING_KEY] || [];
    ring.push(line);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    await chrome.storage.session.set({ [RING_KEY]: ring });
  } catch (err) {
    console.warn("[whitebox] error ring-buffer write failed:", err);
  }

  // 2. Vault file (best-effort).
  try {
    const handle = await loadVaultHandle().catch(() => null);
    if (!handle) return;
    const granted = await hasPermission(handle, "readwrite");
    if (!granted) return;

    const date = isoDate(new Date());
    const relPath = `errors/${date}.md`;

    let header = "";
    try {
      // Check if file exists by trying to read. appendVaultFile creates
      // the file if missing, but we want to add a header on first write.
      const dir = await handle.getDirectoryHandle("errors", { create: false });
      await dir.getFileHandle(`${date}.md`, { create: false });
    } catch {
      header = `# Error log — ${date}\n\n`;
    }

    await appendVaultFile(handle, relPath, header + line);
  } catch (err) {
    console.warn("[whitebox] error vault write failed:", err);
  }
}

/**
 * Read recent errors from the ring buffer.
 */
export async function getRecentErrors(maxLines = 20) {
  try {
    const data = await chrome.storage.session.get([RING_KEY]);
    const ring = data[RING_KEY] || [];
    return ring.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Collect a diagnostics bundle for bug reports.
 */
export async function getDiagnostics() {
  const version = "1.0.0-prealpha.6";
  const sections = [
    "## WhiteBox Diagnostics",
    "",
    `- **Component:** extension`,
    `- **Version:** ${version}`,
    `- **Browser:** ${navigator.userAgent}`,
  ];

  // Settings snapshot.
  try {
    const settings = await chrome.storage.local.get([
      "enabled",
      "scope",
      "enabledSites",
      "style",
      "passiveLog",
      "auditVerbosity",
      "rateLimitCap",
    ]);
    sections.push(`- **Enabled:** ${settings.enabled ?? "?"}`);
    sections.push(`- **Scope:** ${settings.scope || "(none)"}`);
    sections.push(`- **Style:** ${settings.style || "?"}`);
    sections.push(
      `- **Sites:** ${JSON.stringify(settings.enabledSites || {})}`,
    );
    sections.push(`- **Passive log:** ${settings.passiveLog ?? false}`);
    sections.push(
      `- **Audit verbosity:** ${settings.auditVerbosity || "writes"}`,
    );
    sections.push(`- **Rate limit cap:** ${settings.rateLimitCap || "unlimited"}`);
  } catch {
    sections.push("- **Settings:** (could not read)");
  }

  // Vault status.
  try {
    const handle = await loadVaultHandle().catch(() => null);
    if (!handle) {
      sections.push(`- **Vault:** no handle`);
    } else {
      const granted = await hasPermission(handle, "readwrite");
      sections.push(
        `- **Vault:** ${handle.name} (permission: ${granted ? "granted" : "expired"})`,
      );
    }
  } catch {
    sections.push(`- **Vault:** (error checking status)`);
  }

  // Recent errors.
  const errors = await getRecentErrors(20);
  sections.push("", "### Recent errors (this session)", "");
  if (errors.length === 0) {
    sections.push("  (none)");
  } else {
    sections.push("```");
    sections.push(errors.join("\n"));
    sections.push("```");
  }

  return sections.join("\n");
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
