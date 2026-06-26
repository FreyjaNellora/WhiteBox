/**
 * WhiteBox setup wizard.
 *
 * Multi-step flow: welcome → vault → identity → working style → style → done.
 * Auto-creates AGENTS.md, identity.md, working-style.md, tags.md when the
 * user picks an empty (or non-vault) folder, so non-developer users
 * never need to touch the CLI to bootstrap a vault.
 */

import {
  saveVaultHandle,
  loadVaultHandle,
  hasPermission,
  ensurePermission,
  listTopLevel,
} from "../lib/vault-handle.js";

// ─── Step navigation ─────────────────────────────────────────────────────
const stepIds = ["welcome", "vault", "identity", "working-style", "style", "done"];
const stepEls = Object.fromEntries(
  stepIds.map((id) => [id, document.getElementById("step-" + id)]),
);
const indicatorItems = Array.from(
  document.querySelectorAll("#step-indicator li"),
);

function goto(stepName) {
  for (const id of stepIds) {
    stepEls[id].hidden = id !== stepName;
    stepEls[id].classList.toggle("active", id === stepName);
  }
  indicatorItems.forEach((li) => {
    li.classList.toggle("active", li.dataset.step === stepName);
  });
  // Scroll to top so the wizard doesn't feel laggy on small screens.
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Wire all data-goto buttons
document.querySelectorAll("[data-goto]").forEach((btn) => {
  btn.addEventListener("click", async (ev) => {
    const target = btn.getAttribute("data-goto");
    // Some transitions trigger a side effect (write files, save settings).
    if (target === "identity" && btn.id === "vault-continue") {
      // No-op; vault was already saved at pick time
    } else if (target === "working-style" && btn.id === "identity-continue") {
      await writeIdentityFiles();
    } else if (target === "style" && btn.id === "ws-continue") {
      await writeWorkingStyleFile();
    } else if (target === "done" && btn.id === "style-continue") {
      await writeStyleSetting();
    }
    goto(target);
  });
});

// ─── Step 2: vault ───────────────────────────────────────────────────────
const pickFolderBtn = document.getElementById("pick-folder-btn");
const vaultPickResult = document.getElementById("vault-pick-result");
const vaultPickWarn = document.getElementById("vault-pick-warn");
const vaultActions = document.getElementById("vault-actions");

let currentHandle = null;

pickFolderBtn.addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({
      id: "whitebox-vault",
      mode: "readwrite",
      startIn: "documents",
    });
    const ok = await ensurePermission(handle, "readwrite");
    if (!ok) {
      vaultPickWarn.textContent = "Permission denied. Try picking the folder again.";
      vaultPickWarn.hidden = false;
      return;
    }
    currentHandle = handle;
    await saveVaultHandle(handle);

    // Inspect the folder. If it has no AGENTS.md, scaffold a fresh vault.
    const entries = await listTopLevel(handle);
    const hasAgents = entries.some((e) => e.name === "AGENTS.md");
    if (!hasAgents) {
      vaultPickResult.innerHTML =
        `Picked <strong>${escapeHtml(handle.name)}</strong> — empty / not yet a vault. Setting up a fresh one for you…`;
      vaultPickResult.hidden = false;
      vaultPickWarn.hidden = true;
      try {
        await scaffoldFreshVault(handle);
        vaultPickResult.innerHTML =
          `Vault created in <strong>${escapeHtml(handle.name)}</strong>. Files: AGENTS.md, identity.md, working-style.md, tags.md, observations/.`;
      } catch (err) {
        vaultPickWarn.textContent = "Couldn't scaffold the vault: " + err.message;
        vaultPickWarn.hidden = false;
        return;
      }
    } else {
      vaultPickResult.innerHTML =
        `Connected to existing vault in <strong>${escapeHtml(handle.name)}</strong> (${entries.length} top-level entries, AGENTS.md present).`;
      vaultPickResult.hidden = false;
      vaultPickWarn.hidden = true;
    }

    vaultActions.hidden = false;
  } catch (err) {
    if (err?.name === "AbortError") return; // user cancelled picker
    vaultPickWarn.textContent = "Couldn't connect: " + err.message;
    vaultPickWarn.hidden = false;
  }
});

