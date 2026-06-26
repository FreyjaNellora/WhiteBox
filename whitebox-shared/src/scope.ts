import path from "node:path";

export interface ScopeDefinition {
  name: string;
  includes: string[];
  /** Optional list of source identifiers granted access to this scope.
   *  If absent, the scope is accessible to all sources (backward-compatible).
   *  If present, only listed sources may read files within this scope. */
  grants?: string[];
}

/**
 * Parse a scopes.md file into structured scope definitions.
 * Each line is a markdown list item:
 *   `- \`name\` — dir1, dir2`
 *   `- \`name\` — dir1, dir2 | grants: src1, src2`
 *
 * The optional `| grants: <src,...>` segment restricts which sources can
 * access files within this scope. If absent, all sources have access
 * (backward-compatible behavior).
 */
export function parseScopes(content: string): ScopeDefinition[] {
  const lines = content.split(/\r?\n/);
  const scopes: ScopeDefinition[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const match = line.match(/^[-*]\s*`([^`]+)`\s*[\u2014\-]\s*(.+)$/);
    if (!match) continue;
    const [, name, rawSpec] = match;

    // Split off the optional grants segment: "includes | grants: src1, src2"
    const grantsMatch = rawSpec.match(/^(.*)\|\s*grants:\s*(.+)$/i);
    const spec = grantsMatch ? grantsMatch[1].trimEnd() : rawSpec;
    const grants = grantsMatch
      ? grantsMatch[2]
          .split(/[,+]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;

    const includes = spec
      .split(/[,+]/)
      .map((s) => s.trim().replace(/`/g, ""))
      .filter((s) => s.length > 0)
      // Reject scope entries that escape the vault: absolute paths, leading
      // `..`, or any traversal segment. A scope is meant to RESTRICT access,
      // not grant it outside the vault. Silently dropping is safer than
      // throwing because scopes.md may be hand-edited.
      .filter((s) => {
        if (path.isAbsolute(s)) return false;
        const normalized = path.normalize(s);
        if (normalized.startsWith("..")) return false;
        if (normalized.split(/[\\/]/).includes("..")) return false;
        return true;
      });
    if (includes.length > 0) {
      const def: ScopeDefinition = { name, includes };
      if (grants && grants.length > 0) def.grants = grants;
      scopes.push(def);
    }
  }
  return scopes;
}

/**
 * Check whether a relative path falls within a scope's include list.
 * Pure function — caller is responsible for loading scopes and finding
 * the active scope's includes.
 */
export function checkInScope(relativePath: string, includes: string[]): boolean {
  const normalized = path.normalize(relativePath).split(path.sep).join("/");
  return includes.some((included) => {
    const inc = included.replace(/\/$/, "");
    return normalized === inc || normalized.startsWith(`${inc}/`);
  });
}

/**
 * Check whether a given source identifier is granted access to a scope.
 *
 * Rules:
 *   - If the scope has no `grants` field, ALL sources have access
 *     (backward-compatible — existing scopes.md without grants remain open).
 *   - If `grants` is present and non-empty, ONLY listed sources have access.
 *   - An empty `grants` array means NO source has access (deny-by-default
 *     for explicitly restricted scopes).
 *
 * Source identifiers should match the convention used in observations:
 * e.g. "mcp:claude", "mcp:kimi", "cli:user", "extension:chrome".
 */
export function canSourceAccess(
  scope: ScopeDefinition,
  source: string,
): boolean {
  if (!scope.grants || scope.grants.length === 0) {
    // No grants field = backward-compatible open access
    // Empty grants array = deny all (explicitly locked)
    return scope.grants === undefined;
  }
  return scope.grants.includes(source);
}
