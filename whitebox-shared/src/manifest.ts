/**
 * Vault manifest — lightweight index for fast health/search introspection.
 *
 * The manifest is a JSON file at `.whitebox/manifest.json` that caches
 * aggregate stats from the observations directory. It is rebuilt on each
 * write (appendObservation) and read by health/search to avoid parsing
 * all observations on every call.
 *
 * Design: intentionally simple. No incremental updates, no watchers.
 * Rebuild is O(n) but happens only on writes. Reads are O(1).
 *
 * If the manifest is missing or stale, callers fall back to full scan.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseObservationsFromFile, type ParsedObservation } from "./observation-parser.js";

export const MANIFEST_DIR = ".whitebox";
export const MANIFEST_FILE = "manifest.json";

export interface VaultManifest {
  /** ISO timestamp of when the manifest was last rebuilt. */
  rebuiltAt: string;
  /** Total observations across all monthly files. */
  observationCount: number;
  /** Per-source observation counts. */
  sourceCounts: Record<string, number>;
  /** Per-tag observation counts. */
  tagCounts: Record<string, number>;
  /** Number of distinct sources. */
  distinctSources: number;
  /** Monthly file list (newest first). */
  monthFiles: string[];
  /** Manifest schema version. */
  version: number;
}

/**
 * Read the manifest if it exists and is fresh enough (rebuilt within
 * `maxAgeMs`). Returns null if missing, unreadable, or stale.
 */
export async function readManifest(
  vaultRoot: string,
  opts: { maxAgeMs?: number } = {},
): Promise<VaultManifest | null> {
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000; // default 24h
  const filePath = path.join(vaultRoot, MANIFEST_DIR, MANIFEST_FILE);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let manifest: VaultManifest;
  try {
    manifest = JSON.parse(content) as VaultManifest;
  } catch {
    return null;
  }

  // Validate required fields
  if (
    typeof manifest.rebuiltAt !== "string" ||
    typeof manifest.observationCount !== "number" ||
    typeof manifest.sourceCounts !== "object" ||
    typeof manifest.tagCounts !== "object" ||
    typeof manifest.distinctSources !== "number" ||
    !Array.isArray(manifest.monthFiles)
  ) {
    return null;
  }

  const age = Date.now() - new Date(manifest.rebuiltAt).getTime();
  if (Number.isNaN(age) || age > maxAge) return null;

  return manifest;
}

/**
 * Build a fresh manifest by scanning all observations/*.md files.
 * Writes the manifest to disk. Idempotent (safe to call multiple times).
 */
export async function rebuildManifest(vaultRoot: string): Promise<VaultManifest> {
  const obsDir = path.join(vaultRoot, "observations");
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
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const sourceCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  let observationCount = 0;

  for (const fileName of monthFiles) {
    const filePath = path.join(obsDir, fileName);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseObservationsFromFile(content);
    for (const obs of parsed) {
      observationCount++;
      const src = obs.source || "(unknown)";
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      for (const t of obs.tags ?? []) {
        const key = t.toLowerCase();
        tagCounts[key] = (tagCounts[key] || 0) + 1;
      }
    }
  }

  const manifest: VaultManifest = {
    rebuiltAt: new Date().toISOString(),
    observationCount,
    sourceCounts,
    tagCounts,
    distinctSources: Object.keys(sourceCounts).length,
    monthFiles,
    version: 1,
  };

  const manifestDir = path.join(vaultRoot, MANIFEST_DIR);
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  return manifest;
}
