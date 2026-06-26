import { Vault, VaultError } from "./vault.js";

export interface BundleOptions {
  vault: Vault;
  includeObservations: number;
}

/** Read a vault file, treating OUT_OF_SCOPE as null (not an error). */
async function safeRead(vault: Vault, relativePath: string): Promise<string | null> {
  try {
    return await vault.readFile(relativePath);
  } catch (err) {
    if (err instanceof VaultError && err.code === "OUT_OF_SCOPE") return null;
    throw err;
  }
}

/**
 * Build the paste-in context bundle — the string a user prepends to any
 * agent that doesn't have a direct vault integration. Same shape as the
 * browser extension's `buildBootstrapText`.
 *
 * Returns null if the vault has no readable files at all (a sign that the
 * user pointed at the wrong directory).
 */
export async function buildBundle({
  vault,
  includeObservations,
}: BundleOptions): Promise<string | null> {
  await vault.ensureExists();

  const sections: Array<[string, string]> = [];

  const agents = await safeRead(vault, "AGENTS.md");
  if (agents) sections.push(["AGENTS.md", agents.trim()]);

  const identity = await safeRead(vault, "identity.md");
  if (identity) sections.push(["identity.md", identity.trim()]);

  const working = await safeRead(vault, "working-style.md");
  if (working) sections.push(["working-style.md", working.trim()]);

  if (includeObservations > 0) {
    const observations = await vault.readLatestObservations(includeObservations);
    if (observations) {
      sections.push([
        `Recent observations (last ${includeObservations})`,
        observations,
      ]);
    }
  }

  if (sections.length === 0) return null;

  const parts = [
    "<!-- whitebox-context: start -->",
    "Before responding, use this context about who I am. This was attached from my WhiteBox vault; it persists across every agent I use.",
    "",
  ];

  for (const [heading, content] of sections) {
    parts.push(`## From ${heading}`, "", content, "");
  }

  parts.push("<!-- whitebox-context: end -->", "", "My message follows:", "");

  return parts.join("\n");
}
