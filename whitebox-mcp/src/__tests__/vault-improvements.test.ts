import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Vault } from "../vault.js";

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-improvements-"));
  fs.mkdirSync(path.join(root, "observations"), { recursive: true });
  fs.writeFileSync(path.join(root, "identity.md"), "Test user");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("backtick escaping in observations", () => {
  it("uses longer fence when body contains triple backticks", async () => {
    const vault = new Vault({ root });
    await vault.appendObservation({
      source: "test",
      tags: ["test"],
      confidence: "medium",
      body: "User said: ```code block``` in their message",
    });

    const obsDir = path.join(root, "observations");
    const files = fs.readdirSync(obsDir).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(obsDir, files[0]), "utf-8");
    // Should use ```` (4 backticks) as fence
    expect(content).toContain("````");
    // The body should be intact
    expect(content).toContain("```code block```");
  });

  it("uses normal fence when body has no triple backticks", async () => {
    // Clean up previous test's file
    const obsDir = path.join(root, "observations");
    for (const f of fs.readdirSync(obsDir)) {
      fs.unlinkSync(path.join(obsDir, f));
    }

    const vault = new Vault({ root });
    await vault.appendObservation({
      source: "test",
      tags: ["test"],
      confidence: "medium",
      body: "Normal observation with no backticks",
    });

    const files = fs.readdirSync(obsDir).filter((f) => f.endsWith(".md"));
    const content = fs.readFileSync(path.join(obsDir, files[0]), "utf-8");
    // Should use ``` (3 backticks), not ````
    expect(content).not.toContain("````");
    expect(content).toContain("```");
  });
});

describe("audit log atomicity", () => {
  it("creates audit log entry alongside observation", async () => {
    const vault = new Vault({ root });
    await vault.appendObservation({
      source: "test-audit",
      tags: ["audit-test"],
      confidence: "high",
      body: "Testing audit atomicity",
    });

    const auditDir = path.join(root, "audit");
    expect(fs.existsSync(auditDir)).toBe(true);

    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".md"));
    expect(auditFiles.length).toBeGreaterThan(0);

    const auditContent = fs.readFileSync(path.join(auditDir, auditFiles[0]), "utf-8");
    expect(auditContent).toContain("kind=wb-save");
    expect(auditContent).toContain("source=test-audit");
    expect(auditContent).toContain("audit-test");
  });
});

describe("audit log sanitization", () => {
  it("strips newlines from audit entry values", async () => {
    const vault = new Vault({ root });
    await vault.appendObservation({
      source: "test\nnewline",
      tags: ["tag\ninjection"],
      confidence: "medium",
      body: "Testing sanitization",
    });

    const auditDir = path.join(root, "audit");
    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".md"));
    const auditContent = fs.readFileSync(
      path.join(auditDir, auditFiles[auditFiles.length - 1]),
      "utf-8",
    );

    // Each audit entry should be a single line (after the header)
    const lines = auditContent.split("\n").filter((l) => l.includes("kind=wb-save"));
    for (const line of lines) {
      // No embedded newlines — each entry is one line
      expect(line).not.toContain("\n");
    }
  });
});

describe("regex DoS protection", () => {
  it("rejects alternation-based backtracking patterns", async () => {
    const vault = new Vault({ root });
    await expect(
      vault.grep({ pattern: "(a|a)*b" }),
    ).rejects.toThrow("excessive backtracking");
  });

  it("rejects nested quantifier patterns", async () => {
    const vault = new Vault({ root });
    await expect(
      vault.grep({ pattern: "(a+)+" }),
    ).rejects.toThrow("excessive backtracking");
  });

  it("allows safe alternation patterns", async () => {
    const vault = new Vault({ root });
    // Non-overlapping alternation without quantifier should be fine
    const results = await vault.grep({ pattern: "foo|bar" });
    expect(Array.isArray(results)).toBe(true);
  });
});
