import { promises as fs } from "node:fs";
import path from "node:path";
import { VaultError } from "./vault-error.js";
import {
  ScopeDefinition,
  parseScopes,
  checkInScope,
  canSourceAccess,
} from "./scope.js";
import { resolvePath } from "./path-security.js";
import {
  splitObservationEntries,
  parseObservationsFromFile,
  type ParsedObservation,
} from "./observation-parser.js";
import { recencyWeight, DEFAULT_HALF_LIFE_DAYS, ageInDays } from "./recency.js";
import { latestSynthesis, type Synthesis } from "./synthesis.js";

export interface VaultConfig {
  root: string;
  scope?: string;
  /** MEM-2: the server's pinned source identity (e.g. "mcp:claude"), set by the
   *  launcher from WHITEBOX_SOURCE. When present, scope `grants:` lists are
   *  ENFORCED (a non-granted source is treated as out-of-scope). When absent,
   *  grants stay advisory — unchanged behavior for local single-user use. */
  source?: string;
}

/**
 * Shared vault base class. Owns path resolution, scope enforcement,
 * and observation reading — the logic that was duplicated across the
 * MCP server and CLI packages before unification.
 */
export class VaultBase {
  readonly root: string;
  readonly scope?: string;
  readonly source?: string;

  constructor(config: VaultConfig) {
    this.root = path.resolve(config.root);
    this.scope = config.scope;
    this.source = config.source;
  }

  async resolvePath(relativePath: string): Promise<string> {
    return resolvePath(this.root, relativePath);
  }

  async isInScope(relativePath: string): Promise<boolean> {
    if (!this.scope) return true;

    const scopes = await this.loadScopes();
    if (!scopes) return true;

    const scope = scopes.find((s) => s.name === this.scope);
    if (!scope) {
      throw new VaultError(
        `Active scope "${this.scope}" not defined in scopes.md`,
        "UNKNOWN_SCOPE",
      );
    }

    if (!checkInScope(relativePath, scope.includes)) return false;
    // MEM-2: enforce scope grants only when a source identity is pinned (set by
    // the launcher via WHITEBOX_SOURCE). A non-granted source is treated as
    // out-of-scope. Without a pinned source, grants remain advisory (unchanged).
    if (this.source && !canSourceAccess(scope, this.source)) return false;
    return true;
  }

