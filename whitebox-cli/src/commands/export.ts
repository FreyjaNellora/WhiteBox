import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";
import { buildBundle } from "../lib/bundle.js";

interface ExportOptions {
  vault?: string;
  scope?: string;
  includeObservations?: string;
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  const root = resolveVaultRoot(options.vault);
  const includeObservations = Math.max(0, parseInt(options.includeObservations || "5", 10) || 0);

  const vault = new Vault({ root, scope: options.scope });

  let bundle: string | null;
  try {
    bundle = await buildBundle({ vault, includeObservations });
  } catch (err) {
    if (err instanceof VaultError) {
      console.error(`Error (${err.code}): ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  if (!bundle) {
    console.error(
      `No readable WhiteBox files found in ${root}. Check the path, or run 'whitebox init <path>' to create a vault first.`,
    );
    process.exit(3);
  }

  process.stdout.write(bundle);
  if (!bundle.endsWith("\n")) process.stdout.write("\n");
}
