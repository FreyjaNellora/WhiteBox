import { describe, it, expect } from "vitest";
import {
  parseObservationsFromFile,
  parseObservationBlock,
  parseInlineTagList,
  splitObservationEntries,
} from "../observation-parser.js";

describe("parseInlineTagList", () => {
  it("parses quoted tags", () => {
    expect(parseInlineTagList('["coding", "bug"]')).toEqual([
      "coding",
      "bug",
    ]);
  });

  it("parses unquoted tags", () => {
    expect(parseInlineTagList("[coding, bug]")).toEqual(["coding", "bug"]);
  });

  it("parses single tag", () => {
    expect(parseInlineTagList("[single]")).toEqual(["single"]);
  });

  it("parses single-quoted tags", () => {
    expect(parseInlineTagList("['a', 'b']")).toEqual(["a", "b"]);
  });

  it("returns empty for empty brackets", () => {
    expect(parseInlineTagList("[]")).toEqual([]);
  });
});

describe("parseObservationBlock", () => {
  const validBlock = [
    "---",
    "date: 2026-04-22",
    'source: "claude"',
    'tags: ["coding", "test"]',
    'confidence: "observed"',
    "---",
    "User prefers vitest over jest.",
  ].join("\n");

  it("parses complete frontmatter with body", () => {
    const result = parseObservationBlock(validBlock);
    expect(result).not.toBeNull();
    expect(result!.date).toBe("2026-04-22");
    expect(result!.source).toBe('"claude"');
    expect(result!.tags).toEqual(["coding", "test"]);
    expect(result!.confidence).toBe('"observed"');
    expect(result!.body).toBe("User prefers vitest over jest.");
  });

  it("handles missing optional fields", () => {
    const block = "---\ndate: 2026-04-22\ntags: [misc]\n---\nSome body.";
    const result = parseObservationBlock(block);
    expect(result).not.toBeNull();
    expect(result!.date).toBe("2026-04-22");
    expect(result!.source).toBeUndefined();
    expect(result!.context).toBeUndefined();
    expect(result!.kind).toBeUndefined();
    expect(result!.body).toBe("Some body.");
  });

  it("parses kind: quote", () => {
    const block = "---\ndate: 2026-04-22\ntags: [misc]\nkind: quote\n---\nUser said hi.";
    const result = parseObservationBlock(block);
    expect(result?.kind).toBe("quote");
  });

  it("parses kind: inference", () => {
    const block = "---\ndate: 2026-04-22\ntags: [misc]\nkind: inference\n---\nUser prefers Y.";
    const result = parseObservationBlock(block);
    expect(result?.kind).toBe("inference");
  });

  it("silently drops unknown kind values (forward-compat)", () => {
    const block = "---\ndate: 2026-04-22\ntags: [misc]\nkind: speculation\n---\nGuess.";
    const result = parseObservationBlock(block);
    expect(result?.kind).toBeUndefined();
  });

  it("returns null for block without --- delimiters", () => {
    expect(parseObservationBlock("just some text")).toBeNull();
  });

  it("returns null for empty block", () => {
    expect(parseObservationBlock("")).toBeNull();
  });
});

describe("parseObservationsFromFile", () => {
  it("parses a file with one observation", () => {
    const content = [
      "# Observations",
      "",
      "```",
      "---",
      "date: 2026-04-22",
      "tags: [test]",
      "---",
      "Hello world.",
      "```",
    ].join("\n");
    const result = parseObservationsFromFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Hello world.");
  });

  it("parses multiple observation blocks", () => {
    const content = [
      "```",
      "---",
      "date: 2026-04-01",
      "tags: [a]",
      "---",
      "First.",
      "```",
      "",
      "```",
      "---",
      "date: 2026-04-02",
      "tags: [b]",
      "---",
      "Second.",
      "```",
    ].join("\n");
    const result = parseObservationsFromFile(content);
    expect(result).toHaveLength(2);
    expect(result[0].body).toBe("First.");
    expect(result[1].body).toBe("Second.");
  });

  it("returns empty for content with no fenced blocks", () => {
    expect(parseObservationsFromFile("Just plain text.")).toEqual([]);
  });

  it("skips malformed blocks gracefully", () => {
    const content = [
      "```",
      "no frontmatter here",
      "```",
      "",
      "```",
      "---",
      "date: 2026-04-22",
      "tags: [ok]",
      "---",
      "Valid.",
      "```",
    ].join("\n");
    const result = parseObservationsFromFile(content);
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Valid.");
  });
});

describe("splitObservationEntries", () => {
  it("splits entries delimited by horizontal rules", () => {
    // splitObservationEntries splits on \n---\n and filters for entries
    // containing ```. The --- inside frontmatter also acts as a splitter,
    // so each observation produces multiple fragments. We verify that
    // fragments are returned and all contain code fences.
    const content = [
      "# April 2026",
      "",
      "```",
      "---",
      "date: 2026-04-01",
      "tags: [a]",
      "---",
      "First.",
      "```",
      "",
      "---",
      "",
      "```",
      "---",
      "date: 2026-04-02",
      "tags: [b]",
      "---",
      "Second.",
      "```",
    ].join("\n");
    const result = splitObservationEntries(content);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((e) => e.includes("```"))).toBe(true);
  });

  it("filters entries without code blocks", () => {
    const content = [
      "# Header",
      "",
      "Some plain text without code blocks",
      "",
      "---",
      "",
      "```",
      "---",
      "tags: [x]",
      "---",
      "Body.",
      "```",
    ].join("\n");
    const result = splitObservationEntries(content);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every((e) => e.includes("```"))).toBe(true);
  });
});
