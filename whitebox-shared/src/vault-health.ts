/**
 * vault_health — introspection over the vault's collective memory state.
 *
 * Makes the swarm visible to its user. Answers questions like:
 *   - How many observations live in this vault, and how old are they?
 *   - Which agents have contributed how much?
 *   - What fraction of observations are corroborated across sources vs.
 *     held only by one agent (the "monoculture" risk)?
 *   - Are reads concentrated on a few hot items, or spread evenly?
 *   - What tags dominate the vocabulary?
 *
 * Pure function over an in-memory snapshot. Caller (MCP tool, CLI command)
 * loads observations + access counts from disk and passes them in. Output
 * is a structured report — JSON-friendly, easy to render as text or surface
 * in a UI later.
 *
 * Reference: Emergent Collective Memory (arXiv:2512.10166) — measures
 * "consensus formation rate" and "memory strength concentration" as the
 * two key swarm-health metrics.
 */

import type { ParsedObservation } from "./observation-parser.js";
import { ageInDays } from "./recency.js";

export interface VaultHealthReport {
  /** Total observations in the snapshot. */
  observationCount: number;
  /** Number of distinct non-empty source values. */
  distinctSources: number;
  /** Per-source counts. Sorted by count descending. */
  sourceDistribution: Array<{ source: string; count: number; share: number; trust: number }>;
  /** Bucketed age distribution (last 7d, 7-30d, 30-90d, 90d+, undated). */
  ageDistribution: {
    last7d: number;
    last7to30d: number;
    last30to90d: number;
    over90d: number;
    undated: number;
  };
  /**
   * Cross-source corroboration rate: percentage of observations whose tag-
   * cluster spans ≥2 distinct sources. The "what 'we' agree on" metric.
   * Zero if the vault has only one source (which is the failure mode this
   * metric is designed to surface).
   */
  corroborationRate: number;
  /**
   * Access concentration: top-10% of observations' share of total accesses.
   * 0 means perfectly even (no item read more than any other).
   * 1.0 means all reads concentrated on the top 10% (one obvious hot path).
   * High concentration with low corroboration rate = "the swarm follows one
   * trail no one else has corroborated" — a monoculture warning.
   */
  accessConcentration: number;
  /** Top N tag-frequency. Sorted by count descending. */
  topTags: Array<{ tag: string; count: number }>;
  /**
   * Recency-weighted observation count. A vault with many old observations
   * will have a much smaller weighted count than its raw count, signalling
   * that most "memory" is stale.
   */
  effectiveObservationCount: number;
  /** Snapshot timestamp (ISO). */
  generatedAt: string;
}

/**
 * Compute the vault health report.
 *
 * `accessCounts` is keyed by observation index in the input array, matching
 * the same convention as `search()` in `search.ts`.
 */
export function computeVaultHealth(
  observations: ParsedObservation[],
  opts: {
    accessCounts?: number[];
    referenceDate?: Date;
    halfLifeDays?: number;
    topTagsLimit?: number;
    sourceTrust?: (source: string | undefined) => number;
  } = {},
): VaultHealthReport {
  const refDate = opts.referenceDate ?? new Date();
  const halfLifeDays = opts.halfLifeDays ?? 30;
  const topTagsLimit = opts.topTagsLimit ?? 15;
  const total = observations.length;

  // Source distribution
  const sourceCounts = new Map<string, number>();
  for (const o of observations) {
    const src = (o.source ?? "").trim() || "(unknown)";
    sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
  }
  const sourceDistribution = Array.from(sourceCounts.entries())
    .map(([source, count]) => ({
      source,
      count,
      share: total > 0 ? count / total : 0,
      trust: opts.sourceTrust ? opts.sourceTrust(source) : 1.0,
    }))
    .sort((a, b) => b.count - a.count);
  const distinctSources = sourceDistribution.filter(
    (s) => s.source !== "(unknown)",
  ).length;

  // Age distribution
  const ageDistribution = {
    last7d: 0,
    last7to30d: 0,
    last30to90d: 0,
    over90d: 0,
    undated: 0,
  };
  for (const o of observations) {
    if (!o.date) {
      ageDistribution.undated++;
      continue;
    }
    const age = ageInDays(o.date, refDate);
    if (!Number.isFinite(age)) {
      ageDistribution.undated++;
    } else if (age <= 7) {
      ageDistribution.last7d++;
    } else if (age <= 30) {
      ageDistribution.last7to30d++;
    } else if (age <= 90) {
      ageDistribution.last30to90d++;
    } else {
      ageDistribution.over90d++;
    }
  }

  // Cross-source corroboration rate
  // Cluster key = sorted lowercase tag list. Same definition as search.ts /
  // bootstrap-aligned. An observation is corroborated if its cluster spans
  // ≥2 distinct sources.
  const clusterSources = new Map<string, Set<string>>();
  for (const o of observations) {
    const key = [...(o.tags ?? [])].map((t) => t.toLowerCase()).sort().join(",");
    if (!clusterSources.has(key)) clusterSources.set(key, new Set());
    if (o.source) clusterSources.get(key)!.add(o.source);
  }
  let corroborated = 0;
  for (const o of observations) {
    const key = [...(o.tags ?? [])].map((t) => t.toLowerCase()).sort().join(",");
    if ((clusterSources.get(key)?.size ?? 0) >= 2) corroborated++;
  }
  const corroborationRate = total > 0 ? corroborated / total : 0;

  // Access concentration: top-10% items' share of accesses
  let accessConcentration = 0;
  if (opts.accessCounts && opts.accessCounts.length > 0) {
    const totalAccess = opts.accessCounts.reduce((a, b) => a + b, 0);
    if (totalAccess > 0) {
      const sorted = [...opts.accessCounts].sort((a, b) => b - a);
      const top10pct = Math.max(1, Math.ceil(sorted.length * 0.1));
      const topShare = sorted.slice(0, top10pct).reduce((a, b) => a + b, 0);
      accessConcentration = topShare / totalAccess;
    }
  }

  // Top tags
  const tagCounts = new Map<string, number>();
  for (const o of observations) {
    for (const t of o.tags ?? []) {
      const key = t.toLowerCase();
      tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    }
  }
  const topTags = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topTagsLimit);

  // Effective observation count = sum of recency weights. A vault dominated
  // by old observations has effectiveCount << observationCount, signalling
  // the bootstrap is mostly stale.
  let effective = 0;
  for (const o of observations) {
    if (!o.date) {
      effective += 0.5; // neutral for undated, matches promotion.ts convention
      continue;
    }
    const age = ageInDays(o.date, refDate);
    if (!Number.isFinite(age)) continue;
    effective += Math.pow(2, -age / halfLifeDays);
  }

  return {
    observationCount: total,
    distinctSources,
    sourceDistribution,
    ageDistribution,
    corroborationRate,
    accessConcentration,
    topTags,
    effectiveObservationCount: Math.round(effective * 100) / 100,
    generatedAt: refDate.toISOString(),
  };
}

