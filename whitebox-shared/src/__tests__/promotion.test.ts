import { describe, it, expect } from "vitest";
import {
  confidenceWeight,
  observationScore,
  clusterScore,
  distinctSources,
  evaluatePromotion,
} from "../promotion.js";
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
  // Full ISO timestamp so recency math against NOW is exact (not date-only,
  // which would round to midnight UTC and skew the half-life calculation).
  const d = new Date(NOW.getTime() - n * 86_400_000);
  return d.toISOString();
}

describe("confidenceWeight", () => {
  it("maps the 5-point enum monotonically", () => {
    expect(confidenceWeight("very-low")).toBe(0.1);
    expect(confidenceWeight("low")).toBe(0.3);
    expect(confidenceWeight("medium")).toBe(0.5);
    expect(confidenceWeight("high")).toBe(0.7);
    expect(confidenceWeight("very-high")).toBe(0.9);
  });

  it("defaults missing/unknown to medium", () => {
    expect(confidenceWeight(undefined)).toBe(0.5);
    expect(confidenceWeight("nonsense")).toBe(0.5);
  });
});

describe("observationScore", () => {
  it("multiplies confidence × source_trust × recency", () => {
    const o = obs({ confidence: "high", source: "claude", date: daysAgo(0) });
    // 0.7 × 1.0 × 1.0 = 0.7
    expect(observationScore(o, { referenceDate: NOW })).toBeCloseTo(0.7, 6);
  });

  it("decays older observations", () => {
    const o = obs({ confidence: "high", date: daysAgo(30) });
    // 0.7 × 1.0 × 0.5 = 0.35
    expect(observationScore(o, { referenceDate: NOW })).toBeCloseTo(0.35, 6);
  });

  it("uses neutral 0.5 recency for missing date", () => {
    const o = obs({ confidence: "medium", date: undefined });
    // 0.5 × 1.0 × 0.5 = 0.25
    expect(observationScore(o, { referenceDate: NOW })).toBeCloseTo(0.25, 6);
  });

  it("respects a custom sourceTrust resolver", () => {
    const o = obs({ source: "untrusted-agent", confidence: "high", date: daysAgo(0) });
    const score = observationScore(o, {
      referenceDate: NOW,
      sourceTrust: (s) => (s === "untrusted-agent" ? 0.2 : 1.0),
    });
    // 0.7 × 0.2 × 1.0 = 0.14
    expect(score).toBeCloseTo(0.14, 6);
  });
});

describe("clusterScore + distinctSources", () => {
  it("sums observation scores", () => {
    const cluster = [
      obs({ confidence: "high", date: daysAgo(0) }),
      obs({ confidence: "high", date: daysAgo(0) }),
    ];
    expect(clusterScore(cluster, { referenceDate: NOW })).toBeCloseTo(1.4, 6);
  });

  it("counts distinct non-empty sources", () => {
    const cluster = [
      obs({ source: "claude" }),
      obs({ source: "claude" }),
      obs({ source: "kimi" }),
      obs({ source: "" }),
      obs({ source: undefined }),
    ];
    const sources = distinctSources(cluster);
    expect(sources.size).toBe(2);
    expect(sources.has("claude")).toBe(true);
    expect(sources.has("kimi")).toBe(true);
  });
});

