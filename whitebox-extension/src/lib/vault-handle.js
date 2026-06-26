/**
 * Persistent store for the user's FileSystemDirectoryHandle.
 *
 * Multiple extension contexts (popup, background, content scripts) need to
 * agree on "which folder is the user's vault." chrome.storage can't serialize
 * handles; IndexedDB can. Every context opens the same IDB database and
 * pulls the handle from there.
 *
 * File System Access API permission semantics:
 *   - showDirectoryPicker() must be called from a user gesture (popup button).
 *   - The resulting handle is valid for the current session.
 *   - On browser restart, the permission decays and must be re-requested
 *     via handle.requestPermission(), which also requires a user gesture.
 *
 * Loaded as an ES module from the background service worker (manifest's
 * background.type = "module"). Content scripts cannot use module imports
 * directly in MV3, so they proxy vault operations through messages to the
 * background worker.
 */

const DB_NAME = "whitebox";
const STORE_NAME = "kv";
const HANDLE_KEY = "vaultHandle";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveVaultHandle(handle) {
  await idbSet(HANDLE_KEY, handle);
}

export async function loadVaultHandle() {
  return idbGet(HANDLE_KEY);
}

export async function clearVaultHandle() {
  await idbDelete(HANDLE_KEY);
}

/**
 * Nuke the entire WhiteBox IndexedDB database. Used by the popup's
 * "Reset extension state" / uninstall flow. Returns immediately after
 * deletion is requested; the deleteDatabase callback fires asynchronously.
 *
 * The user's actual vault folder on disk is NOT touched — only the
 * browser's record of which folder it was. They keep their files.
 */
export async function wipeIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      // Another tab/context still has the DB open. Resolve anyway —
      // deletion will complete once they close. Most callers want to
      // continue immediately.
      resolve();
    };
  });
}

/**
 * Verify the extension currently has the requested permission on the handle.
 * Returns true if granted; false if denied or not yet requested.
 * Never triggers a permission prompt.
 */
export async function hasPermission(handle, mode = "readwrite") {
  if (!handle) return false;
  const state = await handle.queryPermission({ mode });
  return state === "granted";
}

/**
 * Request permission on the handle. MUST be called from a user gesture
 * (click handler, etc.). Returns true if granted.
 */
export async function ensurePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  let state = await handle.queryPermission({ mode });
  if (state === "granted") return true;
  state = await handle.requestPermission({ mode });
  return state === "granted";
}

/**
 * Read a text file from the vault by relative path.
 * Subdirectories are resolved via nested getDirectoryHandle calls.
 */
export async function readVaultFile(handle, relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let dir = handle;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: false });
  }
  const fileName = segments[segments.length - 1];
  const fileHandle = await dir.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  return file.text();
}

// Per-path serialization queue. The File System Access API does not expose
// exclusive locks, so two concurrent appendVaultFile() calls to the same path
// race: both read, both write, the second clobbers the first's append.
// We chain promises per relativePath; only one append per path runs at a time.
//
// SECURITY NOTE: This closes the CRITICAL lost-write race identified in
// audit #1. All callers (appendObservation, appendConversationTurns,
// appendAuditEntry, logError) route through appendVaultFile() and are
// therefore protected.
const _appendQueues = new Map();

function _enqueueAppend(relativePath, work) {
  const previous = _appendQueues.get(relativePath) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  _appendQueues.set(relativePath, next);
  // Detach completed entries so the map doesn't grow unbounded.
  next.finally(() => {
    if (_appendQueues.get(relativePath) === next) {
      _appendQueues.delete(relativePath);
    }
  });
  return next;
}

/**
 * Append text to a file (creating intermediate directories and the file
 * itself if they don't exist). Concurrent calls for the same path are
 * serialized in-process to prevent lost-write races (FSA has no flock).
 */
export async function appendVaultFile(handle, relativePath, text) {
  return _enqueueAppend(relativePath, async () => {
    const segments = relativePath.split(/[\\/]+/).filter(Boolean);
    let dir = handle;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i], { create: true });
    }
    const fileName = segments[segments.length - 1];
    const fileHandle = await dir.getFileHandle(fileName, { create: true });

    let existing = "";
    try {
      const file = await fileHandle.getFile();
      existing = await file.text();
    } catch {
      existing = "";
    }

    const writable = await fileHandle.createWritable();
    const newContent =
      existing.length === 0 ? text : existing.replace(/\s+$/, "") + "\n\n" + text;
    await writable.write(newContent);
    await writable.close();
    return relativePath;
  });
}

/**
 * List top-level entries in a directory (for popup UI confirmation that
 * we've got the right folder).
 */
export async function listTopLevel(handle) {
  const entries = [];
  for await (const [name, entryHandle] of handle.entries()) {
    entries.push({ name, kind: entryHandle.kind });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
