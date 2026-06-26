/**
 * Session-digest bulk-save page.
 *
 * Discipline enforcement (added in v1.0.0-prealpha.6):
 * When "Auto-source long turns" is checked (default), any selected turn
 * whose text exceeds 500 chars is written to sources/YYYY-MM-DD-<slug>.md
 * and the companion observation gets a short extract + source_ref back
 * to that file. Keeps observations under the spec's ~500 char guideline
 * while preserving the full turn content reachable.
 *
 * When unchecked, the older behavior applies (whole turn text → observation
 * body). We expose the toggle honestly rather than silently changing
 * semantics between versions.
 */

const SOFT_BODY_LIMIT = 500;
const EXCERPT_TARGET = 400; // chars before " […]"

const emptyEl = document.getElementById("empty");
const metaEl = document.getElementById("meta");
const controlsEl = document.getElementById("controls");
const turnsEl = document.getElementById("turns");
const resultEl = document.getElementById("result");

const metaSite = document.getElementById("meta-site");
const metaCount = document.getElementById("meta-count");
const metaUrl = document.getElementById("meta-url");

const showUser = document.getElementById("show-user");
const showAssistant = document.getElementById("show-assistant");
const selectNoneBtn = document.getElementById("select-none");
const saveAllBtn = document.getElementById("save-all");
const bulkTagsEl = document.getElementById("bulk-tags");
const confidenceEl = document.getElementById("confidence");
const autoSourceCb = document.getElementById("auto-source");

let digest = null;

async function load() {
  const stored = await chrome.storage.session.get("pendingDigest");
  digest = stored?.pendingDigest || null;

  if (!digest) {
    emptyEl.classList.remove("hidden");
    return;
  }

  metaEl.classList.remove("hidden");
  controlsEl.classList.remove("hidden");
  turnsEl.classList.remove("hidden");

  metaSite.textContent = digest.site || "—";
  metaCount.textContent = String(digest.turns?.length || 0);
  metaUrl.textContent = digest.url || "—";

  renderTurns();
}

function renderTurns() {
  turnsEl.innerHTML = "";
  (digest.turns || []).forEach((turn) => {
    const wrap = document.createElement("div");
    wrap.className = `turn role-${turn.role}`;
    wrap.dataset.turnId = turn.id;
    wrap.dataset.role = turn.role;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `cb-${turn.id}`;
    cb.addEventListener("change", () => {
      wrap.classList.toggle("selected", cb.checked);
    });

    const body = document.createElement("div");
    body.className = "turn-body";

    const role = document.createElement("div");
    role.className = "turn-role";
    role.textContent = turn.role;

    // Length badge — flags long turns so the user knows source-routing
    // will apply (when the auto-source checkbox is on).
    const len = (turn.text || "").length;
    const lenBadge = document.createElement("span");
    lenBadge.className = "turn-len";
    lenBadge.textContent = `${len} chars`;
    if (len > SOFT_BODY_LIMIT) lenBadge.classList.add("turn-len--long");
    role.appendChild(lenBadge);

    const text = document.createElement("div");
    text.className = "turn-text";
    text.textContent = turn.text;

    body.appendChild(role);
    body.appendChild(text);
    wrap.appendChild(cb);
    wrap.appendChild(body);
    turnsEl.appendChild(wrap);
  });
  applyFilters();
}

function applyFilters() {
  const wantUser = showUser.checked;
  const wantAssistant = showAssistant.checked;
  [...turnsEl.querySelectorAll(".turn")].forEach((t) => {
    const r = t.dataset.role;
    const show =
      (r === "user" && wantUser) || (r === "assistant" && wantAssistant);
    t.classList.toggle("hidden-by-filter", !show);
  });
}

function selectedTurns() {
  const selected = [];
  [...turnsEl.querySelectorAll(".turn")].forEach((t) => {
    const cb = t.querySelector('input[type="checkbox"]');
    if (cb?.checked && !t.classList.contains("hidden-by-filter")) {
      const id = t.dataset.turnId;
      const turn = digest.turns.find((x) => x.id === id);
      if (turn) selected.push(turn);
    }
  });
  return selected;
}

