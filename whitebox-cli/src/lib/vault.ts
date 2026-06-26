import { promises as fs } from "node:fs";
import path from "node:path";
import { VaultBase, VaultError } from "whitebox-shared";

export { VaultError } from "whitebox-shared";

export class Vault extends VaultBase {
  async ensureExists(): Promise<void> {
    try {
      const stat = await fs.stat(this.root);
      if (!stat.isDirectory()) {
        throw new VaultError(
          `Vault path is not a directory: ${this.root}`,
          "NOT_A_DIRECTORY",
        );
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new VaultError(
          `Vault directory does not exist: ${this.root}`,
          "NOT_FOUND",
        );
      }
      throw err;
    }
  }

  async readFile(relativePath: string): Promise<string | null> {
    if (!(await this.isInScope(relativePath))) {
      throw new VaultError(
        `Path "${relativePath}" is outside the active scope "${this.scope}"`,
        "OUT_OF_SCOPE",
      );
    }
    const absolute = await this.resolvePath(relativePath);
    try {
      const stat = await fs.stat(absolute);
      if (stat.size > 10 * 1024 * 1024) {
        throw new VaultError(
          `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 10 MB): ${relativePath}`,
          "FILE_TOO_LARGE",
        );
      }
      return await fs.readFile(absolute, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Alias for readRecentObservations (inherited from VaultBase). */
  async readLatestObservations(maxEntries: number): Promise<string | null> {
    return this.readRecentObservations(maxEntries);
  }
}

export function resolveVaultRoot(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.WHITEBOX_VAULT_ROOT) {
    return path.resolve(process.env.WHITEBOX_VAULT_ROOT);
  }
  return path.resolve(process.cwd());
}
