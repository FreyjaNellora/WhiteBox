#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { exportCommand } from "./commands/export.js";
import { pasteCommand } from "./commands/paste.js";
import { conflictsCommand } from "./commands/conflicts.js";
import { logCommand } from "./commands/log.js";
import { grepCommand } from "./commands/grep.js";
import { searchCommand } from "./commands/search.js";
import { healthCommand } from "./commands/health.js";
import { diagnosticsCommand } from "./commands/diagnostics.js";
import { reviewStaleCommand } from "./commands/review-stale.js";
import { tagsNormalizeCommand } from "./commands/tags.js";
import { verifyAuditCommand } from "./commands/verify-audit.js";
import { VERSION } from "whitebox-shared";

const program = new Command();

program
  .name("whitebox")
  .description(
    "Universal CLI for WhiteBox portable user-memory vaults. Works with any agent on any platform.",
  )
  .version(VERSION);

program
  .command("init")
  .argument("[path]", "target directory for the new vault (created if missing; defaults to ~/whitebox-vault)")
  .description("Create a new WhiteBox vault. Without a path, seeds one at ~/whitebox-vault.")
  .option("-f, --force", "overwrite existing files if the target already contains a partial vault")
  .action(initCommand);

program
  .command("export")
  .description(
    "Print a paste-in bundle to stdout. Use to hand vault context to any agent that accepts text.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("-s, --scope <name>", "restrict to files within the named scope from scopes.md")
  .option("--include-observations <n>", "include the most recent N observation entries", "5")
  .action(exportCommand);

program
  .command("paste")
  .description("Copy the paste-in bundle to the system clipboard.")
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("-s, --scope <name>", "restrict to files within the named scope")
  .option("--include-observations <n>", "include the most recent N observation entries", "5")
  .action(pasteCommand);

program
  .command("conflicts")
  .description("List unresolved observations tagged `conflict` in the vault.")
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--json", "machine-readable JSON output")
  .action(conflictsCommand);

program
  .command("log")
  .description(
    "List recent passive-memory conversation files (under conversations/), most recent first.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--recent <n>", "max number of files to show", "10")
  .option("--json", "machine-readable JSON output")
  .action(logCommand);

program
  .command("grep")
  .argument("<pattern>", "JavaScript regex source (without slashes)")
  .description(
    "Search passive-memory conversations for matching lines. Use --turn to get whole turns instead of lines.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("-i, --ignore-case", "case-insensitive match")
  .option("-C, --context <n>", "lines of context around each line match", "0")
  .option("--turn", "return whole conversation turns containing the match")
  .option("--json", "machine-readable JSON output")
  .action(grepCommand);

program
  .command("search")
  .argument("[query]", "free-text query (BM25 against observation bodies). Optional — omit to filter-only.")
  .description(
    "Ranked search over observations. Composes text relevance, tag jaccard, recency decay, access pheromones, and cross-source corroboration. Returns ranked results with score breakdown.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--tags <list>", "comma-separated tags for jaccard scoring (ranks, doesn't filter)")
  .option("--require-tags <list>", "comma-separated tags that ALL must be present (filter)")
  .option("--source <list>", "comma-separated source agents to restrict to")
  .option("--after <date>", "drop observations older than YYYY-MM-DD")
  .option("--limit <n>", "max results to return", "10")
  .option("--half-life <days>", "recency half-life override in days (default 30)")
  .option("--json", "machine-readable JSON output")
  .action(searchCommand);

program
  .command("health")
  .description(
    "Vault introspection: observation count, source distribution, age buckets, cross-source corroboration rate, access concentration, top tags. Surfaces health hints for single-source / stale / inactive vaults.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--json", "machine-readable JSON output")
  .action(healthCommand);

program
  .command("diagnostics")
  .description(
    "Print environment info and recent error logs for bug reports.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .action(diagnosticsCommand);

program
  .command("review-stale")
  .description(
    "List observations that have decayed below relevance thresholds. Review and decide whether to keep, archive, or supersede.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--threshold <n>", "custom score threshold for flagging (default 0.15)")
  .option("--json", "machine-readable JSON output")
  .action(reviewStaleCommand);

program
  .command("tags-normalize")
  .description(
    "Detect near-duplicate tags across all observations. Surfaces candidates for user merge confirmation. Dry-run only — no files are modified.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("--json", "machine-readable JSON output")
  .action(tagsNormalizeCommand);

program
  .command("verify-audit")
  .description(
    "Verify hash-chain integrity of audit logs (access, trust). Exit codes: 0=clean, 1=hash mismatch, 2=truncation, 3=file error.",
  )
  .option("-v, --vault <path>", "vault directory (default: $WHITEBOX_VAULT_ROOT or cwd)")
  .option("-t, --type <type>", "audit type to verify: access | trust (default: both)")
  .option("--json", "machine-readable JSON output")
  .action(verifyAuditCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
