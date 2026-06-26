import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { appendAccessEntries } from "whitebox-shared";

const exec = promisify(execFile);

const CLI = path.resolve("dist/index.js");
let vaultDir: string;

function runVerify(args: string[] = []) {
  return exec("node", [CLI, "verify-audit", "-v", vaultDir, ...args], {
    timeout: 15_000,
  });
}

/** Run verify-audit expecting a non-zero exit; returns the exit code. */
async function runVerifyExpectFail(args: string[] = []): Promise<number> {
  try {
    await runVerify(args);
  } catch (err) {
    return (err as { code?: number }).code ?? -1;
  }
  throw new Error("verify-audit unexpectedly exited 0");
}

const LOG = () => path.join(vaultDir, "audit", "access.jsonl");

beforeAll(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-verify-audit-"));
});

afterAll(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe("verify-audit end-to-end", () => {
  it("exits 0 on a vault with no audit log", async () => {
    const { stdout } = await runVerify();
    expect(stdout).toContain("No audit log to verify");
  });

  it("exits 0 with entry count after appends", async () => {
    await appendAccessEntries(vaultDir, [
      { id: "x.md#0", by: "cli:test" },
      { id: "x.md#1", by: "cli:test" },
      { id: "x.md#2", by: "cli:test" },
    ]);
    const { stdout } = await runVerify(["-t", "access"]);
    expect(stdout).toContain("Chain verified: 3 entries");
  });

  it("exits 1 on a tampered entry", async () => {
    const original = fs.readFileSync(LOG(), "utf-8");
    try {
      const lines = original.trim().split("\n");
      lines[1] = lines[1].replace('"by":"cli:test"', '"by":"cli:EVIL"');
      fs.writeFileSync(LOG(), lines.join("\n") + "\n", "utf-8");

      const code = await runVerifyExpectFail(["-t", "access"]);
      expect(code).toBe(1);
    } finally {
      fs.writeFileSync(LOG(), original, "utf-8");
    }
  });

  it("exits 2 on truncation (checkpoint intact)", async () => {
    const original = fs.readFileSync(LOG(), "utf-8");
    try {
      const lines = original.trim().split("\n");
      lines.pop();
      fs.writeFileSync(LOG(), lines.join("\n") + "\n", "utf-8");

      const code = await runVerifyExpectFail(["-t", "access"]);
      expect(code).toBe(2);
    } finally {
      fs.writeFileSync(LOG(), original, "utf-8");
    }
  });

  it("emits parseable --json with per-type results", async () => {
    const { stdout } = await runVerify(["--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.access.code).toBe(0);
    expect(parsed.access.message).toContain("3 entries");
    expect(parsed.trust.code).toBe(0);
  });
});
