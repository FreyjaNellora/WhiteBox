/**
 * Tag normalization — detect near-duplicate tags for user merge confirmation.
 *
 * The vault accumulates tags from multiple agents over time. Without
 * normalization, `working-style`, `working_style`, `WorkingStyle`, and
 * `work-style` all refer to the same concept but fragment search and
 * corroboration. This module surfaces candidates for consolidation.
 *
 * Design principles:
 *   - NO automatic rewriting. The user confirms every merge.
 *   - Deterministic similarity: no embeddings, no ML.
 *   - Conservative: better to miss a near-duplicate than to false-merge.
 *
 * Similarity signals (any one is enough to flag a candidate pair):
 *   1. Case-insensitive exact match after normalization.
 *   2. Levenshtein distance ≤ 2 for tags of length ≥ 6, or ≤ 1 for shorter.
 *   3. Same canonical form after stripping separators and lowercasing.
 */

/** A tag usage record: where it appears and how often. */
export interface TagUsage {
  tag: string;
  count: number;
  sources: string[];
}

/** A candidate merge pair with similarity reasoning. */
export interface MergeCandidate {
  /** The tag that would be kept (typically the more frequent one). */
  canonical: string;
  /** The tag that would be merged into canonical. */
  duplicate: string;
  /** Human-readable reason for the match. */
  reason: string;
  /** Similarity score [0, 1]; higher = more similar. */
  score: number;
}

/**
 * Collect all tags from observations with their usage counts.
 */
export function collectTagUsage(
  observations: Array<{ tags?: string[]; source?: string }>,
): TagUsage[] {
  const map = new Map<
    string,
    { count: number; sources: Set<string> }
  >();
  for (const obs of observations) {
    for (const tag of obs.tags ?? []) {
      const entry = map.get(tag) ?? { count: 0, sources: new Set<string>() };
      entry.count++;
      if (obs.source) entry.sources.add(obs.source);
      map.set(tag, entry);
    }
  }
  return [...map.entries()]
    .map(([tag, { count, sources }]) => ({
      tag,
      count,
      sources: [...sources],
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Find merge candidates among a set of tags.
 * Returns candidates sorted by score descending.
 */
export function findMergeCandidates(tags: string[]): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i];
      const b = tags[j];
      const pairKey = [a, b].sort().join("\x00");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const candidate = comparePair(a, b);
      if (candidate) candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

function comparePair(a: string, b: string): MergeCandidate | null {
  // Prefer the longer/more canonical form as the keeper.
  const canonical = a.length >= b.length ? a : b;
  const duplicate = a.length >= b.length ? b : a;

  // Signal 1: case-insensitive exact match.
  if (a.toLowerCase() === b.toLowerCase()) {
    return {
      canonical,
      duplicate,
      reason: "case difference",
      score: 1.0,
    };
  }

  // Signal 2: canonical form after stripping separators.
  const ca = canonicalForm(a);
  const cb = canonicalForm(b);
  if (ca === cb && ca.length > 0) {
    return {
      canonical,
      duplicate,
      reason: "separator difference",
      score: 0.95,
    };
  }

  // Signal 3: Levenshtein distance.
  const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
  const maxLen = Math.max(a.length, b.length);
  const threshold = maxLen >= 6 ? 2 : 1;
  if (dist <= threshold && dist > 0) {
    const score = 1 - dist / Math.max(maxLen, 1);
    return {
      canonical,
      duplicate,
      reason: `edit distance ${dist}`,
      score: Math.max(0.5, score),
    };
  }

  return null;
}

/** Strip separators and lowercase for canonical comparison. */
function canonicalForm(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use two rows for O(min(m,n)) space.
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * Format merge candidates for CLI display.
 */
export function formatMergeCandidates(
  candidates: MergeCandidate[],
  usage: TagUsage[],
): string {
  if (candidates.length === 0) {
    return "No near-duplicate tags found. Your tag taxonomy is clean.\n";
  }

  const usageMap = new Map(usage.map((u) => [u.tag, u]));
  const lines: string[] = [
    `${candidates.length} merge candidate${candidates.length === 1 ? "" : "s"} found:\n`,
  ];

  for (const c of candidates) {
    const canonUse = usageMap.get(c.canonical);
    const dupUse = usageMap.get(c.duplicate);
    lines.push(
      `  ${c.canonical} (${canonUse?.count ?? 0} uses)` +
        `  →  ${c.duplicate} (${dupUse?.count ?? 0} uses)` +
        `  — ${c.reason} (score ${c.score.toFixed(2)})`,
    );
  }

  lines.push("\nTo apply a merge, edit the observation files directly or use --apply (not yet implemented).");
  return lines.join("\n") + "\n";
}
