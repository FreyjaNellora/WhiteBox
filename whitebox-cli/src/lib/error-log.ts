/**
 * Error log reader for the WhiteBox CLI.
 *
 * The CLI is stateless (run-and-exit), so it only reads error logs and
 * collects diagnostics. Writing errors is handled by the MCP server and
 * extension; the CLI itself is invoked manually and errors are visible
 * in the terminal.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolvePath } from "whitebox-shared";

/**
 * Read error entries from the last N days, most recent first.
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

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = isoDate(cutoff);

    const lines: string[] = [];
    for (const file of files) {
      const dateStr = file.replace(/\.md$/, "");
      if (dateStr < cutoffStr) break;
      const content = await fs.readFile(path.join(dir, file), "utf-8");
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
 * Collect a diagnostics bundle.
 */
export async function collectDiagnostics(vaultRoot: string): Promise<string> {
  const { VERSION: version } = await import("whitebox-shared");
  const sections: string[] = [
    "## WhiteBox Diagnostics",
    "",
    `- **Component:** cli`,
    `- **Version:** ${version}`,
    `- **Platform:** ${os.platform()} ${os.release()} (${os.arch()})`,
    `- **Node:** ${process.version}`,
    `- **Vault:** ${vaultRoot}`,
  ];

  // Vault structure.
  try {
    const entries = await fs.readdir(vaultRoot, { withFileTypes: true });
    const listing = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => `  ${e.isDirectory() ? "d" : "f"} ${e.name}`)
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
