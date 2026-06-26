import { describe, it, expect } from "vitest";
import { ObservationSchema, GrepInputSchema } from "../schema.js";

describe("ObservationSchema", () => {
  const valid = {
    source: "claude",
    tags: ["test"],
    confidence: "medium" as const,
    body: "A short observation.",
  };

  it("accepts a valid observation", () => {
    const result = ObservationSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts body at exactly 500 characters", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      body: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("rejects body exceeding 500 characters", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      body: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty body", () => {
    const result = ObservationSchema.safeParse({ ...valid, body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing source", () => {
    const { source: _, ...noSource } = valid;
    const result = ObservationSchema.safeParse(noSource);
    expect(result.success).toBe(false);
  });

  it("rejects empty tags array", () => {
    const result = ObservationSchema.safeParse({ ...valid, tags: [] });
    expect(result.success).toBe(false);
  });

  it("rejects tag with newline (audit log injection guard)", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      tags: ["bad\ntag"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects tag with uppercase or special chars", () => {
    expect(
      ObservationSchema.safeParse({ ...valid, tags: ["BadTag"] }).success,
    ).toBe(false);
    expect(
      ObservationSchema.safeParse({ ...valid, tags: ["bad tag"] }).success,
    ).toBe(false);
    expect(
      ObservationSchema.safeParse({ ...valid, tags: ["bad@tag"] }).success,
    ).toBe(false);
  });

  it("rejects tag longer than 50 chars", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      tags: ["a".repeat(51)],
    });
    expect(result.success).toBe(false);
  });

  it("accepts hyphenated and digit tags", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      tags: ["audit-test", "v2", "9-lives"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid confidence value", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      confidence: "maybe",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid confidence values", () => {
    for (const c of ["very-low", "low", "medium", "high", "very-high"]) {
      const result = ObservationSchema.safeParse({
        ...valid,
        confidence: c,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects source_ref with absolute path", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      source_ref: "/etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rejects source_ref with path traversal", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      source_ref: "../secret.md",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid source_ref", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      source_ref: "sources/transcript.md",
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional date in ISO format", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      date: "2026-04-22",
    });
    expect(result.success).toBe(true);
  });

  it("rejects malformed date", () => {
    const result = ObservationSchema.safeParse({
      ...valid,
      date: "April 22, 2026",
    });
    expect(result.success).toBe(false);
  });
});

describe("GrepInputSchema", () => {
  it("accepts a valid pattern", () => {
    const result = GrepInputSchema.safeParse({ pattern: "hello" });
    expect(result.success).toBe(true);
  });

  it("rejects empty pattern", () => {
    const result = GrepInputSchema.safeParse({ pattern: "" });
    expect(result.success).toBe(false);
  });
});