// ─── Step 3: identity ────────────────────────────────────────────────────
async function writeIdentityFiles() {
  const handle = currentHandle || (await loadVaultHandle());
  if (!handle) return;

  const name = (document.getElementById("ident-name").value || "").trim();
  const occupation = (document.getElementById("ident-occupation").value || "").trim();
  const location = (document.getElementById("ident-location").value || "").trim();
  const extra = (document.getElementById("ident-extra").value || "").trim();

  if (!name && !occupation && !location && !extra) return; // nothing entered, leave default

  const lines = [
    "---",
    "schema: whitebox/1.0",
    "---",
    "",
    "# Identity",
    "",
    "Stable, long-lived facts about who I am. Edit freely.",
    "",
  ];
  if (name) lines.push(`- Name: ${name}`);
  if (occupation) lines.push(`- Occupation / role: ${occupation}`);
  if (location) lines.push(`- Location: ${location}`);
  lines.push("- Active projects: see `projects/`");
  lines.push("- Significant people: see `relationships/`");
  if (extra) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    lines.push(extra);
  }
  lines.push("");

  await writeVaultFile(handle, "identity.md", lines.join("\n"));
}

// ─── Step 4: working style ───────────────────────────────────────────────
async function writeWorkingStyleFile() {
  const handle = currentHandle || (await loadVaultHandle());
  if (!handle) return;

  const pace = getRadio("ws-pace");
  const register = getRadio("ws-register");
  const pushback = getRadio("ws-pushback");
  const unhelpful = (document.getElementById("ws-unhelpful").value || "").trim();

  const paceText = {
    step: "One step at a time. Don't dump full plans up front; show me one move and let me react.",
    full: "Give me the full plan up front so I can see the whole arc before we start.",
    adaptive: "Let me steer per task. Ask if you're unsure how much detail I want.",
  }[pace] || "";

  const registerText = {
    terse: "Direct and terse. No softening, no trailing summaries, no warm-up.",
    warm: "Warm and conversational. Friendly tone is welcome.",
    default: "No strong preference on register; default is fine.",
  }[register] || "";

  const pushbackText = {
    strong: "Push back hard when you disagree. Sycophancy reads as a warning sign.",
    gentle: "Note disagreements but defer to me unless I ask for a deeper challenge.",
    default: "Default behavior is fine.",
  }[pushback] || "";

  const lines = [
    "---",
    "schema: whitebox/1.0",
    "---",
    "",
    "# Working style",
    "",
    "How I want AI agents to work with me. Read this before responding.",
    "",
    "## Pace",
    "",
    paceText,
    "",
    "## Register",
    "",
    registerText,
    "",
    "## Pushback",
    "",
    pushbackText,
    "",
  ];
  if (unhelpful) {
    lines.push("## What I find unhelpful");
    lines.push("");
    lines.push(unhelpful);
    lines.push("");
  }

  await writeVaultFile(handle, "working-style.md", lines.join("\n"));
}

// ─── Step 5: style preset ────────────────────────────────────────────────
async function writeStyleSetting() {
  const style = getRadio("ui-style") || "office";
  await chrome.runtime.sendMessage({
    type: "wb:set-settings",
    payload: {
      style,
      enabled: true,
      firstRunComplete: true,
    },
  });
}

// ─── Step 6: done ────────────────────────────────────────────────────────
document.getElementById("close-tab-btn").addEventListener("click", () => {
  window.close();
});

// ─── Helpers ─────────────────────────────────────────────────────────────
function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

async function writeVaultFile(handle, relativePath, text) {
  const segments = relativePath.split("/").filter(Boolean);
  let dir = handle;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i], { create: true });
  }
  const fileName = segments[segments.length - 1];
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(text);
  await writable.close();
}

/**
 * Create a minimal-but-complete vault from scratch in the picked folder.
 * Mirrors `whitebox init` from the CLI so non-developer users never need
 * the terminal.
 */
async function scaffoldFreshVault(handle) {
  await writeVaultFile(handle, "AGENTS.md", VAULT_AGENTS_MD);
  await writeVaultFile(handle, "identity.md", VAULT_IDENTITY_MD);
  await writeVaultFile(handle, "working-style.md", VAULT_WORKING_STYLE_MD);
  await writeVaultFile(handle, "tags.md", VAULT_TAGS_MD);
  await writeVaultFile(handle, "README.md", VAULT_README_MD);
  // Create observations/ dir by writing an empty placeholder
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  await writeVaultFile(
    handle,
    `observations/${yyyy}-${mm}.md`,
    `# Observations — ${monthLabel(yyyy, today.getMonth())}\n\nAppend-only. One observation per entry. Never edit another agent's entries.\n\n---\n`,
  );
}

