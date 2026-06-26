import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENTS_MD,
  IDENTITY_MD,
  WORKING_STYLE_MD,
  TAGS_MD,
  README_MD,
  observationsHeader,
} from "../lib/templates.js";

interface InitOptions {
  force?: boolean;
}

const DEFAULT_VAULT_NAME = "whitebox-vault";

export async function initCommand(
  targetPath: string | undefined,
  options: InitOptions,
): Promise<void> {
  const resolvedTarget = targetPath ?? path.join(os.homedir(), DEFAULT_VAULT_NAME);
  const absolute = path.resolve(resolvedTarget);

  if (!targetPath) {
    console.log(`No path provided; using default: ${absolute}`);
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isDirectory()) {
      throw new Error(`${absolute} exists and is not a directory`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.mkdir(absolute, { recursive: true });
    } else {
      throw err;
    }
  }

  const files: Array<[string, string]> = [
    ["AGENTS.md", AGENTS_MD],
    ["identity.md", IDENTITY_MD],
    ["working-style.md", WORKING_STYLE_MD],
    ["tags.md", TAGS_MD],
    ["README.md", README_MD],
  ];

  const month = new Date().toISOString().slice(0, 7);
  const monthLabel = formatMonthLabel(month);
  files.push([`observations/${month}.md`, observationsHeader(monthLabel)]);

  const written: string[] = [];
  const skipped: string[] = [];

  for (const [relative, content] of files) {
    const filePath = path.join(absolute, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const exists = await fileExists(filePath);
    if (exists && !options.force) {
      skipped.push(relative);
      continue;
    }

    await fs.writeFile(filePath, content, "utf-8");
    written.push(relative);
  }

  await fs.mkdir(path.join(absolute, "relationships"), { recursive: true });
  await fs.mkdir(path.join(absolute, "projects"), { recursive: true });

  console.log(`\nVault initialized at ${absolute}\n`);
  if (written.length > 0) {
    console.log("Wrote:");
    for (const f of written) console.log(`  + ${f}`);
  }
  if (skipped.length > 0) {
    console.log("\nSkipped (already exists — re-run with --force to overwrite):");
    for (const f of skipped) console.log(`  . ${f}`);
  }

  console.log("\nNext steps:");
  console.log("  1. Edit identity.md and working-style.md with what matters.");
  console.log("  2. Point any agent at this directory:");
  console.log(`       - MCP: set WHITEBOX_VAULT_ROOT="${absolute}"`);
  console.log(`       - Paste-in: run 'whitebox paste' from inside the vault`);
  console.log(`       - Obsidian: open ${path.basename(absolute)} as a vault`);
  console.log("");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function formatMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names[m - 1]} ${y}`;
}
