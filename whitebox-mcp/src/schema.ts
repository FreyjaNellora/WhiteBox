import path from "node:path";
import { z } from "zod";

export const ConfidenceSchema = z.enum([
  "very-low",
  "low",
  "medium",
  "high",
  "very-high",
]);

function isValidDate(str: string): boolean {
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return false;
  // Reject invalid dates like 2026-02-30 that parse to March 2
  const [y, m, day] = str.split("-").map(Number);
  return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day;
}

export const ObservationSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD")
    .refine(isValidDate, { message: "date is not a valid calendar date (e.g. 2026-02-30 is invalid)" })
    .optional(),
  source: z.string().min(1, "source must identify the writing agent or model"),
  tags: z
    .array(
      z
        .string()
        .min(1, "tag cannot be empty")
        .max(50, "tag must be 50 chars or fewer")
        .regex(
          /^[a-z0-9][a-z0-9\-]*$/,
          "tag must be lowercase alphanumerics or hyphens, starting with a letter or digit",
        ),
    )
    .min(1, "at least one tag is required")
    .max(10, "no more than ten tags per observation"),
  confidence: ConfidenceSchema,
  body: z
    .string()
    .min(1, "observation body cannot be empty")
    .max(500, "observation body must be under ~500 characters; use source_ref for longer content"),
  // Optional reference to a longer captured artifact. Spec says
  // observation bodies should be direct quotes under ~500 chars; when
  // the worthy content is longer, agents save the full text as a
  // sources/<filename>.md and reference it here via source_ref.
  source_ref: z
    .string()
    .optional()
    .refine((p) => p === undefined || !p.startsWith("/"), {
      message: "source_ref must be a vault-relative path",
    })
    .refine((p) => p === undefined || !p.includes(".."), {
      message: "source_ref must not traverse",
    }),
  // Optional situational-scope label. Per v1.1 spec: differentiates
  // context-dependent observations that would otherwise look like
  // conflicts (e.g. context: coding-conversations).
  context: z.string().optional(),
  // Optional signal-type discriminator (P3.3):
  //   "quote"     — verbatim text from the user. Raw evidence; observational.
  //   "inference" — agent's interpretation user has affirmed. Stronger
  //                 identity signal; weighted higher in promotion.
  // Omit for legacy / unspecified — treated as default weight (1.0).
  kind: z.enum(["quote", "inference"]).optional(),
});

export const StableEditSchema = z.object({
  source: z.string().min(1),
  rationale: z.string().min(1),
  proposed_content: z.string().min(1),
});

export const ReadFileInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine((p) => !path.isAbsolute(p), {
      message: "path must be relative to the vault root",
    })
    .refine((p) => !p.includes(".."), {
      message: "path traversal not permitted",
    }),
});

export const ListFilesInputSchema = z.object({
  subdir: z.string().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max number of files to return. Default 200."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Number of files to skip before returning results. Default 0."),
});

export const AppendObservationInputSchema = ObservationSchema;

export const ProposeStableEditInputSchema = z.object({
  target: z
    .string()
    .min(1)
    .refine((p) => !path.isAbsolute(p), {
      message: "target path must be relative to vault root",
    })
    .refine((p) => !p.includes(".."), {
      message: "path traversal not permitted",
    }),
  edit: StableEditSchema,
});

export const BootstrapInputSchema = z.object({
  include_observations: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("How many recent observations to include. Default 8."),
});

export const VaultSearchInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Free-text query. Words are matched against observation bodies via BM25. Optional — if you only want to filter (by tag/source/date) without text matching, omit.",
    ),
  query_tags: z
    .array(z.string())
    .optional()
    .describe(
      "Tag-list query. Each result is scored by jaccard overlap with this set. Use to find observations on a topic by tag rather than free text.",
    ),
  require_tags: z
    .array(z.string())
    .optional()
    .describe(
      "Hard filter — observation must have ALL of these tags to be returned. Different from query_tags (which ranks but doesn't filter).",
    ),
  sources: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict results to observations authored by any of these source identifiers (e.g. ['mcp:claude', 'mcp:cursor']).",
    ),
  date_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date_after must be ISO YYYY-MM-DD")
    .optional()
    .describe("Drop observations strictly older than this date."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max results to return. Default 10, max 100."),
  half_life_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .describe(
      "Recency half-life override (days). Default 30. Increase to value older observations more.",
    ),
});

export const GrepInputSchema = z.object({
  pattern: z
    .string()
    .min(1, "pattern is required")
    .describe(
      "JavaScript regex source (without slashes). Example: 'project:foo' or 'working-style.*concise'.",
    ),
  scope: z
    .enum(["observations", "conversations", "all"])
    .optional()
    .describe(
      "Where to search. observations = active memory only, conversations = passive transcripts only, all = both. Default observations.",
    ),
  ignore_case: z.boolean().optional().describe("Case-insensitive match."),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Lines of context around each match."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Cap on returned matches. Default 50."),
});
