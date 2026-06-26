import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultBase } from "../vault-core.js";

// MEM-2: scope `grants:` are ENFORCED when the vault is constructed with a
// pinned source identity, and remain ADVISORY (unchanged) when it is not.
describe("VaultBase scope grants enforcement (MEM-2)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-mem2-"));
    await fs.writeFile(
      path.join(root, "scopes.md"),
      // open scope (no grants) + restricted scope (granted only to mcp:claude)
      "- `shared` — observations\n" +
        "- `private` — secret | grants: mcp:claude\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("open scope (no grants) is accessible regardless of pinned source", async () => {
    const v = new VaultBase({ root, scope: "shared", source: "mcp:kimi" });
    expect(await v.isInScope("observations/2026-06.md")).toBe(true);
  });

  it("granted scope DENIES a non-granted pinned source", async () => {
    const denied = new VaultBase({ root, scope: "private", source: "mcp:kimi" });
    expect(await denied.isInScope("secret/notes.md")).toBe(false);
  });

  it("granted scope ALLOWS the granted pinned source", async () => {
    const allowed = new VaultBase({ root, scope: "private", source: "mcp:claude" });
    expect(await allowed.isInScope("secret/notes.md")).toBe(true);
  });

  it("grants stay advisory (not enforced) when no source is pinned", async () => {
    const v = new VaultBase({ root, scope: "private" }); // no source
    expect(await v.isInScope("secret/notes.md")).toBe(true);
  });

  it("a path outside the scope's includes is still out of scope", async () => {
    const allowed = new VaultBase({ root, scope: "private", source: "mcp:claude" });
    expect(await allowed.isInScope("observations/2026-06.md")).toBe(false);
  });
});
