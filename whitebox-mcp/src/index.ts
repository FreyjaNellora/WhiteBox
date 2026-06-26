#!/usr/bin/env node
/**
 * WhiteBox MCP Server
 *
 * Error policy (P2.11 — converging here):
 *   - All business-logic errors throw VaultError with a machine-readable code.
 *   - Tool handlers catch everything, map to MCP isError responses.
 *   - Every caught error is appended to the vault's error log (audit trail).
 *   - Silent catches (`.catch(() => ...)`) are reserved for best-effort
 *     operations (access log append, trust load) where failure must not
 *     block the primary operation.
 *   - Never swallow errors in loops without counting/logging them.
 *
 * Target state: all error paths go through VaultError + error-log append.
 * Current gaps: some legacy catch blocks still use console.error only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { VERSION } from "whitebox-shared";
import { promises as fs } from "node:fs";
import { Vault, VaultError } from "./vault.js";
import { appendErrorEntry } from "./error-log.js";

// ─── Global safety net ────────────────────────────────────────────────────
// Without these, any unhandled error kills the Node process. Claude Desktop
// then restarts it in a tight loop, causing repeated freezes.
process.on("uncaughtException", (err) => {
  console.error("[whitebox-mcp] Uncaught exception:", err);
  if (process.env.WHITEBOX_VAULT_ROOT) {
    appendErrorEntry(process.env.WHITEBOX_VAULT_ROOT, {
      component: "mcp",
      code: "UNCAUGHT",
      message: err.message,
      stack: err.stack,
      context: "global",
    });
  }
});
process.on("unhandledRejection", (reason) => {
  console.error("[whitebox-mcp] Unhandled rejection:", reason);
  if (process.env.WHITEBOX_VAULT_ROOT) {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    appendErrorEntry(process.env.WHITEBOX_VAULT_ROOT, {
      component: "mcp",
      code: "UNHANDLED_REJECTION",
      message: msg,
      stack,
      context: "global",
    });
  }
});

import {
  AppendObservationInputSchema,
  BootstrapInputSchema,
  GrepInputSchema,
  ListFilesInputSchema,
  ProposeStableEditInputSchema,
  ReadFileInputSchema,
  VaultSearchInputSchema,
} from "./schema.js";
import {
  refuseWideOpen,
  buildAllowedHosts,
  isHostAllowed,
  isAuthorized,
} from "./sse-guard.js";
import {
  search as runSearch,
  parseObservationsFromFile,
  collectMdFiles,
  loadAccessCounts,
  appendAccessEntries,
  observationId,
  computeVaultHealth,
  formatVaultHealthReport,
  listStaleFacts,
  formatStaleReview,
  loadSourceTrust,
  makeSourceTrustResolver,
  readManifest,
  rebuildManifest,
  resolveObservationSource,
} from "whitebox-shared";

const VAULT_ROOT = process.env.WHITEBOX_VAULT_ROOT;
const ACTIVE_SCOPE = process.env.WHITEBOX_SCOPE;
// MEM-3: server-pinned provenance. When whoever launches this MCP server sets
// WHITEBOX_SOURCE (e.g. the supervisor sets it per spawned agent), observations
// are stamped with THIS identity and the caller's `source` argument cannot
// override it — closing the memory-poisoning hole where one agent forges another
// agent's provenance. Unset → fall back to the caller's claim (local single-user).
const CONFIGURED_SOURCE = process.env.WHITEBOX_SOURCE ?? null;
// MEM-2: the pinned identity in the source convention used by scopes.md grants
// (e.g. "mcp:claude"). Passed to the vault so scope `grants:` lists are enforced.
const PINNED_SOURCE =
  CONFIGURED_SOURCE == null
    ? undefined
    : CONFIGURED_SOURCE.startsWith("mcp:")
      ? CONFIGURED_SOURCE
      : `mcp:${CONFIGURED_SOURCE}`;

if (!VAULT_ROOT) {
  console.error(
    "[whitebox-mcp] WHITEBOX_VAULT_ROOT environment variable is required.",
  );
  console.error(
    "  Set it to the absolute path of your WhiteBox vault directory.",
  );
  process.exit(1);
}

const vault = new Vault({
  root: VAULT_ROOT,
  activeScope: ACTIVE_SCOPE,
  source: PINNED_SOURCE,
});

const server = new Server(
  {
    name: "whitebox-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.onerror = (error) => {
  console.error("[whitebox-mcp] MCP protocol error:", error);
  if (VAULT_ROOT) {
    const msg = error instanceof Error ? error.message : String(error);
    appendErrorEntry(VAULT_ROOT, {
      component: "mcp",
      code: "PROTOCOL_ERROR",
      message: msg,
      stack: error instanceof Error ? error.stack : undefined,
      context: "mcp-protocol",
    });
  }
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_file",
      description:
        "Read a markdown file from the WhiteBox vault. Path is relative to vault root. Use this to load AGENTS.md, identity.md, working-style.md, or any other file the user references.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Vault-relative path, e.g. 'identity.md' or 'observations/2026-04.md'",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description:
        "List markdown files in the WhiteBox vault. Optional subdir argument restricts to a subdirectory. Respects active scope if one is set.",
      inputSchema: {
        type: "object",
        properties: {
          subdir: {
            type: "string",
            description:
              "Optional subdirectory to restrict listing, e.g. 'observations' or 'relationships'",
          },
          limit: {
            type: "number",
            description: "Max number of files to return (default 200, max 1000).",
          },
          offset: {
            type: "number",
            description: "Number of files to skip (default 0).",
          },
        },
      },
    },
    {
      name: "append_observation",
      description:
        "Append a single observation to the current month's observations file. Use this whenever you learn something about the user during the conversation. The observation is appended, never overwritten. Other agents' observations are never modified.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description:
              "Identifier for the agent or model writing this observation, e.g. 'claude-opus-4-7' or 'chatgpt-5'",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Tags from tags.md. Prefer existing tags. New tags will need to be added to tags.md by the user.",
          },
          confidence: {
            type: "string",
            enum: ["very-low", "low", "medium", "high", "very-high"],
            description:
              "How confident you are in this observation. very-low = fleeting impression, weak evidence. low = possibly true, one data point, matches pattern. medium = probably true, consistent across moments. high = clearly stated by user or observed repeatedly. very-high = explicitly confirmed or identity-level claim.",
          },
          body: {
            type: "string",
            description:
              "One paragraph describing what you learned about the user and the context you learned it in. Aim for under 100 words.",
          },
          date: {
            type: "string",
            description:
              "Optional ISO date YYYY-MM-DD. Defaults to today.",
          },
          kind: {
            type: "string",
            enum: ["quote", "inference"],
            description:
              "Optional signal type. 'quote' = verbatim user words (raw evidence). 'inference' = your interpretation the user has affirmed (validated synthesis; weighted higher in promotion). Omit for legacy / unspecified.",
          },
        },
        required: ["source", "tags", "confidence", "body"],
      },
    },
    {
      name: "propose_stable_edit",
      description:
        "Propose an edit to a stable file (identity.md, working-style.md, relationships/*, projects/*). The proposal is written to proposed/ for the user to review and apply manually. Never silently overwrite stable files.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Vault-relative path of the stable file you propose changing",
          },
          edit: {
            type: "object",
            properties: {
              source: {
                type: "string",
                description: "Agent or model identifier",
              },
              rationale: {
                type: "string",
                description:
                  "Why you believe this change should be made. Cite the observations or user statements that support it.",
              },
              proposed_content: {
                type: "string",
                description:
                  "The full new content for the file (or the relevant section).",
              },
            },
            required: ["source", "rationale", "proposed_content"],
          },
        },
        required: ["target", "edit"],
      },
    },
    {
      name: "list_conflicts",
      description:
        "List unresolved observations tagged `conflict` in the vault. Useful at session start to surface pending issues for the user to resolve. Returns each conflict's file path, position, date, source, tags, confidence, context, and body.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max number of conflicts to return (default 100).",
          },
          offset: {
            type: "number",
            description: "Number of conflicts to skip (default 0).",
          },
        },
      },
    },
    {
      name: "bootstrap",
      description:
        "Pull the user's orientation pack: AGENTS.md, identity.md, working-style.md, tags.md, plus the most recent observation entries. Same content the browser extension injects on first message. Call this at session start, OR mid-conversation if you want to re-read it. The user can choose to expose this via guardrails per source.",
      inputSchema: {
        type: "object",
        properties: {
          include_observations: {
            type: "number",
            description:
              "How many recent observation entries to include. Default 8.",
          },
        },
      },
    },
    {
      name: "vault_health",
      description:
        "Introspection over the vault's collective memory state. Returns: total observation count, distinct sources contributing, source distribution (% per agent), age distribution buckets, cross-source corroboration rate (the swarm-coordination metric — what fraction of observations have ≥2 distinct sources in their tag-cluster), access concentration (top-10% items' share of reads — high concentration with low corroboration is a monoculture warning), top tags, and effective recency-weighted observation count. Surfaces health hints when the vault is single-source, low-corroboration, mostly-stale, or inactive.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_stale_facts",
      description:
        "Review observations that have decayed below relevance thresholds. Returns a demotion report showing which observations are stale (very old or low-scoring), why they were flagged, and their current recency/age metrics. Use this periodically to clean up observations that no longer shape agent behavior. The user decides: keep, archive, or add a superseded reaction.",
      inputSchema: {
        type: "object",
        properties: {
          threshold: {
            type: "number",
            description: "Optional custom score threshold for flagging (default 0.15).",
          },
        },
      },
    },
    {
      name: "vault_search",
      description:
        "Ranked search over observations. Composes BM25 text matching, tag jaccard, recency decay, access pheromones, and cross-source corroboration into a single score. Returns observations ranked by relevance with a per-result score breakdown so you can see WHY each surfaced. Prefer this over grep when you want 'most-relevant memories about X' rather than 'all lines containing the literal string Y'. Empty query + filters = ranked browse by recency.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Free-text query. Words matched against observation bodies via BM25.",
          },
          query_tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags for jaccard scoring (does not filter; ranks).",
          },
          require_tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags that MUST all be present (hard filter).",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "Restrict to these source agents (e.g. ['mcp:claude']).",
          },
          date_after: {
            type: "string",
            description: "ISO YYYY-MM-DD. Drops observations strictly older than this date.",
          },
          limit: {
            type: "number",
            description: "Max results to return. Default 10, max 100.",
          },
          half_life_days: {
            type: "number",
            description: "Recency half-life override in days. Default 30.",
          },
        },
      },
    },
    {
      name: "grep",
      description:
        "Regex search across the vault's active memory (observations) and/or passive memory (conversations). Use this to look up what's been said about a topic instead of re-reading whole files. Returns file path, line number, matched line, and surrounding context if requested.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regex source (without slashes). Example: 'project:foo' or 'concise|terse'.",
          },
          scope: {
            type: "string",
            enum: ["observations", "conversations", "all"],
            description:
              "Where to search. Default 'observations' (active memory only).",
          },
          ignore_case: {
            type: "boolean",
            description: "Case-insensitive match.",
          },
          context: {
            type: "number",
            description: "Lines of surrounding context per match (0-20).",
          },
          max_results: {
            type: "number",
            description: "Cap on returned matches (default 50).",
          },
        },
        required: ["pattern"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "read_file": {
        const { path: p } = ReadFileInputSchema.parse(args);
        const content = await vault.readFile(p);
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "list_files": {
        const { subdir, limit, offset } = ListFilesInputSchema.parse(args);
        const allFiles = await vault.listFiles(subdir);
        const start = offset ?? 0;
        const cap = limit ?? 200;
        const files = allFiles.slice(start, start + cap);
        const total = allFiles.length;
        const suffix =
          total > start + cap
            ? `\n\n(showing ${start + 1}-${start + files.length} of ${total} files)`
            : "";
        return {
          content: [
            {
              type: "text",
              text:
                files.length === 0
                  ? "(no files)"
                  : files.join("\n") + suffix,
            },
          ],
        };
      }

      case "append_observation": {
        const obs = AppendObservationInputSchema.parse(args);
        // MEM-3: provenance is authoritative when the server is launched with a
        // pinned identity (WHITEBOX_SOURCE) — the caller's `source` cannot then
        // override it. Otherwise we fall back to the caller's claim, prefixed
        // `mcp:` so it is at least annotated honestly.
        const { stamped: stampedSource, pinned } = resolveObservationSource(
          obs.source,
          CONFIGURED_SOURCE,
        );
        const written = await vault.appendObservation(
          { ...obs, source: stampedSource },
          { viaSource: "mcp" },
        );
        const note = pinned
          ? `source pinned to ${stampedSource} (caller claim ignored)`
          : `source stamped as ${stampedSource}`;
        return {
          content: [
            {
              type: "text",
              text: `Observation appended to ${written} (${note}; audit log updated).`,
            },
          ],
        };
      }

      case "propose_stable_edit": {
        const { target, edit } = ProposeStableEditInputSchema.parse(args);
        const proposalPath = await vault.proposeStableEdit(target, edit);
        return {
          content: [
            {
              type: "text",
              text: `Proposal written to ${proposalPath}. The user will review and apply it manually.`,
            },
          ],
        };
      }

      case "bootstrap": {
        const { include_observations } = BootstrapInputSchema.parse(args || {});
        const pack = await vault.bootstrap(include_observations ?? 8);
        const sections: string[] = [];
        for (const [name, content] of Object.entries(pack.files)) {
          if (!content) continue;
          sections.push(`## ${name}\n\n${content.trim()}`);
        }
        if (pack.recent_observations) {
          sections.push(
            `## recent observations\n\n${pack.recent_observations.trim()}`,
          );
        }
        return {
          content: [
            {
              type: "text",
              text: sections.length
                ? sections.join("\n\n---\n\n")
                : "(vault has no readable bootstrap files)",
            },
          ],
        };
      }

      case "vault_health": {
        // Fast path: use manifest if fresh (rebuilt within last hour).
        const manifest = await readManifest(VAULT_ROOT, { maxAgeMs: 60 * 60 * 1000 });
        if (manifest && !args?.force_refresh) {
          const lines = [
            `╔══════════════════════════════════════════════════════════╗`,
            `║         VAULT HEALTH REPORT (from manifest)              ║`,
            `╚══════════════════════════════════════════════════════════╝`,
            "",
            `Manifest rebuilt: ${manifest.rebuiltAt}`,
            "",
            "── Volume ──",
            `  Total observations:      ${manifest.observationCount}`,
            `  Distinct sources:        ${manifest.distinctSources}`,
            "",
            "── Source distribution ──",
          ];
          const sourceEntries = Object.entries(manifest.sourceCounts)
            .sort((a, b) => b[1] - a[1]);
          for (const [source, count] of sourceEntries) {
            const share = manifest.observationCount > 0
              ? (count / manifest.observationCount * 100).toFixed(1)
              : "0.0";
            lines.push(`  ${source.padEnd(24)} ${String(count).padStart(5)}  (${share}%)`);
          }
          lines.push("", "── Top tags ──");
          const tagEntries = Object.entries(manifest.tagCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15);
          for (const [tag, count] of tagEntries) {
            lines.push(`  ${tag.padEnd(28)} ${String(count).padStart(4)}`);
          }
          lines.push("", "Use force_refresh=true for full scan with access counts + trust scores.");
          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }

        // Slow path: load all observations + access counts; compute the report.
        const obsDir = await vault.resolvePath("observations");
        const files = await collectMdFiles(obsDir).catch(() => [] as string[]);
        const allObs = [];
        const allIds: string[] = [];
        let skippedFiles = 0;
        for (const filePath of files) {
          const rel = path.relative(VAULT_ROOT, filePath).split(path.sep).join("/");
          if (!(await vault.isInScope(rel))) continue;
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = parseObservationsFromFile(content);
            for (let i = 0; i < parsed.length; i++) {
              allObs.push(parsed[i]);
              allIds.push(observationId(rel, i));
            }
          } catch {
            skippedFiles++;
          }
        }
        const counts = await loadAccessCounts(VAULT_ROOT).catch(
          () => new Map<string, number>(),
        );
        const accessCounts = allIds.map((id) => counts.get(id) ?? 0);
        // Wire in per-source trust scores so health report reflects calibrated weights.
        const trustMap = await loadSourceTrust(VAULT_ROOT).catch(
          () => new Map<string, number>(),
        );
        const sourceTrust = makeSourceTrustResolver(trustMap);
        const report = computeVaultHealth(allObs, { accessCounts, sourceTrust });
        let reportText = formatVaultHealthReport(report);
        if (skippedFiles > 0) {
          reportText += `\n⚠  ${skippedFiles} file(s) skipped due to read/parse errors.\n`;
          // Log to error log so the user can investigate later.
          appendErrorEntry(VAULT_ROOT, {
            component: "mcp",
            code: "HEALTH_SKIPPED",
            message: `${skippedFiles} observation file(s) skipped during health computation`,
            context: "vault_health",
          });
        }
        return {
          content: [{ type: "text", text: reportText }],
        };
      }

      case "vault_search": {
        const opts = VaultSearchInputSchema.parse(args || {});
        // Load all observations from observations/ directory. Uses existing
        // shared utilities so we stay in lock-step with the parser the rest
        // of the system uses.
        const obsDir = await vault.resolvePath("observations");
        const files = await collectMdFiles(obsDir).catch(() => [] as string[]);
        const allObs = [];
        // Track each observation's stable id so we can a) feed pheromone
        // counts to the ranker and b) record fresh access entries for
        // whatever the search surfaces.
        const allIds: string[] = [];
        let skippedFiles = 0;
        for (const filePath of files) {
          const rel = path.relative(VAULT_ROOT, filePath).split(path.sep).join("/");
          if (!(await vault.isInScope(rel))) continue;
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = parseObservationsFromFile(content);
            for (let i = 0; i < parsed.length; i++) {
              allObs.push(parsed[i]);
              allIds.push(observationId(rel, i));
            }
          } catch {
            skippedFiles++;
          }
        }
        // Load pheromone trail (best-effort; brand-new vaults have no log).
        const counts = await loadAccessCounts(VAULT_ROOT).catch(
          () => new Map<string, number>(),
        );
        const accessCounts = allIds.map((id) => counts.get(id) ?? 0);
        // Wire in per-source trust scores so search ranking reflects calibrated weights.
        const trustMap = await loadSourceTrust(VAULT_ROOT).catch(
          () => new Map<string, number>(),
        );
        const sourceTrust = makeSourceTrustResolver(trustMap);
        const results = runSearch(allObs, {
          query: opts.query,
          queryTags: opts.query_tags,
          requireTags: opts.require_tags,
          sources: opts.sources,
          dateAfter: opts.date_after,
          limit: opts.limit ?? 10,
          halfLifeDays: opts.half_life_days,
          accessCounts,
          sourceTrust,
        });
        // Reinforce surfaced items with fresh pheromone entries. Best-effort
        // — never let access logging fail the search itself.
        if (results.length > 0) {
          const ts = new Date().toISOString();
          const entries = results.map((r) => ({
            ts,
            id: allIds[r.index],
            by: "mcp",
            via: "vault_search",
          }));
          appendAccessEntries(VAULT_ROOT, entries).catch((err) => {
            console.error("[whitebox-mcp] access log append failed:", err);
          });
        }
        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "(no results match the query and filters)",
              },
            ],
          };
        }
        const lines: string[] = [
          `${results.length} result${results.length === 1 ? "" : "s"}, ranked:`,
          "",
        ];
        for (const r of results) {
          const o = r.observation;
          const b = r.breakdown;
          lines.push(`── score ${r.score.toFixed(3)} — ${o.source ?? "?"} on ${o.date ?? "?"}`);
          lines.push(
            `   breakdown: text=${b.text.toFixed(2)} tags=${b.tags.toFixed(2)} recency=${b.recency.toFixed(2)} pheromone=${b.pheromone.toFixed(2)} corroboration=${b.corroboration.toFixed(2)}`,
          );
          lines.push(`   tags: [${(o.tags ?? []).join(", ")}]`);
          if (o.confidence) lines.push(`   confidence: ${o.confidence}`);
          lines.push(`   ${o.body.replace(/\n/g, " ").slice(0, 240)}`);
          lines.push("");
        }
        if (skippedFiles > 0) {
          lines.push(`\n⚠  ${skippedFiles} observation file(s) skipped due to read/parse errors.`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "grep": {
        const opts = GrepInputSchema.parse(args);
        const matches = await vault.grep(opts);
        if (matches.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `(no matches for /${opts.pattern}/${opts.ignore_case ? "i" : ""} in ${opts.scope || "observations"})`,
              },
            ],
          };
        }
        const lines: string[] = [
          `${matches.length} match${matches.length === 1 ? "" : "es"} for /${opts.pattern}/${opts.ignore_case ? "i" : ""}:`,
          "",
        ];
        let lastFile = "";
        for (const m of matches) {
          if (m.file !== lastFile) {
            lines.push(`── ${m.file} ─`);
            lastFile = m.file;
          }
          if (m.before.length) {
            m.before.forEach((l, i) => {
              const n = m.line - m.before.length + i;
              lines.push(`  ${String(n).padStart(5)}-  ${l}`);
            });
          }
          lines.push(`  ${String(m.line).padStart(5)}:  ${m.text}`);
          if (m.after.length) {
            m.after.forEach((l, i) => {
              lines.push(`  ${String(m.line + 1 + i).padStart(5)}-  ${l}`);
            });
            lines.push("");
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      case "list_conflicts": {
        const conflictArgs = args as { limit?: number; offset?: number } | undefined;
        const allConflicts = await vault.listConflicts();
        const cStart = conflictArgs?.offset ?? 0;
        const cCap = conflictArgs?.limit ?? 100;
        const conflicts = allConflicts.slice(cStart, cStart + cCap);
        if (allConflicts.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "(no unresolved conflicts)",
              },
            ],
          };
        }
        const lines: string[] = [
          `${conflicts.length} unresolved ${conflicts.length === 1 ? "conflict" : "conflicts"}:`,
          "",
        ];
        conflicts.forEach((c, i) => {
          lines.push(`── ${i + 1}/${conflicts.length} ──`);
          lines.push(`  ${c.file} (entry ${c.position})`);
          if (c.date) lines.push(`  date: ${c.date}`);
          if (c.source) lines.push(`  source: ${c.source}`);
          lines.push(`  tags: ${c.tags.join(", ")}`);
          if (c.confidence) lines.push(`  confidence: ${c.confidence}`);
          if (c.context) lines.push(`  context: ${c.context}`);
          lines.push("");
          c.body.split("\n").forEach((line) => lines.push(`  > ${line}`));
          lines.push("");
        });
        return {
          content: [
            {
              type: "text",
              text: lines.join("\n"),
            },
          ],
        };
      }

      case "list_stale_facts": {
        const staleArgs = args as { threshold?: number } | undefined;
        const obsDir = await vault.resolvePath("observations");
        const files = await collectMdFiles(obsDir).catch(() => [] as string[]);
        const allObs = [];
        for (const filePath of files) {
          const rel = path.relative(VAULT_ROOT, filePath).split(path.sep).join("/");
          if (!(await vault.isInScope(rel))) continue;
          try {
            const content = await fs.readFile(filePath, "utf-8");
            const parsed = parseObservationsFromFile(content);
            for (const obs of parsed) allObs.push(obs);
          } catch {
            // skip unreadable
          }
        }
        const stale = listStaleFacts(allObs, {
          scoreThreshold: staleArgs?.threshold,
        });
        if (stale.length === 0) {
          return {
            content: [{ type: "text", text: "No stale observations found." }],
          };
        }
        return {
          content: [{ type: "text", text: formatStaleReview(stale) }],
        };
      }

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    const code =
      err instanceof VaultError ? err.code : "TOOL_ERROR";
    const message =
      err instanceof VaultError
        ? `[${err.code}] ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    if (VAULT_ROOT) {
      appendErrorEntry(VAULT_ROOT, {
        component: "mcp",
        code,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        context: `tool:${name}`,
      });
    }
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

// Cap on resources returned in a single ListResources response.
// MCP responses go through the entire request/response transport in memory;
// a 10k-file vault could OOM the MCP host. Cursor-based pagination is the
// proper fix; until then, cap and warn on overflow.
const LIST_RESOURCES_MAX = 1000;

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const files = await vault.listFiles();
    const truncated = files.length > LIST_RESOURCES_MAX;
    const slice = truncated ? files.slice(0, LIST_RESOURCES_MAX) : files;
    if (truncated) {
      console.error(
        `[whitebox-mcp] ListResources truncated: ${files.length} files in vault, returning first ${LIST_RESOURCES_MAX}`,
      );
    }
    return {
      resources: slice.map((f) => ({
        uri: `whitebox://${f}`,
        name: f,
        mimeType: "text/markdown",
      })),
    };
  } catch (err) {
    console.error("[whitebox-mcp] ListResources error:", err);
    if (VAULT_ROOT) {
      appendErrorEntry(VAULT_ROOT, {
        component: "mcp",
        code: "LIST_RESOURCES",
        message: err instanceof Error ? err.message : String(err),
        context: "list-resources",
      });
    }
    return { resources: [] };
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (!uri.startsWith("whitebox://")) {
    throw new Error(`Unsupported URI scheme: ${uri}`);
  }
  const relativePath = uri.slice("whitebox://".length);
  const text = await vault.readFile(relativePath);
  return {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text,
      },
    ],
  };
});

async function main() {
  await ensureVaultExists(vault.root);

  const args = process.argv.slice(2);
  const transportFlag = args.includes("--transport")
    ? args[args.indexOf("--transport") + 1]
    : "stdio";
  const portFlag = args.includes("--port")
    ? parseInt(args[args.indexOf("--port") + 1], 10)
    : 8787;
  const hostFlag = args.includes("--host")
    ? args[args.indexOf("--host") + 1]
    : "127.0.0.1";

  const vaultInfo = `Vault: ${vault.root}${ACTIVE_SCOPE ? ` (scope: ${ACTIVE_SCOPE})` : ""}`;

  if (transportFlag === "sse") {
    // SSE mode — HTTP server for ChatGPT Desktop and other SSE MCP clients.
    // MEM-1: optional bearer token + Host-header allow-list, and a refusal to
    // expose the vault unauthenticated on a non-loopback interface.
    const sseToken = process.env.WHITEBOX_SSE_TOKEN || null;
    if (refuseWideOpen(hostFlag, sseToken)) {
      console.error(
        `[whitebox-mcp] REFUSING to start SSE on non-loopback host "${hostFlag}" ` +
          `without WHITEBOX_SSE_TOKEN — that would serve the vault unauthenticated ` +
          `to the LAN. Set WHITEBOX_SSE_TOKEN, bind 127.0.0.1, or front it with a TLS tunnel.`,
      );
      process.exit(1);
    }
    const allowedHosts = buildAllowedHosts(
      hostFlag,
      portFlag,
      process.env.WHITEBOX_SSE_ALLOWED_HOSTS,
    );

    let sseTransport: SSEServerTransport | null = null;

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers for browser-based clients
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      // MEM-1: DNS-rebinding defense — reject mismatched Host headers.
      if (!isHostAllowed(req.headers.host, allowedHosts)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden: Host header not allowed.");
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // MEM-1: require the bearer token when WHITEBOX_SSE_TOKEN is configured.
      if (!isAuthorized(req.headers["authorization"], sseToken)) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized: missing or invalid bearer token.");
        return;
      }

      if (req.method === "GET" && req.url === "/sse") {
        sseTransport = new SSEServerTransport("/message", res);
        await server.connect(sseTransport);
      } else if (req.method === "POST" && req.url === "/message") {
        if (sseTransport) {
          await sseTransport.handlePostMessage(req, res);
        } else {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("No active SSE connection. Connect to /sse first.");
        }
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found. Use GET /sse to connect.");
      }
    });

    httpServer.listen(portFlag, hostFlag, () => {
      console.error(
        `[whitebox-mcp] SSE server listening on http://${hostFlag}:${portFlag}/sse`,
      );
      console.error(
        `[whitebox-mcp] SSE auth: ${sseToken ? "bearer token REQUIRED" : "none (loopback only)"}`,
      );
      console.error(`[whitebox-mcp] ${vaultInfo}`);
    });
  } else {
    // Default: stdio mode for Claude Desktop / Cursor / Gemini CLI / etc.
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[whitebox-mcp] Connected. ${vaultInfo}`);
  }
}

async function ensureVaultExists(root: string) {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      console.error(`[whitebox-mcp] Vault root is not a directory: ${root}`);
      process.exit(1);
    }
  } catch {
    console.error(`[whitebox-mcp] Vault root does not exist: ${root}`);
    console.error(
      "  Create the directory and add an AGENTS.md before connecting.",
    );
    process.exit(1);
  }

  const agentsPath = path.join(root, "AGENTS.md");
  try {
    await fs.access(agentsPath);
  } catch {
    console.error(
      `[whitebox-mcp] Warning: ${agentsPath} not found. Agents may not orient correctly.`,
    );
  }
}

main().catch((err) => {
  console.error("[whitebox-mcp] Fatal:", err);
  process.exit(1);
});
