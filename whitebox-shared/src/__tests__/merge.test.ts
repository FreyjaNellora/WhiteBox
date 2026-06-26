import { describe, it, expect } from "vitest";
import { mergeDrafts } from "../merge.js";
import type { Synthesis } from "../synthesis.js";

function draft(p: {
  source: string;
  synthesized_at?: string;
  derived_from?: string[];
  body?: string;
}): Synthesis {
  return {
    synthesized_at: p.synthesized_at ?? "2026-04-26T12:00:00Z",
    synthesized_by: [p.source],
    derived_from: p.derived_from ?? [],
    version: 0,
    body: p.body ?? "default body",
  };
}

describe("mergeDrafts", () => {
  it("throws on zero drafts", () => {
    expect(() => mergeDrafts({ drafts: [], version: 1 })).toThrow();
  });

  it("merges a single draft into a versioned synthesis", () => {
    const r = mergeDrafts({
      drafts: [draft({ source: "claude", body: "claude says X", derived_from: ["o#1"] })],
      version: 3,
    });
    expect(r.candidate.version).toBe(3);
    expect(r.candidate.synthesized_by).toEqual(["claude"]);
    expect(r.candidate.derived_from).toEqual(["o#1"]);
    expect(r.candidate.body).toContain("From claude");
    expect(r.candidate.body).toContain("claude says X");
  });

  it("combines multiple agents with section attribution", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "claude", body: "claude view", derived_from: ["o#1", "o#2"] }),
        draft({ source: "kimi", body: "kimi view", derived_from: ["o#2", "o#3"] }),
      ],
      version: 1,
    });
    expect(r.candidate.synthesized_by).toEqual(["claude", "kimi"]);
    // derived_from is unioned, deduped, in first-appearance order
    expect(r.candidate.derived_from).toEqual(["o#1", "o#2", "o#3"]);
    expect(r.candidate.body).toContain("From claude");
    expect(r.candidate.body).toContain("From kimi");
    expect(r.candidate.body).toContain("claude view");
    expect(r.candidate.body).toContain("kimi view");
  });

  it("respects preferredOrder when supplied", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "kimi", body: "kimi" }),
        draft({ source: "claude", body: "claude" }),
        draft({ source: "chatgpt", body: "chatgpt" }),
      ],
      version: 1,
      preferredOrder: ["claude", "chatgpt"],
    });
    // claude first, chatgpt second, kimi last (not in preferred list)
    const claudeIdx = r.candidate.body.indexOf("claude");
    const chatgptIdx = r.candidate.body.indexOf("chatgpt");
    const kimiIdx = r.candidate.body.indexOf("kimi");
    expect(claudeIdx).toBeLessThan(chatgptIdx);
    expect(chatgptIdx).toBeLessThan(kimiIdx);
  });

  it("flags duplicate sources without auto-deduping", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "claude", body: "first take", synthesized_at: "2026-04-25T12:00:00Z" }),
        draft({ source: "claude", body: "second take", synthesized_at: "2026-04-26T12:00:00Z" }),
        draft({ source: "kimi", body: "kimi take" }),
      ],
      version: 1,
    });
    expect(r.duplicateSources).toContain("claude");
    expect(r.candidate.body).toContain("first take");
    expect(r.candidate.body).toContain("second take");
    // synthesized_by union should still dedup the source
    expect(r.candidate.synthesized_by).toEqual(["claude", "kimi"]);
  });

  it("reports per-source contributions", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "claude", body: "abc", derived_from: ["o#1", "o#2", "o#3"] }),
        draft({ source: "kimi", body: "longer body", derived_from: ["o#1"] }),
      ],
      version: 1,
    });
    expect(r.contributions).toHaveLength(2);
    expect(r.contributions[0]).toEqual({
      source: "claude",
      observationCount: 3,
      bodyChars: 3,
    });
    expect(r.contributions[1]).toEqual({
      source: "kimi",
      observationCount: 1,
      bodyChars: 11,
    });
  });

  it("preserves first-appearance order in derived_from union", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "a", derived_from: ["o#3", "o#1"] }),
        draft({ source: "b", derived_from: ["o#1", "o#2"] }),
      ],
      version: 1,
    });
    // First-appearance: o#3 (from a), o#1 (from a), o#2 (from b)
    expect(r.candidate.derived_from).toEqual(["o#3", "o#1", "o#2"]);
  });

  it("deduplicates identical paragraphs across drafts", () => {
    const shared = "The user prefers dark mode in all applications.";
    const r = mergeDrafts({
      drafts: [
        draft({ source: "claude", body: `Claude's view.\n\n${shared}` }),
        draft({ source: "kimi", body: `Kimi's view.\n\n${shared}` }),
      ],
      version: 1,
    });
    // The shared paragraph should appear only once in the merged body.
    const matches = r.candidate.body.split(shared).length - 1;
    expect(matches).toBe(1);
  });

  it("truncates body when maxBodyLength is exceeded", () => {
    const r = mergeDrafts({
      drafts: [
        draft({ source: "claude", body: "a".repeat(500) }),
        draft({ source: "kimi", body: "b".repeat(500) }),
      ],
      version: 1,
      maxBodyLength: 200,
    });
    expect(r.candidate.body.length).toBeLessThanOrEqual(200);
    expect(r.candidate.body).toContain("<!-- whitebox: merge truncated");
  });
});
