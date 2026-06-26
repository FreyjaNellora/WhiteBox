import { describe, it, expect } from "vitest";
import { evaluateSynthesisTriggers } from "../synthesis-triggers.js";
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

describe("evaluateSynthesisTriggers — empty / first-time", () => {
  it("does NOT fire on an empty vault with no prior synthesis", () => {
    const d = evaluateSynthesisTriggers({
      observations: [],
      lastSynthesisAt: null,
      referenceDate: NOW,
    });
    expect(d.shouldSynthesize).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it("fires on volume even with no prior synthesis (gives the user a baseline)", () => {
    const observations = Array.from({ length: 25 }, () => obs({}));
    const d = evaluateSynthesisTriggers({
      observations,
      lastSynthesisAt: null,
      referenceDate: NOW,
    });
    expect(d.shouldSynthesize).toBe(true);
    expect(d.reasons).toContain("volume");
  });
});

describe("volume trigger", () => {
  it("fires when N+ new observations land since last synthesis", () => {
    const observations = Array.from({ length: 21 }, (_, i) =>
      obs({ date: daysAgo(1) }),
    );
    const d = evaluateSynthesisTriggers({
      observations,
      lastSynthesisAt: daysAgo(7),
      referenceDate: NOW,
    });
    expect(d.reasons).toContain("volume");
  });

  it("does NOT fire when fewer than N new observations exist", () => {
    const observations = Array.from({ length: 5 }, () => obs({ date: daysAgo(1) }));
    const d = evaluateSynthesisTriggers({
      observations,
      lastSynthesisAt: daysAgo(7),
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("volume");
  });

  it("respects custom newObservationCount threshold", () => {
    const observations = Array.from({ length: 3 }, () => obs({ date: daysAgo(1) }));
    const d = evaluateSynthesisTriggers({
      observations,
      lastSynthesisAt: daysAgo(7),
      referenceDate: NOW,
      thresholds: { newObservationCount: 3 },
    });
    expect(d.reasons).toContain("volume");
  });
});

describe("life-event trigger", () => {
  it("fires on a single observation tagged life-event", () => {
    const d = evaluateSynthesisTriggers({
      observations: [
        obs({ tags: ["life-event", "career"], body: "started a new job" }),
      ],
      lastSynthesisAt: daysAgo(30),
      referenceDate: NOW,
    });
    expect(d.reasons).toContain("life-event");
    expect(d.shouldSynthesize).toBe(true);
  });

  it("ignores life-event observations from BEFORE last synthesis", () => {
    const d = evaluateSynthesisTriggers({
      observations: [
        obs({ tags: ["life-event"], date: daysAgo(60) }),
      ],
      lastSynthesisAt: daysAgo(30),
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("life-event");
  });
});

describe("demotion trigger", () => {
  it("fires when demotionsSinceLastSynthesis >= threshold", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({})],
      lastSynthesisAt: daysAgo(7),
      demotionsSinceLastSynthesis: 1,
      referenceDate: NOW,
    });
    expect(d.reasons).toContain("demotion");
  });

  it("does NOT fire when demotion count is zero", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({})],
      lastSynthesisAt: daysAgo(7),
      demotionsSinceLastSynthesis: 0,
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("demotion");
  });
});

describe("time-fallback trigger", () => {
  it("fires when 90+ days have passed since last synthesis even with no other signal", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({ date: daysAgo(91) })],
      lastSynthesisAt: daysAgo(91),
      referenceDate: NOW,
    });
    expect(d.reasons).toContain("time-fallback");
  });

  it("does NOT fire when last synthesis is within window", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({})],
      lastSynthesisAt: daysAgo(30),
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("time-fallback");
  });

  it("does NOT fire when no prior synthesis exists (baseline already covered by volume rule)", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({})],
      lastSynthesisAt: null,
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("time-fallback");
  });
});

describe("tag-drift trigger", () => {
  it("fires when an emerging tag now dominates recent activity", () => {
    // Older history: 10 observations all tagged "coding"
    const older = Array.from({ length: 10 }, () =>
      obs({ tags: ["coding"], date: daysAgo(60) }),
    );
    // Recent: 6 observations all tagged "health" (new dominant tag)
    const recent = Array.from({ length: 6 }, () =>
      obs({ tags: ["health"], date: daysAgo(5) }),
    );
    const d = evaluateSynthesisTriggers({
      observations: [...older, ...recent],
      lastSynthesisAt: daysAgo(50),
      referenceDate: NOW,
    });
    expect(d.reasons).toContain("tag-drift");
    expect(d.details.detectedTagDrift?.tag).toBe("health");
  });

  it("does NOT fire when distributions are stable", () => {
    const stable: ParsedObservation[] = [];
    for (let i = 0; i < 5; i++) {
      stable.push(obs({ tags: ["coding"], date: daysAgo(60 + i) }));
      stable.push(obs({ tags: ["coding"], date: daysAgo(5 + i) }));
    }
    const d = evaluateSynthesisTriggers({
      observations: stable,
      lastSynthesisAt: daysAgo(45),
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("tag-drift");
  });

  it("does NOT fire when one side has too few samples for comparison", () => {
    const d = evaluateSynthesisTriggers({
      observations: [
        obs({ tags: ["a"], date: daysAgo(5) }),
        obs({ tags: ["a"], date: daysAgo(60) }),
      ],
      lastSynthesisAt: daysAgo(50),
      referenceDate: NOW,
    });
    expect(d.reasons).not.toContain("tag-drift");
  });
});

describe("decision aggregation", () => {
  it("returns multiple reasons when several triggers fire together", () => {
    const observations = [
      ...Array.from({ length: 25 }, () => obs({ date: daysAgo(1) })),
      obs({ tags: ["life-event"], date: daysAgo(2) }),
    ];
    const d = evaluateSynthesisTriggers({
      observations,
      lastSynthesisAt: daysAgo(7),
      demotionsSinceLastSynthesis: 1,
      referenceDate: NOW,
    });
    expect(d.shouldSynthesize).toBe(true);
    expect(d.reasons).toEqual(
      expect.arrayContaining(["volume", "life-event", "demotion"]),
    );
  });

  it("summary string mentions all firing reasons", () => {
    const d = evaluateSynthesisTriggers({
      observations: Array.from({ length: 25 }, () => obs({ date: daysAgo(1) })),
      lastSynthesisAt: daysAgo(7),
      referenceDate: NOW,
    });
    expect(d.summary).toContain("volume");
    expect(d.summary.toLowerCase()).toContain("re-synthesize");
  });

  it("summary indicates no trigger when nothing fires", () => {
    const d = evaluateSynthesisTriggers({
      observations: [obs({})],
      lastSynthesisAt: daysAgo(7),
      referenceDate: NOW,
    });
    expect(d.shouldSynthesize).toBe(false);
    expect(d.summary).toContain("no trigger");
  });
});
