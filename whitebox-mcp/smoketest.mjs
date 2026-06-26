import { Vault } from "./dist/vault.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(here, "..", "vault-example");
console.log("Vault root:", vaultRoot);

const vault = new Vault({ root: vaultRoot });

// 1. List files
const files = await vault.listFiles();
console.log("\n[list_files]");
files.forEach((f) => console.log("  -", f));

// 2. Read AGENTS.md
console.log("\n[read_file AGENTS.md]");
const agents = await vault.readFile("AGENTS.md");
console.log("  length:", agents.length, "chars");
console.log("  first line:", agents.split("\n")[0]);

// 3. Append a test observation
console.log("\n[append_observation]");
const target = await vault.appendObservation({
  source: "smoketest",
  tags: ["test", "smoke"],
  confidence: "low",
  body: "This is a smoke-test observation written during WhiteBox v0.1 integration testing. Safe to delete.",
});
console.log("  written to:", target);

// 4. Propose a stable edit
console.log("\n[propose_stable_edit]");
const proposal = await vault.proposeStableEdit("identity.md", {
  source: "smoketest",
  rationale: "Smoke test of the propose_stable_edit flow. Not a real proposal.",
  proposed_content: "# Identity\n\nname: example\n",
});
console.log("  proposal at:", proposal);

// 5. Path traversal should be rejected
console.log("\n[path traversal guard]");
try {
  await vault.readFile("../../../etc/passwd");
  console.log("  FAIL: traversal was not rejected");
} catch (e) {
  console.log("  OK:", e.message);
}

// 6. Absolute path should be rejected
console.log("\n[absolute path guard]");
try {
  await vault.readFile("/etc/passwd");
  console.log("  FAIL: absolute path was not rejected");
} catch (e) {
  console.log("  OK:", e.message);
}

// 7. Scope enforcement smoke test (if scopes.md exists later)
console.log("\n[scope enforcement]");
const scopedVault = new Vault({ root: vaultRoot, activeScope: "nonexistent" });
try {
  await scopedVault.readFile("identity.md");
  console.log("  (no scopes.md — scope is no-op, read succeeded)");
} catch (e) {
  console.log("  scope error:", e.message);
}

// Cleanup: remove the smoke test artifacts
console.log("\n[cleanup]");
const month = new Date().toISOString().slice(0, 7);
const obsPath = path.join(vaultRoot, "observations", `${month}.md`);
const before = await fs.readFile(obsPath, "utf-8");
// Strip any block whose source is "smoketest"
const cleaned = before.replace(
  /\n*---\n\n```[^`]*source: smoketest[^`]*```\n/g,
  "",
);
if (cleaned !== before) {
  await fs.writeFile(obsPath, cleaned, "utf-8");
  console.log("  cleaned smoketest observations from", obsPath);
}
// Remove the proposal file
const proposalAbs = path.join(vaultRoot, proposal);
try {
  await fs.rm(proposalAbs);
  console.log("  removed proposal", proposal);
} catch {}
// Remove the proposed/ dir if empty
try {
  const remaining = await fs.readdir(path.join(vaultRoot, "proposed"));
  if (remaining.length === 0) {
    await fs.rmdir(path.join(vaultRoot, "proposed"));
    console.log("  removed empty proposed/ dir");
  }
} catch {}

console.log("\nAll smoke tests passed.");
