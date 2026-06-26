import { VaultError } from "./vault.js";

/**
 * Standard exit codes used by the CLI:
 *   0 — success
 *   1 — unexpected internal error
 *   2 — vault error (validation, schema, scope) — recoverable by user
 *   3 — file/path not found
 *   4 — invalid CLI argument
 *
 * Wrap a command body to centralize this mapping. Existing callers can adopt
 * incrementally; uncaught errors elsewhere fall back to Node's default exit 1
 * behavior.
 */
export async function runCommand(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof VaultError) {
      console.error(`Error (${err.code}): ${err.message}`);
      process.exit(2);
    }
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      console.error(`Error: file or directory not found: ${err.message}`);
      process.exit(3);
    }
    console.error(
      `Internal error: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (process.env.WHITEBOX_DEBUG) {
      console.error(err);
    }
    process.exit(1);
  }
}
