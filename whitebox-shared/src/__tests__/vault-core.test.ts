import { describe, it, expect } from "vitest";
import { monthLabel, isoDate, today } from "../vault-core.js";

describe("monthLabel", () => {
  it("formats valid months", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("2025-06")).toBe("June 2025");
  });

  it("throws on month 0", () => {
    expect(() => monthLabel("2026-00")).toThrow("Invalid month");
  });

  it("throws on month 13", () => {
    expect(() => monthLabel("2026-13")).toThrow("Invalid month");
  });

  it("throws on non-numeric month", () => {
    expect(() => monthLabel("2026-xx")).toThrow("Invalid month");
  });
});

describe("isoDate", () => {
  it("formats a date correctly", () => {
    const d = new Date(2026, 3, 25); // April 25, 2026
    expect(isoDate(d)).toBe("2026-04-25");
  });

  it("pads single-digit months and days", () => {
    const d = new Date(2026, 0, 5); // January 5, 2026
    expect(isoDate(d)).toBe("2026-01-05");
  });
});

describe("today", () => {
  it("returns a YYYY-MM-DD string", () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
