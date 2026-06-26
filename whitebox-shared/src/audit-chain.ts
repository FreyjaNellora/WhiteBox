/**
 * Hash-chained audit log — ported from ChatBox's `audit_log.py` to TypeScript.
 *
 * Each line is a JSON object with a SHA-256 hash chain linking it to the
 * previous entry. A lightweight checkpoint file stores the latest sequence
 * number and hash for fast verification.
 *
 * Design properties (matching ChatBox v1.5):
 *   - Canonical JSON: sorted keys, minimal separators, no ASCII escape
 *   - Append-only writes (no rewrite, no deletion)
 *   - Atomic checkpoint writes (temp + rename)
 *   - Integrity violation on startup: archive broken log, start fresh, alert
 *   - Standalone verification with exit codes: 0=clean, 1=hash mismatch,
 *     2=truncation, 3=file error
 *
 * This module is intentionally low-level — it knows nothing about access vs
 * trust vs other audit types. Callers provide the payload shape; this module
 * handles the chain mechanics.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The all-zeros hash that seeds the chain. */
export const GENESIS_HASH = "0".repeat(64);

/** Recursively sort object keys so serialization is order-independent. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON stringification for cross-language consistency.
 *
 * Matches Python's sort_keys=True, separators=(",", ":"), ensure_ascii=False:
 * JSON.stringify already emits minimal separators and leaves non-ASCII
 * unescaped, so deep key sorting is the only work needed. Keys are sorted at
 * every nesting level, not just the top.
 */
export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(obj));
}

/** Compute SHA-256(prev_hash + payload_bytes). */
export function hashEntry(prevHash: string, payloadBytes: Buffer): string {
  const h = createHash("sha256");
  h.update(prevHash, "utf-8");
  h.update(payloadBytes);
  return h.digest("hex");
}

/** Atomically write checkpoint file (temp + fsync + rename). */
async function writeCheckpoint(
  seq: number,
  hashHex: string,
  checkpointPath: string,
): Promise<void> {
  const tmp = checkpointPath + ".tmp";
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(`${seq}\n${hashHex}\n`, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, checkpointPath);
}

/** Read checkpoint file; returns (-1, genesis) if missing or malformed. */
async function readCheckpoint(checkpointPath: string): Promise<[number, string]> {
  try {
    const text = await fs.readFile(checkpointPath, "utf-8");
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [-1, GENESIS_HASH];
    return [parseInt(lines[0], 10), lines[1]];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [-1, GENESIS_HASH];
    }
    throw err;
  }
}

/** A single entry in the hash-chained audit log. */
export interface AuditEntry {
  seq: number;
  ts: number;
  hash: string;
  [key: string]: unknown;
}

/** Result of chain verification. */
export interface VerifyResult {
  code: 0 | 1 | 2 | 3;
  message: string;
  lastSeq?: number;
  lastHash?: string;
}

/** Options for creating an AuditChain. */
export interface AuditChainOptions {
  logPath: string;
  checkpointPath: string;
  /** If true, verify on startup and archive broken chains. Default: true. */
  verifyOnStartup?: boolean;
}

/**
 * Hash-chained audit log. Append-only; each entry carries a SHA-256 hash
 * linking it to the previous entry.
 *
 * Thread-safe within one process (Node.js single-threaded event loop).
 * Not safe across processes — use external locking if multi-process.
 */
export class AuditChain {
  readonly logPath: string;
  readonly checkpointPath: string;
  archivedBrokenPath: string | null = null;

  private _seq: number;
  private _prevHash: string;
  /** Serializes appends; concurrent callers queue rather than drop. */
  private _writeQueue: Promise<void> = Promise.resolve();

  constructor(opts: AuditChainOptions) {
    this.logPath = opts.logPath;
    this.checkpointPath = opts.checkpointPath;
    this._seq = -1;
    this._prevHash = GENESIS_HASH;

    if (opts.verifyOnStartup !== false) {
      // Defer to async init — caller must await init()
    }
  }

  /** Must be called before any append operations. Verifies chain on startup. */
  async init(): Promise<void> {
    await this._verifyOnStartup();
  }

