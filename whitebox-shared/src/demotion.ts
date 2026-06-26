/**
 * Demotion review — identifying observations that have decayed below
 * relevance thresholds and are candidates for archival or re-evaluation.
 *
 * The promotion system (promotion.ts) decides when a cluster of observations
 * earns the right to become a stable fact. Demotion is the inverse: over
 * time, recency decay reduces an observation's contribution to its cluster's
 * score. When the cluster no longer meets promotion criteria, the underlying
 * observations become "stale" — they're still true (we don't delete history),
 * but they no longer actively shape the agent's model of the user.
 *
 * This module provides pure functions for identifying stale observations
 * and formatting them for review UIs (MCP tool + CLI command).
 *
 * Design principles:
 *   - Stale ≠ false. We mark for review, not deletion.
 *   - User decides: keep, archive, or add a `superseded_by` reaction.
 *   - Thresholds mirror promotion thresholds for consistency.
 */

import type { ParsedObservation } from "./observation-parser.js";
import { observationScore, distinctSources, type PromotionOptions } from "./promotion.js";

export interface StaleFact {
  /** The observation that has decayed. */
  observation: ParsedObservation;
  /** Its current individual score (confidence × trust × recency). */
  currentScore: number;
  /** How many days old the observation is. */
  ageDays: number;
  /** Current recency weight (0-1, lower = older). */
  recencyWeight: number;
  /** Why it's flagged (e.g. "recency below 0.1"). */
  reason: string;
}

export interface StaleReviewOptions {
  /** Date used to compute observation age. Defaults to now. */
  referenceDate?: Date;
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /**
   * Recency threshold below which an observation is flagged as stale.
   * Default 0.1 ≈ "more than ~100 days old" (with 30-day half-life).
   * This is a per-observation heuristic, not a cluster re-evaluation.
   */
  recencyThreshold?: number;
  /**
   * Score threshold below which an observation is flagged.
   * Default 0.15 ≈ "medium confidence, default trust, very old".
   * Mirrors the promotion threshold but at observation level.
   */
  scoreThreshold?: number;
  /** Per-source trust resolver. Defaults to 1.0 for all sources. */
  sourceTrust?: (source: string | undefined) => number;
}

/**
 * Identify observations that have decayed below relevance thresholds.
 *
 * An observation is stale if EITHER:
 *   - Its recency weight is below recencyThreshold (very old)
 *   - Its total score is below scoreThreshold (low confidence + old)
 *
 * Returns observations sorted by age descending (oldest first).
 */
export function listStaleFacts(
  observations: ParsedObservation[],
  opts: StaleReviewOptions = {},
): StaleFact[] {
  const recencyThreshold = opts.recencyThreshold ?? 0.1;
  const scoreThreshold = opts.scoreThreshold ?? 0.15;
  const referenceDate = opts.referenceDate ?? new Date();
  const halfLifeDays = opts.halfLifeDays ?? 30;

  const stale: StaleFact[] = [];

  for (const obs of observations) {
    const score = observationScore(obs, {
      referenceDate,
      halfLifeDays,
      sourceTrust: opts.sourceTrust,
    });

    // Compute age in days for reporting
    let ageDays = 0;
    let recency = 1;
    if (obs.date) {
      const obsMs = Date.parse(obs.date);
      const refMs = referenceDate.getTime();
      if (!Number.isNaN(obsMs) && !Number.isNaN(refMs)) {
        ageDays = Math.max(0, (refMs - obsMs) / (1000 * 60 * 60 * 24));
      }
      // Recency = 2^(-age/halfLife)
      recency = Math.pow(2, -ageDays / halfLifeDays);
    }

    let reason: string | null = null;
    if (recency < recencyThreshold) {
      reason = `recency ${recency.toFixed(3)} below threshold ${recencyThreshold} (~${Math.round(ageDays)} days old)`;
    } else if (score < scoreThreshold) {
      reason = `score ${score.toFixed(3)} below threshold ${scoreThreshold} (confidence: ${obs.confidence || "unknown"})`;
    }

    if (reason) {
      stale.push({
        observation: obs,
        currentScore: score,
        ageDays,
        recencyWeight: recency,
        reason,
      });
    }
  }

  // Sort by age descending (oldest first) so the most stale appear first
  stale.sort((a, b) => b.ageDays - a.ageDays);
  return stale;
}

/**
 * Summarize a stale review for display.
 */
export function formatStaleReview(stale: StaleFact[]): string {
  if (stale.length === 0) {
    return "No stale observations found. All observations are above relevance thresholds.";
  }

  const lines: string[] = [
    `# Demotion Review — ${stale.length} stale observation${stale.length === 1 ? "" : "s"}`,
    "",
    "These observations have decayed below relevance thresholds. They remain in the vault",
    "but no longer actively shape agent behavior. Review and decide: keep, archive, or",
    "add a `superseded` reaction if a newer observation replaces this one.",
    "",
  ];

  for (const fact of stale) {
    const obs = fact.observation;
    lines.push(`## ${obs.date || "no date"} — ${obs.source || "unknown source"}`);
    lines.push("");
    lines.push(`- **Tags:** ${(obs.tags || []).join(", ") || "none"}`);
    lines.push(`- **Confidence:** ${obs.confidence || "unknown"}`);
    lines.push(`- **Age:** ${Math.round(fact.ageDays)} days`);
    lines.push(`- **Recency:** ${fact.recencyWeight.toFixed(3)}`);
    lines.push(`- **Score:** ${fact.currentScore.toFixed(3)}`);
    lines.push(`- **Reason:** ${fact.reason}`);
    lines.push("");
    // Truncate body to first 200 chars for preview
    const preview = (obs.body || "").slice(0, 200);
    lines.push("> " + (preview.length >= 200 ? preview + "..." : preview));
    lines.push("");
  }

  return lines.join("\n");
}
