import { resolveVaultRoot } from "../lib/vault.js";
import { collectDiagnostics } from "../lib/error-log.js";

interface DiagnosticsOptions {
  vault?: string;
}

export async function diagnosticsCommand(options: DiagnosticsOptions) {
  try {
    const root = resolveVaultRoot(options.vault);
    const report = await collectDiagnostics(root);
    console.log(report);
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