  private _initPromise: Promise<void> | null = null;

  /**
   * Idempotent init for long-lived shared instances: the startup
   * verification runs once; later callers await the same promise instead of
   * re-verifying (and re-verification must not race queued appends).
   */
  initOnce(): Promise<void> {
    this._initPromise ??= this._verifyOnStartup();
    return this._initPromise;
  }

  // ------------------------------------------------------------------
  // Startup integrity check
  // ------------------------------------------------------------------

  private async _verifyOnStartup(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });

    let stat;
    try {
      stat = await fs.stat(this.logPath);
    } catch {
      stat = null;
    }

    if (!stat || stat.size === 0) {
      // Fresh start
      this._seq = -1;
      this._prevHash = GENESIS_HASH;
      await writeCheckpoint(this._seq, this._prevHash, this.checkpointPath);
      return;
    }

    const [cpSeq, cpHash] = await readCheckpoint(this.checkpointPath);

    // Verify the chain
    let lastSeq = -1;
    let lastHash = GENESIS_HASH;
    const content = await fs.readFile(this.logPath, "utf-8");
    const lines = content.split("\n");

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo].trim();
      if (!line) continue;

      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        await this._archiveBroken();
        return;
      }

      const seq = entry.seq ?? lineNo;
      const entryHash = entry.hash ?? "";
      const { hash: _h, ...payload } = entry;
      const payloadBytes = Buffer.from(canonicalJson(payload), "utf-8");
      const computed = hashEntry(lastHash, payloadBytes);

      if (computed !== entryHash) {
        await this._archiveBroken();
        return;
      }

      lastSeq = seq;
      lastHash = entryHash;
    }

    // Compare with checkpoint
    if (cpSeq >= 0 && (lastSeq !== cpSeq || lastHash !== cpHash)) {
      await this._archiveBroken();
      return;
    }

    this._seq = lastSeq;
    this._prevHash = lastHash;
  }

  private async _archiveBroken(): Promise<void> {
    const ts = Date.now();
    const brokenLog = this.logPath + `.broken.${ts}.jsonl`;
    const brokenCp = this.checkpointPath + `.broken.${ts}.checkpoint`;

    try {
      await fs.rename(this.logPath, brokenLog).catch(() => {});
      await fs.rename(this.checkpointPath, brokenCp).catch(() => {});
      this.archivedBrokenPath = brokenLog;
    } catch {
      // Fallback: truncate in place
      await fs.writeFile(this.logPath, "", "utf-8").catch(() => {});
      this.archivedBrokenPath = this.logPath;
    }

    this._seq = -1;
    this._prevHash = GENESIS_HASH;
    await writeCheckpoint(this._seq, this._prevHash, this.checkpointPath);

    // Seed fresh log with INTEGRITY_VIOLATION entry
    if (this.archivedBrokenPath) {
      await this.append({
        event: "INTEGRITY_VIOLATION",
        archived_to: path.basename(this.archivedBrokenPath),
        reason: "chain verification failed on startup",
      });
    }
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  /**
   * Append a new audit entry. The payload can contain any fields; `seq`,
   * `ts`, and `hash` are added automatically.
   *
   * Concurrent calls are serialized through a write queue so every entry
   * lands, in call order. Each caller's promise reflects its own write; a
   * failed write does not block later ones.
   */
  async append(payload: Record<string, unknown>): Promise<void> {
    const task = this._writeQueue.then(() => this._appendNow(payload));
    this._writeQueue = task.catch(() => {});
    return task;
  }

  private async _appendNow(payload: Record<string, unknown>): Promise<void> {
    this._seq += 1;
    // Allow caller to override timestamp (for backdated entries in tests/imports)
    const ts = payload.ts_override ?? Date.now() / 1000;
    delete payload.ts_override;
    const entry: Record<string, unknown> = {
      seq: this._seq,
      ts,
      ...payload,
    };

    const payloadBytes = Buffer.from(canonicalJson(entry), "utf-8");
    const entryHash = hashEntry(this._prevHash, payloadBytes);
    entry.hash = entryHash;

    const canonicalLine = canonicalJson(entry) + "\n";

    // Append + fsync so an acknowledged entry survives a crash
    // (UNIFIED_SECURITY_BASELINE: flush + fsync on every audit write).
    const fh = await fs.open(this.logPath, "a");
    try {
      await fh.appendFile(canonicalLine, "utf-8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    this._prevHash = entryHash;
    await writeCheckpoint(this._seq, this._prevHash, this.checkpointPath);
  }

  // ------------------------------------------------------------------
  // Verification
  // ------------------------------------------------------------------

  /**
   * Verify the audit chain.
   *
   * @param full - If true, also compare against checkpoint (truncation detection).
   * @returns VerifyResult with code: 0=clean, 1=hash mismatch, 2=truncation, 3=file error
   */
  async verify(full = true): Promise<VerifyResult> {
    let stat;
    try {
      stat = await fs.stat(this.logPath);
    } catch {
      return { code: 0, message: "No audit log to verify" };
    }

    if (!stat || stat.size === 0) {
      return { code: 0, message: "Audit log is empty" };
    }

    let lastSeq = -1;
    let lastHash = GENESIS_HASH;
    let lineNo = 0;

    try {
      const content = await fs.readFile(this.logPath, "utf-8");
      const lines = content.split("\n");

      for (; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo].trim();
        if (!line) continue;

        let entry: AuditEntry;
        try {
          entry = JSON.parse(line) as AuditEntry;
        } catch (err) {
          return {
            code: 3,
            message: `File error at line ${lineNo + 1}: ${err}`,
          };
        }

        const seq = entry.seq ?? lineNo;
        const entryHash = entry.hash ?? "";
        const { hash: _h, ...payload } = entry;
        const payloadBytes = Buffer.from(canonicalJson(payload), "utf-8");
        const computed = hashEntry(lastHash, payloadBytes);

        if (computed !== entryHash) {
          return {
            code: 1,
            message: `Hash mismatch at seq ${seq} (line ${lineNo + 1})`,
            lastSeq,
            lastHash,
          };
        }

        lastSeq = seq;
        lastHash = entryHash;
      }
    } catch (err) {
      return {
        code: 3,
        message: `File error at line ${lineNo + 1}: ${err}`,
      };
    }

    if (full) {
      const [cpSeq, cpHash] = await readCheckpoint(this.checkpointPath);
      if (cpSeq >= 0 && (lastSeq !== cpSeq || lastHash !== cpHash)) {
        return {
          code: 2,
          message: `Truncation detected: log ends at seq=${lastSeq}, checkpoint says seq=${cpSeq}`,
          lastSeq,
          lastHash,
        };
      }
    }

    return {
      code: 0,
      message: `Chain verified: ${lastSeq + 1} entries`,
      lastSeq,
      lastHash,
    };
  }
}

const _sharedChains = new Map<string, AuditChain>();

/**
 * Get the process-wide shared AuditChain for a log/checkpoint pair, keyed by
 * resolved log path. Concurrent writers MUST share one instance per log file:
 * two instances over the same file each hold independent seq/prevHash state
 * and race the checkpoint (e.g. fire-and-forget appendAccessEntries calls
 * from concurrent MCP tool handlers). Pair with initOnce(), not init().
 */
export function sharedAuditChain(
  logPath: string,
  checkpointPath: string,
): AuditChain {
  const key = path.resolve(logPath);
  let chain = _sharedChains.get(key);
  if (!chain) {
    chain = new AuditChain({ logPath, checkpointPath });
    _sharedChains.set(key, chain);
  }
  return chain;
}

/**
 * Standalone verification function — verifies a log file without modifying it.
 * Useful for CLI tools and external checks.
 *
 * @returns VerifyResult with code: 0=clean, 1=hash mismatch, 2=truncation, 3=file error
 */
export async function verifyAuditChain(
  logPath: string,
  checkpointPath: string,
  full = true,
): Promise<VerifyResult> {
  const chain = new AuditChain({
    logPath,
    checkpointPath,
    verifyOnStartup: false,
  });
  return chain.verify(full);
}
