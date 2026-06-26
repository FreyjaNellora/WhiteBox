import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ACCESS_LOG_PATH,
  appendAccessEntries,
  loadAccessCounts,
  observationId,
} from "../access-log.js";

let root: string;

beforeEach(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-access-test-"));
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("observationId", () => {
  it("formats as <file>#<position>", () => {
    expect(observationId("observations/2026-04.md", 0)).toBe(
      "observations/2026-04.md#0",
    );
    expect(observationId("observations/2026-04.md", 7)).toBe(
      "observations/2026-04.md#7",
    );
  });
});

describe("appendAccessEntries + loadAccessCounts", () => {
  it("returns empty map on a brand-new vault (no log file yet)", async () => {
    const counts = await loadAccessCounts(root);
    expect(counts.size).toBe(0);
  });

  it("creates the audit directory if missing and writes entries", async () => {
    await appendAccessEntries(root, [
      {
        ts: new Date().toISOString(),
        id: "observations/2026-04.md#0",
        by: "mcp:claude",
        via: "vault_search",
      },
    ]);
    const filePath = path.join(root, ACCESS_LOG_PATH);
    expect(fsSync.existsSync(filePath)).toBe(true);
    const content = await fs.readFile(filePath, "utf-8");
    expect(content.split("\n").filter(Boolean).length).toBe(1);
  });

  it("counts all reads of the same observation", async () => {
    const id = "observations/2026-04.md#3";
    await appendAccessEntries(root, [
      { ts: "2026-04-26T10:00:00Z", id, by: "mcp:claude" },
      { ts: "2026-04-26T11:00:00Z", id, by: "mcp:kimi" },
      { ts: "2026-04-26T12:00:00Z", id, by: "mcp:claude" },
    ]);
    const counts = await loadAccessCounts(root);
    expect(counts.get(id)).toBe(3);
  });

  it("aggregates across multiple ids", async () => {
    await appendAccessEntries(root, [
      { ts: "2026-04-26T10:00:00Z", id: "observations/2026-04.md#0", by: "x" },
      { ts: "2026-04-26T10:01:00Z", id: "observations/2026-04.md#0", by: "x" },
      { ts: "2026-04-26T10:02:00Z", id: "observations/2026-04.md#1", by: "x" },
    ]);
    const counts = await loadAccessCounts(root);
    expect(counts.get("observations/2026-04.md#0")).toBe(2);
    expect(counts.get("observations/2026-04.md#1")).toBe(1);
  });

  it("respects sinceDate filter", async () => {
    await appendAccessEntries(root, [
      { ts: "2026-04-01T00:00:00Z", id: "old", by: "x" },
      { ts: "2026-04-25T00:00:00Z", id: "recent", by: "x" },
    ]);
    const counts = await loadAccessCounts(root, { sinceDate: "2026-04-20T00:00:00Z" });
    expect(counts.get("old")).toBeUndefined();
    expect(counts.get("recent")).toBe(1);
  });

  it("handles malformed lines gracefully (skips, doesn't crash)", async () => {
    const filePath = path.join(root, ACCESS_LOG_PATH);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({ ts: "2026-04-26T10:00:00Z", id: "good", by: "x" }),
        "this is not json",
        JSON.stringify({ ts: "2026-04-26T11:00:00Z", id: "good", by: "x" }),
      ].join("\n"),
    );
    const counts = await loadAccessCounts(root);
    expect(counts.get("good")).toBe(2);
  });

  it("appendAccessEntries with empty array is a no-op", async () => {
    await appendAccessEntries(root, []);
    const filePath = path.join(root, ACCESS_LOG_PATH);
    expect(fsSync.existsSync(filePath)).toBe(false);
  });
});
