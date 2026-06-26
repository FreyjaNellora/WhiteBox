/**
 * Promotion: deciding when a cluster of observations earns the right to
 * become a stable fact about the user (or whatever entity the vault models).
 *
 * Replaces the legacy "≥3 matching observations" rule, which is gameable
 * (one prolific agent dominates) and ignores recency and confidence. The
 * weighted formulation here mirrors what every relevant memory system does:
 *
 *   score = Σ (confidence × source_trust × recency_decay)
 *
 * Promotion fires when the score crosses a threshold AND the corroboration
 * comes from at least two distinct sources (cross-source rule). A single
 * source can still promote, but only if it accumulates substantially more
 * weight (single-source threshold, set higher).
 *
 * References:
 *  - Generative Agents (Park et al. 2023, §4.2): importance-triggered reflection
 *  - HeLa-Mem (2026): associative-weight thresholds for episodic→semantic
 *  - Knowledge-Based Trust (Dong et al. VLDB 2015): per-source trust calibration
 *  - ACM TOIS 2025 survey on agent memory mechanisms
 *
 * Pure functions only — no I/O. Callers (CLI command, MCP tool) provide the
 * candidate observation cluster and read the decision.
 */

import type { ParsedObservation } from "./observation-parser.js";
import { recencyWeight, DEFAULT_HALF_LIFE_DAYS } from "./recency.js";

/**
 * Map the schema's 5-point confidence enum to a numeric weight in [0, 1].
 * Linear-ish curve: very-low contributes minimal signal; very-high near full.
 * Unknown / missing → medium (0.5) so we don't penalize older observations
 * written before confidence was schema-required.
 */
const CONFIDENCE_WEIGHTS: Record<string, number> = {
  "very-low": 0.1,
  "low": 0.3,
  "medium": 0.5,
  "high": 0.7,
  "very-high": 0.9,
};

export function confidenceWeight(confidence: string | undefined): number {
  if (!confidence) return 0.5;
  return CONFIDENCE_WEIGHTS[confidence] ?? 0.5;
}

/**
 * Default per-source trust. P0 treats all sources equally (1.0). Per-source
 * calibration based on historical agreement is a P3 add-on; the function
 * signature here lets callers pass a `sourceTrust` resolver later without
 * changing the promotion API.
 */
export type SourceTrustFn = (source: string | undefined) => number;
export const defaultSourceTrust: SourceTrustFn = () => 1.0;

export interface PromotionOptions {
  /** Date used to compute observation age. Defaults to now. */
  referenceDate?: Date;
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Per-source trust resolver. Defaults to 1.0 for all sources. */
  sourceTrust?: SourceTrustFn;
  /**
   * Score threshold for the cross-source path (≥2 distinct sources required).
   * Default 1.5 ≈ "three medium-confidence observations today across two
   * agents" or "two high-confidence observations within the last week."
   */
  scoreThreshold?: number;
  /**
   * Higher threshold for the single-source path (only one source contributing).
   * Default 3.0 ≈ "five high-confidence observations within the last week from
   * one agent" — substantially more evidence required when no corroborator.
   */
  singleSourceThreshold?: number;
}

/**
 * Kind weight multiplier — P3.3 distinguishes raw quotes from agent
 * inferences user has affirmed.
 *   inference: 1.3 (validated synthesis is stronger identity signal)
 *   quote: 1.0 (raw evidence, default)
 *   undefined: 1.0 (legacy / unspecified; backward-compatible)
 */
function kindWeight(kind: "quote" | "inference" | undefined): number {
  if (kind === "inference") return 1.3;
  return 1.0;
}

/**
 * Score one observation's contribution to a candidate cluster.
 * confidence × source_trust × recency_decay × kind_weight.
 */
export function observationScore(
  obs: ParsedObservation,
  opts: PromotionOptions = {},
): number {
  const conf = confidenceWeight(obs.confidence);
  const trust = (opts.sourceTrust ?? defaultSourceTrust)(obs.source);
  // Missing date: treat as one half-life old (neutral, not zero) so legacy
  // observations without dates aren't silently disqualified.
  const recency = obs.date
    ? recencyWeight(obs.date, opts.referenceDate, opts.halfLifeDays)
    : 0.5;
  const kind = kindWeight(obs.kind);
  return conf * trust * recency * kind;
}

/** Sum of observationScore across the cluster. */
export function clusterScore(
  observations: ParsedObservation[],
  opts: PromotionOptions = {},
): number {
  let total = 0;
  for (const obs of observations) total += observationScore(obs, opts);
  return total;
}

/**
 * Set of distinct non-empty `source` values across the cluster. Used by the
 * cross-source corroboration rule.
 */
export function distinctSources(observations: ParsedObservation[]): Set<string> {
  const sources = new Set<string>();
  for (const obs of observations) {
    if (obs.source && obs.source.trim().length > 0) {
      sources.add(obs.source.trim());
    }
  }
  return sources;
}

export interface PromotionDecision {
  /** Whether the cluster meets promotion criteria. */
  promote: boolean;
  /** Aggregated weighted score. */
  score: number;
  /** Number of distinct sources contributing. */
  distinctSourceCount: number;
  /** Human-readable explanation, suitable for surfacing in a review UI. */
  reason: string;
  /** Effective thresholds used for this evaluation (for transparency). */
  thresholds: { score: number; singleSource: number };
}

/**
 * Decide whether a cluster of observations earns promotion. The rule:
 *
 *   - At least one source must be present (otherwise: no provenance, no promotion)
 *   - Cross-source path: ≥2 distinct sources AND score ≥ scoreThreshold
 *   - Single-source path: exactly 1 source AND score ≥ singleSourceThreshold
 *
 * Decision is fully described by the returned object. No side effects.
 */
export function evaluatePromotion(
  observations: ParsedObservation[],
  opts: PromotionOptions = {},
): PromotionDecision {
  const score = clusterScore(observations, opts);
  const sources = distinctSources(observations);
  const scoreThreshold = opts.scoreThreshold ?? 1.5;
  const singleSourceThreshold = opts.singleSourceThreshold ?? 3.0;
  const thresholds = {
    score: scoreThreshold,
    singleSource: singleSourceThreshold,
  };

  if (observations.length === 0) {
    return {
      promote: false,
      score: 0,
      distinctSourceCount: 0,
      reason: "no observations supplied",
      thresholds,
    };
  }

  if (sources.size === 0) {
    return {
      promote: false,
      score,
      distinctSourceCount: 0,
      reason: "no source attribution on any observation",
      thresholds,
    };
  }

  if (sources.size >= 2 && score >= scoreThreshold) {
    return {
      promote: true,
      score,
      distinctSourceCount: sources.size,
      reason: `cross-source corroboration (${sources.size} sources, score ${score.toFixed(2)} ≥ ${scoreThreshold})`,
      thresholds,
    };
  }

  if (sources.size === 1 && score >= singleSourceThreshold) {
    return {
      promote: true,
      score,
      distinctSourceCount: 1,
      reason: `single-source high weight (score ${score.toFixed(2)} ≥ ${singleSourceThreshold})`,
      thresholds,
    };
  }

  const reason =
    sources.size === 1
      ? `only one source; score ${score.toFixed(2)} below single-source threshold ${singleSourceThreshold}`
      : `score ${score.toFixed(2)} below cross-source threshold ${scoreThreshold} (${sources.size} source${sources.size === 1 ? "" : "s"})`;
  return {
    promote: false,
    score,
    distinctSourceCount: sources.size,
    reason,
    thresholds,
  };
}

// Re-export the half-life constant for callers configuring scopes.
export { DEFAULT_HALF_LIFE_DAYS };
