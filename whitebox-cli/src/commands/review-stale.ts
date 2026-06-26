import { promises as fs } from "node:fs";
import { Vault } from "../lib/vault.js";
import {
  listStaleFacts,
  formatStaleReview,
  parseObservationsFromFile,
} from "whitebox-shared";
import path from "node:path";

interface ReviewStaleOptions {
  vault?: string;
  json?: boolean;
  threshold?: string;
}

export async function reviewStaleCommand(options: ReviewStaleOptions): Promise<void> {
  const vault = new Vault({ root: options.vault || process.cwd() });
  await vault.ensureExists();

  // Collect all observations from the vault
  const obsDir = path.join(vault.root, "observations");
  let monthFiles: string[] = [];
  try {
    monthFiles = (await fs.readdir(obsDir))
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .sort()
      .reverse();
  } catch {
    // No observations directory
  }

  const allObservations: ReturnType<typeof parseObservationsFromFile> = [];
  for (const file of monthFiles) {
    const relPath = `observations/${file}`;
    try {
      const content = await vault.readFile(relPath);
      if (!content) continue;
      const parsed = parseObservationsFromFile(content);
      for (const obs of parsed) allObservations.push(obs);
    } catch {
      // Skip unreadable files
    }
  }

  const scoreThreshold = options.threshold ? parseFloat(options.threshold) : undefined;
  const stale = listStaleFacts(allObservations, {
    scoreThreshold: Number.isNaN(scoreThreshold) ? undefined : scoreThreshold,
  });

  if (options.json) {
    console.log(JSON.stringify(stale, null, 2));
    return;
  }

  const report = formatStaleReview(stale);
  console.log(report);
}
