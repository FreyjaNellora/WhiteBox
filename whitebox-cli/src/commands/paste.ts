import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";
import { buildBundle } from "../lib/bundle.js";
import { writeClipboard } from "../lib/clipboard.js";

interface PasteOptions {
  vault?: string;
  scope?: string;
  includeObservations?: string;
}

export async function pasteCommand(options: PasteOptions): Promise<void> {
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

  let utility: string;
  try {
    utility = await writeClipboard(bundle);
  } catch (err) {
    console.error(`Clipboard write failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Fallback: run 'whitebox export' and pipe to your clipboard manually.");
    process.exit(4);
  }

  const chars = bundle.length;
  console.error(
    `Copied ${chars} chars to clipboard via ${utility}. Paste into any agent before your first message.`,
  );
}
