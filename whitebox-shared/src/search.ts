/**
 * Vault search — composable ranker over observations.
 *
 * Pure-function ranking. Caller loads candidate observations from disk (using
 * existing parser primitives) and passes them in. We score each, sort, and
 * return ranked results with score breakdown so the agent can see WHY each
 * result surfaced.
 *
 * No embeddings by default — every signal is human-grep-able. The composition:
 *
 *   score = w_text     · BM25(body, query_terms)
 *         + w_tags     · jaccard(observation.tags, query_tags)
 *         + w_recency  · recencyWeight(observation.date)
 *         + w_pheromone · log(1 + access_count)
 *         + w_corroboration · cross_source_bonus
 *
 * The pheromone term defaults to 0 if no access log exists (gracefully
 * degrades pre-P1.1). Cross-source bonus is +0.5 if the matched observation
 * is part of a tag-cluster with ≥2 distinct sources.
 *
 * References: BM25 (Robertson & Zaragoza 2009), classical IR. Plus stigmergy
 * literature for the pheromone interpretation (Dorigo ACO; Halpin folksonomy).
 *
 * Pure functions. No I/O. The MCP/CLI handlers do the loading.
 */

import type { ParsedObservation } from "./observation-parser.js";
import { recencyWeight, DEFAULT_HALF_LIFE_DAYS } from "./recency.js";
import { distinctSources } from "./promotion.js";

/** Default ranking weights. Tunable via SearchOptions; documented in spec. */
export const DEFAULT_WEIGHTS = {
  text: 1.0,
  tags: 1.5,         // tag matches are stronger signal than token matches
  recency: 0.8,
  pheromone: 0.5,
  corroboration: 0.5,
};

/** BM25 hyperparameters. Standard defaults; rarely tuned. */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

export interface SearchOptions {
  /** Free-text query terms. Whitespace-tokenized, lowercased. */
  query?: string;
  /** Required tag intersection. Result must have ALL of these tags. */
  requireTags?: string[];
  /** Tag query for jaccard scoring (does not filter; just ranks). */
  queryTags?: string[];
  /** Restrict to these source agents. */
  sources?: string[];
  /** Date floor — observations strictly older are excluded. */
  dateAfter?: string;
  /** Result cap. Default 10. */
  limit?: number;
  /** Reference date for recency. Defaults to now. */
  referenceDate?: Date;
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Per-observation access counts (pheromone). Indexed by observation index in the input array. */
  accessCounts?: number[];
  /** Override default weights. */
  weights?: Partial<typeof DEFAULT_WEIGHTS>;
  /** Per-source trust multiplier. Defaults to 1.0 for all sources. */
  sourceTrust?: (source: string | undefined) => number;
}

export interface ScoreBreakdown {
  text: number;
  tags: number;
  recency: number;
  pheromone: number;
  corroboration: number;
  total: number;
}

export interface SearchResult {
  /** Index into the input observations array. Lets caller cite back. */
  index: number;
  observation: ParsedObservation;
  score: number;
  breakdown: ScoreBreakdown;
}

/** Lowercase + split on non-word chars + drop short stopword-ish tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ]+/)
    .filter((t) => t.length >= 2);
}

/** Tag jaccard: |A ∩ B| / |A ∪ B|. Returns 0 if either set is empty. */
export function tagJaccard(tagsA: string[], tagsB: string[]): number {
  if (tagsA.length === 0 || tagsB.length === 0) return 0;
  const a = new Set(tagsA.map((t) => t.toLowerCase()));
  const b = new Set(tagsB.map((t) => t.toLowerCase()));
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * BM25 score for one document against a query. Standard formula:
 *   score = Σ IDF(qi) · (tf · (k1+1)) / (tf + k1 · (1 - b + b · |D|/avgdl))
 *
 * For our small corpora (hundreds to low-thousands of observations), naive
 * implementation is fast enough.
 */
export function bm25Score(
  docTokens: string[],
  queryTokens: string[],
  corpusStats: { avgDocLen: number; docFrequencies: Map<string, number>; totalDocs: number },
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const docLen = docTokens.length;
  const termFreqs = new Map<string, number>();
  for (const t of docTokens) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    const tf = termFreqs.get(q) || 0;
    if (tf === 0) continue;
    const df = corpusStats.docFrequencies.get(q) || 0;
    if (df === 0) continue;
    // IDF with the +0.5 / +0.5 smoothing variant; floor at 0 so common terms
    // never push score negative.
    const idf = Math.max(
      0,
      Math.log((corpusStats.totalDocs - df + 0.5) / (df + 0.5) + 1),
    );
    const norm =
      tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / Math.max(1, corpusStats.avgDocLen));
    score += idf * ((tf * (BM25_K1 + 1)) / norm);
  }
  return score;
}

