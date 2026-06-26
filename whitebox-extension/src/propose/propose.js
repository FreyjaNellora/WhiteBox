/**
 * Propose-an-observation page (post-Capture review).
 *
 * Discipline enforcement (added in v1.0.0-prealpha.6):
 * Per AGENTS.md: observation bodies should be verbatim quotes under ~500
 * chars; longer content goes to sources/<file>.md with source_ref: in
 * the observation. Earlier versions of Capture saved the whole assistant
 * response as the observation body, which produced over-long entries
 * that violated the spec the tool itself was meant to help follow.
 *
 * This page now adapts to capture length:
 *   - Short capture (≤500 chars): single-textarea flow as before.
 *   - Long capture (>500 chars):
 *       * Reference panel shows the full text (read-only, scrollable).
 *       * Body textarea is for the user's extracted key passage.
 *       * "Save full text as a source file" checkbox is shown + checked
 *         by default. On save, writes sources/YYYY-MM-DD-<slug>.md and
 *         injects source_ref: into the observation frontmatter.
 */

const SOFT_BODY_LIMIT = 500;

const emptyEl = document.getElementById("empty");
const formEl = document.getElementById("form");
const sourceEl = document.getElementById("source");
const bodyEl = document.getElementById("body");
const tagsEl = document.getElementById("tags");
const suggestionsEl = document.getElementById("tag-suggestions");
const confidenceEl = document.getElementById("confidence");
const contextEl = document.getElementById("context");
const metaSite = document.getElementById("meta-site");
const metaUrl = document.getElementById("meta-url");
const metaTime = document.getElementById("meta-time");
const saveBtn = document.getElementById("save");
const discardBtn = document.getElementById("discard");
const resultEl = document.getElementById("result");

const longBanner = document.getElementById("long-capture-banner");
const charCountEl = document.getElementById("char-count");
const referencePanel = document.getElementById("reference-panel");
const fullTextEl = document.getElementById("full-text");
const copyAllBtn = document.getElementById("copy-all-to-body");
const saveSourceSection = document.getElementById("save-source-section");
const saveAsSourceCb = document.getElementById("save-as-source");
const bodyHint = document.getElementById("body-hint");

let pendingProposal = null;
let isLongCapture = false;

async function load() {
  const stored = await chrome.storage.session.get("pendingProposal");
  pendingProposal = stored?.pendingProposal || null;

  if (!pendingProposal) {
    emptyEl.classList.remove("hidden");
    return;
  }

  formEl.classList.remove("hidden");
  sourceEl.value = pendingProposal.source || "whitebox-extension";
  metaSite.textContent = pendingProposal.site || "—";
  metaUrl.textContent = pendingProposal.url || "—";
  metaTime.textContent = pendingProposal.capturedAt
    ? new Date(pendingProposal.capturedAt).toLocaleString()
    : "—";

  const text = pendingProposal.text || "";
  isLongCapture = text.length > SOFT_BODY_LIMIT;

  if (isLongCapture) {
    // Long-capture mode: show reference panel + source-save checkbox,
    // leave body empty so the user is prompted to extract.
    longBanner.classList.remove("hidden");
    charCountEl.textContent = String(text.length);
    referencePanel.classList.remove("hidden");
    fullTextEl.value = text;
    saveSourceSection.classList.remove("hidden");
    bodyEl.value = "";
    bodyEl.placeholder =
      "Extract a key passage from the full text above. Aim for under ~500 chars. The agent will see this verbatim every session.";
  } else {
    // Short capture: original single-textarea flow.
    bodyEl.value = text;
  }

  updateBodyHint();
  await loadTagSuggestions();
}

function updateBodyHint() {
  const len = bodyEl.value.length;
  if (len === 0) {
    bodyHint.textContent = "";
    bodyHint.classList.remove("body-hint--warn");
    return;
  }
  bodyHint.textContent = `(${len} chars)`;
  bodyHint.classList.toggle("body-hint--warn", len > SOFT_BODY_LIMIT);
}

bodyEl.addEventListener("input", updateBodyHint);

if (copyAllBtn) {
  copyAllBtn.addEventListener("click", () => {
    bodyEl.value = fullTextEl.value;
    updateBodyHint();
    bodyEl.focus();
  });
}

