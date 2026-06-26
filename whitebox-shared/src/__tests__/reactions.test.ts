import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  REACTION_KINDS,
  isValidReactionKind,
  reactionFilePath,
  serializeReaction,
  parseReaction,
  addReaction,
  listReactions,
  listAllReactions,
  summarizeReactions,
} from "../reactions.js";

let root: string;

beforeEach(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-reactions-test-"));
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("isValidReactionKind", () => {
  it("accepts all known kinds", () => {
    for (const kind of REACTION_KINDS) {
      expect(isValidReactionKind(kind)).toBe(true);
    }
  });

  it("rejects unknown kinds", () => {
    expect(isValidReactionKind("liked")).toBe(false);
    expect(isValidReactionKind("")).toBe(false);
    expect(isValidReactionKind("AGREED")).toBe(false);
  });
});

describe("reactionFilePath", () => {
  it("builds path with sanitized obs id and source", () => {
    const p = reactionFilePath(root, "observations/2026-04.md#3", "mcp:claude", "2026-04-26");
    // Colons in source are sanitized to underscores for Windows filename compatibility
    expect(p).toBe(path.join(root, "reactions", "observations_2026-04.md#3", "mcp_claude-2026-04-26.md"));
  });

  it("sanitizes backslashes in obs id", () => {
    const p = reactionFilePath(root, "a\\b", "src", "2026-04-26");
    expect(p).toContain(path.join("reactions", "a_b"));
  });
});

describe("serializeReaction + parseReaction", () => {
  it("round-trips a complete reaction", () => {
    const r = {
      date: "2026-04-26",
      source: "mcp:claude",
      observation_id: "observations/2026-04.md#3",
      kind: "agreed" as const,
      note: "This matches my own observation from Tuesday.",
    };
    const serialized = serializeReaction(r);
    expect(serialized).toContain("kind: agreed");
    expect(serialized).toContain("source: mcp:claude");
    const parsed = parseReaction(serialized);
    expect(parsed).toEqual(r);
  });

  it("round-trips without note", () => {
    const r = {
      date: "2026-04-26",
      source: "mcp:kimi",
      observation_id: "observations/2026-04.md#0",
      kind: "contradicted" as const,
    };
    const parsed = parseReaction(serializeReaction(r));
    expect(parsed).toEqual(r);
  });

  it("returns null for malformed content", () => {
    expect(parseReaction("not frontmatter")).toBeNull();
    expect(parseReaction("---\nkind: agreed\n---")).toBeNull(); // missing required fields
    expect(parseReaction("---\ndate: x\nsource: y\nobservation_id: z\nkind: invalid\n---")).toBeNull();
  });

  it("handles multiline notes as body text", () => {
    const r = {
      date: "2026-04-26",
      source: "cli:user",
      observation_id: "observations/2026-04.md#1",
      kind: "context-narrowed" as const,
      note: "Line one\nLine two",
    };
    const serialized = serializeReaction(r);
    // Note is placed after frontmatter, not as YAML folded block
    expect(serialized).toContain("Line one\nLine two");
    const parsed = parseReaction(serialized);
    expect(parsed?.note).toBe("Line one\nLine two");
  });
});

describe("addReaction + listReactions", () => {
  it("adds and retrieves a reaction", async () => {
    const r = {
      date: "2026-04-26",
      source: "mcp:claude",
      observation_id: "observations/2026-04.md#3",
      kind: "agreed" as const,
    };
    await addReaction(root, r);
    const list = await listReactions(root, "observations/2026-04.md#3");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(r);
  });

  it("returns empty array for unknown observation", async () => {
    const list = await listReactions(root, "observations/2026-04.md#999");
    expect(list).toEqual([]);
  });

  it("sorts reactions by date ascending", async () => {
    const obsId = "observations/2026-04.md#3";
    await addReaction(root, { date: "2026-04-27", source: "mcp:claude", observation_id: obsId, kind: "agreed" });
    await addReaction(root, { date: "2026-04-25", source: "mcp:kimi", observation_id: obsId, kind: "contradicted" });
    await addReaction(root, { date: "2026-04-26", source: "cli:user", observation_id: obsId, kind: "agreed" });
    const list = await listReactions(root, obsId);
    expect(list.map((r) => r.date)).toEqual(["2026-04-25", "2026-04-26", "2026-04-27"]);
  });

  it("allows multiple reactions from same source on different dates", async () => {
    const obsId = "observations/2026-04.md#3";
    await addReaction(root, { date: "2026-04-25", source: "mcp:claude", observation_id: obsId, kind: "agreed" });
    await addReaction(root, { date: "2026-04-26", source: "mcp:claude", observation_id: obsId, kind: "contradicted" });
    const list = await listReactions(root, obsId);
    expect(list).toHaveLength(2);
  });

  it("rejects invalid kind", async () => {
    await expect(
      addReaction(root, {
        date: "2026-04-26",
        source: "x",
        observation_id: "observations/2026-04.md#0",
        kind: "invalid" as any,
      }),
    ).rejects.toThrow("Invalid reaction kind");
  });
});

describe("listAllReactions", () => {
  it("lists reactions across multiple observations", async () => {
    await addReaction(root, { date: "2026-04-26", source: "a", observation_id: "obs/1.md#0", kind: "agreed" });
    await addReaction(root, { date: "2026-04-27", source: "b", observation_id: "obs/2.md#0", kind: "contradicted" });
    const all = await listAllReactions(root);
    expect(all).toHaveLength(2);
  });

  it("filters by kind", async () => {
    await addReaction(root, { date: "2026-04-26", source: "a", observation_id: "obs/1.md#0", kind: "agreed" });
    await addReaction(root, { date: "2026-04-27", source: "b", observation_id: "obs/1.md#0", kind: "contradicted" });
    await addReaction(root, { date: "2026-04-28", source: "c", observation_id: "obs/2.md#0", kind: "agreed" });
    const agreed = await listAllReactions(root, { kind: "agreed" });
    expect(agreed).toHaveLength(2);
    expect(agreed.every((r) => r.kind === "agreed")).toBe(true);
  });

  it("returns empty array when no reactions dir", async () => {
    const all = await listAllReactions(root);
    expect(all).toEqual([]);
  });
});

describe("summarizeReactions", () => {
  it("counts by kind", () => {
    const reactions = [
      { date: "2026-04-26", source: "a", observation_id: "x", kind: "agreed" as const },
      { date: "2026-04-27", source: "b", observation_id: "x", kind: "agreed" as const },
      { date: "2026-04-28", source: "c", observation_id: "x", kind: "contradicted" as const },
    ];
    const summary = summarizeReactions(reactions);
    expect(summary.agreed).toBe(2);
    expect(summary.contradicted).toBe(1);
    expect(summary["context-narrowed"]).toBe(0);
    expect(summary.superseded).toBe(0);
  });
});
