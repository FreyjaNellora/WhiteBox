import { promises as fs } from "node:fs";
import path from "node:path";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";

interface LogOptions {
  vault?: string;
  recent?: string;
  json?: boolean;
}

interface ConversationEntry {
  file: string; // vault-relative
  id: string;
  date: string; // YYYY-MM-DD
  part: number;
  size: number;
  modified: string; // ISO
  firstUserSnippet?: string;
}

/**
 * `whitebox log [--recent N]`
 *
 * Lists recent passive-memory conversation files (under conversations/)
 * sorted by mtime descending. Each line shows the date directory, the
 * conversation id, part number, size, mtime, and a short snippet from
 * the first user turn so you can recognize the session.
 */
export async function logCommand(options: LogOptions): Promise<void> {
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

  const recent = parseRecent(options.recent);
  const convoRoot = await vault.resolvePath("conversations");

  let dateDirs: string[] = [];
  try {
    const entries = await fs.readdir(convoRoot, { withFileTypes: true });
    dateDirs = entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      printNone(options, root);
      return;
    }
    throw err;
  }

  const all: ConversationEntry[] = [];
  for (const date of dateDirs) {
    const dir = path.join(convoRoot, date);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (process.env.WHITEBOX_DEBUG) {
          console.error(`[log] skipping missing date dir: ${dir}`);
        }
        continue;
      }
      throw err;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          if (process.env.WHITEBOX_DEBUG) {
            console.error(`[log] file disappeared mid-scan: ${full}`);
          }
          continue;
        }
        throw err;
      }
      const { id, part } = parseConvoFilename(f);
      let snippet: string | undefined;
      try {
        const text = await fs.readFile(full, "utf-8");
        snippet = firstUserSnippet(text);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      all.push({
        file: `conversations/${date}/${f}`,
        id,
        date,
        part,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        firstUserSnippet: snippet,
      });
    }
  }

  all.sort((a, b) => b.modified.localeCompare(a.modified));
  const slice = all.slice(0, recent);

  if (options.json) {
    process.stdout.write(JSON.stringify(slice, null, 2));
    process.stdout.write("\n");
    return;
  }

  if (slice.length === 0) {
    printNone(options, root);
    return;
  }

  console.log(
    `\n${slice.length} most-recent conversation file${slice.length === 1 ? "" : "s"} in ${root}\n`,
  );
  for (const e of slice) {
    const sizeKB = (e.size / 1024).toFixed(1);
    console.log(`  ${e.modified.slice(0, 19).replace("T", " ")}  ${e.file}`);
    console.log(`    id=${e.id}  part=${e.part}  ${sizeKB} KB`);
    if (e.firstUserSnippet) {
      console.log(`    > ${e.firstUserSnippet}`);
    }
    console.log("");
  }
  console.log(`Tip: pass --recent N to change the count, --json for machine output.\n`);
}

function printNone(options: LogOptions, root: string): void {
  if (options.json) {
    process.stdout.write("[]\n");
    return;
  }
  console.log(`\nNo passive-memory conversations under ${root}/conversations/.`);
  console.log(
    `Enable passive logging in the WhiteBox extension popup to start auto-logging.\n`,
  );
}

function parseRecent(raw: string | undefined): number {
  if (raw === undefined) return 10;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
    console.error(
      `Error: --recent must be a positive integer (got "${raw}")`,
    );
    process.exit(2);
  }
  return n;
}

function parseConvoFilename(name: string): { id: string; part: number } {
  // Expect <id>-part-N.md
  const m = name.match(/^(.+)-part-(\d+)\.md$/);
  if (!m) return { id: name.replace(/\.md$/, ""), part: 1 };
  return { id: m[1], part: parseInt(m[2], 10) };
}

function firstUserSnippet(text: string): string | undefined {
  // Look for the first `## user` heading; grab the first non-empty line after it.
  const idx = text.indexOf("## user");
  if (idx < 0) return undefined;
  const after = text.slice(idx + "## user".length).split("\n");
  for (const raw of after) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("<!--")) continue; // skip ts comment
    if (line.startsWith("##")) break;
    return line.length > 100 ? line.slice(0, 100) + "\u2026" : line;
  }
  return undefined;
}