async function loadTagSuggestions() {
  const res = await chrome.runtime.sendMessage({
    type: "wb:read-file",
    path: "tags.md",
  });
  if (!res?.ok || !res.content) return;

  const tags = parseActiveTags(res.content);
  suggestionsEl.innerHTML = "";
  for (const tag of tags) {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag;
    chip.addEventListener("click", () => addTag(tag));
    suggestionsEl.appendChild(chip);
  }
}

function parseActiveTags(content) {
  const activeMatch = content.match(/##\s*Active([\s\S]*?)(?:##\s*Proposed|$)/i);
  const block = activeMatch ? activeMatch[1] : content;
  const tags = [];
  const lineRe = /^[-*]\s*`([^`]+)`/gm;
  let match;
  while ((match = lineRe.exec(block))) {
    tags.push(match[1]);
  }
  return tags;
}

function addTag(tag) {
  const current = tagsEl.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (current.includes(tag)) return;
  current.push(tag);
  tagsEl.value = current.join(", ");
}

async function save() {
  resultEl.textContent = "";
  resultEl.classList.remove("error");

  const body = bodyEl.value.trim();
  if (!body) {
    resultEl.textContent = "Body is empty.";
    resultEl.classList.add("error");
    return;
  }

  const tags = tagsEl.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (tags.length === 0) {
    resultEl.textContent = "Add at least one tag.";
    resultEl.classList.add("error");
    return;
  }

  // Soft warning for over-length bodies (don't block — user may have
  // explicitly chosen to save a long quote verbatim).
  if (body.length > SOFT_BODY_LIMIT) {
    const proceed = confirm(
      `The observation body is ${body.length} chars — longer than the spec's ~500 char guideline.\n\n` +
        `Recommended: trim to a key quote and tick "Save full text as source file" to keep the long content reachable.\n\n` +
        `Save anyway?`,
    );
    if (!proceed) return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  // Step 1 (long captures only): write the source file first so we have
  // a path to put in source_ref. If this fails, abort the whole save —
  // we don't want an observation with a dangling source_ref.
  let sourceRef = null;
  if (isLongCapture && saveAsSourceCb && saveAsSourceCb.checked) {
    const sourcePayload = {
      text: pendingProposal.text,
      source: sourceEl.value.trim() || pendingProposal.source || "whitebox-extension",
      url: pendingProposal.url,
      site: pendingProposal.site,
      title: pendingProposal.title,
      date: undefined, // background uses today()
    };
    const sourceRes = await chrome.runtime.sendMessage({
      type: "wb:write-source",
      payload: sourcePayload,
    });
    if (sourceRes?.error) {
      resultEl.textContent = `Source file write failed: ${sourceRes.error}`;
      resultEl.classList.add("error");
      saveBtn.disabled = false;
      saveBtn.textContent = "Save to vault";
      return;
    }
    sourceRef = sourceRes.path;
  }

  // Step 2: append the observation, including source_ref if we have one.
  const payload = {
    source: sourceEl.value.trim() || "whitebox-extension",
    tags,
    confidence: confidenceEl.value,
    body,
  };
  if (sourceRef) payload.source_ref = sourceRef;
  const ctx = contextEl.value.trim();
  if (ctx) payload.context = ctx;

  const res = await chrome.runtime.sendMessage({
    type: "wb:append-observation",
    payload,
  });

  if (res?.error) {
    resultEl.textContent = `Save failed: ${res.error}`;
    resultEl.classList.add("error");
    saveBtn.disabled = false;
    saveBtn.textContent = "Save to vault";
    return;
  }

  let msg = `Saved to ${res.path}.`;
  if (sourceRef) msg += ` Full text preserved at ${sourceRef}.`;
  msg += " You can close this tab.";
  resultEl.textContent = msg;
  await chrome.storage.session.remove("pendingProposal");
  saveBtn.textContent = "Saved";
}

async function discard() {
  if (!confirm("Discard this proposed observation?")) return;
  await chrome.storage.session.remove("pendingProposal");
  resultEl.textContent = "Discarded. You can close this tab.";
  saveBtn.disabled = true;
  discardBtn.disabled = true;
}

saveBtn.addEventListener("click", save);
discardBtn.addEventListener("click", discard);

load();
