import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { Vault } from "../vault.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-concurrency-"));
  fs.mkdirSync(path.join(root, "observations"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("withFileLock concurrency", () => {
  it("serializes parallel appends to the same monthly file with no lost writes", async () => {
    const vault = new Vault({ root });
    // N kept at 5 to fit within the current 5-retry budget of withFileLock.
    // Higher N exposes a real backpressure limit (LOCK_TIMEOUT thrown) — see
    // the "rejects beyond lock retry budget" test below.
    const N = 5;
    const writes = Array.from({ length: N }, (_, i) =>
      vault.appendObservation({
        source: "concurrent-test",
        tags: ["concurrent"],
        confidence: "low",
        body: `entry ${i}`,
      }),
    );

    const results = await Promise.all(writes);
    expect(results.length).toBe(N);

    const month = new Date().toISOString().slice(0, 7);
    const content = await fsp.readFile(
      path.join(root, "observations", `${month}.md`),
      "utf-8",
    );

    // Each appendObservation contributes one fenced block; count fences.
    const fenceCount = (content.match(/^```\s*$/gm) || []).length;
    // Each entry is wrapped in opening + closing ``` => 2 fences per entry.
    expect(fenceCount).toBe(N * 2);

    // Each "entry N" body must be present exactly once.
    for (let i = 0; i < N; i++) {
      const occurrences = content.split(`entry ${i}`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("throws LOCK_TIMEOUT when contention exceeds the retry budget", async () => {
    const vault = new Vault({ root });
    const N = 30;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        vault.appendObservation({
          source: "stress",
          tags: ["stress"],
          confidence: "low",
          body: `stress ${i}`,
        }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected");
    // Some MUST fail — a fixed retry budget cannot serialize 30 contenders.
    expect(failed.length).toBeGreaterThan(0);
    for (const f of failed) {
      const reason = (f as PromiseRejectedResult).reason;
      // VaultError code is "LOCK_TIMEOUT" — the message is human-readable.
      expect(reason).toBeInstanceOf(Error);
      expect((reason as { code?: string }).code).toBe("LOCK_TIMEOUT");
    }
  });

  it("removes stale lock files older than 30s and recovers", async () => {
    const vault = new Vault({ root });
    const month = new Date().toISOString().slice(0, 7);
    const target = path.join(root, "observations", `${month}.md`);
    const lockPath = `${target}.lock`;

    // Plant a stale lock with mtime 1 minute in the past.
    fs.writeFileSync(lockPath, "stale\n0");
    const oneMinAgo = Date.now() - 60_000;
    fs.utimesSync(lockPath, oneMinAgo / 1000, oneMinAgo / 1000);

    // Append should succeed by detecting + removing the stale lock.
    await expect(
      vault.appendObservation({
        source: "stale-lock-recovery",
        tags: ["test"],
        confidence: "low",
        body: "recovered",
      }),
    ).resolves.toBeTruthy();

    // Lock should be cleaned up after the write.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("audit log gets an entry for every concurrent successful write", async () => {
    const vault = new Vault({ root });
    const N = 5;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        vault.appendObservation({
          source: "audit-concurrency",
          tags: ["concurrent"],
          confidence: "low",
          body: `audit entry ${i}`,
        }),
      ),
    );

    const date = new Date().toISOString().slice(0, 10);
    const auditPath = path.join(root, "audit", `${date}.md`);
    const audit = await fsp.readFile(auditPath, "utf-8");

    // wb-save lines (audit-first ordering writes one before each data write).
    const auditLines = audit
      .split("\n")
      .filter((l) => l.includes("kind=wb-save"));
    expect(auditLines.length).toBe(N);
  });
});
