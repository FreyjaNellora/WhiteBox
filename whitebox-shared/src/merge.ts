/**
 * merge_syntheses — combine multiple per-agent draft syntheses into a single
 * canonical profile.
 *
 * Design philosophy: NO LLM-mediated merge. Mechanical, deterministic
 * combination only. The agents have already done the hard work of writing
 * their drafts; merge is just attribution + union + deduplication. If the
 * user wants a smarter merge, they invoke an LLM-based one explicitly via
 * the agent (which would call a separate `propose_synthesis` tool with the
 * drafts as input — that's the agent's job, not the merge primitive's).
 *
 * Why mechanical:
 *   - Stays within the "no embeddings, no learning, fully grep-able" rule
 *   - Reviewable: user can always see exactly what each agent contributed
 *   - Reversible: re-run the merge with different drafts, deterministic output
 *
 * Output: a candidate Synthesis with:
 *   - body = sectioned text with per-agent headers
 *   - derived_from = union of all drafts' observation IDs (deduplicated)
 *   - synthesized_by = union of all contributing source identifiers
 *   - version = caller-supplied (typically nextVersion(vaultRoot))
 *
 * Caller decides whether to write it via writeSynthesis(). The merge
 * function never touches disk.
 */

import type { Synthesis, SynthesisOptions } from "./synthesis.js";

export interface MergeOptions {
  /** Drafts to combine. Order is preserved in the output sectioning. */
  drafts: Synthesis[];
  /** Version number for the resulting canonical synthesis. */
  version: number;
  /**
   * Optional explicit ordering of source identifiers. Drafts whose source
   * appears here are emitted in that order; others appended in input order.
   * Useful when one agent has higher trust and should appear first.
   */
  preferredOrder?: string[];
  /**
   * Max body length in characters. If the merged body exceeds this, it is
   * truncated with a marker. Default 8000 (roughly 2k tokens, well within
   * typical context windows).
   */
  maxBodyLength?: number;
}

export interface MergeResult {
  /** Candidate synthesis ready for writeSynthesis(). NOT yet on disk. */
  candidate: SynthesisOptions;
  /** Per-source contribution counts for transparency. */
  contributions: Array<{ source: string; observationCount: number; bodyChars: number }>;
  /** Sources that appeared in multiple drafts (cross-source corroboration). */
  duplicateSources: string[];
}

export function mergeDrafts(opts: MergeOptions): MergeResult {
  if (opts.drafts.length === 0) {
    throw new Error("mergeDrafts requires at least one draft");
  }

  // Order drafts: preferred order first, then input order for the rest.
  let ordered = [...opts.drafts];
  if (opts.preferredOrder && opts.preferredOrder.length > 0) {
    const indexOf = (d: Synthesis) => {
      // A draft is identified by its first synthesized_by entry (drafts have one).
      const src = d.synthesized_by[0] ?? "";
      const idx = opts.preferredOrder!.indexOf(src);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    ordered.sort((a, b) => {
      const ai = indexOf(a);
      const bi = indexOf(b);
      if (ai !== bi) return ai - bi;
      return 0;
    });
  }

  // Detect duplicate sources (agent contributed multiple drafts) — useful
  // signal for the user; not deduplicated automatically because two drafts
  // from the same agent on different dates may both have value.
  const seen = new Set<string>();
  const duplicateSources: string[] = [];
  for (const d of ordered) {
    const src = d.synthesized_by[0] ?? "";
    if (seen.has(src)) {
      if (!duplicateSources.includes(src)) duplicateSources.push(src);
    } else {
      seen.add(src);
    }
  }

  // Sectioned body. Each draft gets a header attributing it.
  const sections: string[] = [];
  for (const d of ordered) {
    const src = d.synthesized_by[0] ?? "(unknown)";
    sections.push(`## From ${src} (synthesized ${d.synthesized_at}, derived from ${d.derived_from.length} observations)\n\n${d.body.trim()}`);
  }
  let body = sections.join("\n\n---\n\n");

  // Exact-paragraph deduplication: remove paragraphs that appear verbatim
  // in earlier sections. This prevents 5+ agents from ballooning to 10K chars
  // when they all say the same thing.
  const paragraphs = body.split(/\n\n+/);
  const seenParagraphs = new Set<string>();
  const deduped: string[] = [];
  for (const p of paragraphs) {
    const normalized = p.trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized.length > 20 && seenParagraphs.has(normalized)) {
      continue; // skip duplicate paragraph
    }
    seenParagraphs.add(normalized);
    deduped.push(p);
  }
  body = deduped.join("\n\n");

  // Length cap with truncation marker.
  const maxLen = opts.maxBodyLength ?? 8000;
  if (body.length > maxLen) {
    const marker = "\n\n<!-- whitebox: merge truncated, original length exceeded max -->\n";
    body = body.slice(0, maxLen - marker.length) + marker;
  }

  // Union derived_from (preserve order, deduplicate).
  const derivedFromSet = new Set<string>();
  const derivedFrom: string[] = [];
  for (const d of ordered) {
    for (const id of d.derived_from) {
      if (!derivedFromSet.has(id)) {
        derivedFromSet.add(id);
        derivedFrom.push(id);
      }
    }
  }

  // Union synthesized_by.
  const sourceSet = new Set<string>();
  const synthesizedBy: string[] = [];
  for (const d of ordered) {
    for (const s of d.synthesized_by) {
      if (!sourceSet.has(s)) {
        sourceSet.add(s);
        synthesizedBy.push(s);
      }
    }
  }

  const contributions = ordered.map((d) => ({
    source: d.synthesized_by[0] ?? "(unknown)",
    observationCount: d.derived_from.length,
    bodyChars: d.body.length,
  }));

  return {
    candidate: {
      synthesized_by: synthesizedBy,
      derived_from: derivedFrom,
      version: opts.version,
      body,
    },
    contributions,
    duplicateSources,
  };
}
