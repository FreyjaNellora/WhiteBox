/**
 * Synthesis tier — agent-generated condensations of observations.
 *
 * The synthesis tier is the learning loop: agents read observations,
 * reactions, and access patterns, then produce condensed "current state"
 * documents. These live in `synthesized/` and are explicitly marked as
 * derived/agent-generated — the user can reject, edit, or accept them.
 *
 * Storage layout:
 *   synthesized/profile-YYYY-MM-DD.md          — final synthesis
 *   synthesized/drafts/<source>-YYYY-MM-DD.md  — per-agent draft
 *
 * Frontmatter schema:
 *   derived_from:   string[]  — observation ids that contributed
 *   synthesized_by: string[]  — source identifiers of contributing agents
 *   synthesized_at: string    — ISO-8601 timestamp
 *   version:        number    — monotonic synthesis version (1, 2, 3...)
 *
 * Design principles:
 *   - Syntheses are derived and rejectable (separate tier from observations)
 *   - Old syntheses kept as evolution trail (append-only history)
 *   - Cross-agent agreement prioritized in merge
 *   - Verbatim invariant preserved: observations stay immutable
 *
 * References: Self-Evolving LLM Agents, Persistent Memory and User Profiles
 *   (arXiv:2510.07925), Generative Agents reflection-on-importance.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export interface Synthesis {
  /** ISO-8601 timestamp. */
  synthesized_at: string;
  /** Source identifiers of contributing agents. */
  synthesized_by: string[];
  /** Observation ids that contributed to this synthesis. */
  derived_from: string[];
  /** Monotonic version number. */
  version: number;
  /** The synthesized content (markdown). */
  body: string;
}

export interface DraftOptions {
  source: string;
  derived_from: string[];
  body: string;
  date?: string;
}

export interface SynthesisOptions {
  synthesized_by: string[];
  derived_from: string[];
  body: string;
  version: number;
  date?: string;
}

/** Sanitize a string for use in a filename. */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:]/g, "_");
}

/**
 * Serialize synthesis frontmatter + body.
 */
export function serializeSynthesis(s: Synthesis): string {
  const frontmatter = [
    "---",
    `synthesized_at: ${s.synthesized_at}`,
    `synthesized_by: [${s.synthesized_by.join(", ")}]`,
    `derived_from: [${s.derived_from.join(", ")}]`,
    `version: ${s.version}`,
    "---",
    "",
    s.body,
  ].join("\n");
  return frontmatter;
}

/**
 * Parse a synthesis from markdown file content.
 * Returns null if malformed.
 */
export function parseSynthesis(content: string): Synthesis | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const get = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };

  const getList = (key: string): string[] => {
    const raw = get(key);
    if (!raw) return [];
    // Handle [a, b, c] or a, b, c
    const cleaned = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (!cleaned) return [];
    return cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  };

  const synthesized_at = get("synthesized_at");
  const versionStr = get("version");
  if (!synthesized_at || !versionStr) return null;
  const version = parseInt(versionStr, 10);
  if (Number.isNaN(version)) return null;

  const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1].trim() : "";

  return {
    synthesized_at,
    synthesized_by: getList("synthesized_by"),
    derived_from: getList("derived_from"),
    version,
    body,
  };
}

/**
 * Build the filesystem path for a draft file.
 *   synthesized/drafts/<source>-<date>.md
 */
export function draftFilePath(
  vaultRoot: string,
  source: string,
  date: string,
): string {
  const safeSource = sanitizeFileName(source);
  return path.join(vaultRoot, "synthesized", "drafts", `${safeSource}-${date}.md`);
}

/**
 * Build the filesystem path for a final synthesis file.
 *   synthesized/profile-<date>.md
 */
export function synthesisFilePath(
  vaultRoot: string,
  date: string,
): string {
  return path.join(vaultRoot, "synthesized", `profile-${date}.md`);
}

/**
 * Write a draft synthesis to `synthesized/drafts/`.
 */
export async function writeDraft(
  vaultRoot: string,
  opts: DraftOptions,
): Promise<string> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const filePath = draftFilePath(vaultRoot, opts.source, date);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const synthesis: Synthesis = {
    synthesized_at: new Date().toISOString(),
    synthesized_by: [opts.source],
    derived_from: opts.derived_from,
    version: 0, // drafts are version 0
    body: opts.body,
  };

  await fs.writeFile(filePath, serializeSynthesis(synthesis), "utf-8");
  return filePath;
}

/**
 * Write a final synthesis to `synthesized/profile-<date>.md`.
 */
export async function writeSynthesis(
  vaultRoot: string,
  opts: SynthesisOptions,
): Promise<string> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const filePath = synthesisFilePath(vaultRoot, date);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const synthesis: Synthesis = {
    synthesized_at: new Date().toISOString(),
    synthesized_by: opts.synthesized_by,
    derived_from: opts.derived_from,
    version: opts.version,
    body: opts.body,
  };

  await fs.writeFile(filePath, serializeSynthesis(synthesis), "utf-8");
  return filePath;
}

/**
 * List all draft syntheses, optionally filtered by source.
 * Returns them sorted by synthesized_at ascending.
 */
export async function listDrafts(
  vaultRoot: string,
  opts: { source?: string } = {},
): Promise<Synthesis[]> {
  const dir = path.join(vaultRoot, "synthesized", "drafts");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const drafts: Synthesis[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    if (opts.source && !file.startsWith(sanitizeFileName(opts.source))) continue;
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const s = parseSynthesis(content);
    if (s) drafts.push(s);
  }

  drafts.sort((a, b) => a.synthesized_at.localeCompare(b.synthesized_at));
  return drafts;
}

/**
 * List all final syntheses (profile-*.md files).
 * Returns them sorted by version ascending.
 */
export async function listSyntheses(
  vaultRoot: string,
): Promise<Synthesis[]> {
  const dir = path.join(vaultRoot, "synthesized");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const syntheses: Synthesis[] = [];
  for (const file of entries) {
    if (!file.startsWith("profile-") || !file.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const s = parseSynthesis(content);
    if (s) syntheses.push(s);
  }

  syntheses.sort((a, b) => a.version - b.version);
  return syntheses;
}

/**
 * Get the latest synthesis (highest version).
 * Returns null if none exist.
 */
export async function latestSynthesis(
  vaultRoot: string,
): Promise<Synthesis | null> {
  const all = await listSyntheses(vaultRoot);
  if (all.length === 0) return null;
  return all[all.length - 1];
}

/**
 * Compute the next version number for a new synthesis.
 */
export async function nextVersion(vaultRoot: string): Promise<number> {
  const all = await listSyntheses(vaultRoot);
  if (all.length === 0) return 1;
  return all[all.length - 1].version + 1;
}
