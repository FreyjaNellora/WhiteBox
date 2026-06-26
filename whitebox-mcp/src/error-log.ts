/**
 * Persistent error logger for WhiteBox Node components (MCP server + CLI).
 *
 * Writes structured error entries to `errors/YYYY-MM-DD.md` in the vault,
 * mirroring the audit log pattern (`audit/YYYY-MM-DD.md`). Every method is
 * no-throw: if logging itself fails, it falls back to stderr and moves on.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePath } from "whitebox-shared";

export interface ErrorEntry {
  component: "mcp" | "cli";
  code: string;
  message: string;
  stack?: string;
  context?: string;
}

/**
 * Append a single error line to `errors/YYYY-MM-DD.md`.
 * Creates the directory and file (with header) if missing.
 */
export async function appendErrorEntry(
  vaultRoot: string,
  entry: ErrorEntry,
): Promise<void> {
  try {
    const date = isoDate(new Date());
    const dir = await resolvePath(vaultRoot, "errors");
    const filePath = path.join(dir, `${date}.md`);
    await fs.mkdir(dir, { recursive: true });

    const ts = new Date().toISOString();
    const msg = entry.message.replace(/"/g, '\\"');
    let line =
      `${ts} component=${entry.component}` +
      ` code=${entry.code}` +
      (entry.context ? ` context=${entry.context}` : "") +
      ` message="${msg}"`;

    // Append first 5 lines of stack trace as indented continuation.
    if (entry.stack) {
      const stackLines = entry.stack
        .split("\n")
        .slice(1, 6)
        .map((l) => `  ${l.trim()}`);
      line += "\n" + stackLines.join("\n");
    }

    let existing = "";
    try {
      existing = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    if (existing.length === 0) {
      const header = `# Error log — ${date}\n\n`;
      await fs.writeFile(filePath, header + line + "\n", "utf-8");
    } else {
      await fs.writeFile(
        filePath,
        existing.replace(/\s+$/, "") + "\n" + line + "\n",
        "utf-8",
      );
    }
  } catch (err) {
    // Last resort: stderr. Never crash the caller.
    console.error("[whitebox] error-log write failed:", err);
  }
}

/**
 * Read error entries from the last N days, most recent first.
 * Returns raw lines (empty string if no errors found).
 */
export async function readRecentErrors(
  vaultRoot: string,
  days = 7,
): Promise<string> {
  try {
    const dir = await resolvePath(vaultRoot, "errors");
    let files: string[];
    try {
      files = (await fs.readdir(dir))
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort()
        .reverse();
    } catch {
      return "";
    }

    // Filter to last N days.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = isoDate(cutoff);

    const lines: string[] = [];
    for (const file of files) {
      const dateStr = file.replace(/\.md$/, "");
      if (dateStr < cutoffStr) break;
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      // Skip the header line, collect the rest.
      const entries = content
        .split("\n")
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      lines.push(...entries);
    }
    return lines.slice(0, 50).join("\n");
  } catch {
    return "";
  }
}

/**
 * Collect a diagnostics bundle suitable for pasting into a GitHub issue.
 */
export async function collectDiagnostics(
  vaultRoot: string,
  component: "mcp" | "cli",
): Promise<string> {
  const { VERSION: version } = await import("whitebox-shared");
  const sections: string[] = [
    "## WhiteBox Diagnostics",
    "",
    `- **Component:** ${component}`,
    `- **Version:** ${version}`,
    `- **Platform:** ${os.platform()} ${os.release()} (${os.arch()})`,
    `- **Node:** ${process.version}`,
    `- **Vault:** ${vaultRoot}`,
  ];

  // Vault structure (top-level).
  try {
    const entries = await fs.readdir(vaultRoot, { withFileTypes: true });
    // Use emoji only when output goes to a UTF-8-capable terminal; ASCII
    // fallback for non-UTF8 pipes / GitHub-issue copy-paste safety.
    const useEmoji =
      process.stdout.isTTY === true &&
      /UTF-?8/i.test(process.env.LANG || process.env.LC_ALL || "");
    const dirGlyph = useEmoji ? "📁" : "[dir]";
    const fileGlyph = useEmoji ? "📄" : "[file]";
    const listing = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => `  ${e.isDirectory() ? dirGlyph : fileGlyph} ${e.name}`)
      .join("\n");
    sections.push("", "### Vault structure", "", listing);
  } catch {
    sections.push("", "### Vault structure", "", "  (could not read vault)");
  }

  // Recent errors.
  const errors = await readRecentErrors(vaultRoot, 7);
  sections.push("", "### Recent errors (last 7 days)", "");
  if (errors.length === 0) {
    sections.push("  (none)");
  } else {
    sections.push("```");
    sections.push(errors);
    sections.push("```");
  }

  return sections.join("\n");
}

function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
