/**
 * Synthesis triggers — when the swarm should rebuild its model of the user.
 *
 * Generative Agents (Park et al. 2023) fires reflection on importance-score
 * threshold; HeLa-Mem fires consolidation on associative-edge weight. Same
 * pattern here: detect when enough has changed in the vault that the prior
 * synthesis is stale, and signal "time to re-synthesize."
 *
 * Triggers (any one is sufficient):
 *  1. **Volume**: N new observations since the last synthesis. Default 20.
 *  2. **Life event**: any observation tagged `life-event` since last synthesis.
 *  3. **Tag drift**: the active tag distribution has shifted significantly
 *     vs. the last-synthesis snapshot. Specifically, a tag that was <5%
 *     of recent observations is now >15%, OR a previously-dominant tag
 *     has dropped to near zero.
 *  4. **Demotion**: any stable fact was demoted since last synthesis (signals
 *     the user materially changed). Pluggable — caller passes the demotion
 *     count.
 *  5. **Time fallback**: it has been > 90 days since last synthesis even with
 *     no other signal. Catches the slow-drift case.
 *
 * Pure function — caller supplies the inputs, gets back a structured decision.
 *
 * Reference: Generative Agents importance-triggered reflection
 * (arXiv:2304.03442 §4.2); HeLa-Mem associative thresholds (arXiv:2604.16839);
 * AutoProfiler (ACL 2026) on profile staleness signals.
 */

import type { ParsedObservation } from "./observation-parser.js";
import { ageInDays, DEFAULT_HALF_LIFE_DAYS } from "./recency.js";

export interface SynthesisTriggerInput {
  /** All observations currently in the vault (in any order). */
  observations: ParsedObservation[];
  /** ISO timestamp of the most recent synthesis, or null if none exists yet. */
  lastSynthesisAt: string | null;
  /** Number of stable facts demoted since lastSynthesisAt. */
  demotionsSinceLastSynthesis?: number;
  /** Reference date for time math; defaults to now. */
  referenceDate?: Date;
  /** Override default thresholds. */
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS>;
}

export const DEFAULT_THRESHOLDS = {
  /** Min new observations since last synthesis to fire on volume alone. */
  newObservationCount: 20,
  /** Days since last synthesis to fire on time alone. */
  maxStalenessDays: 90,
  /** Demotions since last synthesis to fire on demotion alone. */
  demotionCount: 1,
  /** Tag drift detection — emerging tag share threshold. */
  tagDriftEmergingShare: 0.15,
  /** Tag drift detection — pre-existing tag share threshold. */
  tagDriftPreviousShare: 0.05,
  /** Recency window (days) for "current" tag distribution. */
  driftWindowDays: 30,
};

export type TriggerReason =
  | "volume"
  | "life-event"
  | "tag-drift"
  | "demotion"
  | "time-fallback";

export interface SynthesisTriggerDecision {
  shouldSynthesize: boolean;
  reasons: TriggerReason[];
  /** Human-readable summary of what fired (for review surfaces). */
  summary: string;
  /** Diagnostic counts for transparency. */
  details: {
    newObservationsSinceLastSynthesis: number;
    lifeEventsSinceLastSynthesis: number;
    demotionsSinceLastSynthesis: number;
    daysSinceLastSynthesis: number | null;
    detectedTagDrift: { tag: string; oldShare: number; newShare: number } | null;
  };
}

/**
 * Decide whether re-synthesis should fire. Returns a structured decision
 * including which triggers matched and a human summary.
 *
 * The function is permissive — any single trigger is enough. Conservative
 * tuning (require multiple triggers) is the caller's choice via thresholds.
 */
