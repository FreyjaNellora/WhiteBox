/**
 * Content script for gemini.google.com.
 *
 * Same pattern as claude-ai.js and chatgpt.js. Gemini uses a rich-text
 * contenteditable composer inside a <rich-textarea> custom element.
 * Selectors here are tuned against the public web UI; will drift when
 * Google ships redesigns. v0.4 will externalize selectors.
 */

(async () => {
  const wb = window.__whitebox;
  wb.log("gemini.google.com", "content script v0.3 live");

  const settings = await wb.getSettings();
  if (!settings.enabled) return;
  if (!settings.enabledSites?.gemini) return;

  const status = await wb.vaultStatus();
  if (!status.granted) {
    wb.log(
      "gemini.google.com",
      `vault not accessible (${status.reason || "unknown"}); open the extension popup and grant access.`,
    );
    return;
  }
  wb.log("gemini.google.com", `vault ready: ${status.vaultName}`);

  // Tear down if user disables WhiteBox mid-session via popup.
  wb.onSettingsChanged((changes) => {
    if (changes.enabled?.newValue === false) {
      wb.log("gemini.google.com", "disabled via settings change — tearing down");
      teardownAll();
    } else if (changes.enabledSites?.newValue?.gemini === false) {
      wb.log("gemini.google.com", "gemini disabled per-site — tearing down");
      teardownAll();
    }
  });

  // --- Cleanup ---
  const _intervals = [];
  const _listeners = []; // { target, event, handler, options }
  let tornDown = false;
  function registerListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    _listeners.push({ target, event, handler, options });
  }
  function teardownAll() {
    if (tornDown) return;
    tornDown = true;
    _intervals.forEach(clearInterval);
    _intervals.length = 0;
    _listeners.forEach(({ target, event, handler, options }) => {
      target.removeEventListener(event, handler, options);
    });
    _listeners.length = 0;
    wb.log("gemini.google.com", "teardownAll complete");
  }

  let bootstrapCache = null;
  let injectedForThisConversation = false;
  let currentConversationKey = conversationKey();

  const urlWatcher = setInterval(() => {
    const key = conversationKey();
    if (key !== currentConversationKey) {
      currentConversationKey = key;
      injectedForThisConversation = false;
    }
  }, 500);
  _intervals.push(urlWatcher);

  registerListener(
    document,
    "keydown",
    async (ev) => {
      if (tornDown) return;
      if (ev.key !== "Enter" || ev.shiftKey) return;
      if (injectedForThisConversation) return;
      const composer = findComposer();
      if (!composer) return;
      if (!composer.contains(ev.target) && ev.target !== composer) return;
      if (!isNewConversation()) return;

      ev.preventDefault();
      ev.stopPropagation();
      await injectAndSubmit(composer);
    },
    true,
  );

  registerListener(
    document,
    "click",
    async (ev) => {
      if (tornDown) return;
      if (injectedForThisConversation) return;
      const btn = ev.target.closest("button, [role='button']");
      if (!btn) return;
      if (!isSendButton(btn)) return;
      const composer = findComposer();
      if (!composer) return;
      if (!isNewConversation()) return;

      ev.preventDefault();
      ev.stopPropagation();
      await injectAndSubmit(composer);
    },
    true,
  );

  async function loadBootstrap() {
    if (bootstrapCache) return bootstrapCache;
    const res = await wb.readBootstrap();
    if (res.error) {
      wb.log("gemini.google.com", "bootstrap read failed:", res.error);
      return null;
    }
    bootstrapCache = wb.buildBootstrapText(res.files || {});
    return bootstrapCache;
  }

  async function injectAndSubmit(composer) {
    try {
      const bootstrap = await loadBootstrap();
      if (!bootstrap) return submitComposer(composer);

      const userText = readComposerText(composer);
      const combined = bootstrap + userText;
      writeComposerText(composer, combined);

      injectedForThisConversation = true;
      wb.log("gemini.google.com", `injected ${bootstrap.length} chars of vault context`);

      await new Promise((r) => setTimeout(r, 30));
      submitComposer(composer);
    } catch (err) {
      wb.log("gemini.google.com", "injection error; passing through:", err.message);
      submitComposer(composer);
    }
  }

  function findComposer() {
    return (
      document.querySelector("rich-textarea .ql-editor") ||
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('[aria-label*="prompt" i][contenteditable="true"]') ||
      document.querySelector('[aria-label*="message" i][contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      null
    );
  }

  function isSendButton(btn) {
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("send")) return true;
    if (aria.includes("submit")) return true;
    const text = (btn.textContent || "").trim().toLowerCase();
    if (text === "send" || text === "submit") return true;
    const mat = btn.querySelector("mat-icon, [data-icon]");
    const iconName = (mat?.textContent || mat?.getAttribute("data-icon") || "")
      .toLowerCase();
    if (iconName.includes("send")) return true;
    return false;
  }

  function isNewConversation() {
    // gemini.google.com/app: landing page before first message. After send,
    // URL becomes /app/<id>.
    const path = location.pathname;
    if (/\/app\/?$/.test(path)) return true;
    // Fallback: no model response bubbles yet.
    const modelMessages = document.querySelectorAll(
      "model-response, message-content[data-role='model']",
    );
    return modelMessages.length === 0;
  }

  function conversationKey() {
    const m = location.pathname.match(/\/app\/([^/?#]+)/);
    return m ? m[1] : location.pathname;
  }

  function readComposerText(composer) {
    return composer.innerText || composer.textContent || "";
  }

  function writeComposerText(composer, text) {
    // Gemini uses Quill's .ql-editor under the hood in some builds.
    // Replace content and dispatch input event so Angular/Quill picks it up.
    while (composer.firstChild) composer.removeChild(composer.firstChild);
    const lines = text.split("\n");
    for (const line of lines) {
      const p = document.createElement("p");
      if (line.length === 0) p.appendChild(document.createElement("br"));
      else p.textContent = line;
      composer.appendChild(p);
    }
    composer.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true }),
    );
  }

  function submitComposer(composer) {
    const buttons = Array.from(
      document.querySelectorAll("button, [role='button']"),
    );
    const send = buttons.find(isSendButton);
    if (send && !send.getAttribute("aria-disabled") && !send.disabled) {
      send.click();
      return;
    }

    composer.focus?.();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "wb:extract-last-assistant") {
      try {
        const text = extractLastAssistantText();
        sendResponse({
          ok: !!text,
          text: text || "",
          url: location.href,
          site: "gemini.google.com",
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return true;
    }
    if (msg?.type === "wb:extract-conversation") {
      try {
        const turns = extractConversation();
        sendResponse({
          ok: turns.length > 0,
          turns,
          url: location.href,
          site: "gemini.google.com",
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return true;
    }
    return false;
  });

  function extractLastAssistantText() {
    const candidates = document.querySelectorAll(
      "model-response, message-content[data-role='model']"
    );
    if (candidates.length === 0) return null;
    const last = candidates[candidates.length - 1];
    return (last.innerText || last.textContent || "").trim() || null;
  }

  function extractConversation() {
    // Gemini uses custom elements: user-query for input, model-response
    // for output. Walk both in DOM order.
    const nodes = document.querySelectorAll(
      "user-query, user-query-content, model-response, message-content[data-role='model']"
    );
    const turns = [];
    const seen = new Set();
    nodes.forEach((el, i) => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = (el.innerText || el.textContent || "").trim();
      if (!text) return;
      const tag = el.tagName.toLowerCase();
      const role =
        tag.startsWith("user") || /user/i.test(tag) ? "user" : "assistant";
      turns.push({
        id: `turn-${i}`,
        role,
        text,
      });
    });
    return turns;
  }

  // ─── Passive auto-logging ───────────────────────────────────────────
  // Track mounted state so a mid-session toggle in the popup activates the
  // logger without forcing a tab refresh.
  let passiveLogMounted = false;
  function ensurePassiveLog() {
    if (passiveLogMounted || tornDown) return;
    passiveLogMounted = true;
    const FLUSH_MS = 30_000;
    let lastTurnHash = "";
    let inflight = false;

    const flush = async (reason = "tick") => {
      if (inflight || tornDown) return;
      const id = location.pathname;
      if (!/\/app\//.test(id) && !/\/app\/?$/.test(id)) return;
      const turns = extractConversation();
      if (!turns.length) return;
      if (turns.length > 100) turns.splice(0, turns.length - 100);
      const hash = `${id}|${turns.length}|${turns[turns.length - 1]?.text?.slice(0, 80) || ""}`;
      if (hash === lastTurnHash && reason === "tick") return;
      lastTurnHash = hash;
      inflight = true;
      try {
        const res = await wb.appendConversationTurns({
          id,
          site: "gemini.google.com",
          capturedAt: new Date().toISOString(),
          turns,
        });
        if (res?.error) {
          wb.log("gemini.google.com", "passive log failed:", res.error);
        } else if (res?.written > 0) {
          wb.log("gemini.google.com", `passive log: wrote ${res.written} turn(s) to ${res.path}`);
        }
      } catch (err) {
        wb.log("gemini.google.com", "passive log error:", err.message || err);
      } finally {
        inflight = false;
      }
    };

    const flushInterval = setInterval(() => flush("tick"), FLUSH_MS);
    _intervals.push(flushInterval);

    registerListener(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") flush("hidden");
    });

    wb.log("gemini.google.com", "passive auto-logging enabled (30s flush)");
  }
  if (settings.passiveLog) ensurePassiveLog();
  wb.onSettingsChanged((changes) => {
    if (changes.passiveLog?.newValue === true) ensurePassiveLog();
  });

  window.addEventListener("beforeunload", teardownAll);
})();