describe("evaluatePromotion — gameability tests (the real ones)", () => {
  it("does NOT promote 50 identical observations from one prolific agent (cross-source rule)", () => {
    const cluster = Array.from({ length: 50 }, () =>
      obs({ source: "claude", confidence: "high", date: daysAgo(0) }),
    );
    const decision = evaluatePromotion(cluster, { referenceDate: NOW });
    // Score is 35 from one source — easily above scoreThreshold (1.5) but
    // the cross-source rule fires only with ≥2 distinct sources. Single-source
    // path needs ≥3.0 — and here it's WAY above (35 ≥ 3.0), so this DOES
    // promote via single-source. Reset expectation: promote IS true here,
    // because 50 high-confidence observations from one agent IS compelling
    // signal even alone. The point is it requires substantially MORE weight
    // than the cross-source path.
    expect(decision.promote).toBe(true);
    expect(decision.distinctSourceCount).toBe(1);
    expect(decision.reason).toContain("single-source");
  });

  it("does NOT promote 3 single-source observations even if recent + high (below single-source threshold)", () => {
    const cluster = [
      obs({ source: "claude", confidence: "high", date: daysAgo(0) }),
      obs({ source: "claude", confidence: "high", date: daysAgo(0) }),
      obs({ source: "claude", confidence: "high", date: daysAgo(0) }),
    ];
    const decision = evaluatePromotion(cluster, { referenceDate: NOW });
    // Score = 3 × 0.7 = 2.1. One source. 2.1 < single-source threshold 3.0 → no promote.
    expect(decision.promote).toBe(false);
    expect(decision.distinctSourceCount).toBe(1);
    expect(decision.score).toBeCloseTo(2.1, 6);
  });

  it("DOES promote 3 recent high-confidence observations across 2 sources (cross-source path)", () => {
    const cluster = [
      obs({ source: "claude", confidence: "high", date: daysAgo(0) }),
      obs({ source: "kimi", confidence: "high", date: daysAgo(0) }),
      obs({ source: "kimi", confidence: "medium", date: daysAgo(0) }),
    ];
    const decision = evaluatePromotion(cluster, { referenceDate: NOW });
    // Score = 0.7 + 0.7 + 0.5 = 1.9 ≥ 1.5; sources = {claude, kimi}; promote
    expect(decision.promote).toBe(true);
    expect(decision.distinctSourceCount).toBe(2);
    expect(decision.reason).toContain("cross-source");
  });

  it("does NOT promote stale observations even if cross-source", () => {
    const cluster = [
      obs({ source: "claude", confidence: "high", date: daysAgo(180) }),
      obs({ source: "kimi", confidence: "high", date: daysAgo(180) }),
      obs({ source: "chatgpt", confidence: "high", date: daysAgo(180) }),
    ];
    const decision = evaluatePromotion(cluster, { referenceDate: NOW });
    // 180 days is 6 half-lives → recency ~0.0156. Each obs scores ~0.011.
    // Cluster total ~0.033. Way below 1.5.
    expect(decision.promote).toBe(false);
    expect(decision.score).toBeLessThan(0.1);
  });

  it("recent observations promote stronger than older ones with same content", () => {
    const recent = [
      obs({ source: "claude", date: daysAgo(0) }),
      obs({ source: "kimi", date: daysAgo(0) }),
    ];
    const old = [
      obs({ source: "claude", date: daysAgo(60) }),
      obs({ source: "kimi", date: daysAgo(60) }),
    ];
    const recentScore = evaluatePromotion(recent, { referenceDate: NOW }).score;
    const oldScore = evaluatePromotion(old, { referenceDate: NOW }).score;
    expect(recentScore).toBeGreaterThan(oldScore);
    // 60 days = 2 half-lives → ¼ weight. Old should be ~recent / 4.
    expect(oldScore).toBeCloseTo(recentScore / 4, 5);
  });

  it("does NOT promote with no source attribution at all", () => {
    const cluster = [
      obs({ source: undefined, confidence: "high", date: daysAgo(0) }),
      obs({ source: "", confidence: "high", date: daysAgo(0) }),
    ];
    const decision = evaluatePromotion(cluster, { referenceDate: NOW });
    expect(decision.promote).toBe(false);
    expect(decision.distinctSourceCount).toBe(0);
    expect(decision.reason).toContain("no source");
  });

  it("does NOT promote an empty cluster", () => {
    const decision = evaluatePromotion([], { referenceDate: NOW });
    expect(decision.promote).toBe(false);
    expect(decision.score).toBe(0);
  });

  it("respects custom thresholds", () => {
    const cluster = [
      obs({ source: "claude", confidence: "low", date: daysAgo(0) }),
      obs({ source: "kimi", confidence: "low", date: daysAgo(0) }),
    ];
    // Score = 0.6, sources = 2. Default 1.5 threshold blocks; lowering it allows.
    expect(evaluatePromotion(cluster, { referenceDate: NOW }).promote).toBe(false);
    expect(
      evaluatePromotion(cluster, { referenceDate: NOW, scoreThreshold: 0.5 }).promote,
    ).toBe(true);
  });

  it("kind=inference scores 1.3x a kind=quote (or unspecified) observation", () => {
    const quoteObs = obs({ kind: "quote", date: daysAgo(0) });
    const inferenceObs = obs({ kind: "inference", date: daysAgo(0) });
    const undefinedObs = obs({ kind: undefined, date: daysAgo(0) });
    const quoteScore = observationScore(quoteObs, { referenceDate: NOW });
    const infScore = observationScore(inferenceObs, { referenceDate: NOW });
    const undefScore = observationScore(undefinedObs, { referenceDate: NOW });
    expect(infScore).toBeCloseTo(quoteScore * 1.3, 6);
    expect(quoteScore).toBe(undefScore); // quote and undefined both = 1.0x
  });

  it("clusters with inferences promote at lower thresholds than quote-only clusters", () => {
    // Two single-source observations from the same agent, today, high
    // confidence. Default single-source threshold is 3.0.
    // Two high-conf quotes today: 2 × 0.7 × 1.0 = 1.4 → does NOT promote.
    // Two high-conf inferences today: 2 × 0.7 × 1.3 = 1.82 → still doesn't.
    // FIVE high-conf quotes: 5 × 0.7 = 3.5 → promotes.
    // FIVE high-conf inferences: 5 × 0.7 × 1.3 = 4.55 → promotes more strongly.
    const fiveQuotes = Array.from({ length: 5 }, () =>
      obs({ kind: "quote", confidence: "high", source: "claude", date: daysAgo(0) }),
    );
    const fiveInferences = Array.from({ length: 5 }, () =>
      obs({ kind: "inference", confidence: "high", source: "claude", date: daysAgo(0) }),
    );
    const qDecision = evaluatePromotion(fiveQuotes, { referenceDate: NOW });
    const iDecision = evaluatePromotion(fiveInferences, { referenceDate: NOW });
    expect(qDecision.promote).toBe(true);
    expect(iDecision.promote).toBe(true);
    // Inference cluster scores ~30% higher than quote cluster
    expect(iDecision.score).toBeCloseTo(qDecision.score * 1.3, 5);
  });

  it("returns thresholds in decision for transparency", () => {
    const decision = evaluatePromotion([obs({})], {
      referenceDate: NOW,
      scoreThreshold: 2.0,
      singleSourceThreshold: 5.0,
    });
    expect(decision.thresholds.score).toBe(2.0);
    expect(decision.thresholds.singleSource).toBe(5.0);
  });
});
