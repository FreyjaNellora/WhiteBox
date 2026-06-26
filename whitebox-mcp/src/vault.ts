import { promises as fs } from "node:fs";
import path from "node:path";
import {
  VaultBase,
  VaultError,
  parseObservationsFromFile,
  collectMdFiles,
  today,
  monthLabel,
  isoDate,
  parseScopes,
  resolvePath,
} from "whitebox-shared";

export { VaultError } from "whitebox-shared";

// Simple file-based advisory lock to prevent concurrent write collisions.
// Uses exclusive file creation (wx flag) as an atomic test-and-set.
//
// LIMITATIONS (documented for users):
//   - Process-local only: works for multiple Node processes on the same
//     machine, but NOT across network drives or sync services (Dropbox,
//     OneDrive, iCloud). If the vault is synced, concurrent writes from
//     different machines can collide.
//   - The extension uses File System Access API (no locks). If both the
//     extension and MCP server write to the same monthly file concurrently,
//     the result is undefined (last-write-wins or interleaved).
//   - Stale-lock recovery (30s) is heuristic: a very slow write could be
//     interrupted and retried, leading to duplicate entries.
//
// For single-user single-machine usage, this is sufficient. For multi-device
// or sync-folder scenarios, consider a vault-per-device model or accept the
// small risk of occasional duplicate entries.
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const maxRetries = 5;
  const retryDelay = 100; // ms

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await fs.writeFile(lockPath, `${process.pid}\n${Date.now()}`, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Surface contention so a slow holder is visible instead of silent.
      console.error(
        `[whitebox-mcp] lock contended on ${path.basename(lockPath)}, attempt ${attempt + 1}/${maxRetries}`,
      );
      if (attempt === maxRetries - 1) {
        // Stale lock check: if lock is older than 30s, force-remove it
        try {
          const stat = await fs.stat(lockPath);
          if (Date.now() - stat.mtimeMs > 30_000) {
            console.error(
              `[whitebox-mcp] removing stale lock ${path.basename(lockPath)} (age ${Math.round((Date.now() - stat.mtimeMs) / 1000)}s)`,
            );
            await fs.unlink(lockPath);
            continue;
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        throw new VaultError("Could not acquire write lock — another process may be writing", "LOCK_TIMEOUT");
      }
      await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

export class Vault extends VaultBase {
  constructor(config: { root: string; activeScope?: string; source?: string }) {
    super({ root: config.root, scope: config.activeScope, source: config.source });
  }

  async readFile(relativePath: string): Promise<string> {
    if (!(await this.isInScope(relativePath))) {
      throw new VaultError(
        `Path "${relativePath}" is outside the active scope "${this.scope}"`,
        "OUT_OF_SCOPE",
      );
    }
    const absolute = await this.resolvePath(relativePath);
    const stat = await fs.stat(absolute);
    if (stat.size > 10 * 1024 * 1024) {
      throw new VaultError(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, limit 10 MB): ${relativePath}`,
        "FILE_TOO_LARGE",
      );
    }
    return fs.readFile(absolute, "utf-8");
  }

  async listFiles(subdir?: string): Promise<string[]> {
    // Subdir scope check — if a caller asks for a specific subdir, that subdir
    // itself must be in scope. Without this check, an attacker can probe
    // out-of-scope dir existence (ENOENT vs empty) even though file contents
    // stay protected by the per-file isInScope filter below.
    if (subdir) {
      const subRel = subdir.split(path.sep).join("/").replace(/\/+$/, "");
      if (!(await this.isInScope(subRel))) {
        throw new VaultError(
          `Subdir "${subdir}" is outside the active scope "${this.scope}"`,
          "OUT_OF_SCOPE",
        );
      }
    }
    const start = subdir ? await this.resolvePath(subdir) : this.root;
    const results: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const rel = path
          .relative(this.root, full)
          .split(path.sep)
          .join("/");

        if (entry.isDirectory()) {
          // Skip whole subtrees that fall outside scope so we don't probe them.
          if (!(await this.isInScope(rel))) continue;
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (await this.isInScope(rel)) {
            results.push(rel);
          }
        }
      }
    };

    try {
      await walk(start);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    return results.sort();
  }

  /**
   * Append a properly-formatted observation to the current month's
   * observations/YYYY-MM.md file. Creates the file (and the observations/
   * directory) if missing.
   *
   * Vault-integrity responsibilities here:
   *   - Source-stamping handled by the caller (server stamps `mcp:` prefix);
   *     a `via:` annotation can be passed for audit clarity.
   *   - Active-scope check (rejects writes outside an active scope).
   *   - Audit log: every successful write appends to audit/YYYY-MM-DD.md.
   *
   * NOT the responsibility of WhiteBox: content moderation. Whatever the
   * user said reached this code through the LLM provider's safety layers
   * already; our job is faithful storage and user control over that
   * storage, not deciding what the user should record about themselves.
   */
  async appendObservation(
    observation: ObservationInput,
    opts: { viaSource?: string } = {},
  ): Promise<string> {
    const date = observation.date ?? today();
    const month = date.slice(0, 7);
    const filePath = `observations/${month}.md`;

    if (!(await this.isInScope(filePath))) {
      throw new VaultError(
        `Cannot write to ${filePath} under active scope "${this.scope}"`,
        "OUT_OF_SCOPE",
      );
    }

    const absolute = await this.resolvePath(filePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const block = formatObservation({ ...observation, date });
    const lockPath = `${absolute}.lock`;

    return withFileLock(lockPath, async () => {
      let existing = "";
      try {
        existing = await fs.readFile(absolute, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }

      // Normalize trailing whitespace deterministically: strip ALL trailing
      // whitespace, then end with exactly one newline before the separator.
      // Without this, repeated appends could drift between files ending in
      // \n, \n\n, etc.
      const trimmedExisting = existing.replace(/\s+$/, "");
      const newContent =
        trimmedExisting.length === 0
          ? `# Observations \u2014 ${monthLabel(month)}\n\nAppend-only. Each entry is one observation. Never edit another agent's entries.\n\n---\n\n${block.replace(/\s+$/, "")}\n`
          : `${trimmedExisting}\n\n---\n\n${block.replace(/\s+$/, "")}\n`;

      // Audit-first ordering: write the audit entry BEFORE the data write so a
      // crash between the two leaves a stale audit (recoverable signal) rather
      // than an orphan unaudited write. If the data write fails, append a second
      // audit line marking the failure so the timeline is honest.
      await appendAuditEntry(this.root, {
        kind: "wb-save",
        source: observation.source,
        via: opts.viaSource,
        tags: observation.tags,
        confidence: observation.confidence,
        target: filePath,
      });

      try {
        await fs.writeFile(absolute, newContent, "utf-8");
      } catch (writeErr) {
        await appendAuditEntry(this.root, {
          kind: "wb-save-failed",
          source: observation.source,
          via: opts.viaSource,
          target: filePath,
        }).catch(() => {});
        throw writeErr;
      }

      // Rebuild manifest in the background (best-effort; never block the write).
      const { rebuildManifest } = await import("whitebox-shared");
      rebuildManifest(this.root).catch(() => {});

      return filePath;
    });
  }

  /**
   * Write a proposed edit to a stable file as a separate file under
   * `proposed/`. The user reviews and applies (or rejects) manually.
   */
  async proposeStableEdit(
    targetPath: string,
    edit: StableEditInput,
  ): Promise<string> {
    if (!(await this.isInScope(targetPath))) {
      throw new VaultError(
        `Target path ${targetPath} is outside active scope "${this.scope}"`,
        "OUT_OF_SCOPE",
      );
    }

    await this.resolvePath(targetPath);

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const slug = targetPath.replace(/[\\/]/g, "_").replace(/\.md$/, "");
    const proposalPath = `proposed/${timestamp}-${slug}.md`;
    const absolute = await this.resolvePath(proposalPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const body = formatProposal(targetPath, edit);
    await fs.writeFile(absolute, body, "utf-8");

    return proposalPath;
  }

  /**
   * Build the orientation pack the agent reads at session start. Mirrors
   * what the browser extension injects on first message: AGENTS.md,
   * identity.md, working-style.md, plus the latest N observation entries.
   */
  async bootstrap(includeObservations = 8): Promise<{
    files: Record<string, string | null>;
    recent_observations: string | null;
  }> {
    const wanted = ["AGENTS.md", "identity.md", "working-style.md", "tags.md"];
    const files: Record<string, string | null> = {};
    for (const name of wanted) {
      try {
        files[name] = await this.readFile(name);
      } catch (err) {
        if (err instanceof VaultError && err.code === "OUT_OF_SCOPE") {
          files[name] = null;
        } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          files[name] = null;
        } else {
          throw err;
        }
      }
    }

    let recent: string | null = null;
    if (includeObservations > 0) {
      recent = await this.readRecentObservations(includeObservations);
    }
    return { files, recent_observations: recent };
  }

  /**
   * Regex search across observations/*.md and/or conversations/**.md.
   * Returns matched lines with optional surrounding context. Honors the
   * active scope.
   */
  async grep(opts: {
    pattern: string;
    scope?: "observations" | "conversations" | "all";
    ignore_case?: boolean;
    context?: number;
    max_results?: number;
  }): Promise<GrepMatch[]> {
    // Input cap: reject absurdly long patterns (memory pressure / ReDoS vector).
    if (opts.pattern.length > 10_000) {
      throw new VaultError(
        `Pattern too long (${opts.pattern.length} chars; max 10,000)`,
        "BAD_PATTERN",
      );
    }

    const flags = opts.ignore_case ? "gi" : "g";
    let regex: RegExp;
    try {
      regex = new RegExp(opts.pattern, flags);
    } catch (err) {
      throw new VaultError(
        `Invalid regex /${opts.pattern}/: ${(err as Error).message}`,
        "BAD_PATTERN",
      );
    }

    // Reject patterns likely to cause catastrophic backtracking:
    // 1. Nested quantifiers: (a+)+, (a*)+, (a+)*, etc.
    // 2. Alternation with overlap inside a quantifier: (a|a)*, (x|xy)+ etc.
    // 3. Quantified groups with quantified alternation: (a+|b+)*
    if (
      /([+*])\)?[+*]/.test(opts.pattern) ||
      /\([^)]*\|[^)]*\)[*+]/.test(opts.pattern) ||
      /\([^)]*[+*][^)]*\|[^)]*[+*][^)]*\)[*+]/.test(opts.pattern)
    ) {
      throw new VaultError(
        `Pattern may cause excessive backtracking: ${opts.pattern}`,
        "UNSAFE_PATTERN",
      );
    }

    // Quick probe: test against a short pathological string to catch
    // patterns that slip through the heuristic checks above.
    const probeStart = Date.now();
    regex.lastIndex = 0;
    regex.test("a".repeat(25));
    if (Date.now() - probeStart > 100) {
      throw new VaultError(
        `Pattern is too slow (probe took ${Date.now() - probeStart}ms): ${opts.pattern}`,
        "UNSAFE_PATTERN",
      );
    }

    // Semantic ReDoS probe: test against a string designed to trigger
    // exponential backtracking in patterns like (a+)+b.
    const semanticProbe = "a".repeat(30) + "c";
    const semStart = Date.now();
    regex.lastIndex = 0;
    regex.test(semanticProbe);
    if (Date.now() - semStart > 100) {
      throw new VaultError(
        `Pattern failed semantic backtracking probe (${Date.now() - semStart}ms): ${opts.pattern}`,
        "UNSAFE_PATTERN",
      );
    }

    // Defensive validation: schema caps these but never trust schema bypass.
    const ctxRaw = opts.context ?? 0;
    if (!Number.isInteger(ctxRaw) || ctxRaw < 0 || ctxRaw > 20) {
      throw new VaultError(
        `Invalid context value (must be integer 0-20): ${ctxRaw}`,
        "BAD_PARAM",
      );
    }
    const ctx = ctxRaw;
    const capRaw = opts.max_results ?? 50;
    if (!Number.isInteger(capRaw) || capRaw < 1 || capRaw > 1000) {
      throw new VaultError(
        `Invalid max_results value (must be integer 1-1000): ${capRaw}`,
        "BAD_PARAM",
      );
    }
    const cap = capRaw;
    const deadline = Date.now() + 5_000; // 5-second hard cap on grep execution
    const targets =
      opts.scope === "conversations"
        ? ["conversations"]
        : opts.scope === "all"
          ? ["observations", "conversations"]
          : ["observations"];

    const results: GrepMatch[] = [];
    for (const dirName of targets) {
      const dirAbs = await this.resolvePath(dirName);
      const files = await collectMdFiles(dirAbs);
      for (const file of files) {
        const rel = path.relative(this.root, file).split(path.sep).join("/");
        if (!(await this.isInScope(rel))) continue;
        const stat = await fs.stat(file);
        if (stat.size > 10 * 1024 * 1024) continue; // Skip files > 10 MB
        const text = await fs.readFile(file, "utf-8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (Date.now() > deadline) {
            throw new VaultError("Grep timed out after 5 seconds", "GREP_TIMEOUT");
          }
          regex.lastIndex = 0;
          if (!regex.test(lines[i])) continue;
          results.push({
            file: rel,
            line: i + 1,
            text: lines[i],
            before:
              ctx > 0 ? lines.slice(Math.max(0, i - ctx), i) : [],
            after: ctx > 0 ? lines.slice(i + 1, i + 1 + ctx) : [],
          });
          if (results.length >= cap) return results;
        }
      }
    }
    return results;
  }

  /**
   * List unresolved observations tagged `conflict` across the vault's
   * monthly observation files. Returns enough metadata to surface them
   * for user review without loading the full file content.
   */
  async listConflicts(): Promise<ConflictEntry[]> {
    const obsDir = await this.resolvePath("observations");
    let files: string[] = [];
    try {
      files = (await fs.readdir(obsDir))
        .filter((f) => f.endsWith(".md"))
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const conflicts: ConflictEntry[] = [];
    for (const file of files) {
      const fullPath = path.join(obsDir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.size > 10 * 1024 * 1024) continue; // Skip files > 10 MB
        const content = await fs.readFile(fullPath, "utf-8");
        const entries = parseObservationsFromFile(content);
        entries.forEach((entry, idx) => {
          if (entry.tags.includes("conflict")) {
            conflicts.push({
              file: `observations/${file}`,
              position: idx + 1,
              date: entry.date,
              source: entry.source,
              tags: entry.tags,
              confidence: entry.confidence,
              context: entry.context,
              body: entry.body,
            });
          }
        });
      } catch (err) {
        // One corrupt monthly file shouldn't sink listConflicts. Log and skip.
        console.error(
          `[whitebox-mcp] listConflicts: skipping ${file}: ${(err as Error).message}`,
        );
      }
    }
    return conflicts;
  }
}

