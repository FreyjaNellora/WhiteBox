import { promises as fs } from "node:fs";
import path from "node:path";
import { collectMdFiles } from "whitebox-shared";
import { Vault, VaultError, resolveVaultRoot } from "../lib/vault.js";

interface GrepOptions {
  vault?: string;
  context?: string;
  ignoreCase?: boolean;
  turn?: boolean;
  json?: boolean;
}

function parseContext(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 20 || String(n) !== raw.trim()) {
    console.error(
      `Error: --context must be an integer 0-20 (got "${raw}")`,
    );
    process.exit(2);
  }
  return n;
}

interface LineMatch {
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

interface TurnMatch {
  file: string;
  turn: number;
  role: string;
  text: string;
}

/**
 * `whitebox grep <pattern>`
 *
 * Search the passive-memory conversations/ directory for matching lines.
 * Pattern is treated as a JavaScript regex source (without slashes).
 *
 * Flags:
 *   -i, --ignore-case       case-insensitive
 *   -C, --context N         show N lines of context around each line match
 *   --turn                  return whole conversation turns containing the match
 *   --json                  machine-readable output
 */
export async function grepCommand(
  pattern: string,
  options: GrepOptions,
): Promise<void> {
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

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, options.ignoreCase ? "i" : "");
  } catch (err) {
    console.error(
      `Invalid regex: ${(err as Error).message}. Tip: shell-escape special chars or quote the whole pattern.`,
    );
    process.exit(2);
    return;
  }

  const ctxLines = parseContext(options.context);
  const convoRoot = await vault.resolvePath("conversations");

  const files = await collectMdFiles(convoRoot);
  if (files.length === 0) {
    if (options.json) {
      process.stdout.write("[]\n");
    } else {
      console.log(
        `\nNo conversation files under ${convoRoot}. Enable passive logging in the extension first.\n`,
      );
    }
    return;
  }

  if (options.turn) {
    const matches: TurnMatch[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, "utf-8");
      const turns = splitTurns(text);
      turns.forEach((t, i) => {
        if (regex.test(t.text)) {
          matches.push({
            file: path.relative(root, file).split(path.sep).join("/"),
            turn: i + 1,
            role: t.role,
            text: t.text,
          });
        }
      });
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(matches, null, 2));
      process.stdout.write("\n");
      return;
    }
    if (matches.length === 0) {
      console.log(`No turn matches for /${pattern}/.`);
      return;
    }
    console.log(`\n${matches.length} matching turn${matches.length === 1 ? "" : "s"}:\n`);
    for (const m of matches) {
      console.log(`── ${m.file} (turn ${m.turn}, ${m.role}) ─`);
      m.text.split("\n").forEach((l) => console.log(`  ${l}`));
      console.log("");
    }
    return;
  }

  // Line-mode
  const matches: LineMatch[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf-8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (!regex.test(line)) return;
      const before =
        ctxLines > 0
          ? lines.slice(Math.max(0, idx - ctxLines), idx)
          : [];
      const after =
        ctxLines > 0 ? lines.slice(idx + 1, idx + 1 + ctxLines) : [];
      matches.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        line: idx + 1,
        text: line,
        before,
        after,
      });
    });
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(matches, null, 2));
    process.stdout.write("\n");
    return;
  }

  if (matches.length === 0) {
    console.log(`No matches for /${pattern}/${options.ignoreCase ? "i" : ""}.`);
    return;
  }

  console.log(`\n${matches.length} match${matches.length === 1 ? "" : "es"}:\n`);
  let lastFile = "";
  for (const m of matches) {
    if (m.file !== lastFile) {
      console.log(`── ${m.file} ─`);
      lastFile = m.file;
    }
    if (ctxLines > 0) {
      m.before.forEach((l, i) => {
        const n = m.line - m.before.length + i;
        console.log(`  ${String(n).padStart(5)}-  ${l}`);
      });
    }
    console.log(`  ${String(m.line).padStart(5)}:  ${m.text}`);
    if (ctxLines > 0) {
      m.after.forEach((l, i) => {
        console.log(`  ${String(m.line + 1 + i).padStart(5)}-  ${l}`);
      });
      console.log("");
    }
  }
  if (ctxLines === 0) console.log("");
}

function splitTurns(text: string): { role: string; text: string }[] {
  // Each turn begins with `## user` or `## assistant`. Body runs until the
  // next heading or `---` separator emitted by the extension.
  const turns: { role: string; text: string }[] = [];
  const re = /^##\s+(user|assistant)\s*$/gm;
  let match: RegExpExecArray | null;
  const indices: { idx: number; role: string }[] = [];
  while ((match = re.exec(text))) {
    indices.push({ idx: match.index, role: match[1] });
  }
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].idx;
    const end = i + 1 < indices.length ? indices[i + 1].idx : text.length;
    const block = text.slice(start, end);
    // Drop the heading line itself, ts comment, and trailing `---`.
    const body = block
      .replace(/^##\s+(user|assistant)\s*\n+/, "")
      .replace(/^<!--[^\n]*-->\n+/m, "")
      .replace(/\n+---\s*\n*$/, "")
      .trim();
    turns.push({ role: indices[i].role, text: body });
  }
  return turns;
}