  async loadScopes(): Promise<ScopeDefinition[] | null> {
    const scopesPath = await this.resolvePath("scopes.md");
    try {
      const content = await fs.readFile(scopesPath, "utf-8");
      return parseScopes(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async readRecentObservations(maxEntries: number): Promise<string | null> {
    const obsDir = await this.resolvePath("observations");
    let monthFiles: string[] = [];
    try {
      // Sort numerically by parsed (year, month) instead of lexicographically.
      // Lexicographic sort happens to work for ISO YYYY-MM but is fragile —
      // any malformed name could land in an unexpected position. Parsing first
      // also lets us defensively skip filenames that pass the regex but
      // contain impossible months (00, 13+).
      monthFiles = (await fs.readdir(obsDir))
        .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
        .map((f) => {
          const [year, month] = f.replace(".md", "").split("-").map(Number);
          return { name: f, year, month };
        })
        .filter((x) => x.month >= 1 && x.month <= 12)
        .sort((a, b) => b.year - a.year || b.month - a.month) // newest first
        .map((x) => x.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    if (monthFiles.length === 0) return null;

    const collected: string[] = [];
    for (const fileName of monthFiles) {
      const rel = `observations/${fileName}`;
      if (!(await this.isInScope(rel))) continue;
      const filePath = path.join(obsDir, fileName);
      const stat = await fs.stat(filePath);
      if (stat.size > 10 * 1024 * 1024) continue; // Skip files > 10 MB
      const content = await fs.readFile(filePath, "utf-8");
      const entries = splitObservationEntries(content);
      for (const entry of entries.reverse()) {
        collected.push(entry);
        if (collected.length >= maxEntries) break;
      }
      if (collected.length >= maxEntries) break;
    }
    if (collected.length === 0) return null;
    return collected.reverse().join("\n\n---\n\n");
  }

  /**
   * Role-aligned bootstrap selection. Each agent gets a view tuned to its
   * source identity:
   *   - **Own continuity** — observations *this* agent authored (chronological)
   *   - **Collective truth** — observations whose tag-cluster spans ≥2 distinct
   *     sources (cross-corroborated; what "we" agree on)
   *
   * Stops the failure mode where the most prolific agent's view crystallizes
   * into the canonical model of the user. Each agent sees its own history plus
   * what the swarm collectively agrees on, instead of one agent's monoculture.
   *
   * Scoring (deterministic, no embeddings):
   *   score = 2.0 (if source matches)
   *         + 1.0 (if observation participates in a cross-source tag cluster)
   *         + recencyWeight(date)              ← tiebreaker / drift control
   *
   * Returns up to `maxEntries` observations, formatted as a single string with
   * `---` separators for direct injection into a bootstrap. `null` when the
   * vault has no observations yet.
   *
   * Reference: Intrinsic Memory Agents (arXiv:2508.08997) — heterogeneous
   * agents with role-aligned memory views over a shared store.
   */
  async readRoleAlignedObservations(opts: {
    source: string;
    maxEntries: number;
    referenceDate?: Date;
    halfLifeDays?: number;
  }): Promise<string | null> {
    const obsDir = await this.resolvePath("observations");
    let monthFiles: string[] = [];
    try {
      monthFiles = (await fs.readdir(obsDir))
        .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
        .map((f) => {
          const [year, month] = f.replace(".md", "").split("-").map(Number);
          return { name: f, year, month };
        })
        .filter((x) => x.month >= 1 && x.month <= 12)
        .sort((a, b) => b.year - a.year || b.month - a.month)
        .map((x) => x.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    if (monthFiles.length === 0) return null;

    // Parse all observations in scope. We need parsed structure (source,
    // tags, date) to score, AND the raw text to splice back into the bootstrap.
    // We can't use splitObservationEntries here because the YAML `---`
    // separators inside each fenced block interfere with the cross-block
    // `---` separators — both look identical to a naive splitter. Instead,
    // walk the same regex parseObservationsFromFile uses and capture match[0]
    // (the full fenced block including the ```...``` markers) alongside the
    // parsed structure. Indexes line up by construction.
    interface Candidate {
      raw: string;
      parsed: ParsedObservation;
    }
    const candidates: Candidate[] = [];
    const blockRe = /```\s*\n([\s\S]*?)\n```/g;
    for (const fileName of monthFiles) {
      const rel = `observations/${fileName}`;
      if (!(await this.isInScope(rel))) continue;
      const filePath = path.join(obsDir, fileName);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch {
        continue;
      }
      if (stat.size > 10 * 1024 * 1024) continue;
      const content = await fs.readFile(filePath, "utf-8");
      blockRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = blockRe.exec(content))) {
        const parsedEntries = parseObservationsFromFile(match[0]);
        if (parsedEntries.length > 0) {
          candidates.push({ raw: match[0], parsed: parsedEntries[0] });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Build tag-cluster → distinct-source map for the corroboration check.
    // Cluster key = sorted tag list. Refine to jaccard-overlap later if too coarse.
    const clusterSources = new Map<string, Set<string>>();
    for (const c of candidates) {
      const key = [...(c.parsed.tags || [])]
        .map((t) => t.toLowerCase())
        .sort()
        .join(",");
      if (!clusterSources.has(key)) clusterSources.set(key, new Set());
      if (c.parsed.source) clusterSources.get(key)!.add(c.parsed.source);
    }

    const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
    const refDate = opts.referenceDate ?? new Date();

    const scored = candidates.map((c) => {
      const isOwn = c.parsed.source === opts.source ? 2.0 : 0;
      const tagKey = [...(c.parsed.tags || [])]
        .map((t) => t.toLowerCase())
        .sort()
        .join(",");
      const sources = clusterSources.get(tagKey)?.size ?? 0;
      const corroborated = sources >= 2 ? 1.0 : 0;
      const recency = c.parsed.date
        ? recencyWeight(c.parsed.date, refDate, halfLife)
        : 0.5;
      return { ...c, score: isOwn + corroborated + recency };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, opts.maxEntries);
    if (top.length === 0) return null;

    // Re-sort selected entries chronologically (oldest → newest) so the
    // bootstrap reads naturally as a timeline, not a ranking.
    top.sort((a, b) => {
      const ta = a.parsed.date ? Date.parse(a.parsed.date) : 0;
      const tb = b.parsed.date ? Date.parse(b.parsed.date) : 0;
      return ta - tb;
    });

    return top.map((c) => c.raw).join("\n\n---\n\n");
  }

  /**
   * Bootstrap selection — what an agent reads at session start.
   *
   * Three-tier priority:
   *   1. **Fresh synthesis** (preferred when one exists AND is within freshness
   *      window). The synthesis is the swarm's best current model of the user;
   *      it's already the right shape for k=4-10 saturation (LaMP, Lost in
   *      the Middle).
   *   2. **Role-aligned observations** (fallback) — from P1.2; gives this
   *      agent its own continuity + cross-source corroborated facts.
   *   3. **null** if the vault has neither synthesis nor observations.
   *
   * Returns a `BootstrapContent` with the selected text PLUS metadata about
   * which tier fired and why, so callers (and the user) can see how the
   * bootstrap was chosen.
   */
  async readBootstrapContent(opts: {
    source: string;
    maxEntries?: number;
    /** Max age of a synthesis before falling back to observations. Default 30 days. */
    freshnessDays?: number;
    referenceDate?: Date;
    halfLifeDays?: number;
  }): Promise<BootstrapContent> {
    const refDate = opts.referenceDate ?? new Date();
    const freshnessDays = opts.freshnessDays ?? 30;
    const maxEntries = opts.maxEntries ?? 8;

    // Try the synthesis tier first.
    let synthesis: Synthesis | null = null;
    try {
      synthesis = await latestSynthesis(this.root);
    } catch {
      synthesis = null;
    }

    if (synthesis) {
      const age = ageInDays(synthesis.synthesized_at, refDate);
      if (age <= freshnessDays) {
        return {
          tier: "synthesis",
          content: synthesis.body,
          synthesis,
          reason: `latest synthesis is ${Math.round(age)}d old (within ${freshnessDays}d freshness window)`,
        };
      }
      // Stale synthesis — fall through to observations and note it
      const observations = await this.readRoleAlignedObservations({
        source: opts.source,
        maxEntries,
        referenceDate: refDate,
        halfLifeDays: opts.halfLifeDays,
      });
      return {
        tier: "observations",
        content: observations,
        synthesis,
        reason: `synthesis is ${Math.round(age)}d old (stale, > ${freshnessDays}d) — falling back to role-aligned observations`,
      };
    }

    // No synthesis — pure observation tier.
    const observations = await this.readRoleAlignedObservations({
      source: opts.source,
      maxEntries,
      referenceDate: refDate,
      halfLifeDays: opts.halfLifeDays,
    });
    return {
      tier: "observations",
      content: observations,
      synthesis: null,
      reason: observations
        ? "no synthesis exists yet — using role-aligned observations"
        : "vault has no synthesis and no observations",
    };
  }
}

export type BootstrapTier = "synthesis" | "observations";

export interface BootstrapContent {
  /** Which tier provided the content. */
  tier: BootstrapTier;
  /** The selected content (synthesis body or formatted observations). null when vault is empty. */
  content: string | null;
  /** The latest synthesis if one exists, regardless of which tier won. */
  synthesis: Synthesis | null;
  /** Human-readable explanation of why this tier was chosen. */
  reason: string;
}

/**
 * Recursively collect all .md files under a directory.
 * Skips hidden files/dirs and symlinks.
 */
export async function collectMdFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/** YYYY-MM-DD for today. */
export function today(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** "April 2026" from "2026-04". Throws on invalid month. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  if (m < 1 || m > 12 || !Number.isFinite(m)) {
    throw new VaultError(
      `Invalid month in "${month}": expected 01-12`,
      "INVALID_DATE",
    );
  }
  return `${names[m - 1]} ${y}`;
}

/** YYYY-MM-DD from a Date object. */
export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