export interface ConflictEntry {
  file: string;
  position: number;
  date?: string;
  source?: string;
  tags: string[];
  confidence?: string;
  context?: string;
  body: string;
}

export interface ObservationInput {
  date?: string;
  source: string;
  tags: string[];
  confidence: "very-low" | "low" | "medium" | "high" | "very-high";
  body: string;
  source_ref?: string;
  context?: string;
  kind?: "quote" | "inference";
}

export interface StableEditInput {
  source: string;
  rationale: string;
  proposed_content: string;
}

function formatObservation(input: ObservationInput & { date: string }): string {
  const tags = input.tags
    .map((t) => `"${t.replace(/"/g, '\\"')}"`)
    .join(", ");
  const frontLines = [
    "---",
    `date: ${input.date}`,
    `source: ${input.source}`,
    `tags: [${tags}]`,
    `confidence: ${input.confidence}`,
  ];
  if (input.source_ref) frontLines.push(`source_ref: ${input.source_ref}`);
  if (input.context) frontLines.push(`context: ${input.context}`);
  if (input.kind) frontLines.push(`kind: ${input.kind}`);
  frontLines.push("---");
  const front = frontLines.join("\n");
  const body = input.body.trim();
  // Use a longer fence if the body contains triple backticks (valid markdown)
  const fence = body.includes("```") ? "````" : "```";
  return fence + "\n" + front + "\n\n" + body + "\n" + fence;
}

