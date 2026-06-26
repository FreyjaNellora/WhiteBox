import { promises as fs } from "node:fs";
import path from "node:path";
import {
  collectTagUsage,
  findMergeCandidates,
  formatMergeCandidates,
  parseObservationsFromFile,
  type ParsedObservation,
} from "whitebox-shared";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";

interface TagsOptions {
  vault?: string;
  json?: boolean;
}

/**
 * `whitebox tags normalize [--json]`
 *
 * Scan all observations for near-duplicate tags and surface merge candidates.
 * Operates in dry-run mode — no files are modified. The user reviews the
 * candidates and edits observation files directly.
 */
export async function tagsNormalizeCommand(options: TagsOptions): Promise<void> {
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

  // Load all observations.
  const obsDir = await vault.resolvePath("observations");
  let files: string[] = [];
  try {
    files = (await fs.readdir(obsDir))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(obsDir, f));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const allObs: ParsedObservation[] = [];
  for (const filePath of files) {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    if (!(await vault.isInScope(rel))) continue;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseObservationsFromFile(content);
      for (const o of parsed) allObs.push(o);
    } catch {
      // skip unreadable
    }
  }

  const usage = collectTagUsage(allObs);
  const tagNames = usage.map((u) => u.tag);
  const candidates = findMergeCandidates(tagNames);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          tagCount: usage.length,
          observationCount: allObs.length,
          candidates,
          usage,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write(
    `\nScanned ${allObs.length} observation${allObs.length === 1 ? "" : "s"} ` +
      `across ${usage.length} distinct tag${usage.length === 1 ? "" : "s"}.\n`,
  );
  process.stdout.write(formatMergeCandidates(candidates, usage));
}
