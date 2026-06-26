import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { VaultBase } from "../vault-core.js";

let root: string;

const NOW = new Date("2026-04-26T12:00:00Z");

function mkObs(p: {
  date: string;
  source: string;
  tags: string[];
  body: string;
  confidence?: string;
}) {
  return [
    "```",
    "---",
    `date: ${p.date}`,
    `source: "${p.source}"`,
    `tags: [${p.tags.join(", ")}]`,
    `confidence: "${p.confidence ?? "high"}"`,
    "---",
    p.body,
    "```",
  ].join("\n");
}

function makeMonthFile(month: string, observations: string[]) {
  const header = `# Observations — ${month}\n\nAppend-only.\n\n---\n\n`;
  const body = observations.join("\n\n---\n\n");
  return header + body + "\n";
}

beforeEach(async () => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-aligned-"));
  await fs.mkdir(path.join(root, "observations"), { recursive: true });
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("readRoleAlignedObservations", () => {
  it("returns null when no observations exist", async () => {
    const vault = new VaultBase({ root });
    const result = await vault.readRoleAlignedObservations({
      source: "claude",
      maxEntries: 5,
    });
    expect(result).toBeNull();
  });

  it("prioritizes observations from the requesting source (own continuity)", async () => {
    const obs = [
      mkObs({ date: "2026-04-20", source: "kimi", tags: ["a"], body: "kimi entry 1" }),
      mkObs({ date: "2026-04-21", source: "kimi", tags: ["b"], body: "kimi entry 2" }),
      mkObs({ date: "2026-04-22", source: "claude", tags: ["c"], body: "CLAUDE OWN" }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    const result = await vault.readRoleAlignedObservations({
      source: "claude",
      maxEntries: 1,
      referenceDate: NOW,
    });
    // Claude's own observation should win the single slot even though it's recent for everyone
    expect(result).toContain("CLAUDE OWN");
  });

  it("includes cross-source corroborated entries when there's room", async () => {
    const obs = [
      // claude+kimi BOTH tag {coding, preference} — corroborated cluster
      mkObs({
        date: "2026-04-20",
        source: "claude",
        tags: ["coding", "preference"],
        body: "CORROBORATED CLAUDE",
      }),
      mkObs({
        date: "2026-04-21",
        source: "kimi",
        tags: ["coding", "preference"],
        body: "CORROBORATED KIMI",
      }),
      // chatgpt-only cluster {food} — not corroborated
      mkObs({
        date: "2026-04-22",
        source: "chatgpt",
        tags: ["food"],
        body: "SOLO CHATGPT",
      }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    // Asking from a SOURCE THAT HASN'T WRITTEN — gemini sees nothing of its own
    const result = await vault.readRoleAlignedObservations({
      source: "gemini",
      maxEntries: 2,
      referenceDate: NOW,
    });
    // Both corroborated entries should appear; the solo chatgpt one is lower priority
    expect(result).toContain("CORROBORATED");
    expect(result).not.toContain("SOLO CHATGPT");
  });

  it("returns observations in chronological order (oldest → newest)", async () => {
    const obs = [
      mkObs({ date: "2026-04-10", source: "claude", tags: ["x"], body: "OLDEST" }),
      mkObs({ date: "2026-04-20", source: "claude", tags: ["y"], body: "MIDDLE" }),
      mkObs({ date: "2026-04-25", source: "claude", tags: ["z"], body: "NEWEST" }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    const result = await vault.readRoleAlignedObservations({
      source: "claude",
      maxEntries: 3,
      referenceDate: NOW,
    });
    expect(result).not.toBeNull();
    const oldestIdx = result!.indexOf("OLDEST");
    const middleIdx = result!.indexOf("MIDDLE");
    const newestIdx = result!.indexOf("NEWEST");
    expect(oldestIdx).toBeGreaterThanOrEqual(0);
    expect(middleIdx).toBeGreaterThan(oldestIdx);
    expect(newestIdx).toBeGreaterThan(middleIdx);
  });

  it("respects maxEntries cap", async () => {
    const obs = Array.from({ length: 10 }, (_, i) =>
      mkObs({
        date: `2026-04-${10 + i}`,
        source: "claude",
        tags: [`tag-${i}`],
        body: `entry-${i}`,
      }),
    );
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    const result = await vault.readRoleAlignedObservations({
      source: "claude",
      maxEntries: 3,
      referenceDate: NOW,
    });
    // Count fenced blocks (each observation starts/ends with ```), not raw
    // --- separators (because YAML inside each entry also uses ---).
    const fenceCount = (result!.match(/^```\s*$/gm) || []).length;
    // Each observation is wrapped in opening + closing fence => 2 per obs
    expect(fenceCount).toBe(3 * 2);
  });

  it("recency acts as tiebreaker — newer wins between two own observations", async () => {
    const obs = [
      mkObs({ date: "2026-01-15", source: "claude", tags: ["x"], body: "JAN ENTRY" }),
      mkObs({ date: "2026-04-25", source: "claude", tags: ["y"], body: "APRIL ENTRY" }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    const result = await vault.readRoleAlignedObservations({
      source: "claude",
      maxEntries: 1,
      referenceDate: NOW,
    });
    // Both score 2.0 (own), then recency breaks tie → April wins
    expect(result).toContain("APRIL ENTRY");
    expect(result).not.toContain("JAN ENTRY");
  });
});