/** Build corpus stats once per search call; reused across all observations. */
export function buildCorpusStats(observations: ParsedObservation[]): {
  avgDocLen: number;
  docFrequencies: Map<string, number>;
  totalDocs: number;
  tokensPerDoc: string[][];
} {
  const tokensPerDoc: string[][] = observations.map((o) => tokenize(o.body || ""));
  const totalDocs = tokensPerDoc.length;
  let totalLen = 0;
  const docFrequencies = new Map<string, number>();
  for (const tokens of tokensPerDoc) {
    totalLen += tokens.length;
    const seen = new Set(tokens);
    for (const t of seen) docFrequencies.set(t, (docFrequencies.get(t) || 0) + 1);
  }
  const avgDocLen = totalDocs === 0 ? 0 : totalLen / totalDocs;
  return { avgDocLen, docFrequencies, totalDocs, tokensPerDoc };
}

/**
 * Run a search over the supplied observations. Returns ranked results with
 * full score breakdown. Side-effect free.
 */
export function search(
  observations: ParsedObservation[],
  opts: SearchOptions = {},
): SearchResult[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const queryTokens = opts.query ? tokenize(opts.query) : [];
  const queryTags = (opts.queryTags ?? []).map((t) => t.toLowerCase());
  const limit = Math.max(1, opts.limit ?? 10);

  // Filter pass: required tags, source restriction, date floor.
  const dateFloor = opts.dateAfter ? Date.parse(opts.dateAfter) : -Infinity;
  const sourceSet = opts.sources ? new Set(opts.sources) : null;
  const requiredTags = opts.requireTags
    ? new Set(opts.requireTags.map((t) => t.toLowerCase()))
    : null;

  const candidates: { idx: number; obs: ParsedObservation }[] = [];
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i];
    if (sourceSet && (!o.source || !sourceSet.has(o.source))) continue;
    if (dateFloor !== -Infinity) {
      const t = o.date ? Date.parse(o.date) : NaN;
      if (Number.isNaN(t) || t < dateFloor) continue;
    }
    if (requiredTags) {
      const obsTags = new Set((o.tags ?? []).map((t) => t.toLowerCase()));
      let allPresent = true;
      for (const r of requiredTags) {
        if (!obsTags.has(r)) {
          allPresent = false;
          break;
        }
      }
      if (!allPresent) continue;
    }
    candidates.push({ idx: i, obs: o });
  }

  if (candidates.length === 0) return [];

  // Build corpus stats over the full input (so IDF reflects the whole vault,
  // not just the candidate slice).
  const stats = buildCorpusStats(observations);

  // Pre-compute tag-cluster source diversity for the corroboration bonus.
  // Two observations are in the same cluster if their tag sets are equal
  // (cheap; refine with overlap-threshold later if useful).
  const tagKey = (tags: string[]) =>
    [...tags].map((t) => t.toLowerCase()).sort().join(",");
  const clusterSources = new Map<string, Set<string>>();
  for (const o of observations) {
    const key = tagKey(o.tags ?? []);
    if (!clusterSources.has(key)) clusterSources.set(key, new Set());
    if (o.source) clusterSources.get(key)!.add(o.source);
  }

  const results: SearchResult[] = candidates.map(({ idx, obs }) => {
    const docTokens = stats.tokensPerDoc[idx];
    const text =
      queryTokens.length === 0
        ? 0
        : bm25Score(docTokens, queryTokens, stats);
    const tags = queryTags.length === 0 ? 0 : tagJaccard(obs.tags ?? [], queryTags);
    const recency = obs.date
      ? recencyWeight(obs.date, opts.referenceDate, opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
      : 0;
    const accessCount = opts.accessCounts?.[idx] ?? 0;
    const pheromone = accessCount > 0 ? Math.log(1 + accessCount) : 0;
    const sourcesInCluster = clusterSources.get(tagKey(obs.tags ?? []))?.size ?? 0;
    const corroboration = sourcesInCluster >= 2 ? 1 : 0;
    const trust = opts.sourceTrust ? opts.sourceTrust(obs.source) : 1.0;

    const breakdown: ScoreBreakdown = {
      text: weights.text * text,
      tags: weights.tags * tags,
      recency: weights.recency * recency,
      pheromone: weights.pheromone * pheromone,
      corroboration: weights.corroboration * corroboration,
      total: 0,
    };
    breakdown.total =
      (breakdown.text + breakdown.tags + breakdown.recency + breakdown.pheromone + breakdown.corroboration) * trust;

    return { index: idx, observation: obs, score: breakdown.total, breakdown };
  });

  // When the user queried for something (text or tags), require a relevance
  // signal — text > 0 OR tags > 0 — to be a candidate. Recency / pheromone /
  // corroboration are RANKING modifiers, not gates: a search for "typescript"
  // shouldn't surface unrelated observations just because they happen to be
  // cross-source corroborated. When there's no query (pure filter mode), keep
  // everything and let recency + pheromone do the ranking.
  const queriedSomething = queryTokens.length > 0 || queryTags.length > 0;
  const filtered = queriedSomething
    ? results.filter((r) => r.breakdown.text > 0 || r.breakdown.tags > 0)
    : results;

  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, limit);
}
