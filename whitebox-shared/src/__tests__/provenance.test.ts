import { describe, it, expect } from "vitest";
import { resolveObservationSource } from "../provenance.js";

describe("resolveObservationSource (MEM-3)", () => {
  it("uses the caller's claim, mcp-prefixed, when no identity is pinned", () => {
    expect(resolveObservationSource("claude", null)).toEqual({
      stamped: "mcp:claude",
      pinned: false,
    });
    expect(resolveObservationSource("mcp:claude", undefined)).toEqual({
      stamped: "mcp:claude",
      pinned: false,
    });
    expect(resolveObservationSource("kimi", "")).toEqual({
      stamped: "mcp:kimi",
      pinned: false,
    });
  });

  it("pins to the configured identity and ignores a forged caller source", () => {
    // attacker claims to be 'claude' but the server is launched as 'kimi'
    expect(resolveObservationSource("claude", "kimi")).toEqual({
      stamped: "mcp:kimi",
      pinned: true,
    });
    expect(resolveObservationSource("mcp:trusted-agent", "mcp:kimi")).toEqual({
      stamped: "mcp:kimi",
      pinned: true,
    });
  });

  it("does not flag pinned when the claim already matches the configured identity", () => {
    expect(resolveObservationSource("kimi", "kimi")).toEqual({
      stamped: "mcp:kimi",
      pinned: false,
    });
    expect(resolveObservationSource("mcp:kimi", "kimi")).toEqual({
      stamped: "mcp:kimi",
      pinned: false,
    });
  });

  it("normalizes prefixes and trims whitespace", () => {
    expect(resolveObservationSource("  claude  ", null).stamped).toBe("mcp:claude");
    expect(resolveObservationSource("x", "  kimi  ").stamped).toBe("mcp:kimi");
  });
});
