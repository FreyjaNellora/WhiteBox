/**
 * Per-source trust scores — calibrate how much weight each contributing
 * agent's observations carry in promotion. Replaces P0's flat 1.0-for-everyone
 * default with an adjustable, time-decayed, audit-trailed score per source.
 *
 * Design properties:
 *   - Hash-chained JSONL at `audit/trust.jsonl` — matches access-log discipline
 *   - Trust default: 1.0 (no adjustment for sources never seen)
 *   - Adjustments are small additive deltas (typical ±0.1)
 *   - Trust is clamped to [0.1, 2.0] so no source becomes useless or godlike
 *   - Adjustments decay exponentially: events older than 90 days are weighted
 *     half as much as events from the last day. Half-life configurable.
 *   - No "eternal grudges": after a year of inactivity, prior adjustments
 *     are nearly evaporated.
 *
 * Adjustments come from anywhere the caller wants:
 *   - User running `whitebox trust adjust <source> +0.1 --reason "..."`
 *   - Synthesis merge detecting agreement/contradiction
 *   - Manual review — user marks an observation as wrong, source loses trust
 *
 * The shared library only provides storage + read primitives. Population is
 * the caller's policy decision.
 *
 * Reference: Knowledge-Based Trust (Dong et al. VLDB 2015) — per-source
 * trust calibration based on accuracy on known-truth facts. Multi-source
 * trust aggregation (Springer 2023) — direct + indirect trust with time
 * decay. We use the simpler additive form because we have no ground truth
 * to calibrate against; trust is purely user/agent-attested.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { recencyWeight } from "./recency.js";
import { AuditChain, sharedAuditChain } from "./audit-chain.js";

export const TRUST_LOG_PATH = "audit/trust.jsonl";
export const TRUST_CHECKPOINT_PATH = "audit/trust.checkpoint";
export const DEFAULT_TRUST = 1.0;
export const TRUST_MIN = 0.1;
export const TRUST_MAX = 2.0;
export const DEFAULT_TRUST_HALF_LIFE_DAYS = 90;

export interface TrustAdjustment {
  /** ISO-8601 timestamp. If omitted, current time is used. */
  ts?: string;
  /** Source identifier (e.g. "mcp:claude"). */
  source: string;
  /** Additive delta. Positive = agreement reward, negative = penalty. */
  delta: number;
  /** Human-readable reason for the adjustment. */
  reason: string;
  /** Optional: source identifier of who/what made the adjustment (defaults to "system"). */
  by?: string;
}

/** Get the shared per-vault AuditChain for trust logs. */
function getTrustChain(vaultRoot: string): AuditChain {
  return sharedAuditChain(
    path.join(vaultRoot, TRUST_LOG_PATH),
    path.join(vaultRoot, TRUST_CHECKPOINT_PATH),
  );
}

/**
 * Append one or more trust adjustments to the audit log. Idempotent against
 * directory creation.
 */
export async function appendTrustAdjustments(
  vaultRoot: string,
  adjustments: TrustAdjustment[],
): Promise<void> {
  if (adjustments.length === 0) return;
  const chain = getTrustChain(vaultRoot);
  await chain.initOnce();
  for (const adj of adjustments) {
    const payload: Record<string, unknown> = {
      event: "TRUST_ADJUST",
      source: adj.source,
      delta: adj.delta,
      reason: adj.reason,
      by: adj.by ?? "system",
    };
    if (adj.ts) {
      payload.ts_override = Date.parse(adj.ts) / 1000;
    }
    await chain.append(payload);
  }
}

/**
 * Load and compute current trust scores by source. Returns a Map keyed by
 * source identifier. Sources never seen in the log are absent (caller falls
 * back to DEFAULT_TRUST).
 *
 * Adjustments are time-decayed before summing, then added to DEFAULT_TRUST,
 * then clamped to [TRUST_MIN, TRUST_MAX].
 *
 * Missing log file → empty map (no crashes on a brand-new vault).
 */
export async function loadSourceTrust(
  vaultRoot: string,
  opts: { referenceDate?: Date; halfLifeDays?: number } = {},
): Promise<Map<string, number>> {
  const filePath = path.join(vaultRoot, TRUST_LOG_PATH);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  const halfLife = opts.halfLifeDays ?? DEFAULT_TRUST_HALF_LIFE_DAYS;
  const refDate = opts.referenceDate ?? new Date();
  const adjustmentSums = new Map<string, number>();

  for (const line of content.split("\n")) {
    if (!line) continue;
    let entry: { source?: string; delta?: number; ts?: number };
    try {
      entry = JSON.parse(line) as { source?: string; delta?: number; ts?: number };
    } catch {
      continue; // skip malformed lines
    }
    if (!entry.source || typeof entry.delta !== "number") continue;

    // Handle both Unix seconds (number from hash-chain) and ISO strings (legacy)
    let tsIso: string;
    if (typeof entry.ts === "number") {
      tsIso = new Date(entry.ts * 1000).toISOString();
    } else if (typeof entry.ts === "string") {
      tsIso = entry.ts;
    } else {
      continue;
    }
    const decay = recencyWeight(tsIso, refDate, halfLife);
    const decayedDelta = entry.delta * decay;
    adjustmentSums.set(
      entry.source,
      (adjustmentSums.get(entry.source) || 0) + decayedDelta,
    );
  }

  // Apply: DEFAULT_TRUST + sum, then clamp.
  const trustScores = new Map<string, number>();
  for (const [source, sum] of adjustmentSums.entries()) {
    let trust = DEFAULT_TRUST + sum;
    if (trust < TRUST_MIN) trust = TRUST_MIN;
    if (trust > TRUST_MAX) trust = TRUST_MAX;
    trustScores.set(source, trust);
  }
  return trustScores;
}

/**
 * Build a SourceTrustFn closure suitable for `promotion.evaluatePromotion`'s
 * `sourceTrust` option. Wraps the trust map; sources not present in the map
 * default to DEFAULT_TRUST (so unfamiliar agents start neutral).
 *
 * Usage:
 *   const trustMap = await loadSourceTrust(vaultRoot);
 *   const decision = evaluatePromotion(observations, {
 *     sourceTrust: makeSourceTrustResolver(trustMap),
 *   });
 */
export function makeSourceTrustResolver(
  trustMap: Map<string, number>,
): (source: string | undefined) => number {
  return (source: string | undefined): number => {
    if (!source) return DEFAULT_TRUST;
    return trustMap.get(source) ?? DEFAULT_TRUST;
  };
}