export function evaluateSynthesisTriggers(
  input: SynthesisTriggerInput,
): SynthesisTriggerDecision {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const refDate = input.referenceDate ?? new Date();
  const lastMs = input.lastSynthesisAt ? Date.parse(input.lastSynthesisAt) : null;
  const reasons: TriggerReason[] = [];

  // Partition observations by "since last synthesis."
  // If no prior synthesis, ALL observations are "new" — but that can fire
  // volume immediately on a fresh vault with N+ observations, which is
  // probably the right behavior (give the user a baseline synthesis).
  const newSinceLast = input.observations.filter((o) => {
    if (!o.date) return lastMs === null; // count undated only on first synthesis
    if (lastMs === null) return true;
    const ms = Date.parse(o.date);
    if (Number.isNaN(ms)) return false;
    return ms > lastMs;
  });

  // Trigger 1: volume
  if (newSinceLast.length >= t.newObservationCount) {
    reasons.push("volume");
  }

  // Trigger 2: life event
  const lifeEvents = newSinceLast.filter((o) =>
    (o.tags ?? []).some((tag) => tag.toLowerCase() === "life-event"),
  );
  if (lifeEvents.length > 0) {
    reasons.push("life-event");
  }

  // Trigger 3: demotion
  const demotions = input.demotionsSinceLastSynthesis ?? 0;
  if (demotions >= t.demotionCount) {
    reasons.push("demotion");
  }

  // Trigger 4: tag drift
  const tagDrift = detectTagDrift(input.observations, refDate, t);
  if (tagDrift) {
    reasons.push("tag-drift");
  }

  // Trigger 5: time fallback
  let daysSinceLastSynthesis: number | null = null;
  if (lastMs !== null) {
    daysSinceLastSynthesis = Math.max(
      0,
      (refDate.getTime() - lastMs) / 86_400_000,
    );
    if (daysSinceLastSynthesis >= t.maxStalenessDays) {
      reasons.push("time-fallback");
    }
  }

  const shouldSynthesize = reasons.length > 0;
  const summary = shouldSynthesize
    ? `re-synthesize: ${reasons.join(", ")}`
    : "no trigger fired; existing synthesis still adequate";

  return {
    shouldSynthesize,
    reasons,
    summary,
    details: {
      newObservationsSinceLastSynthesis: newSinceLast.length,
      lifeEventsSinceLastSynthesis: lifeEvents.length,
      demotionsSinceLastSynthesis: demotions,
      daysSinceLastSynthesis,
      detectedTagDrift: tagDrift,
    },
  };
}

/**
 * Tag drift: compare the recent tag distribution (last `driftWindowDays`)
 * against the older history. Returns the strongest drift (largest absolute
 * share change crossing the thresholds), or null if no drift detected.
 *
 * Quiet algorithm — works on the actual numbers, no smoothing or ML.
 */
function detectTagDrift(
  observations: ParsedObservation[],
  refDate: Date,
  thresholds: typeof DEFAULT_THRESHOLDS,
): { tag: string; oldShare: number; newShare: number } | null {
  const recent: ParsedObservation[] = [];
  const older: ParsedObservation[] = [];
  for (const o of observations) {
    if (!o.date) continue;
    const age = ageInDays(o.date, refDate);
    if (!Number.isFinite(age)) continue;
    if (age <= thresholds.driftWindowDays) recent.push(o);
    else older.push(o);
  }
  // Need both sides populated to compare.
  if (recent.length < 5 || older.length < 5) return null;

  const tagShare = (set: ParsedObservation[]) => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const o of set) {
      for (const t of o.tags ?? []) {
        const k = t.toLowerCase();
        counts.set(k, (counts.get(k) || 0) + 1);
        total++;
      }
    }
    const shares = new Map<string, number>();
    for (const [k, c] of counts.entries()) shares.set(k, c / Math.max(1, total));
    return shares;
  };
  const recentShares = tagShare(recent);
  const olderShares = tagShare(older);

  // Find the strongest drift: largest |newShare - oldShare| where the
  // crossing meets thresholds.
  let strongest: { tag: string; oldShare: number; newShare: number } | null = null;
  let strongestDelta = 0;
  const allTags = new Set<string>([...recentShares.keys(), ...olderShares.keys()]);
  for (const tag of allTags) {
    const oldShare = olderShares.get(tag) ?? 0;
    const newShare = recentShares.get(tag) ?? 0;
    // Emerging tag: was below previousShare floor, now above emergingShare ceiling
    const emerged = oldShare < thresholds.tagDriftPreviousShare && newShare > thresholds.tagDriftEmergingShare;
    // Faded tag: was above emergingShare ceiling, now below previousShare floor
    const faded = oldShare > thresholds.tagDriftEmergingShare && newShare < thresholds.tagDriftPreviousShare;
    if (emerged || faded) {
      const delta = Math.abs(newShare - oldShare);
      if (delta > strongestDelta) {
        strongestDelta = delta;
        strongest = { tag, oldShare, newShare };
      }
    }
  }
  return strongest;
}
