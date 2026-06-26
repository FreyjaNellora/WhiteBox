import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  serializeSynthesis,
  parseSynthesis,
  draftFilePath,
  synthesisFilePath,
  writeDraft,
  writeSynthesis,
  listDrafts,
  listSyntheses,
  latestSynthesis,
  nextVersion,
} from "../synthesis.js";

let root: string;

beforeEach(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-synthesis-test-"));
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("serializeSynthesis + parseSynthesis", () => {
  it("round-trips a complete synthesis", () => {
    const s = {
      synthesized_at: "2026-04-26T10:00:00Z",
      synthesized_by: ["mcp:claude", "mcp:kimi"],
      derived_from: ["observations/2026-04.md#0", "observations/2026-04.md#1"],
      version: 3,
      body: "## Current preferences\n\n- Prefers concise responses\n- Works best in mornings",
    };
    const serialized = serializeSynthesis(s);
    expect(serialized).toContain("version: 3");
    expect(serialized).toContain("synthesized_by: [mcp:claude, mcp:kimi]");
    const parsed = parseSynthesis(serialized);
    expect(parsed).toEqual(s);
  });

  it("round-trips with empty lists", () => {
    const s = {
      synthesized_at: "2026-04-26T10:00:00Z",
      synthesized_by: [],
      derived_from: [],
      version: 1,
      body: "Initial synthesis.",
    };
    const parsed = parseSynthesis(serializeSynthesis(s));
    expect(parsed).toEqual(s);
  });

  it("returns null for malformed content", () => {
    expect(parseSynthesis("not frontmatter")).toBeNull();
    expect(parseSynthesis("---\nversion: x\n---")).toBeNull();
    expect(parseSynthesis("---\nsynthesized_at: 2026-04-26\n---")).toBeNull(); // missing version
  });

  it("parses body after frontmatter", () => {
    const content = `---
synthesized_at: 2026-04-26T10:00:00Z
synthesized_by: [claude]
derived_from: [obs/1.md#0]
version: 1
---

This is the synthesized content.

With multiple paragraphs.
`;
    const parsed = parseSynthesis(content);
    expect(parsed?.body).toBe("This is the synthesized content.\n\nWith multiple paragraphs.");
  });
});

describe("draftFilePath + synthesisFilePath", () => {
  it("builds draft path with sanitized source", () => {
    const p = draftFilePath(root, "mcp:claude", "2026-04-26");
    expect(p).toBe(path.join(root, "synthesized", "drafts", "mcp_claude-2026-04-26.md"));
  });

  it("builds synthesis path", () => {
    const p = synthesisFilePath(root, "2026-04-26");
    expect(p).toBe(path.join(root, "synthesized", "profile-2026-04-26.md"));
  });
});

describe("writeDraft + listDrafts", () => {
  it("writes and retrieves a draft", async () => {
    const filePath = await writeDraft(root, {
      source: "mcp:claude",
      derived_from: ["observations/2026-04.md#0"],
      body: "Draft content here.",
      date: "2026-04-26",
    });
    expect(fsSync.existsSync(filePath)).toBe(true);

    const drafts = await listDrafts(root);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe("Draft content here.");
    expect(drafts[0].synthesized_by).toEqual(["mcp:claude"]);
    expect(drafts[0].version).toBe(0);
  });

  it("filters drafts by source", async () => {
    await writeDraft(root, { source: "mcp:claude", derived_from: ["a"], body: "A", date: "2026-04-26" });
    await writeDraft(root, { source: "mcp:kimi", derived_from: ["b"], body: "B", date: "2026-04-26" });

    const claudeDrafts = await listDrafts(root, { source: "mcp:claude" });
    expect(claudeDrafts).toHaveLength(1);
    expect(claudeDrafts[0].body).toBe("A");
  });

  it("returns empty array when no drafts dir", async () => {
    const drafts = await listDrafts(root);
    expect(drafts).toEqual([]);
  });
});

describe("writeSynthesis + listSyntheses + latestSynthesis", () => {
  it("writes and lists syntheses", async () => {
    await writeSynthesis(root, {
      synthesized_by: ["mcp:claude", "mcp:kimi"],
      derived_from: ["obs/1.md#0"],
      body: "V1 content",
      version: 1,
      date: "2026-04-25",
    });
    await writeSynthesis(root, {
      synthesized_by: ["mcp:claude"],
      derived_from: ["obs/1.md#0", "obs/2.md#0"],
      body: "V2 content",
      version: 2,
      date: "2026-04-26",
    });

    const all = await listSyntheses(root);
    expect(all).toHaveLength(2);
    expect(all[0].version).toBe(1);
    expect(all[1].version).toBe(2);
    expect(all[1].body).toBe("V2 content");
  });

  it("latestSynthesis returns the highest version", async () => {
    await writeSynthesis(root, {
      synthesized_by: ["a"],
      derived_from: ["x"],
      body: "V1",
      version: 1,
      date: "2026-04-25",
    });
    await writeSynthesis(root, {
      synthesized_by: ["a"],
      derived_from: ["x"],
      body: "V3",
      version: 3,
      date: "2026-04-27",
    });

    const latest = await latestSynthesis(root);
    expect(latest?.version).toBe(3);
    expect(latest?.body).toBe("V3");
  });

  it("latestSynthesis returns null when empty", async () => {
    expect(await latestSynthesis(root)).toBeNull();
  });

  it("nextVersion returns 1 for empty vault", async () => {
    expect(await nextVersion(root)).toBe(1);
  });

  it("nextVersion increments correctly", async () => {
    await writeSynthesis(root, {
      synthesized_by: ["a"],
      derived_from: ["x"],
      body: "V1",
      version: 1,
      date: "2026-04-25",
    });
    await writeSynthesis(root, {
      synthesized_by: ["a"],
      derived_from: ["x"],
      body: "V2",
      version: 2,
      date: "2026-04-26",
    });
    expect(await nextVersion(root)).toBe(3);
  });
});