/**
 * Format the report as human-readable plain text. Used by the CLI command
 * and the MCP tool's text response. Stays grep-friendly.
 */
export function formatVaultHealthReport(report: VaultHealthReport): string {
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════════════════════════╗`);
  lines.push(`║                  VAULT HEALTH REPORT                       ║`);
  lines.push(`╚══════════════════════════════════════════════════════════╝`);
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("── Volume ──");
  lines.push(`  Total observations:      ${report.observationCount}`);
  lines.push(
    `  Effective (recency-weighted): ${report.effectiveObservationCount}`,
  );
  lines.push(`  Distinct sources:        ${report.distinctSources}`);
  lines.push("");
  lines.push("── Source distribution ──");
  if (report.sourceDistribution.length === 0) {
    lines.push("  (no sources)");
  } else {
    for (const s of report.sourceDistribution) {
      const pct = (s.share * 100).toFixed(1);
      const trustStr = s.trust !== 1.0 ? `  trust=${s.trust.toFixed(2)}` : "";
      lines.push(`  ${s.source.padEnd(24)} ${String(s.count).padStart(5)}  (${pct}%)${trustStr}`);
    }
  }
  lines.push("");
  lines.push("── Age distribution ──");
  lines.push(`  Last 7 days:             ${report.ageDistribution.last7d}`);
  lines.push(`  7-30 days ago:           ${report.ageDistribution.last7to30d}`);
  lines.push(`  30-90 days ago:          ${report.ageDistribution.last30to90d}`);
  lines.push(`  Over 90 days ago:        ${report.ageDistribution.over90d}`);
  lines.push(`  Undated:                 ${report.ageDistribution.undated}`);
  lines.push("");
  lines.push("── Swarm coordination ──");
  lines.push(
    `  Cross-source corroboration: ${(report.corroborationRate * 100).toFixed(1)}%  (fraction of observations with ≥2 sources in their tag-cluster)`,
  );
  lines.push(
    `  Access concentration:       ${(report.accessConcentration * 100).toFixed(1)}%  (top-10% of items' share of total accesses; 0 = even, 1 = monoculture)`,
  );
  lines.push("");
  lines.push("── Top tags ──");
  if (report.topTags.length === 0) {
    lines.push("  (no tags yet)");
  } else {
    for (const t of report.topTags) {
      lines.push(`  ${t.tag.padEnd(28)} ${String(t.count).padStart(4)}`);
    }
  }
  lines.push("");

  // Health hints
  const hints: string[] = [];
  if (report.distinctSources < 2 && report.observationCount >= 5) {
    hints.push(
      "⚠  Single-source vault — only one agent has been writing. Cross-source corroboration is impossible until a second agent contributes.",
    );
  }
  if (
    report.observationCount >= 10 &&
    report.corroborationRate < 0.2 &&
    report.distinctSources >= 2
  ) {
    hints.push(
      "⚠  Low corroboration rate — agents aren't agreeing on tag clusters. Could mean tag-vocabulary drift or genuinely divergent views.",
    );
  }
  if (
    report.observationCount >= 20 &&
    report.effectiveObservationCount < report.observationCount * 0.3
  ) {
    hints.push(
      "⚠  Most observations are stale (effective count well below raw count). Consider re-synthesis or pruning.",
    );
  }
  if (
    report.observationCount >= 5 &&
    report.ageDistribution.last7d === 0 &&
    report.ageDistribution.last7to30d === 0
  ) {
    hints.push(
      "⚠  Nothing fresh in the last 30 days. Vault may be inactive or the agent isn't writing.",
    );
  }
  if (hints.length > 0) {
    lines.push("── Health hints ──");
    for (const h of hints) lines.push(`  ${h}`);
    lines.push("");
  }
  return lines.join("\n");
}
