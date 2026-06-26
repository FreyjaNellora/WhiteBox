import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Vault } from "../vault.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-mcp-test-"));

  // Create a minimal vault structure
  fs.mkdirSync(path.join(root, "observations"), { recursive: true });
  fs.writeFileSync(path.join(root, "identity.md"), "Test user");
  fs.writeFileSync(
    path.join(root, "observations", "2026-04.md"),
    [
      "# April 2026",
      "",
      "```",
      "---",
      "date: 2026-04-22",
      'source: "test"',
      "tags: [test]",
      'confidence: "medium"',
      "---",
      "Hello world.",
      "```",
    ].join("\n"),
  );

  // Create scopes.md for scope tests
  fs.writeFileSync(
    path.join(root, "scopes.md"),
    "- `coding` \u2014 observations, sources\n",
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Vault.readFile", () => {
  it("reads a file within the vault", async () => {
    const vault = new Vault({ root });
    const content = await vault.readFile("identity.md");
    expect(content).toBe("Test user");
  });

  it("rejects file exceeding 10 MB", async () => {
    const bigFile = path.join(root, "big.md");
    // Create an 11 MB file
    const fd = fs.openSync(bigFile, "w");
    const chunk = Buffer.alloc(1024 * 1024, 0x41); // 1 MB of 'A'
    for (let i = 0; i < 11; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.closeSync(fd);

    const vault = new Vault({ root });
    await expect(vault.readFile("big.md")).rejects.toThrow("File too large");

    fs.unlinkSync(bigFile);
  });
});

describe("Vault.isInScope", () => {
  it("allows all paths when no scope is active", async () => {
    const vault = new Vault({ root });
    expect(await vault.isInScope("anything.md")).toBe(true);
  });

  it("allows in-scope paths", async () => {
    const vault = new Vault({ root, activeScope: "coding" });
    expect(await vault.isInScope("observations/2026-04.md")).toBe(true);
  });

  it("rejects out-of-scope paths", async () => {
    const vault = new Vault({ root, activeScope: "coding" });
    expect(await vault.isInScope("identity.md")).toBe(false);
  });

  it("throws for unknown scope", async () => {
    const vault = new Vault({ root, activeScope: "nonexistent" });
    await expect(vault.isInScope("identity.md")).rejects.toThrow(
      "not defined in scopes.md",
    );
  });
});

describe("Vault.grep", () => {
  it("rejects nested quantifier patterns (ReDoS)", async () => {
    const vault = new Vault({ root });
    await expect(
      vault.grep({ pattern: "(a+)+" }),
    ).rejects.toThrow("excessive backtracking");
  });

  it("rejects other ReDoS patterns", async () => {
    const vault = new Vault({ root });
    await expect(
      vault.grep({ pattern: "(x*)*" }),
    ).rejects.toThrow("excessive backtracking");
  });

  it("finds matches with a valid pattern", async () => {
    const vault = new Vault({ root });
    const results = await vault.grep({ pattern: "Hello" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("Hello");
  });

  it("returns empty for non-matching pattern", async () => {
    const vault = new Vault({ root });
    const results = await vault.grep({
      pattern: "zzz_nonexistent_pattern_zzz",
    });
    expect(results).toHaveLength(0);
  });
});
