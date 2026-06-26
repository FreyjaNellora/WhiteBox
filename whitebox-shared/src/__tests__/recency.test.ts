import { describe, it, expect } from "vitest";
import { recencyWeight, ageInDays, DEFAULT_HALF_LIFE_DAYS } from "../recency.js";

describe("recencyWeight", () => {
  const now = new Date("2026-04-26T12:00:00Z");

  it("returns 1.0 for an observation at the same instant", () => {
    expect(recencyWeight(now, now)).toBe(1);
  });

  it("returns 0.5 after one half-life", () => {
    const oneHalfAgo = new Date(now.getTime() - DEFAULT_HALF_LIFE_DAYS * 86_400_000);
    expect(recencyWeight(oneHalfAgo, now)).toBeCloseTo(0.5, 6);
  });

  it("returns 0.25 after two half-lives", () => {
    const twoHalvesAgo = new Date(now.getTime() - 2 * DEFAULT_HALF_LIFE_DAYS * 86_400_000);
    expect(recencyWeight(twoHalvesAgo, now)).toBeCloseTo(0.25, 6);
  });

  it("respects custom half-life", () => {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);
    expect(recencyWeight(sevenDaysAgo, now, 7)).toBeCloseTo(0.5, 6);
    expect(recencyWeight(sevenDaysAgo, now, 14)).toBeCloseTo(Math.pow(2, -0.5), 6);
  });

  it("clamps future observations to weight 1.0", () => {
    const tomorrow = new Date(now.getTime() + 86_400_000);
    expect(recencyWeight(tomorrow, now)).toBe(1);
  });

  it("returns 0 for missing or malformed dates", () => {
    expect(recencyWeight(undefined, now)).toBe(0);
    expect(recencyWeight(null, now)).toBe(0);
    expect(recencyWeight("not-a-date", now)).toBe(0);
  });

  it("accepts ISO string dates", () => {
    const oneHalfAgo = new Date(now.getTime() - DEFAULT_HALF_LIFE_DAYS * 86_400_000);
    expect(recencyWeight(oneHalfAgo.toISOString(), now)).toBeCloseTo(0.5, 6);
  });

  it("rejects non-positive half-life", () => {
    expect(() => recencyWeight(now, now, 0)).toThrow();
    expect(() => recencyWeight(now, now, -1)).toThrow();
  });
});

describe("ageInDays", () => {
  const now = new Date("2026-04-26T12:00:00Z");

  it("returns 0 for present or future dates", () => {
    expect(ageInDays(now, now)).toBe(0);
    const future = new Date(now.getTime() + 86_400_000);
    expect(ageInDays(future, now)).toBe(0);
  });

  it("returns the day count for past dates", () => {
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000);
    expect(ageInDays(tenDaysAgo, now)).toBeCloseTo(10, 5);
  });

  it("returns Infinity for missing/malformed dates", () => {
    expect(ageInDays(undefined, now)).toBe(Infinity);
    expect(ageInDays("garbage", now)).toBe(Infinity);
  });
});
