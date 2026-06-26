import { describe, it, expect } from "vitest";
import {
  isLoopbackHost,
  refuseWideOpen,
  buildAllowedHosts,
  isHostAllowed,
  isAuthorized,
} from "../sse-guard.js";

describe("MEM-1 SSE guards", () => {
  describe("refuseWideOpen", () => {
    it("refuses a non-loopback bind without a token", () => {
      expect(refuseWideOpen("0.0.0.0", null)).toBe(true);
      expect(refuseWideOpen("192.168.1.50", null)).toBe(true);
    });
    it("allows a non-loopback bind WITH a token", () => {
      expect(refuseWideOpen("0.0.0.0", "secret")).toBe(false);
    });
    it("allows loopback binds without a token", () => {
      expect(refuseWideOpen("127.0.0.1", null)).toBe(false);
      expect(refuseWideOpen("localhost", null)).toBe(false);
      expect(refuseWideOpen("::1", null)).toBe(false);
    });
  });

  describe("Host-header allow-list (DNS-rebinding defense)", () => {
    const allowed = buildAllowedHosts("127.0.0.1", 8787, "chatbox.local:8787");

    it("accepts loopback + configured hosts (case-insensitive)", () => {
      expect(isHostAllowed("127.0.0.1:8787", allowed)).toBe(true);
      expect(isHostAllowed("localhost:8787", allowed)).toBe(true);
      expect(isHostAllowed("ChatBox.local:8787", allowed)).toBe(true);
    });
    it("rejects a rebound/unknown Host", () => {
      expect(isHostAllowed("evil.example.com", allowed)).toBe(false);
      expect(isHostAllowed("127.0.0.1:9999", allowed)).toBe(false);
      expect(isHostAllowed(undefined, allowed)).toBe(false);
      expect(isHostAllowed("", allowed)).toBe(false);
    });
  });

  describe("isAuthorized", () => {
    it("is open when no token is configured", () => {
      expect(isAuthorized(undefined, null)).toBe(true);
      expect(isAuthorized("Bearer whatever", null)).toBe(true);
    });
    it("requires the exact bearer token when configured", () => {
      expect(isAuthorized("Bearer s3cret", "s3cret")).toBe(true);
      expect(isAuthorized("Bearer wrong", "s3cret")).toBe(false);
      expect(isAuthorized("s3cret", "s3cret")).toBe(false); // missing "Bearer "
      expect(isAuthorized(undefined, "s3cret")).toBe(false);
      expect(isAuthorized("Bearer s3cre", "s3cret")).toBe(false); // length mismatch
    });
  });

  it("isLoopbackHost recognizes loopback aliases", () => {
    for (const h of ["127.0.0.1", "::1", "localhost", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});