function monthLabel(year, monthIdx) {
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[monthIdx]} ${year}`;
}

// ─── Vault file templates (kept short so the wizard doesn't take forever) ─
const VAULT_AGENTS_MD = `# WhiteBox vault — orientation for agents

This directory is a user-memory vault in WhiteBox/1.1 format. The user owns these files. Multiple agents read and write here.

## At session start

1. Read \`identity.md\` and \`working-style.md\`.
2. Skim the latest file in \`observations/\`.

## Discipline

1. **Verbatim bodies.** Observations must be direct quotes — the user's words or your own words the user affirmed. Never paraphrase or invent.
2. **Anti-characterization.** Tag for behavior or topic, never for character. \`tags: [working-style, correction]\` ✓. \`tags: [abrasive, demanding]\` ✗.
3. **Idle-stability.** Before saving autonomously, check if the observation actually adds anything new. If it just restates known content, skip the save.

## Confidence scale

very-low | low | medium | high | very-high

## Saving observations

Append a fenced block to \`observations/YYYY-MM.md\`:

\`\`\`
---
date: YYYY-MM-DD
source: <your model identity>
tags: [tag1, tag2]
confidence: medium
---

Direct verbatim quote.
\`\`\`

When you save autonomously (without asking), acknowledge with one line per file:

\`\`\`
{saved memory: observations/YYYY-MM.md time:HH:MM}
\`\`\`

## Rules summary

- Never edit another agent's observation. Append your own.
- Never silently overwrite stable files (\`identity.md\`, \`working-style.md\`).
- Tag for behavior, never for character.
- Never fabricate. When uncertain, ask the user or skip the capture.
`;

const VAULT_IDENTITY_MD = `---
schema: whitebox/1.0
---

# Identity

Stable, long-lived facts about who I am. Edit freely.

- Name:
- Occupation / role:
- Location:
- Active projects: see \`projects/\`
- Significant people: see \`relationships/\`
`;

const VAULT_WORKING_STYLE_MD = `---
schema: whitebox/1.0
---

# Working style

How I want AI agents to work with me. Read this before responding.

## Pace

(e.g., one step at a time, or full plans up front)

## Register

(e.g., direct and terse, no softening, no trailing summaries)

## Pushback

Do I want agents to push back when they disagree with me? When?
`;

const VAULT_TAGS_MD = `---
schema: whitebox/1.0
---

# Tags

Canonical tags for observations in this vault.

## Active

- \`working-style\` — how the user wants to be worked with
- \`correction\` — user corrected the agent
- \`preference\` — stated likes and dislikes
- \`relationship:<name>\` — observations specific to a named person
- \`project:<slug>\` — observations tied to a named project
- \`health\` — medical, sleep, energy, mood relevant to capacity
- \`emotional-state\` — temporary mood, stress, context
- \`interest\` — things the user is curious about or engaged with
- \`conflict\` — observations that contradict an existing stable fact

## Proposed

(agents append here)
`;

const VAULT_README_MD = `# My WhiteBox vault

Portable user memory for AI agents. Open any file in your text editor; edit freely.

- \`AGENTS.md\` — instructions any AI reads first.
- \`identity.md\` — stable facts about you.
- \`working-style.md\` — how you want agents to work with you.
- \`tags.md\` — vocabulary for categorizing observations.
- \`observations/\` — append-only monthly logs of what agents have learned.

You own these files. Nothing leaves your machine unless you set up sync yourself (git, Syncthing, etc.).
`;

// ─── On load: detect if a vault is already connected and skip ahead ──────
(async () => {
  const handle = await loadVaultHandle();
  if (!handle) return;
  currentHandle = handle;
  const granted = await hasPermission(handle, "readwrite");
  if (!granted) return;
  // Already set up → show the welcome with a hint they can skip to done
  // (we don't auto-skip, in case they want to re-run the wizard)
})();
