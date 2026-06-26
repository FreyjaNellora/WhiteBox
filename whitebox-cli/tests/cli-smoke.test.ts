import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

const CLI = path.resolve("dist/index.js");
let vaultDir: string;

function run(args: string[], env?: Record<string, string>) {
  return exec("node", [CLI, ...args], {
    cwd: vaultDir,
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
}

beforeAll(async () => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cli-test-"));

  // Initialize a vault
  await exec("node", [CLI, "init", vaultDir]);
});

afterAll(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe("CLI smoke tests", () => {
  it("whitebox init creates vault structure", () => {
    expect(fs.existsSync(path.join(vaultDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "identity.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(vaultDir, "working-style.md")),
    ).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "tags.md"))).toBe(true);
    expect(
      fs.statSync(path.join(vaultDir, "observations")).isDirectory(),
    ).toBe(true);
  });

  it("whitebox --version exits 0 and prints version", async () => {
    const { stdout } = await exec("node", [CLI, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("whitebox export produces output", async () => {
    const { stdout } = await run([
      "export",
      "-v",
      vaultDir,
    ]);
    expect(stdout).toContain("<!-- whitebox-context: start -->");
  });

  it("whitebox conflicts --json returns valid JSON", async () => {
    const { stdout } = await run([
      "conflicts",
      "-v",
      vaultDir,
      "--json",
    ]);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("whitebox diagnostics exits 0", async () => {
    const { stdout } = await run([
      "diagnostics",
      "-v",
      vaultDir,
    ]);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("whitebox log --recent rejects non-integer", async () => {
    let failed = false;
    try {
      await run(["log", "-v", vaultDir, "--recent", "abc"]);
    } catch (err) {
      failed = true;
      const stderr = (err as { stderr?: string }).stderr || "";
      expect(stderr).toContain("--recent must be a positive integer");
    }
    expect(failed).toBe(true);
  });

  it("whitebox grep --context rejects out-of-range", async () => {
    let failed = false;
    try {
      await run(["grep", "test", "-v", vaultDir, "--context", "99"]);
    } catch (err) {
      failed = true;
      const stderr = (err as { stderr?: string }).stderr || "";
      expect(stderr).toContain("--context must be an integer 0-20");
    }
    expect(failed).toBe(true);
  });

  it("whitebox log on freshly-initialized vault prints empty notice", async () => {
    const { stdout } = await run(["log", "-v", vaultDir]);
    expect(stdout).toMatch(/no passive-memory conversations/i);
  });

  it("whitebox paste exits 0 or fails gracefully", async () => {
    // paste copies to clipboard — may fail on headless CI without
    // a display server. Acceptable failures must reference a clipboard
    // backend (xclip/pbcopy/powershell/clip), permission denied, or be
    // a non-zero exit with a clipboard-keyword stderr. Anything else
    // (e.g. vault-format error, missing file) should fail the test.
    try {
      await run(["paste", "-v", vaultDir]);
    } catch (err: unknown) {
      const message = ((err as Error).message || "").toLowerCase();
      const clipboardKeywords = [
        "clipboard",
        "xclip",
        "xsel",
        "pbcopy",
        "powershell",
        "clip.exe",
        "wl-copy",
      ];
      const looksClipboard =
        clipboardKeywords.some((k) => message.includes(k)) ||
        message.includes("eperm") ||
        message.includes("display");
      if (!looksClipboard) {
        // Re-throw so a real bug (vault parse error etc.) actually fails.
        throw err;
      }
      expect(looksClipboard).toBe(true);
    }
  });
});
