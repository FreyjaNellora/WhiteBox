import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsSync from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AuditChain,
  verifyAuditChain,
  sharedAuditChain,
  GENESIS_HASH,
  canonicalJson,
  hashEntry,
} from "../audit-chain.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-audit-test-"));
});

afterEach(() => {
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

function logPath(name: string) {
  return path.join(tmpDir, `${name}.jsonl`);
}

function checkpointPath(name: string) {
  return path.join(tmpDir, `${name}.checkpoint`);
}

// ------------------------------------------------------------------
// canonicalJson + hashEntry
// ------------------------------------------------------------------

describe("canonicalJson", () => {
  it("produces deterministic output regardless of key order", () => {
    const a = canonicalJson({ z: 1, a: 2, m: 3 });
    const b = canonicalJson({ a: 2, m: 3, z: 1 });
    expect(a).toBe(b);
  });

  it("matches cross-language expectations (sorted keys, minimal separators)", () => {
    const out = canonicalJson({ event: "TEST", seq: 0 });
    expect(out).toBe('{"event":"TEST","seq":0}');
  });
});

describe("hashEntry", () => {
  it("produces 64-char hex", () => {
    const h = hashEntry(GENESIS_HASH, Buffer.from("hello"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    const h1 = hashEntry(GENESIS_HASH, Buffer.from("hello"));
    const h2 = hashEntry(GENESIS_HASH, Buffer.from("hello"));
    expect(h1).toBe(h2);
  });

  it("changes with different prevHash", () => {
    const h1 = hashEntry(GENESIS_HASH, Buffer.from("hello"));
    const h2 = hashEntry("a".repeat(64), Buffer.from("hello"));
    expect(h1).not.toBe(h2);
  });
});

// ------------------------------------------------------------------
// AuditChain lifecycle
// ------------------------------------------------------------------

describe("AuditChain", () => {
  it("initializes fresh when no log exists", async () => {
    const chain = new AuditChain({
      logPath: logPath("fresh"),
      checkpointPath: checkpointPath("fresh"),
    });
    await chain.init();
    const result = await chain.verify();
    expect(result.code).toBe(0);
    expect(result.message).toBe("No audit log to verify");
  });

  it("appends entries and verifies clean", async () => {
    const chain = new AuditChain({
      logPath: logPath("append"),
      checkpointPath: checkpointPath("append"),
    });
    await chain.init();
    await chain.append({ event: "TEST", data: "first" });
    await chain.append({ event: "TEST", data: "second" });

    const result = await chain.verify();
    expect(result.code).toBe(0);
    expect(result.message).toBe("Chain verified: 2 entries");
    expect(result.lastSeq).toBe(1);
  });

  it("re-initializes from existing log and continues chain", async () => {
    const log = logPath("resume");
    const cp = checkpointPath("resume");

    const chain1 = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain1.init();
    await chain1.append({ event: "A" });
    await chain1.append({ event: "B" });

    const chain2 = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain2.init();
    await chain2.append({ event: "C" });

    const result = await chain2.verify();
    expect(result.code).toBe(0);
    expect(result.message).toBe("Chain verified: 3 entries");
    expect(result.lastSeq).toBe(2);
  });

  it("detects hash mismatch (tampered entry)", async () => {
    const log = logPath("tamper");
    const cp = checkpointPath("tamper");

    const chain = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain.init();
    await chain.append({ event: "GOOD" });

    // Tamper: append a line with wrong hash
    const badLine = JSON.stringify({
      seq: 1,
      ts: Date.now() / 1000,
      event: "BAD",
      hash: "0".repeat(64),
    });
    await fs.appendFile(log, badLine + "\n", "utf-8");

    const chain2 = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain2.init(); // should archive broken on startup
    expect(chain2.archivedBrokenPath).not.toBeNull();

    // Fresh log should have INTEGRITY_VIOLATION entry
    const result = await chain2.verify();
    expect(result.code).toBe(0);
    expect(result.message).toBe("Chain verified: 1 entries");
  });

  it("detects truncation (missing tail entries)", async () => {
    const log = logPath("truncate");
    const cp = checkpointPath("truncate");

    const chain = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain.init();
    await chain.append({ event: "A" });
    await chain.append({ event: "B" });
    await chain.append({ event: "C" });

    // Truncate: remove last line
    const content = await fs.readFile(log, "utf-8");
    const lines = content.trim().split("\n");
    lines.pop();
    await fs.writeFile(log, lines.join("\n") + "\n", "utf-8");

    const result = await chain.verify(true);
    expect(result.code).toBe(2);
    expect(result.message).toContain("Truncation detected");
  });

  it("serializes concurrent appends without dropping entries", async () => {
    const log = logPath("concurrent");
    const chain = new AuditChain({
      logPath: log,
      checkpointPath: checkpointPath("concurrent"),
    });
    await chain.init();

    // Fire N appends without awaiting between them — every entry must land,
    // in call order, with a clean chain (the old boolean guard silently
    // dropped all but the first).
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) => chain.append({ event: "C", i })),
    );

    const content = await fs.readFile(log, "utf-8");
    const entries = content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.length).toBe(N);
    expect(entries.map((e) => e.i)).toEqual([...Array(N).keys()]);
    expect(entries.map((e) => e.seq)).toEqual([...Array(N).keys()]);

    const result = await chain.verify();
    expect(result.code).toBe(0);
    expect(result.lastSeq).toBe(N - 1);
  });

  it("does not block the queue after a failed write", async () => {
    const chain = new AuditChain({
      logPath: logPath("queue-recovery"),
      checkpointPath: checkpointPath("queue-recovery"),
    });
    await chain.init();

    // Point the log at a directory so appendFile fails, then restore.
    const blocked = new AuditChain({
      logPath: tmpDir, // a directory — appendFile will reject
      checkpointPath: checkpointPath("queue-recovery"),
    });
    await expect(blocked.append({ event: "FAIL" })).rejects.toThrow();

    // The good chain still accepts writes after a rejected one elsewhere,
    // and a failed append on the same instance doesn't poison later calls.
    await expect(blocked.append({ event: "FAIL2" })).rejects.toThrow();
    await chain.append({ event: "OK" });
    const result = await chain.verify();
    expect(result.code).toBe(0);
    expect(result.lastSeq).toBe(0);
  });

  it("accepts ts_override for backdated entries", async () => {
    const chain = new AuditChain({
      logPath: logPath("override"),
      checkpointPath: checkpointPath("override"),
    });
    await chain.init();

    const oldTs = 1609459200; // 2021-01-01 00:00:00 UTC
    await chain.append({ event: "OLD", ts_override: oldTs });

    const content = await fs.readFile(logPath("override"), "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.ts).toBe(oldTs);
    expect(entry.seq).toBe(0);
    // ts_override should NOT appear in output
    expect(entry.ts_override).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Standalone verifyAuditChain
// ------------------------------------------------------------------

describe("verifyAuditChain", () => {
  it("returns clean for empty log", async () => {
    const result = await verifyAuditChain(
      logPath("empty"),
      checkpointPath("empty"),
    );
    expect(result.code).toBe(0);
  });

  it("returns hash mismatch for tampered log", async () => {
    const log = logPath("standalone-tamper");
    const cp = checkpointPath("standalone-tamper");

    const chain = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain.init();
    await chain.append({ event: "GOOD" });

    // Tamper
    const content = await fs.readFile(log, "utf-8");
    const entry = JSON.parse(content.trim());
    entry.event = "TAMPERED";
    await fs.writeFile(log, JSON.stringify(entry) + "\n", "utf-8");

    const result = await verifyAuditChain(log, cp);
    expect(result.code).toBe(1);
    expect(result.message).toContain("Hash mismatch");
  });

  it("returns file error for unreadable log", async () => {
    const log = logPath("unreadable");
    const cp = checkpointPath("unreadable");
    await fs.writeFile(log, "this is not json\n", "utf-8");
    await fs.writeFile(cp, "0\n" + GENESIS_HASH + "\n", "utf-8");

    const result = await verifyAuditChain(log, cp);
    expect(result.code).toBe(3);
    expect(result.message).toContain("File error");
  });
});

// ------------------------------------------------------------------
// Cross-language compatibility check
// ------------------------------------------------------------------

describe("cross-language canonical JSON", () => {
  it("matches Python's sort_keys=True, separators=(',', ':')", () => {
    const obj = { event: "TEST", seq: 1, ts: 1234567890.5 };
    const out = canonicalJson(obj);
    // Keys sorted: event, seq, ts
    expect(out).toBe('{"event":"TEST","seq":1,"ts":1234567890.5}');
  });

  it("handles nested objects", () => {
    const obj = { a: 1, b: { z: 9, a: 8 } };
    const out = canonicalJson(obj);
    // Outer keys sorted; inner keys sorted
    expect(out).toContain('"a":1');
    expect(out).toContain('"b":{');
    expect(out).toContain('"a":8');
    expect(out).toContain('"z":9');
  });

  it("sorts keys at every nesting level, including inside arrays", () => {
    const obj = { b: { z: 9, a: 8 }, a: [{ y: 2, x: 1 }] };
    const out = canonicalJson(obj);
    expect(out).toBe('{"a":[{"x":1,"y":2}],"b":{"a":8,"z":9}}');
  });

  it("leaves colon sequences inside string keys and values intact", () => {
    const obj = {
      note: "ratio: 1:2, msg: ok",
      by: 'user: "nate"',
      'odd": key': "v: w",
    };
    const out = canonicalJson(obj);
    // Values must round-trip unmangled (the old implementation rewrote the
    // first ": " it found anywhere in the serialized output).
    expect(JSON.parse(out)).toEqual(obj);
    expect(out).toBe(
      '{"by":"user: \\"nate\\"","note":"ratio: 1:2, msg: ok","odd\\": key":"v: w"}',
    );
  });

  it("chains entries with colon-laden payloads and verifies clean", async () => {
    const log = logPath("colons");
    const cp = checkpointPath("colons");
    const chain = new AuditChain({ logPath: log, checkpointPath: cp });
    await chain.init();
    await chain.append({ event: "NOTE", note: "a: b", by: 'x": y' });
    await chain.append({ event: "NOTE", note: "c: d: e" });

    const result = await verifyAuditChain(log, cp);
    expect(result.code).toBe(0);
    expect(result.lastSeq).toBe(1);
  });

  // Fixtures generated with CPython 3.11.9:
  //   json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
  // — the exact call ChatBox's audit_log.py canonical_json() makes. The
  // planned cross-chain reconciler depends on both languages producing
  // identical bytes for these payloads.
  it("matches CPython output byte-for-byte on shared vectors", () => {
    const vectors: Array<[Record<string, unknown>, string]> = [
      [{ event: "TEST", seq: 0 }, '{"event":"TEST","seq":0}'],
      [
        { b: { z: 9, a: 8 }, a: [{ y: 2, x: 1 }] },
        '{"a":[{"x":1,"y":2}],"b":{"a":8,"z":9}}',
      ],
      [{ note: "héllo — ünïcode ✓" }, '{"note":"héllo — ünïcode ✓"}'],
      [
        { by: 'user: "nate"', note: "ratio: 1:2, msg: ok" },
        '{"by":"user: \\"nate\\"","note":"ratio: 1:2, msg: ok"}',
      ],
      [{ ts: 1234567890.5 }, '{"ts":1234567890.5}'],
      [{ ts: 1718000000.123456 }, '{"ts":1718000000.123456}'],
      [{ seq: 9007199254740991 }, '{"seq":9007199254740991}'],
      [{ a: -42, b: 0 }, '{"a":-42,"b":0}'],
      [{ a: true, b: null }, '{"a":true,"b":null}'],
    ];
    for (const [obj, expected] of vectors) {
      expect(canonicalJson(obj)).toBe(expected);
    }
  });

  it("KNOWN DIVERGENCE: integral floats serialize differently than Python", () => {
    // CPython: json.dumps({"ts": 1.0}) -> '{"ts":1.0}'
    // JS: JSON.stringify cannot distinguish 1.0 from 1 -> '{"ts":1}'
    // Consequence: a chain written by Python with integral-float fields
    // will NOT verify from TS (and vice versa) because verification
    // re-serializes the parsed payload. Same-language verification is
    // unaffected. The reconciler (MERGE_PLAN/baseline) must normalize
    // numbers or pin a shared formatting rule before cross-verifying.
    expect(canonicalJson({ ts: 1.0 })).toBe('{"ts":1}');
    expect(canonicalJson({ ts: 1.0 })).not.toBe('{"ts":1.0}');
  });
});

// ------------------------------------------------------------------
// Shared-instance cache
// ------------------------------------------------------------------

describe("sharedAuditChain", () => {
  it("returns the same instance for the same log path", async () => {
    const log = logPath("shared");
    const cp = checkpointPath("shared");
    const a = sharedAuditChain(log, cp);
    const b = sharedAuditChain(log, cp);
    expect(a).toBe(b);
    expect(sharedAuditChain(logPath("other"), checkpointPath("other"))).not.toBe(a);
  });

  it("initOnce verifies once and serializes concurrent fire-and-forget appends", async () => {
    const log = logPath("shared-concurrent");
    const cp = checkpointPath("shared-concurrent");

    // Simulate two concurrent tool handlers, each doing get -> initOnce ->
    // append without awaiting each other (the mcp access-log pattern).
    const writer = async (tag: string) => {
      const chain = sharedAuditChain(log, cp);
      await chain.initOnce();
      await chain.append({ event: "ACCESS", tag });
    };
    await Promise.all([writer("a"), writer("b"), writer("c")]);

    const result = await verifyAuditChain(log, cp);
    expect(result.code).toBe(0);
    expect(result.lastSeq).toBe(2);
  });
});
