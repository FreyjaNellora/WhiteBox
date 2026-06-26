/**
 * Recency weighting for observations.
 *
 * Older signals matter less. Used by:
 *  - retrieval ranking (recent observations float to the top)
 *  - promotion scoring (a fact corroborated this week is stronger than one
 *    last seen six months ago)
 *  - demotion detection (stale stable facts age out of relevance)
 *
 * Model: exponential decay with configurable half-life.
 *   weight(t) = 2^(-Δdays / halfLifeDays)
 *
 * Defaults to a 30-day half-life — long enough that a regular weekly cadence
 * keeps observations fresh, short enough that life changes propagate within
 * a couple of months. Per-scope configuration is left to the caller.
 *
 * Reference: Generative Agents (Park et al. 2023, §4.1) uses exponential decay
 * 0.995/hr on recency. Per-user adaptive forgetting is standard in recommender
 * literature (Koren 2009, ACM TORS 2025).
 */

export const DEFAULT_HALF_LIFE_DAYS = 30;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Returns a weight in [0, 1] reflecting how "fresh" the observation is.
 * 1.0 at observationDate == referenceDate; 0.5 after one half-life; etc.
 *
 * Future-dated observations (clock skew, tests with synthetic data) clamp to
 * weight 1.0. Malformed/missing dates return 0 — treat them as no signal
 * rather than guessing.
 */
export function recencyWeight(
  observationDate: Date | string | undefined | null,
  referenceDate: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  if (observationDate === undefined || observationDate === null) return 0;
  if (halfLifeDays <= 0) {
    throw new Error(`halfLifeDays must be > 0, got ${halfLifeDays}`);
  }
  const obsTime =
    typeof observationDate === "string"
      ? Date.parse(observationDate)
      : observationDate.getTime();
  if (Number.isNaN(obsTime)) return 0;
  const refTime = referenceDate.getTime();
  const deltaDays = (refTime - obsTime) / MS_PER_DAY;
  if (deltaDays <= 0) return 1; // future or same instant
  return Math.pow(2, -deltaDays / halfLifeDays);
}

/**
 * Convenience: how many days have elapsed between observation and reference.
 * Negative values clamp to 0 (future observations are treated as "now").
 */
export function ageInDays(
  observationDate: Date | string | undefined | null,
  referenceDate: Date = new Date(),
): number {
  if (observationDate === undefined || observationDate === null) return Infinity;
  const obsTime =
    typeof observationDate === "string"
      ? Date.parse(observationDate)
      : observationDate.getTime();
  if (Number.isNaN(obsTime)) return Infinity;
  return Math.max(0, (referenceDate.getTime() - obsTime) / MS_PER_DAY);
}
