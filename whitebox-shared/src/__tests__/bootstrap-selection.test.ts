import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { VaultBase } from "../vault-core.js";
import { writeSynthesis } from "../synthesis.js";

let root: string;

const NOW = new Date("2026-04-26T12:00:00Z");

function mkObs(p: {
  date: string;
  source: string;
  tags: string[];
  body: string;
}) {
  return [
    "```",
    "---",
    `date: ${p.date}`,
    `source: "${p.source}"`,
    `tags: [${p.tags.join(", ")}]`,
    `confidence: "high"`,
    "---",
    p.body,
    "```",
  ].join("\n");
}

function makeMonthFile(month: string, observations: string[]) {
  const header = `# Observations — ${month}\n\nAppend-only.\n\n---\n\n`;
  return header + observations.join("\n\n---\n\n") + "\n";
}

beforeEach(async () => {
  root = fsSync.mkdtempSync(path.join(os.tmpdir(), "wb-bootstrap-sel-"));
  await fs.mkdir(path.join(root, "observations"), { recursive: true });
});

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true });
});

describe("readBootstrapContent — empty vault", () => {
  it("returns null content with observations tier when nothing exists", async () => {
    const vault = new VaultBase({ root });
    const result = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
    });
    expect(result.tier).toBe("observations");
    expect(result.content).toBeNull();
    expect(result.synthesis).toBeNull();
    expect(result.reason).toContain("no synthesis");
  });
});

describe("readBootstrapContent — observations only (no synthesis)", () => {
  it("falls back to role-aligned observations", async () => {
    const obs = [
      mkObs({ date: "2026-04-25", source: "claude", tags: ["a"], body: "OBS_BODY" }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );
    const vault = new VaultBase({ root });
    const result = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
    });
    expect(result.tier).toBe("observations");
    expect(result.content).toContain("OBS_BODY");
    expect(result.synthesis).toBeNull();
  });
});

describe("readBootstrapContent — fresh synthesis preferred", () => {
  it("returns the synthesis body when one exists and is within freshness window", async () => {
    // Write a synthesis dated yesterday
    const yesterday = new Date(NOW.getTime() - 86_400_000);
    await writeSynthesis(root, {
      synthesized_by: ["claude", "kimi"],
      derived_from: ["observations/2026-04.md#0"],
      version: 1,
      body: "SYNTHESIZED_PROFILE_BODY",
      date: yesterday.toISOString().slice(0, 10),
    });
    // Also write some observations — they should be ignored when synthesis is fresh
    const obs = [
      mkObs({ date: "2026-04-25", source: "claude", tags: ["a"], body: "OBS_BODY" }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );

    const vault = new VaultBase({ root });
    const result = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
    });
    expect(result.tier).toBe("synthesis");
    expect(result.content).toContain("SYNTHESIZED_PROFILE_BODY");
    expect(result.content).not.toContain("OBS_BODY");
    expect(result.synthesis?.version).toBe(1);
    expect(result.reason).toContain("within");
  });
});

describe("readBootstrapContent — stale synthesis falls back to observations", () => {
  it("uses observations when synthesis is older than freshness window", async () => {
    // Synthesis dated 60 days ago — way outside default 30-day window
    const longAgo = new Date(NOW.getTime() - 60 * 86_400_000);
    await writeSynthesis(root, {
      synthesized_by: ["claude"],
      derived_from: [],
      version: 1,
      body: "OLD_SYNTHESIS_BODY",
      date: longAgo.toISOString().slice(0, 10),
    });
    // Need to backdate the synthesized_at field too — writeSynthesis sets
    // it to now() regardless of `date`. We patch it directly.
    const synthFile = path.join(
      root,
      "synthesized",
      `profile-${longAgo.toISOString().slice(0, 10)}.md`,
    );
    let content = await fs.readFile(synthFile, "utf-8");
    content = content.replace(
      /synthesized_at: .*/,
      `synthesized_at: ${longAgo.toISOString()}`,
    );
    await fs.writeFile(synthFile, content);

    const obs = [
      mkObs({
        date: "2026-04-25",
        source: "claude",
        tags: ["x"],
        body: "FRESH_OBS_BODY",
      }),
    ];
    await fs.writeFile(
      path.join(root, "observations", "2026-04.md"),
      makeMonthFile("April 2026", obs),
    );

    const vault = new VaultBase({ root });
    const result = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
    });
    expect(result.tier).toBe("observations");
    expect(result.content).toContain("FRESH_OBS_BODY");
    expect(result.synthesis?.version).toBe(1); // still surfaced even when stale
    expect(result.reason).toContain("stale");
  });

  it("custom freshnessDays controls the threshold", async () => {
    // Synthesis dated 10 days ago — within default 30 but outside custom 5
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000);
    await writeSynthesis(root, {
      synthesized_by: ["claude"],
      derived_from: [],
      version: 1,
      body: "TEN_DAY_OLD_SYNTH",
      date: tenDaysAgo.toISOString().slice(0, 10),
    });
    const synthFile = path.join(
      root,
      "synthesized",
      `profile-${tenDaysAgo.toISOString().slice(0, 10)}.md`,
    );
    let content = await fs.readFile(synthFile, "utf-8");
    content = content.replace(
      /synthesized_at: .*/,
      `synthesized_at: ${tenDaysAgo.toISOString()}`,
    );
    await fs.writeFile(synthFile, content);

    const vault = new VaultBase({ root });
    // Default 30-day window: synthesis is fresh
    const def = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
    });
    expect(def.tier).toBe("synthesis");
    // Custom 5-day window: synthesis is stale
    const tight = await vault.readBootstrapContent({
      source: "claude",
      referenceDate: NOW,
      freshnessDays: 5,
    });
    expect(tight.tier).toBe("observations");
  });
});
