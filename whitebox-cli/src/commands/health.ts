import { promises as fs } from "node:fs";
import path from "node:path";
import {
  computeVaultHealth,
  formatVaultHealthReport,
  parseObservationsFromFile,
  collectMdFiles,
  loadAccessCounts,
  loadSourceTrust,
  makeSourceTrustResolver,
  observationId,
  type ParsedObservation,
} from "whitebox-shared";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";

interface HealthOptions {
  vault?: string;
  json?: boolean;
}

/**
 * `whitebox health [--json]`
 *
 * Vault introspection. Surfaces total observation count, source distribution,
 * age buckets, cross-source corroboration rate, access concentration, and
 * top tags. Health hints fire on single-source / low-corroboration / mostly-
 * stale / inactive vaults.
 */
export async function healthCommand(options: HealthOptions): Promise<void> {
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

  // Load observations + access counts (mirrors the MCP tool)
  const obsDir = await vault.resolvePath("observations");
  const files = await collectMdFiles(obsDir).catch(() => [] as string[]);
  const allObs: ParsedObservation[] = [];
  const allIds: string[] = [];
  for (const filePath of files) {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    if (!(await vault.isInScope(rel))) continue;
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = parseObservationsFromFile(content);
      for (let i = 0; i < parsed.length; i++) {
        allObs.push(parsed[i]);
        allIds.push(observationId(rel, i));
      }
    } catch {
      // skip unreadable
    }
  }
  const counts = await loadAccessCounts(root).catch(() => new Map<string, number>());
  const accessCounts = allIds.map((id) => counts.get(id) ?? 0);

  // Wire in per-source trust scores so health report reflects calibrated weights.
  const trustMap = await loadSourceTrust(root).catch(() => new Map<string, number>());
  const sourceTrust = makeSourceTrustResolver(trustMap);

  const report = computeVaultHealth(allObs, { accessCounts, sourceTrust });

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  process.stdout.write("\n" + formatVaultHealthReport(report) + "\n");
}
