import { promises as fs } from "node:fs";
import path from "node:path";
import {
  search,
  parseObservationsFromFile,
  collectMdFiles,
  type ParsedObservation,
} from "whitebox-shared";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";

interface SearchOptions {
  vault?: string;
  tags?: string;          // comma-separated for query_tags
  requireTags?: string;   // comma-separated for require_tags (filter)
  source?: string;        // comma-separated for sources filter
  after?: string;         // YYYY-MM-DD
  limit?: string;
  halfLife?: string;
  json?: boolean;
}

/**
 * `whitebox search [query] [options]`
 *
 * Ranked search over the vault's observations. Composes BM25, tag jaccard,
 * recency decay, access pheromones (when P1.1 lands), and cross-source
 * corroboration into a single score. Returns ranked results with score
 * breakdown so the user can see why each surfaced.
 */
export async function searchCommand(
  query: string | undefined,
  options: SearchOptions,
): Promise<void> {
  const root = resolveVaultRoot(options.vault);
  const vault = new Vault({ root });

  try {
    await vault.ensureExists();
  } catch (err) {
    if (err instanceof VaultError) {
      console.error(`Error (${err.code}): ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const limit = parsePositiveInt(options.limit, 10, "--limit");
  const halfLife = options.halfLife
    ? parsePositiveInt(options.halfLife, 30, "--half-life")
    : undefined;
  const queryTags = options.tags ? splitList(options.tags) : undefined;
  const requireTags = options.requireTags ? splitList(options.requireTags) : undefined;
  const sources = options.source ? splitList(options.source) : undefined;

  if (options.after && !/^\d{4}-\d{2}-\d{2}$/.test(options.after)) {
    console.error(`Error: --after must be ISO YYYY-MM-DD (got "${options.after}")`);
    process.exit(2);
  }

  // Load all observations from observations/, respecting active scope.
  const obsDir = await vault.resolvePath("observations");
  const files = await collectMdFiles(obsDir).catch(() => [] as string[]);
  const allObs: ParsedObservation[] = [];
  for (const filePath of files) {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    if (!(await vault.isInScope(rel))) continue;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseObservationsFromFile(content);
      for (const o of parsed) allObs.push(o);
    } catch {
      // skip unreadable files
    }
  }

  const results = search(allObs, {
    query,
    queryTags,
    requireTags,
    sources,
    dateAfter: options.after,
    limit,
    halfLifeDays: halfLife,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  if (results.length === 0) {
    console.log("\n(no results match the query and filters)\n");
    return;
  }

  console.log(
    `\n${results.length} result${results.length === 1 ? "" : "s"} ranked by relevance + recency + corroboration:\n`,
  );
  for (const r of results) {
    const o = r.observation;
    const b = r.breakdown;
    console.log(
      `── score ${r.score.toFixed(3)}  ${o.source ?? "?"}  ${o.date ?? "?"}`,
    );
    console.log(
      `   text=${b.text.toFixed(2)} tags=${b.tags.toFixed(2)} recency=${b.recency.toFixed(2)} pheromone=${b.pheromone.toFixed(2)} corroboration=${b.corroboration.toFixed(2)}`,
    );
    console.log(`   tags: [${(o.tags ?? []).join(", ")}]`);
    if (o.confidence) console.log(`   confidence: ${o.confidence}`);
    const body = o.body.replace(/\n/g, " ");
    console.log(`   ${body.length > 240 ? body.slice(0, 240) + "…" : body}`);
    console.log("");
  }
  console.log(
    "Tip: --tags, --require-tags, --source, --after, --limit, --half-life, --json\n",
  );
}

function splitList(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
    console.error(`Error: ${name} must be a positive integer (got "${raw}")`);
    process.exit(2);
  }
  return n;
}
