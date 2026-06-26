import { describe, it, expect } from "vitest";
import {
  search,
  bm25Score,
  buildCorpusStats,
  tagJaccard,
  tokenize,
  DEFAULT_WEIGHTS,
} from "../search.js";
import type { ParsedObservation } from "../observation-parser.js";

const NOW = new Date("2026-04-26T12:00:00Z");

function obs(p: Partial<ParsedObservation>): ParsedObservation {
  return {
    date: NOW.toISOString(),
    source: "claude",
    confidence: "high",
    tags: ["preference"],
    body: "test body",
    ...p,
  };
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe("tokenize", () => {
  it("lowercases and splits on non-word characters", () => {
    expect(tokenize("Hello, World!")).toEqual(["hello", "world"]);
  });
  it("drops single-char tokens", () => {
    expect(tokenize("a big cat")).toEqual(["big", "cat"]);
  });
  it("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("tagJaccard", () => {
  it("returns 1.0 for identical tag sets", () => {
    expect(tagJaccard(["a", "b"], ["a", "b"])).toBe(1);
  });
  it("returns 0 when one set is empty", () => {
    expect(tagJaccard([], ["a"])).toBe(0);
    expect(tagJaccard(["a"], [])).toBe(0);
  });
  it("computes intersection / union correctly", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} (size 2); union size 4 → 0.5
    expect(tagJaccard(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
  });
  it("is case-insensitive", () => {
    expect(tagJaccard(["Coding"], ["coding"])).toBe(1);
  });
});

describe("bm25Score", () => {
  it("returns 0 when no query terms appear in doc", () => {
    const stats = buildCorpusStats([
      obs({ body: "hello world" }),
      obs({ body: "another doc" }),
    ]);
    const score = bm25Score(["hello", "world"], ["typescript"], stats);
    expect(score).toBe(0);
  });
  it("returns positive score when query terms hit", () => {
    const stats = buildCorpusStats([
      obs({ body: "i prefer typescript over javascript" }),
      obs({ body: "i love python" }),
      obs({ body: "rust is fun" }),
    ]);
    const docTokens = stats.tokensPerDoc[0];
    const score = bm25Score(docTokens, ["typescript"], stats);
    expect(score).toBeGreaterThan(0);
  });
  it("rewards rarer terms more (IDF)", () => {
    // 'typescript' appears in 1 of 3 docs; 'love' in 2 of 3
    const stats = buildCorpusStats([
      obs({ body: "love typescript" }),
      obs({ body: "love javascript" }),
      obs({ body: "love rust" }),
    ]);
    const tsScore = bm25Score(stats.tokensPerDoc[0], ["typescript"], stats);
    const loveScore = bm25Score(stats.tokensPerDoc[0], ["love"], stats);
    expect(tsScore).toBeGreaterThan(loveScore);
  });
});

describe("search — composition", () => {
  const corpus: ParsedObservation[] = [
    obs({
      body: "user prefers typescript for new projects",
      tags: ["preference", "coding"],
      source: "claude",
      date: daysAgo(0),
    }),
    obs({
      body: "user said typescript is more maintainable",
      tags: ["preference", "coding"],
      source: "kimi",
      date: daysAgo(2),
    }),
    obs({
      body: "user mentioned vegetarian diet",
      tags: ["preference", "food"],
      source: "claude",
      date: daysAgo(60),
    }),
    obs({
      body: "user works in IP law primarily",
      tags: ["work", "identity"],
      source: "chatgpt",
      date: daysAgo(10),
    }),
  ];

  it("returns ranked results matching query terms", () => {
    const results = search(corpus, {
      query: "typescript",
      referenceDate: NOW,
      limit: 5,
    });
    expect(results.length).toBe(2);
    expect(results[0].observation.body).toContain("typescript");
    // Ordered by total score, desc
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("respects limit", () => {
    const results = search(corpus, {
      query: "user",
      referenceDate: NOW,
      limit: 2,
    });
    expect(results.length).toBe(2);
  });

  it("returns empty when query matches nothing", () => {
    const results = search(corpus, {
      query: "xyzzy nonsense",
      referenceDate: NOW,
    });
    expect(results).toEqual([]);
  });

  it("filters by required tags (AND semantics)", () => {
    const results = search(corpus, {
      query: "user",
      requireTags: ["food"],
      referenceDate: NOW,
    });
    expect(results.length).toBe(1);
    expect(results[0].observation.tags).toContain("food");
  });

  it("ranks by tag jaccard when queryTags supplied", () => {
    const results = search(corpus, {
      queryTags: ["preference", "coding"],
      referenceDate: NOW,
    });
    // Two observations have exactly {preference, coding}; both get jaccard=1.
    // The vegetarian one has {preference, food} — jaccard = 1/3.
    expect(results.length).toBeGreaterThanOrEqual(2);
    const top = results.slice(0, 2).map((r) => r.observation.tags.sort().join(","));
    expect(top.every((t) => t === "coding,preference")).toBe(true);
  });

  it("filters by source", () => {
    const results = search(corpus, {
      query: "user",
      sources: ["chatgpt"],
      referenceDate: NOW,
    });
    expect(results.length).toBe(1);
    expect(results[0].observation.source).toBe("chatgpt");
  });

  it("filters by dateAfter", () => {
    const results = search(corpus, {
      query: "user",
      dateAfter: daysAgo(15),
      referenceDate: NOW,
    });
    // Should exclude the 60-days-ago vegetarian observation
    expect(results.every((r) => r.observation.body.includes("vegetarian") === false)).toBe(true);
  });

  it("recency penalizes old observations", () => {
    const results = search(corpus, {
      query: "user",
      referenceDate: NOW,
      weights: { ...DEFAULT_WEIGHTS, recency: 5.0 }, // amplify recency signal
    });
    // The 60-day-old observation should rank below the recent ones
    const oldIdx = results.findIndex((r) =>
      r.observation.body.includes("vegetarian"),
    );
    const recentIdx = results.findIndex((r) =>
      r.observation.body.includes("typescript"),
    );
    if (oldIdx >= 0 && recentIdx >= 0) {
      expect(recentIdx).toBeLessThan(oldIdx);
    }
  });

  it("pheromone signal boosts items with high access counts", () => {
    const accessCounts = corpus.map((_, i) => (i === 2 ? 100 : 0)); // boost vegetarian obs
    const results = search(corpus, {
      query: "user",
      referenceDate: NOW,
      accessCounts,
      weights: { ...DEFAULT_WEIGHTS, pheromone: 5.0 }, // amplify pheromone
    });
    expect(results[0].observation.body).toContain("vegetarian");
  });

  it("provides score breakdown with all terms", () => {
    const results = search(corpus, {
      query: "typescript",
      queryTags: ["coding"],
      referenceDate: NOW,
    });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(r.breakdown).toMatchObject({
      text: expect.any(Number),
      tags: expect.any(Number),
      recency: expect.any(Number),
      pheromone: expect.any(Number),
      corroboration: expect.any(Number),
      total: expect.any(Number),
    });
    // total == sum of components
    const sum =
      r.breakdown.text +
      r.breakdown.tags +
      r.breakdown.recency +
      r.breakdown.pheromone +
      r.breakdown.corroboration;
    expect(r.breakdown.total).toBeCloseTo(sum, 6);
  });

  it("corroboration bonus fires when tag-cluster has multiple sources", () => {
    // The {preference, coding} cluster has both claude and kimi → bonus
    // The {preference, food} cluster has only claude → no bonus
    const results = search(corpus, {
      queryTags: ["preference"],
      referenceDate: NOW,
      weights: {
        ...DEFAULT_WEIGHTS,
        text: 0,
        tags: 0,
        recency: 0,
        pheromone: 0,
        corroboration: 1,
      },
    });
    const codingResults = results.filter((r) =>
      r.observation.tags.includes("coding"),
    );
    const foodResults = results.filter((r) =>
      r.observation.tags.includes("food"),
    );
    for (const r of codingResults) {
      expect(r.breakdown.corroboration).toBe(1);
    }
    for (const r of foodResults) {
      expect(r.breakdown.corroboration).toBe(0);
    }
  });

  it("returns results indexed back to input array", () => {
    const results = search(corpus, {
      query: "vegetarian",
      referenceDate: NOW,
    });
    expect(results[0].index).toBe(2); // vegetarian is index 2 in corpus
    expect(results[0].observation).toBe(corpus[2]);
  });

  it("when no query and no queryTags, ranks by recency + pheromone alone", () => {
    const results = search(corpus, { referenceDate: NOW, limit: 10 });
    // All observations returned (nothing filtered out)
    expect(results.length).toBe(corpus.length);
    // First should be the most recent (typescript today)
    expect(results[0].observation.date).toBe(daysAgo(0));
  });
});
