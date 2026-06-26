import { promises as fs } from "node:fs";
import path from "node:path";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";
import { ParsedObservation, parseObservationsFromFile } from "whitebox-shared";

interface ConflictsOptions {
  vault?: string;
  json?: boolean;
}

interface ConflictEntry {
  file: string;
  position: number; // 1-indexed observation number within file
  date?: string;
  source?: string;
  tags: string[];
  confidence?: string;
  context?: string;
  body: string;
}

export async function conflictsCommand(options: ConflictsOptions): Promise<void> {
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

  const obsDir = await vault.resolvePath("observations");
  let files: string[] = [];
  try {
    files = (await fs.readdir(obsDir))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      printNone(options);
      return;
    }
    throw err;
  }

  // NOTE: This scan duplicates Vault.listConflicts() in whitebox-mcp.
  // Assessment: move both the ConflictEntry interface and this loop into
  // VaultBase (whitebox-shared/src/vault-core.ts). VaultBase already has
  // access to fs, path, and parseObservationsFromFile via whitebox-shared.
  // Once it lives on VaultBase, the CLI can call vault.listConflicts()
  // and the MCP can inherit it directly, eliminating the duplication.
  const conflicts: ConflictEntry[] = [];

  for (const file of files) {
    const fullPath = path.join(obsDir, file);
    const content = await fs.readFile(fullPath, "utf-8");
    const entries = parseObservationsFromFile(content);
    entries.forEach((entry, idx) => {
      if (entry.tags.includes("conflict")) {
        conflicts.push({
          file: `observations/${file}`,
          position: idx + 1,
          date: entry.date,
          source: entry.source,
          tags: entry.tags,
          confidence: entry.confidence,
          context: entry.context,
          body: entry.body,
        });
      }
    });
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(conflicts, null, 2));
    process.stdout.write("\n");
    return;
  }

  if (conflicts.length === 0) {
    printNone(options);
    return;
  }

  console.log(`\n${conflicts.length} unresolved ${conflicts.length === 1 ? "conflict" : "conflicts"} in ${root}\n`);
  conflicts.forEach((c, i) => {
    console.log(`──── ${i + 1}/${conflicts.length} ─────────────────────────────────────`);
    console.log(`  ${c.file}  (entry ${c.position})`);
    if (c.date) console.log(`  date:       ${c.date}`);
    if (c.source) console.log(`  source:     ${c.source}`);
    console.log(`  tags:       ${c.tags.join(", ")}`);
    if (c.confidence) console.log(`  confidence: ${c.confidence}`);
    if (c.context) console.log(`  context:    ${c.context}`);
    console.log("");
    const trimmedBody = c.body.length > 400 ? c.body.slice(0, 400) + "\u2026" : c.body;
    trimmedBody.split("\n").forEach((line) => console.log(`  > ${line}`));
    console.log("");
  });

  console.log(`To resolve: edit the file directly, or write a follow-up observation that supersedes it.`);
  console.log(`Tip: re-run with --json for machine-readable output.\n`);
}

function printNone(options: ConflictsOptions): void {
  if (options.json) {
    process.stdout.write("[]\n");
    return;
  }
  console.log("\nNo unresolved conflicts in this vault.\n");
}