async function saveAll() {
  resultEl.classList.remove("hidden");
  resultEl.classList.remove("error");
  resultEl.textContent = "";

  const selected = selectedTurns();
  if (selected.length === 0) {
    resultEl.classList.add("error");
    resultEl.textContent = "Nothing selected. Tick at least one turn to save.";
    return;
  }

  const tags = bulkTagsEl.value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tags.length === 0) {
    resultEl.classList.add("error");
    resultEl.textContent = "Add at least one tag before saving.";
    return;
  }

  saveAllBtn.disabled = true;
  saveAllBtn.textContent = "Saving…";

  const confidence = confidenceEl.value;
  const source = digest.source || "whitebox-extension";
  const autoSource = !!(autoSourceCb && autoSourceCb.checked);

  const successes = [];
  const failures = [];
  let sourcesCreated = 0;

  for (const turn of selected) {
    const turnText = String(turn.text || "");
    let body = turnText;
    let sourceRef = null;

    // Long-turn handling: write full text to sources/ and use a short
    // excerpt (with ellipsis) as the observation body. Keeps active
    // memory dense; full content remains reachable via source_ref.
    if (autoSource && turnText.length > SOFT_BODY_LIMIT) {
      const sourceRes = await chrome.runtime.sendMessage({
        type: "wb:write-source",
        payload: {
          text: turnText,
          source,
          url: digest.url,
          site: digest.site,
          title: turn.role + " turn (" + turnText.length + " chars)",
        },
      });
      if (sourceRes?.error) {
        failures.push({ turn, error: "source write failed: " + sourceRes.error });
        continue;
      }
      sourceRef = sourceRes.path;
      sourcesCreated += 1;
      // Excerpt the body to ~400 chars at a word boundary, append " […]"
      // so anyone reading sees the truncation marker.
      let excerpt = turnText.slice(0, EXCERPT_TARGET);
      const lastSpace = excerpt.lastIndexOf(" ");
      if (lastSpace > EXCERPT_TARGET * 0.7) excerpt = excerpt.slice(0, lastSpace);
      body = excerpt.trim() + " […]";
    }

    const payload = {
      source,
      tags,
      confidence,
      body,
    };
    if (sourceRef) payload.source_ref = sourceRef;

    const res = await chrome.runtime.sendMessage({
      type: "wb:append-observation",
      payload,
    });
    if (res?.error) {
      failures.push({ turn, error: res.error });
    } else {
      successes.push({ turn, path: res.path, sourceRef });
    }
  }

  let msg = `Saved ${successes.length} of ${selected.length} selected.`;
  if (successes[0]?.path) msg += ` Appended to ${successes[0].path}.`;
  if (sourcesCreated > 0) {
    msg += ` ${sourcesCreated} long turn${sourcesCreated === 1 ? "" : "s"} written to sources/ with source_ref back-links.`;
  }
  if (failures.length > 0) {
    msg += ` ${failures.length} failed: ${failures.map((f) => f.error).join("; ")}`;
    resultEl.classList.add("error");
  }
  resultEl.textContent = msg;

  if (failures.length === 0) {
    await chrome.storage.session.remove("pendingDigest");
    saveAllBtn.textContent = "Saved";
  } else {
    saveAllBtn.disabled = false;
    saveAllBtn.textContent = "Save selected";
  }
}

function selectNone() {
  [...turnsEl.querySelectorAll('input[type="checkbox"]')].forEach((cb) => {
    cb.checked = false;
    cb.closest(".turn")?.classList.remove("selected");
  });
}

showUser.addEventListener("change", applyFilters);
showAssistant.addEventListener("change", applyFilters);
selectNoneBtn.addEventListener("click", selectNone);
saveAllBtn.addEventListener("click", saveAll);

load();
