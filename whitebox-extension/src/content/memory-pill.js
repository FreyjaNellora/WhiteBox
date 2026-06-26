/**
 * Floating memory-status pill — injected on AI chat pages.
 *
 * Shows two small indicators:
 *   A = active memory (observations via {wb-save})
 *   P = passive memory (conversation logging)
 *
 * Draggable. Position persists in chrome.storage.local.
 * Pulses briefly when a write event fires.
 * Stays out of the way — small, translucent, docked to a corner by default.
 */

(() => {
  if (document.getElementById("wb-memory-pill")) return;

  const STORAGE_KEY = "memoryPillPosition";
  const PILL_ID = "wb-memory-pill";

  // ─── Create DOM ──────────────────────────────────────────────────────
  const pill = document.createElement("div");
  pill.id = PILL_ID;
  pill.innerHTML = `
    <span class="wb-pill-dot" id="wb-dot-a" title="Active memory: checking...">A</span>
    <span class="wb-pill-dot" id="wb-dot-p" title="Passive memory: checking...">P</span>
    <button class="wb-pill-reconnect" id="wb-reconnect" hidden title="Click to reconnect vault">!</button>
  `;
  document.body.appendChild(pill);

  // ─── Styles (injected as a <style> to avoid external CSS files) ──────
  const style = document.createElement("style");
  style.textContent = `
    #${PILL_ID} {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      display: flex;
      gap: 4px;
      padding: 4px 6px;
      border-radius: 12px;
      background: rgba(30, 30, 30, 0.7);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      cursor: grab;
      user-select: none;
      transition: opacity 200ms ease, transform 200ms ease;
      opacity: 0.6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }

    #${PILL_ID}:hover {
      opacity: 1;
    }

    #${PILL_ID}.wb-dragging {
      cursor: grabbing;
      opacity: 1;
      transform: scale(1.1);
    }

    .wb-pill-dot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0;
      cursor: grab;
      transition: background 300ms ease, color 300ms ease, box-shadow 300ms ease;
    }

    .wb-pill-reconnect {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 800;
      border: none;
      cursor: pointer;
      background: rgba(200, 120, 40, 0.9);
      color: #fff;
      padding: 0;
      animation: wb-reconnect-pulse 1.5s ease-in-out infinite;
    }

    .wb-pill-reconnect:hover {
      background: rgba(220, 140, 50, 1);
      transform: scale(1.15);
    }

    @keyframes wb-reconnect-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(200, 120, 40, 0.6); }
      50% { box-shadow: 0 0 6px 3px rgba(200, 120, 40, 0.3); }
    }

    .wb-pill-dot.wb-off {
      background: rgba(120, 120, 120, 0.5);
      color: rgba(180, 180, 180, 0.7);
    }

    .wb-pill-dot.wb-warn {
      background: rgba(200, 120, 40, 0.85);
      color: #fff;
    }

    .wb-pill-dot.wb-on {
      background: rgba(34, 160, 80, 0.85);
      color: #fff;
    }

    .wb-pill-dot.wb-flash {
      animation: wb-pill-flash 600ms ease-out;
    }

    @keyframes wb-pill-flash {
      0% { box-shadow: 0 0 0 0 rgba(34, 160, 80, 0.7); }
      50% { box-shadow: 0 0 8px 4px rgba(34, 160, 80, 0.4); }
      100% { box-shadow: 0 0 0 0 rgba(34, 160, 80, 0); }
    }

    @keyframes wb-pill-pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    #${PILL_ID}.wb-pulse {
      animation: wb-pill-pulse 3s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);

  const dotA = document.getElementById("wb-dot-a");
  const dotP = document.getElementById("wb-dot-p");
  const reconnectBtn = document.getElementById("wb-reconnect");

  // Detect extension context invalidation via heartbeat.
  //
  // The background service worker broadcasts a heartbeat every 5s.
  // If we miss two consecutive heartbeats (10s grace), we assume the
  // extension has been reloaded or disabled and self-destruct.
  // This is more reliable than checking chrome.runtime.id, which
  // false-positives during transient service-worker suspensions.
  let lastHeartbeatAt = Date.now();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "wb:heartbeat") {
      lastHeartbeatAt = Date.now();
    }
    return false;
  });

  function isInvalidated() {
    return Date.now() - lastHeartbeatAt > 10_000;
  }

  function selfDestruct() {
    clearInterval(stateInterval);
    pill.remove();
    style.remove();
    delete window.__wbPillFlash;
    delete window.__wbPillDestroy;
  }

  // One-click reconnect: opens a tiny page that calls requestPermission().
  reconnectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isInvalidated()) { selfDestruct(); return; }
    try {
      const url = chrome.runtime.getURL("src/regrant/regrant.html");
      window.open(url, "wb-regrant", "width=420,height=280");
    } catch { selfDestruct(); }
  });

  // ─── State ──────────────────────────────────────────────────────────
  async function updateState() {
    if (isInvalidated()) { selfDestruct(); return; }
    const wb = window.__whitebox;
    if (!wb) return;

    let settings, status;
    try {
      settings = await wb.getSettings();
      status = await wb.vaultStatus();
    } catch { selfDestruct(); return; }
    const enabled = !!settings.enabled;
    const granted = !!status.granted;
    const passive = !!settings.passiveLog;

    const activeOn = enabled && granted;
    const passiveOn = enabled && granted && passive;
    const needsGrant = enabled && !granted;

    // Active memory dot
    dotA.classList.remove("wb-on", "wb-off", "wb-warn");
    if (needsGrant) {
      dotA.classList.add("wb-warn");
      dotA.title = "Active memory: vault not connected — click WhiteBox icon to grant access";
    } else if (activeOn) {
      dotA.classList.add("wb-on");
      dotA.title = "Active memory: ON — observations are being written to your vault";
    } else {
      dotA.classList.add("wb-off");
      dotA.title = "Active memory: OFF" + (!enabled ? " (disabled)" : "");
    }

    // Passive memory dot
    dotP.classList.remove("wb-on", "wb-off", "wb-warn");
    if (needsGrant) {
      dotP.classList.add("wb-warn");
      dotP.title = "Passive memory: vault not connected — click WhiteBox icon to grant access";
    } else if (passiveOn) {
      dotP.classList.add("wb-on");
      dotP.title = "Passive memory: ON — conversations are being logged";
    } else {
      dotP.classList.add("wb-off");
      dotP.title = "Passive memory: OFF" + (activeOn ? " (enable in popup → Passive log)" : "");
    }

    // Show reconnect button when vault needs re-granting
    reconnectBtn.hidden = !needsGrant;

    // Gentle background pulse when both are active
    pill.classList.toggle("wb-pulse", activeOn && passiveOn);
  }

  updateState();
  // Re-check every 5s (catches setting changes from popup without listeners)
  const stateInterval = setInterval(updateState, 5000);

  // Also update immediately when storage changes
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (isInvalidated()) { selfDestruct(); return; }
      if (area !== "local") return;
      if (changes.enabled || changes.passiveLog) updateState();
    });
  } catch { /* extension already invalidated */ }

  // ─── Flash on write events ──────────────────────────────────────────
  // The content scripts send messages through chrome.runtime. We listen
  // for the background worker's responses to detect saves.
  function flashDot(dot) {
    dot.classList.remove("wb-flash");
    // Force reflow to restart animation
    void dot.offsetWidth;
    dot.classList.add("wb-flash");
    setTimeout(() => dot.classList.remove("wb-flash"), 700);
  }

  // Expose flash so content scripts can call it after a save
  window.__wbPillFlash = (type) => {
    if (type === "active") flashDot(dotA);
    else if (type === "passive") flashDot(dotP);
  };

  // ─── Dragging ───────────────────────────────────────────────────────
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Restore saved position
  try {
    chrome.storage.local.get(STORAGE_KEY, (data) => {
      if (chrome.runtime.lastError) return;
      const pos = data?.[STORAGE_KEY];
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
        pill.style.right = "auto";
        pill.style.bottom = "auto";
        pill.style.left = Math.min(pos.x, window.innerWidth - 60) + "px";
        pill.style.top = Math.min(pos.y, window.innerHeight - 30) + "px";
      }
    });
  } catch { /* invalidated */ }

  pill.addEventListener("mousedown", (e) => {
    isDragging = true;
    pill.classList.add("wb-dragging");
    const rect = pill.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const x = Math.max(0, Math.min(e.clientX - dragOffsetX, window.innerWidth - pill.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - dragOffsetY, window.innerHeight - pill.offsetHeight));
    pill.style.left = x + "px";
    pill.style.top = y + "px";
    pill.style.right = "auto";
    pill.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    pill.classList.remove("wb-dragging");
    // Persist position
    if (isInvalidated()) { selfDestruct(); return; }
    try {
      const rect = pill.getBoundingClientRect();
      chrome.storage.local.set({
        [STORAGE_KEY]: { x: rect.left, y: rect.top },
      });
    } catch { selfDestruct(); }
  });

  // ─── Cleanup hook ───────────────────────────────────────────────────
  window.__wbPillDestroy = selfDestruct;
})();
