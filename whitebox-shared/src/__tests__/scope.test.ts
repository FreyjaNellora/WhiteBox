import { describe, it, expect } from "vitest";
import { parseScopes, checkInScope, canSourceAccess } from "../scope.js";

describe("parseScopes", () => {
  it("parses standard markdown list with em-dash", () => {
    const content = "- `coding` \u2014 src, lib";
    const result = parseScopes(content);
    expect(result).toEqual([{ name: "coding", includes: ["src", "lib"] }]);
  });

  it("parses hyphen separator", () => {
    const content = "- `writing` - docs";
    const result = parseScopes(content);
    expect(result).toEqual([{ name: "writing", includes: ["docs"] }]);
  });

  it("parses * bullet markers", () => {
    const content = "* `dev` \u2014 src, tests";
    const result = parseScopes(content);
    expect(result).toEqual([{ name: "dev", includes: ["src", "tests"] }]);
  });

  it("handles backtick-wrapped includes", () => {
    const content = "- `scope1` \u2014 `src`, `lib`";
    const result = parseScopes(content);
    expect(result).toEqual([{ name: "scope1", includes: ["src", "lib"] }]);
  });

  it("ignores blank lines and headers", () => {
    const content = "# Scopes\n\nSome description\n\n- `coding` \u2014 src\n\n";
    const result = parseScopes(content);
    expect(result).toEqual([{ name: "coding", includes: ["src"] }]);
  });

  it("returns empty array for empty content", () => {
    expect(parseScopes("")).toEqual([]);
  });

  it("parses multiple scopes", () => {
    const content = "- `a` \u2014 src\n- `b` \u2014 lib, docs";
    const result = parseScopes(content);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
    expect(result[1].includes).toEqual(["lib", "docs"]);
  });

  // --- Grants parsing (P1.5) ---

  it("parses grants segment after pipe", () => {
    const content = "- `coding-private` \u2014 observations, projects | grants: claude, cursor";
    const result = parseScopes(content);
    expect(result).toEqual([
      {
        name: "coding-private",
        includes: ["observations", "projects"],
        grants: ["claude", "cursor"],
      },
    ]);
  });

  it("parses grants with spaces around pipe", () => {
    const content = "- `work` \u2014 docs | grants: mcp:claude, cli:user";
    const result = parseScopes(content);
    expect(result[0].grants).toEqual(["mcp:claude", "cli:user"]);
  });

  it("is case-insensitive on 'grants:' keyword", () => {
    const content = "- `x` \u2014 src | GRANTS: a, b";
    const result = parseScopes(content);
    expect(result[0].grants).toEqual(["a", "b"]);
  });

  it("omits grants field when segment absent (backward-compat)", () => {
    const content = "- `open` \u2014 src, lib";
    const result = parseScopes(content);
    expect(result[0].grants).toBeUndefined();
    expect(result[0].includes).toEqual(["src", "lib"]);
  });

  it("ignores empty grants list (no grants field set)", () => {
    const content = "- `empty` \u2014 src | grants: ";
    const result = parseScopes(content);
    // Empty grants list → no grants field (same as backward-compat open)
    expect(result[0].grants).toBeUndefined();
  });

  it("still filters path escapes in includes when grants present", () => {
    const content = "- `bad` \u2014 src, ../secret, lib | grants: claude";
    const result = parseScopes(content);
    expect(result[0].includes).toEqual(["src", "lib"]);
    expect(result[0].grants).toEqual(["claude"]);
  });
});

describe("checkInScope", () => {
  it("matches exact path", () => {
    expect(checkInScope("src", ["src"])).toBe(true);
  });

  it("matches subdirectory", () => {
    expect(checkInScope("src/index.ts", ["src"])).toBe(true);
  });

  it("rejects non-matching path", () => {
    expect(checkInScope("lib/index.ts", ["src"])).toBe(false);
  });

  it("handles trailing slash in includes", () => {
    expect(checkInScope("docs/readme.md", ["docs/"])).toBe(true);
  });

  it("rejects partial name match (prefix-only)", () => {
    expect(checkInScope("src-backup/file.ts", ["src"])).toBe(false);
  });

  it("matches when any include matches", () => {
    expect(checkInScope("lib/utils.ts", ["src", "lib"])).toBe(true);
  });

  it("rejects when no includes match", () => {
    expect(checkInScope("other/file.ts", ["src", "lib"])).toBe(false);
  });
});

describe("canSourceAccess", () => {
  it("allows any source when grants is absent (backward-compat)", () => {
    const scope = { name: "open", includes: ["src"] };
    expect(canSourceAccess(scope, "mcp:claude")).toBe(true);
    expect(canSourceAccess(scope, "anyone")).toBe(true);
  });

  it("allows listed sources only when grants is present", () => {
    const scope = { name: "restricted", includes: ["secret"], grants: ["claude", "cursor"] };
    expect(canSourceAccess(scope, "claude")).toBe(true);
    expect(canSourceAccess(scope, "cursor")).toBe(true);
    expect(canSourceAccess(scope, "kimi")).toBe(false);
    expect(canSourceAccess(scope, "mcp:claude")).toBe(false); // exact match required
  });

  it("denies all sources when grants is empty array (explicit lock)", () => {
    const scope = { name: "locked", includes: ["private"], grants: [] };
    expect(canSourceAccess(scope, "claude")).toBe(false);
    expect(canSourceAccess(scope, "anyone")).toBe(false);
  });

  it("handles source identifiers with colons and hyphens", () => {
    const scope = { name: "work", includes: ["docs"], grants: ["mcp:claude", "cli:user-1"] };
    expect(canSourceAccess(scope, "mcp:claude")).toBe(true);
    expect(canSourceAccess(scope, "cli:user-1")).toBe(true);
    expect(canSourceAccess(scope, "mcp:kimi")).toBe(false);
  });
});
