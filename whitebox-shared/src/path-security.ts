import { promises as fs } from "node:fs";
import path from "node:path";
import { VaultError } from "./vault-error.js";

/**
 * Resolve a relative path against a vault root with three-layer escape
 * validation: reject absolute paths, reject normalized traversal, and
 * verify the resolved path stays within root.
 *
 * Symlinks are followed and the canonical path is checked against the
 * canonical root. This closes the symlink TOCTOU hole where a directory
 * inside the vault is replaced with a symlink pointing outside.
 */
export async function resolvePath(
  root: string,
  relativePath: string,
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new VaultError(
      `Absolute paths are not permitted: ${relativePath}`,
      "ABSOLUTE_PATH",
    );
  }

  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || normalized.includes(`..${path.sep}`)) {
    throw new VaultError(
      `Path traversal not permitted: ${relativePath}`,
      "PATH_TRAVERSAL",
    );
  }

  // Resolve the root itself so symlinks in the root path are followed.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(path.resolve(root));
  } catch {
    realRoot = path.resolve(root);
  }

  const absolute = path.resolve(realRoot, normalized);

  // Follow symlinks to the canonical path.
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Path doesn't exist yet (e.g. new observation file). Walk up to an
      // existing parent, resolve symlinks there, and reconstruct.
      let dir = path.dirname(absolute);
      while (true) {
        try {
          const realDir = await fs.realpath(dir);
          // Verify the resolved parent directory itself stays inside the vault.
          const relDir = path.relative(realRoot, realDir);
          if (relDir.startsWith("..") || path.isAbsolute(relDir)) {
            throw new VaultError(
              `Path escapes vault root: ${relativePath}`,
              "ESCAPES_ROOT",
            );
          }
          const remainder = path.relative(dir, absolute);
          real = path.join(realDir, remainder);
          // For non-existent paths, resolve the parent directory to catch
          // symlinks in intermediate directories (e.g. observations/evil where
          // evil is a symlink to outside the vault).
          const parent = path.dirname(real);
          try {
            const realParent = await fs.realpath(parent);
            const relParent = path.relative(realRoot, realParent);
            if (relParent.startsWith("..") || path.isAbsolute(relParent)) {
              throw new VaultError(
                `Path escapes vault root: ${relativePath}`,
                "ESCAPES_ROOT",
              );
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          break;
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === "ENOENT") {
            const parent = path.dirname(dir);
            if (parent === dir) {
              throw new VaultError(
                `Path escapes vault root: ${relativePath}`,
                "ESCAPES_ROOT",
              );
            }
            dir = parent;
          } else {
            throw e2;
          }
        }
      }
    } else {
      throw err;
    }
  }

  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultError(
      `Path escapes vault root: ${relativePath}`,
      "ESCAPES_ROOT",
    );
  }

  return real;
}
