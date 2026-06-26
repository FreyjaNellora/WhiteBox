import { describe, it, expect } from "vitest";
import { computeVaultHealth, formatVaultHealthReport } from "../vault-health.js";
import type { ParsedObservation } from "../observation-parser.js";

const NOW = new Date("2026-04-26T12:00:00Z");

function obs(p: Partial<ParsedObservation>): ParsedObservation {
  return {
    date: NOW.toISOString(),
    source: "claude",
    confidence: "high",
    tags: ["preference"],
    body: "test",
    ...p,
  };
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe("computeVaultHealth — empty / minimal", () => {
  it("handles an empty vault gracefully", () => {
    const r = computeVaultHealth([], { referenceDate: NOW });
    expect(r.observationCount).toBe(0);
    expect(r.distinctSources).toBe(0);
    expect(r.corroborationRate).toBe(0);
    expect(r.accessConcentration).toBe(0);
    expect(r.topTags).toEqual([]);
  });

  it("counts a single observation correctly", () => {
    const r = computeVaultHealth([obs({})], { referenceDate: NOW });
    expect(r.observationCount).toBe(1);
    expect(r.distinctSources).toBe(1);
    expect(r.sourceDistribution[0]).toEqual({ source: "claude", count: 1, share: 1, trust: 1 });
  });
});

describe("source distribution", () => {
  it("counts per source and computes share", () => {
    const r = computeVaultHealth(
      [
        obs({ source: "claude" }),
        obs({ source: "claude" }),
        obs({ source: "claude" }),
        obs({ source: "kimi" }),
      ],
      { referenceDate: NOW },
    );
    expect(r.distinctSources).toBe(2);
    expect(r.sourceDistribution[0]).toEqual({ source: "claude", count: 3, share: 0.75, trust: 1 });
    expect(r.sourceDistribution[1]).toEqual({ source: "kimi", count: 1, share: 0.25, trust: 1 });
  });

  it("buckets unknown source separately and excludes from distinctSources", () => {
    const r = computeVaultHealth(
      [obs({ source: "claude" }), obs({ source: "" }), obs({ source: undefined })],
      { referenceDate: NOW },
    );
    expect(r.distinctSources).toBe(1); // claude only
    const unknown = r.sourceDistribution.find((s) => s.source === "(unknown)");
    expect(unknown?.count).toBe(2);
  });
});

describe("age distribution", () => {
  it("buckets observations into the right age windows", () => {
    const r = computeVaultHealth(
      [
        obs({ date: daysAgo(2) }), // last 7d
        obs({ date: daysAgo(15) }), // 7-30d
        obs({ date: daysAgo(60) }), // 30-90d
        obs({ date: daysAgo(120) }), // 90+d
        obs({ date: undefined }), // undated
      ],
      { referenceDate: NOW },
    );
    expect(r.ageDistribution).toEqual({
      last7d: 1,
      last7to30d: 1,
      last30to90d: 1,
      over90d: 1,
      undated: 1,
    });
  });
});

describe("corroboration rate", () => {
  it("is 1.0 when every observation is in a multi-source cluster", () => {
    const r = computeVaultHealth(
      [
        obs({ source: "claude", tags: ["coding"] }),
        obs({ source: "kimi", tags: ["coding"] }),
      ],
      { referenceDate: NOW },
    );
    expect(r.corroborationRate).toBe(1);
  });

  it("is 0 when only one source contributes", () => {
    const r = computeVaultHealth(
      [
        obs({ source: "claude", tags: ["a"] }),
        obs({ source: "claude", tags: ["b"] }),
        obs({ source: "claude", tags: ["c"] }),
      ],
      { referenceDate: NOW },
    );
    expect(r.corroborationRate).toBe(0);
  });

  it("partial corroboration mixes both", () => {
    const r = computeVaultHealth(
      [
        // {coding} cluster: claude + kimi → corroborated (counts 2)
        obs({ source: "claude", tags: ["coding"] }),
        obs({ source: "kimi", tags: ["coding"] }),
        // {food} cluster: claude only → not corroborated (counts 0)
        obs({ source: "claude", tags: ["food"] }),
        obs({ source: "claude", tags: ["food"] }),
      ],
      { referenceDate: NOW },
    );
    expect(r.corroborationRate).toBe(0.5);
  });
});

describe("access concentration", () => {
  it("is 0 when no access counts supplied", () => {
    const r = computeVaultHealth([obs({})], { referenceDate: NOW });
    expect(r.accessConcentration).toBe(0);
  });

  it("is high when all reads concentrate on one item", () => {
    const observations = Array.from({ length: 10 }, () => obs({}));
    const accessCounts = [100, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const r = computeVaultHealth(observations, {
      referenceDate: NOW,
      accessCounts,
    });
    // Top 10% = 1 item with all 100 accesses → concentration = 100%
    expect(r.accessConcentration).toBe(1);
  });

  it("is low when reads are evenly distributed", () => {
    const observations = Array.from({ length: 10 }, () => obs({}));
    const accessCounts = Array(10).fill(10);
    const r = computeVaultHealth(observations, {
      referenceDate: NOW,
      accessCounts,
    });
    // Top 10% = 1 of 10 items, with 10/100 reads → concentration = 10%
    expect(r.accessConcentration).toBeCloseTo(0.1, 2);
  });
});

describe("top tags", () => {
  it("returns most-frequent tags sorted descending", () => {
    const r = computeVaultHealth(
      [
        obs({ tags: ["coding", "preference"] }),
        obs({ tags: ["coding", "vim"] }),
        obs({ tags: ["coding"] }),
        obs({ tags: ["food"] }),
      ],
      { referenceDate: NOW, topTagsLimit: 3 },
    );
    expect(r.topTags[0]).toEqual({ tag: "coding", count: 3 });
    expect(r.topTags.length).toBe(3);
  });
});

describe("effective observation count", () => {
  it("equals raw count when all observations are fresh", () => {
    const observations = Array.from({ length: 5 }, () => obs({ date: daysAgo(0) }));
    const r = computeVaultHealth(observations, { referenceDate: NOW });
    expect(r.effectiveObservationCount).toBe(5);
  });

  it("decays toward zero as observations age", () => {
    const observations = Array.from({ length: 10 }, () => obs({ date: daysAgo(180) }));
    const r = computeVaultHealth(observations, { referenceDate: NOW });
    // 180 days = 6 half-lives → each weights ~0.0156. Sum ~0.16.
    expect(r.effectiveObservationCount).toBeLessThan(1);
  });
});

describe("formatVaultHealthReport", () => {
  it("renders a readable text report", () => {
    const r = computeVaultHealth(
      [
        obs({ source: "claude", tags: ["coding"], date: daysAgo(2) }),
        obs({ source: "kimi", tags: ["coding"], date: daysAgo(5) }),
      ],
      { referenceDate: NOW },
    );
    const text = formatVaultHealthReport(r);
    expect(text).toContain("VAULT HEALTH REPORT");
    expect(text).toContain("Total observations:      2");
    expect(text).toContain("Distinct sources:        2");
    expect(text).toContain("Cross-source corroboration: 100.0%");
  });

  it("surfaces health hints when conditions warrant", () => {
    const observations = Array.from({ length: 6 }, () => obs({ source: "claude" }));
    const r = computeVaultHealth(observations, { referenceDate: NOW });
    const text = formatVaultHealthReport(r);
    expect(text).toContain("Single-source vault");
  });
});
