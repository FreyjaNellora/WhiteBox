import { describe, it, expect } from "vitest";
import { listStaleFacts, formatStaleReview } from "../demotion.js";

describe("listStaleFacts", () => {
  it("returns empty array when all observations are fresh", () => {
    const today = new Date().toISOString().slice(0, 10);
    const observations = [
      { date: today, source: "mcp:claude", confidence: "high" as const, tags: ["prefers-concise"], body: "User likes short answers." },
    ];
    const stale = listStaleFacts(observations, { referenceDate: new Date() });
    expect(stale).toHaveLength(0);
  });

  it("flags very old observations by recency threshold", () => {
    const refDate = new Date("2026-04-26T00:00:00Z");
    const observations = [
      { date: "2026-01-01", source: "mcp:claude", confidence: "high" as const, tags: ["old"], body: "Very old observation." },
      { date: "2026-04-25", source: "mcp:claude", confidence: "high" as const, tags: ["recent"], body: "Recent observation." },
    ];
    const stale = listStaleFacts(observations, { referenceDate: refDate });
    expect(stale).toHaveLength(1);
    expect(stale[0].observation.tags).toEqual(["old"]);
    expect(stale[0].ageDays).toBeGreaterThan(100);
  });

  it("flags low-confidence old observations by score threshold", () => {
    const refDate = new Date("2026-04-26T00:00:00Z");
    const observations = [
      { date: "2026-03-01", source: "mcp:claude", confidence: "very-low" as const, tags: ["weak"], body: "Weak old observation." },
      { date: "2026-03-01", source: "mcp:claude", confidence: "high" as const, tags: ["strong"], body: "Strong old observation." },
    ];
    const stale = listStaleFacts(observations, { referenceDate: refDate });
    // very-low confidence + 56 days old should score below 0.15
    expect(stale.length).toBeGreaterThanOrEqual(1);
    const weak = stale.find((s) => s.observation.tags[0] === "weak");
    expect(weak).toBeDefined();
  });

  it("sorts by age descending (oldest first)", () => {
    const refDate = new Date("2026-04-26T00:00:00Z");
    const observations = [
      { date: "2026-02-01", source: "a", confidence: "very-low" as const, tags: ["feb"], body: "Feb." },
      { date: "2025-12-01", source: "a", confidence: "very-low" as const, tags: ["dec"], body: "Dec." },
      { date: "2026-03-01", source: "a", confidence: "very-low" as const, tags: ["mar"], body: "Mar." },
    ];
    const stale = listStaleFacts(observations, { referenceDate: refDate });
    expect(stale[0].observation.tags).toEqual(["dec"]);
    expect(stale[1].observation.tags).toEqual(["feb"]);
    expect(stale[2].observation.tags).toEqual(["mar"]);
  });

  it("respects custom thresholds", () => {
    const refDate = new Date("2026-04-26T00:00:00Z");
    const observations = [
      { date: "2026-04-20", source: "a", confidence: "medium" as const, tags: ["x"], body: "6 days old." },
    ];
    // With very strict thresholds, even 6-day-old medium confidence should be stale
    const stale = listStaleFacts(observations, {
      referenceDate: refDate,
      recencyThreshold: 0.9,
      scoreThreshold: 0.5,
    });
    expect(stale).toHaveLength(1);
  });

  it("handles observations without dates gracefully", () => {
    const observations = [
      { source: "a", confidence: "medium" as const, tags: [], body: "No date." },
    ];
    const stale = listStaleFacts(observations);
    // No date → treated as one half-life old (recency 0.5), score ~0.25
    // Should NOT be below default thresholds (0.1 recency, 0.15 score)
    expect(stale).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(listStaleFacts([])).toEqual([]);
  });
});

describe("formatStaleReview", () => {
  it("formats empty review", () => {
    const text = formatStaleReview([]);
    expect(text).toContain("No stale observations found");
  });

  it("formats stale observations with preview", () => {
    const refDate = new Date("2026-04-26T00:00:00Z");
    const stale = listStaleFacts(
      [
        { date: "2025-01-01", source: "mcp:claude", confidence: "high" as const, tags: ["old"], body: "This is a very old observation that should be reviewed." },
      ],
      { referenceDate: refDate },
    );
    const text = formatStaleReview(stale);
    expect(text).toContain("Demotion Review");
    expect(text).toContain("mcp:claude");
    expect(text).toContain("old");
    expect(text).toContain("This is a very old observation");
  });

  it("truncates long bodies", () => {
    const stale = [
      {
        observation: { date: "2025-01-01", source: "a", confidence: "high" as const, tags: [], body: "x".repeat(500) },
        currentScore: 0.05,
        ageDays: 100,
        recencyWeight: 0.05,
        reason: "test",
      },
    ];
    const text = formatStaleReview(stale);
    expect(text).toContain("...");
    expect(text.length).toBeLessThan(1000);
  });
});