function formatProposal(targetPath: string, edit: StableEditInput): string {
  const front = [
    "---",
    `target: ${targetPath}`,
    `source: ${edit.source}`,
    `proposed_at: ${new Date().toISOString()}`,
    "status: proposed",
    "---",
  ].join("\n");
  return `${front}\n\n## Rationale\n\n${edit.rationale.trim()}\n\n## Proposed content\n\n${edit.proposed_content.trim()}\n`;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
  before: string[];
  after: string[];
}

// ─── Audit log ────────────────────────────────────────────────────────────
// NOTE: WhiteBox does not perform content moderation on observation
// bodies. Content safety is the LLM provider's responsibility (Anthropic,
// OpenAI, Google handle this in the conversation layer). Our scope is
// vault integrity (path traversal, scope enforcement, source stamping,
// audit logging) plus user control. Faithful storage of what was said.
interface AuditEntry {
  kind: string;
  source?: string;
  via?: string;
  tags?: string[];
  confidence?: string;
  target?: string;
}

async function appendAuditEntry(vaultRoot: string, entry: AuditEntry): Promise<void> {
  const date = isoDate(new Date());
  const dir = await resolvePath(vaultRoot, "audit");
  const filePath = path.join(dir, `${date}.md`);
  await fs.mkdir(dir, { recursive: true });

  // Sanitize values: strip newlines and control chars to prevent log injection
  const san = (s: string) => s.replace(/[\n\r\t]/g, " ").replace(/[\x00-\x1f]/g, "");
  const ts = new Date().toISOString();
  const line =
    `${ts} kind=${san(entry.kind)} source=${san(entry.source || "?")}` +
    (entry.via ? ` via=${san(entry.via)}` : "") +
    ` tags=[${(entry.tags || []).map(san).join(",")}]` +
    ` confidence=${san(entry.confidence || "-")}` +
    ` target=${san(entry.target || "-")}\n`;

  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (existing.length === 0) {
    const header = `# Audit log — ${date}\n\nOne line per autonomous vault operation. Source-of-truth for "what did agents do today."\n\n`;
    await fs.writeFile(filePath, header + line, "utf-8");
  } else {
    await fs.writeFile(filePath, existing + line, "utf-8");
  }
}

export const __test = { formatObservation, parseScopes };
