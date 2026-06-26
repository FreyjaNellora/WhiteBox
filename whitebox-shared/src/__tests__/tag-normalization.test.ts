import { describe, it, expect } from "vitest";
import {
  collectTagUsage,
  findMergeCandidates,
  formatMergeCandidates,
} from "../tag-normalization.js";

describe("collectTagUsage", () => {
  it("returns empty for no observations", () => {
    expect(collectTagUsage([])).toEqual([]);
  });

  it("aggregates counts and sources", () => {
    const obs = [
      { tags: ["working-style", "preference"], source: "claude" },
      { tags: ["working-style"], source: "kimi" },
      { tags: ["correction"], source: "claude" },
    ];
    const usage = collectTagUsage(obs);
    expect(usage).toHaveLength(3);
    const ws = usage.find((u) => u.tag === "working-style")!;
    expect(ws.count).toBe(2);
    expect(ws.sources.sort()).toEqual(["claude", "kimi"]);
  });

  it("handles observations without tags or source", () => {
    const obs = [{ tags: undefined, source: undefined }, { tags: ["a"] }];
    const usage = collectTagUsage(obs);
    expect(usage).toHaveLength(1);
    expect(usage[0].tag).toBe("a");
    expect(usage[0].sources).toEqual([]);
  });

  it("sorts by count descending then tag ascending", () => {
    const obs = [
      { tags: ["b"] },
      { tags: ["a"] },
      { tags: ["a"] },
    ];
    const usage = collectTagUsage(obs);
    expect(usage.map((u) => u.tag)).toEqual(["a", "b"]);
  });
});

describe("findMergeCandidates", () => {
  it("returns empty for clean tags", () => {
    expect(findMergeCandidates(["working-style", "preference", "correction"])).toEqual([]);
  });

  it("detects case differences", () => {
    const c = findMergeCandidates(["working-style", "Working-Style"]);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toBe("case difference");
    expect(c[0].score).toBe(1.0);
  });

  it("detects separator differences", () => {
    const c = findMergeCandidates(["working-style", "working_style", "workingStyle"]);
    expect(c).toHaveLength(3); // 3 choose 2 = 3 pairs, all match
    expect(c.every((x) => x.reason === "separator difference")).toBe(true);
  });

  it("detects edit distance ≤ 2 for long tags", () => {
    const c = findMergeCandidates(["preference", "prefernce"]);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toBe("edit distance 1");
    expect(c[0].score).toBeGreaterThan(0.8);
  });

  it("does not flag distant tags", () => {
    const c = findMergeCandidates(["working-style", "completely-different"]);
    expect(c).toHaveLength(0);
  });

  it("flags exact duplicates as case-difference (the canonical form wins)", () => {
    const c = findMergeCandidates(["working-style", "working-style"]);
    expect(c).toHaveLength(1);
    expect(c[0].reason).toBe("case difference");
  });

  it("prefers longer tag as canonical", () => {
    // "work-style" vs "workstyle" — separator difference, canonical = longer
    const c = findMergeCandidates(["workstyle", "work-style"]);
    expect(c).toHaveLength(1);
    expect(c[0].canonical).toBe("work-style");
    expect(c[0].duplicate).toBe("workstyle");
    expect(c[0].reason).toBe("separator difference");
  });

  it("handles empty input", () => {
    expect(findMergeCandidates([])).toEqual([]);
  });

  it("handles single tag", () => {
    expect(findMergeCandidates(["only-one"])).toEqual([]);
  });
});

describe("formatMergeCandidates", () => {
  it("reports clean taxonomy", () => {
    const out = formatMergeCandidates([], []);
    expect(out).toContain("No near-duplicate tags found");
  });

  it("formats candidates with usage counts", () => {
    const usage = [
      { tag: "working-style", count: 5, sources: ["a"] },
      { tag: "Working-Style", count: 2, sources: ["b"] },
    ];
    const candidates = findMergeCandidates(["working-style", "Working-Style"]);
    const out = formatMergeCandidates(candidates, usage);
    expect(out).toContain("working-style (5 uses)");
    expect(out).toContain("Working-Style (2 uses)");
    expect(out).toContain("case difference");
  });
});
