import path from "node:path";
import { verifyAuditChain, VerifyResult } from "whitebox-shared";

export async function verifyAuditCommand(options: {
  vault?: string;
  type?: string;
  json?: boolean;
}): Promise<void> {
  const vaultRoot = options.vault || process.env.WHITEBOX_VAULT_ROOT || process.cwd();

  const types = options.type
    ? [options.type]
    : ["access", "trust"];

  const results: Record<string, VerifyResult> = {};
  let exitCode = 0;

  for (const t of types) {
    const logPath = path.join(vaultRoot, `audit/${t}.jsonl`);
    const checkpointPath = path.join(vaultRoot, `audit/${t}.checkpoint`);

    const result = await verifyAuditChain(logPath, checkpointPath, true);
    results[t] = result;

    if (result.code !== 0) {
      exitCode = Math.max(exitCode, result.code);
    }
  }

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const [t, result] of Object.entries(results)) {
      const status = result.code === 0 ? "✓" : "✗";
      console.log(`${status} ${t}: ${result.message}`);
      if (result.code !== 0) {
        console.log(`  (exit code ${result.code})`);
      }
    }
  }

  process.exit(exitCode);
}
