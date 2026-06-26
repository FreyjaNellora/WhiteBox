/**
 * Access pheromones — read-side audit that reinforces useful observations.
 *
 * Every time an observation surfaces through a tool (vault_search, bootstrap,
 * eventually grep / read_file when those land), we append a single line to
 * `audit/access.jsonl` recording WHO read WHAT and WHEN. Loading the log
 * into a Map<observationId, count> gives us the "pheromone trail" that the
 * search ranker uses to boost frequently-fetched items.
 *
 * Design properties:
 *   - Hash-chained JSONL (matches ChatBox audit_log.py v1.5)
 *   - Plain text, grep-able
 *   - Identifier is `<vault-relative-file>#<position>` — position is the
 *     index of the observation within its file. Stable as long as the file
 *     is append-only, which our schema guarantees.
 *   - The log itself can grow unboundedly; rotation is a v1.1 follow-up.
 *     For now a manual archive-and-compact pass is sufficient.
 *
 * References: Ant Colony Optimization (Dorigo 1992) for the pheromone
 * metaphor. Stigmergy literature (Theraulaz & Bonabeau 1999, Halpin
 * collaborative tagging) for the principle that traces in the environment
 * coordinate behavior without direct agent-to-agent communication.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { AuditChain, sharedAuditChain } from "./audit-chain.js";

/** The relative path inside the vault where access logs are kept. */
export const ACCESS_LOG_PATH = "audit/access.jsonl";
export const ACCESS_CHECKPOINT_PATH = "audit/access.checkpoint";

export interface AccessEntry {
  /** ISO-8601 timestamp. If omitted, current time is used. */
  ts?: string;
  /** Observation identifier — `<file>#<position>`. */
  id: string;
  /** Source that performed the read (e.g. "mcp:claude", "cli:user"). */
  by: string;
  /** Optional context — the tool that surfaced it (e.g. "vault_search"). */
  via?: string;
}

/** Build the stable observation id from its file path and position. */
export function observationId(file: string, position: number): string {
  return `${file}#${position}`;
}

/** Get the shared per-vault AuditChain for access logs. */
function getAccessChain(vaultRoot: string): AuditChain {
  return sharedAuditChain(
    path.join(vaultRoot, ACCESS_LOG_PATH),
    path.join(vaultRoot, ACCESS_CHECKPOINT_PATH),
  );
}

/**
 * Append one or more access entries. Used in batch from the tools that
 * surface multiple observations at once (vault_search, bootstrap).
 *
 * Idempotent against re-creation of the directory; never throws if the
 * audit directory doesn't exist yet — creates it.
 */
export async function appendAccessEntries(
  vaultRoot: string,
  entries: AccessEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  const chain = getAccessChain(vaultRoot);
  await chain.initOnce();
  for (const entry of entries) {
    const payload: Record<string, unknown> = {
      event: "ACCESS",
      id: entry.id,
      by: entry.by,
    };
    if (entry.via) payload.via = entry.via;
    // Pass caller's timestamp if provided; AuditChain will use it instead of current time
    if (entry.ts) {
      // Convert ISO string to Unix seconds for the hash-chain format
      payload.ts_override = Date.parse(entry.ts) / 1000;
    }
    await chain.append(payload);
  }
}

/**
 * Load access counts from the log. Returns a Map keyed by observation id.
 *
 * Optional `sinceDate` (ISO date string) restricts the count window — useful
 * for "what's been hot in the last week" queries. By default counts all-time.
 *
 * Missing log file → empty map (no crashes on a brand-new vault).
 */
export async function loadAccessCounts(
  vaultRoot: string,
  opts: { sinceDate?: string } = {},
): Promise<Map<string, number>> {
  const filePath = path.join(vaultRoot, ACCESS_LOG_PATH);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map();
    }
    throw err;
  }
  const sinceMs = opts.sinceDate ? Date.parse(opts.sinceDate) : -Infinity;
  const counts = new Map<string, number>();
  for (const line of content.split("\n")) {
    if (!line) continue;
    let entry: { ts?: number; id?: string };
    try {
      entry = JSON.parse(line) as { ts?: number; id?: string };
    } catch {
      continue; // skip malformed lines rather than fail the whole load
    }
    if (sinceMs !== -Infinity) {
      // Handle both Unix seconds (number from hash-chain) and ISO strings (legacy)
      let entryMs: number;
      if (typeof entry.ts === "number") {
        entryMs = entry.ts * 1000;
      } else if (typeof entry.ts === "string") {
        entryMs = Date.parse(entry.ts);
      } else {
        continue;
      }
      if (Number.isNaN(entryMs) || entryMs < sinceMs) continue;
    }
    if (entry.id) {
      counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
    }
  }
  return counts;
}
