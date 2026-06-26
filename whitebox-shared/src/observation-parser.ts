export interface ParsedObservation {
  date?: string;
  source?: string;
  tags: string[];
  confidence?: string;
  context?: string;
  /**
   * Optional signal-type discriminator (P3.3):
   *   - "quote" — verbatim text from the user. Raw evidence; could be a
   *     polite remark, sarcasm, role-play, or genuine preference. Treat as
   *     observational signal that needs accumulation/corroboration.
   *   - "inference" — agent's interpretation of user state, ideally affirmed
   *     by the user in-conversation. Stronger identity signal than a single
   *     quote because it represents synthesis the user validated.
   *   - undefined — legacy / agent didn't specify. Default behavior, no
   *     weight adjustment in promotion.
   *
   * Used by promotion's observationScore to weight inferences slightly higher
   * than raw quotes (the audit insight: a casual "I like Python" comment
   * shouldn't promote at the same threshold as a confirmed preference).
   */
  kind?: "quote" | "inference";
  body: string;
}

/**
 * Parse all observations from a monthly observations file.
 * Each observation is a fenced code block with YAML-ish frontmatter.
 */
export function parseObservationsFromFile(content: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];
  const blockRe = /```\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(content))) {
    const parsed = parseObservationBlock(match[1]);
    if (parsed) observations.push(parsed);
  }
  return observations;
}

/**
 * Parse a single observation block (the content inside triple backticks).
 * Expects YAML-ish frontmatter between `---` delimiters followed by body text.
 */
export function parseObservationBlock(block: string): ParsedObservation | null {
  const fmMatch = block.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const [, frontmatter, body] = fmMatch;
  const fields: Record<string, string> = {};
  let tags: string[] = [];
  for (const line of frontmatter.split("\n")) {
    const fieldMatch = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const [, key, rawValue] = fieldMatch;
    const value = rawValue.trim();
    if (key === "tags") {
      tags = parseInlineTagList(value);
    } else {
      fields[key] = value;
    }
  }
  // Validate kind if present; silently drop unknown values rather than
  // throwing, since unknown could mean a future-spec value an older parser
  // doesn't recognize.
  let kind: "quote" | "inference" | undefined;
  if (fields.kind === "quote" || fields.kind === "inference") {
    kind = fields.kind;
  }

  return {
    date: fields.date,
    source: fields.source,
    confidence: fields.confidence,
    context: fields.context,
    kind,
    tags,
    body: body.trim(),
  };
}

/**
 * Parse a YAML-ish inline tag list: `["a", "b"]` or `[a, b]`.
 */
export function parseInlineTagList(raw: string): string[] {
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) =>
      s.trim().replace(/^"/, "").replace(/"$/, "").replace(/^'/, "").replace(/'$/, ""),
    )
    // Strip control characters (newlines, tabs, etc.) — they break audit log
    // single-line invariants and can't round-trip through formatObservation.
    .map((s) => s.replace(/[\r\n\t\x00-\x1f\x7f]/g, ""))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split a monthly observations file into its individual observation blocks.
 * Entries are separated by horizontal rules (`---` on its own line).
 */
export function splitObservationEntries(content: string): string[] {
  const body = content.replace(/^#[^\n]*\n+/, "").replace(/^(?:[^#\n`]+\n)+/, "");
  return body
    .split(/\n-{3,}\n/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.includes("```"));
}
