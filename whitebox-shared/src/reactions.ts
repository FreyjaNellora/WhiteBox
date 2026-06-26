/**
 * Reactions tier — emergent annotation without violating append-only.
 *
 * Agents leave reaction files referencing observations by stable ID.
 * The original observation stays immutable; the swarm conversation
 * happens around it. This is stigmergic coordination: traces in the
 * environment (reaction files) coordinate behavior without direct
 * agent-to-agent communication.
 *
 * Storage layout:
 *   reactions/<obs-id>/<source>-<date>.md
 *
 * Reaction kinds:
 *   - agreed: agent corroborates the observation
 *   - contradicted: agent has conflicting evidence
 *   - context-narrowed: observation is correct but only in a specific context
 *   - superseded: agent has written a successor observation that replaces this one
 *
 * Reference: Stigmergic social annotation (ACM 2022),
 *   Stigmergy in Wikipedia (2023).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { isoDate } from "./vault-core.js";

export const REACTION_KINDS = [
  "agreed",
  "contradicted",
  "context-narrowed",
  "superseded",
] as const;

export type ReactionKind = (typeof REACTION_KINDS)[number];

export interface Reaction {
  /** ISO-8601 date. */
  date: string;
  /** Source that left the reaction (e.g. "mcp:claude"). */
  source: string;
  /** Target observation identifier — `<file>#<position>`. */
  observation_id: string;
  /** Reaction kind. */
  kind: ReactionKind;
  /** Optional free-text note explaining the reaction. */
  note?: string;
}

/** Validate a reaction kind string. */
export function isValidReactionKind(kind: string): kind is ReactionKind {
  return (REACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Sanitize an observation ID for use as a directory name.
 * Replaces path separators with underscores.
 */
export function sanitizeObsId(observationId: string): string {
  return observationId.replace(/[\\/]/g, "_");
}

/**
 * Sanitize a string for use in a filename.
 * Replaces path separators and colons (illegal on Windows).
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:]/g, "_");
}

/**
 * Build the filesystem path for a reaction file.
 *   reactions/<obs-id>/<source>-<date>.md
 *
 * The observation_id may contain `/` (e.g. "observations/2026-04.md#3"),
 * so we sanitize it for use as a directory name by replacing path
 * separators with underscores. Source identifiers like "mcp:claude"
 * are also sanitized (colons become underscores).
 */
export function reactionFilePath(
  vaultRoot: string,
  observationId: string,
  source: string,
  date: string,
): string {
  const safeObsId = sanitizeObsId(observationId);
  const safeSource = sanitizeFileName(source);
  const fileName = `${safeSource}-${date}.md`;
  return path.join(vaultRoot, "reactions", safeObsId, fileName);
}

/**
 * Serialize a reaction to markdown with YAML frontmatter.
 *
 * Notes are serialized as a body paragraph after the frontmatter
 * rather than inline, to avoid YAML parsing complexity for multi-line
 * text. If a note contains newlines, each line becomes a paragraph.
 */
export function serializeReaction(r: Reaction): string {
  const frontmatter = [
    "---",
    `date: ${r.date}`,
    `source: ${r.source}`,
    `observation_id: ${r.observation_id}`,
    `kind: ${r.kind}`,
    "---",
    "",
  ].join("\n");
  if (r.note) {
    return frontmatter + r.note + "\n";
  }
  return frontmatter;
}

/**
 * Parse a reaction from markdown file content.
 * Returns null if the file is malformed (caller decides whether to
 * throw or skip).
 */
export function parseReaction(content: string): Reaction | null {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  const get = (key: string): string | undefined => {
    // Match simple key: value lines (not folded/multi-line blocks)
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };

  const date = get("date");
  const source = get("source");
  const observation_id = get("observation_id");
  const kind = get("kind");

  // Note is stored as body text after the frontmatter delimiter.
  const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  const note = bodyMatch ? bodyMatch[1].trim() || undefined : undefined;

  if (!date || !source || !observation_id || !kind) return null;
  if (!isValidReactionKind(kind)) return null;

  return { date, source, observation_id, kind, note };
}

/**
 * Add a reaction to the vault. Creates the reactions directory tree
 * if missing. Idempotent — calling twice with the same parameters
 * creates two files (intentional; agents may react multiple times
 * on different days with different notes).
 */
export async function addReaction(
  vaultRoot: string,
  reaction: Reaction,
): Promise<string> {
  if (!isValidReactionKind(reaction.kind)) {
    throw new Error(`Invalid reaction kind: ${reaction.kind}`);
  }
  const filePath = reactionFilePath(
    vaultRoot,
    reaction.observation_id,
    reaction.source,
    reaction.date,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, serializeReaction(reaction), "utf-8");
  return filePath;
}

/**
 * List all reactions for a given observation ID.
 * Returns them sorted by date ascending (oldest first).
 */
export async function listReactions(
  vaultRoot: string,
  observationId: string,
): Promise<Reaction[]> {
  const dir = path.join(vaultRoot, "reactions", sanitizeObsId(observationId));
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const reactions: Reaction[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const content = await fs.readFile(path.join(dir, file), "utf-8");
    const r = parseReaction(content);
    if (r) reactions.push(r);
  }

  reactions.sort((a, b) => a.date.localeCompare(b.date));
  return reactions;
}

/**
 * List all reactions in the vault, optionally filtered by kind.
 * Returns them sorted by date ascending.
 */
export async function listAllReactions(
  vaultRoot: string,
  opts: { kind?: ReactionKind; observationId?: string } = {},
): Promise<Reaction[]> {
  const reactionsDir = path.join(vaultRoot, "reactions");
  let obsDirs: string[] = [];
  try {
    obsDirs = await fs.readdir(reactionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const targetObsId = opts.observationId ? sanitizeObsId(opts.observationId) : null;

  const all: Reaction[] = [];
  for (const obsId of obsDirs) {
    if (targetObsId && obsId !== targetObsId) continue;
    const dir = path.join(reactionsDir, obsId);
    let entries: string[] = [];
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const content = await fs.readFile(path.join(dir, file), "utf-8");
      const r = parseReaction(content);
      if (!r) continue;
      if (opts.kind && r.kind !== opts.kind) continue;
      all.push(r);
    }
  }

  all.sort((a, b) => a.date.localeCompare(b.date));
  return all;
}

/**
 * Summarize reactions for an observation: count by kind.
 */
export function summarizeReactions(reactions: Reaction[]): Record<ReactionKind, number> {
  const summary: Record<ReactionKind, number> = {
    agreed: 0,
    contradicted: 0,
    "context-narrowed": 0,
    superseded: 0,
  };
  for (const r of reactions) {
    summary[r.kind] = (summary[r.kind] || 0) + 1;
  }
  return summary;
}
