import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  TRUST_LOG_PATH,
  DEFAULT_TRUST,
  TRUST_MIN,
  TRUST_MAX,
  appendTrustAdjustments,
  loadSourceTrust,
  makeSourceTrustResolver,
} from "../trust.js";

const NOW = new Date("2026-04-26T12:00:00Z");

let root: string;

beforeEach(() => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-trust-test-"));
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("appendTrustAdjustments + loadSourceTrust", () => {
  it("returns empty map on a brand-new vault (no log file)", async () => {
    const trust = await loadSourceTrust(root);
    expect(trust.size).toBe(0);
  });

  it("creates audit dir if missing and writes adjustments", async () => {
    await appendTrustAdjustments(root, [
      { ts: NOW.toISOString(), source: "claude", delta: 0.1, reason: "agreement" },
    ]);
    const filePath = path.join(root, TRUST_LOG_PATH);
    expect(fsSync.existsSync(filePath)).toBe(true);
  });

  it("computes trust as DEFAULT + sum of decayed deltas, clamped", async () => {
    await appendTrustAdjustments(root, [
      { ts: NOW.toISOString(), source: "claude", delta: 0.1, reason: "agreement" },
      { ts: NOW.toISOString(), source: "claude", delta: 0.1, reason: "agreement" },
      { ts: NOW.toISOString(), source: "claude", delta: -0.05, reason: "minor wrong" },
    ]);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    // Recent adjustments at full weight: 1.0 + 0.1 + 0.1 - 0.05 = 1.15
    expect(trust.get("claude")).toBeCloseTo(1.15, 5);
  });

  it("clamps to TRUST_MAX when accumulated rewards exceed it", async () => {
    const adjustments = Array.from({ length: 20 }, () => ({
      ts: NOW.toISOString(),
      source: "claude",
      delta: 0.5,
      reason: "lots of wins",
    }));
    await appendTrustAdjustments(root, adjustments);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    expect(trust.get("claude")).toBe(TRUST_MAX);
  });

  it("clamps to TRUST_MIN when accumulated penalties exceed it", async () => {
    const adjustments = Array.from({ length: 20 }, () => ({
      ts: NOW.toISOString(),
      source: "bad-agent",
      delta: -0.5,
      reason: "lots of losses",
    }));
    await appendTrustAdjustments(root, adjustments);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    expect(trust.get("bad-agent")).toBe(TRUST_MIN);
  });

  it("decays older adjustments — events 90 days old contribute half weight", async () => {
    const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 86_400_000);
    await appendTrustAdjustments(root, [
      { ts: ninetyDaysAgo.toISOString(), source: "kimi", delta: 0.4, reason: "old win" },
    ]);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    // 0.4 × 0.5 (90d half-life) = 0.2 → 1.0 + 0.2 = 1.2
    expect(trust.get("kimi")).toBeCloseTo(1.2, 5);
  });

  it("ancient adjustments evaporate (no eternal grudges)", async () => {
    const veryLongAgo = new Date(NOW.getTime() - 365 * 86_400_000);
    await appendTrustAdjustments(root, [
      { ts: veryLongAgo.toISOString(), source: "claude", delta: -0.5, reason: "year-old issue" },
    ]);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    // 365d / 90d half-life = ~4 half-lives → -0.5 × 2^-4 = -0.03125 → trust ~0.97
    expect(trust.get("claude")).toBeGreaterThan(0.95);
  });

  it("respects custom halfLifeDays", async () => {
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 86_400_000);
    await appendTrustAdjustments(root, [
      { ts: sevenDaysAgo.toISOString(), source: "x", delta: 0.4, reason: "" },
    ]);
    // With 7-day half-life, event from 7d ago contributes half: 1.0 + 0.2 = 1.2
    const trust = await loadSourceTrust(root, {
      referenceDate: NOW,
      halfLifeDays: 7,
    });
    expect(trust.get("x")).toBeCloseTo(1.2, 5);
  });

  it("aggregates per-source independently", async () => {
    await appendTrustAdjustments(root, [
      { ts: NOW.toISOString(), source: "claude", delta: 0.2, reason: "" },
      { ts: NOW.toISOString(), source: "kimi", delta: -0.1, reason: "" },
      { ts: NOW.toISOString(), source: "chatgpt", delta: 0.05, reason: "" },
    ]);
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    expect(trust.get("claude")).toBeCloseTo(1.2, 5);
    expect(trust.get("kimi")).toBeCloseTo(0.9, 5);
    expect(trust.get("chatgpt")).toBeCloseTo(1.05, 5);
  });

  it("skips malformed lines gracefully", async () => {
    const filePath = path.join(root, TRUST_LOG_PATH);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({ ts: NOW.toISOString(), source: "good", delta: 0.1, reason: "" }),
        "not json at all",
        JSON.stringify({ ts: NOW.toISOString(), source: "good", delta: 0.1, reason: "" }),
      ].join("\n"),
    );
    const trust = await loadSourceTrust(root, { referenceDate: NOW });
    expect(trust.get("good")).toBeCloseTo(1.2, 5);
  });

  it("appendTrustAdjustments with empty array is a no-op", async () => {
    await appendTrustAdjustments(root, []);
    expect(fsSync.existsSync(path.join(root, TRUST_LOG_PATH))).toBe(false);
  });
});

describe("makeSourceTrustResolver", () => {
  it("returns DEFAULT_TRUST for sources not in the map", () => {
    const resolver = makeSourceTrustResolver(new Map());
    expect(resolver("anyone")).toBe(DEFAULT_TRUST);
    expect(resolver(undefined)).toBe(DEFAULT_TRUST);
  });

  it("returns the mapped value when source is present", () => {
    const resolver = makeSourceTrustResolver(
      new Map([
        ["claude", 1.4],
        ["bad-agent", 0.3],
      ]),
    );
    expect(resolver("claude")).toBe(1.4);
    expect(resolver("bad-agent")).toBe(0.3);
    expect(resolver("unknown")).toBe(DEFAULT_TRUST);
  });
});

describe("integration with promotion", () => {
  it("an untrusted source's contributions count for less in promotion", async () => {
    const { evaluatePromotion } = await import("../promotion.js");
    await appendTrustAdjustments(root, [
      // Penalize bad-agent severely
      ...Array.from({ length: 5 }, () => ({
        ts: NOW.toISOString(),
        source: "bad-agent",
        delta: -0.5,
        reason: "history of wrongness",
      })),
    ]);
    const trustMap = await loadSourceTrust(root, { referenceDate: NOW });
    const resolver = makeSourceTrustResolver(trustMap);
    expect(resolver("bad-agent")).toBe(TRUST_MIN);

    // 4 high-confidence observations from bad-agent today, single source.
    // Without trust adjustment: 4 × 0.7 × 1.0 × 1.0 = 2.8 (below 3.0 threshold)
    // With trust=0.1: 4 × 0.7 × 0.1 × 1.0 = 0.28 (way below)
    const observations = Array.from({ length: 4 }, () => ({
      date: NOW.toISOString(),
      source: "bad-agent",
      tags: ["preference"],
      confidence: "high",
      body: "test",
    }));
    const decision = evaluatePromotion(observations, {
      referenceDate: NOW,
      sourceTrust: resolver,
    });
    expect(decision.promote).toBe(false);
    expect(decision.score).toBeLessThan(0.5);
  });
});
