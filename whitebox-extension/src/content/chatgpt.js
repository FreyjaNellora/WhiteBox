/**
 * Content script for chatgpt.com (and legacy chat.openai.com).
 *
 * Mirrors the claude-ai.js pattern: on a new conversation, hook the
 * submit path and prepend the WhiteBox bootstrap to the first user
 * message. Fails safe — if anything breaks, the user's message sends
 * unchanged.
 *
 * Selectors are best-effort. ChatGPT redesigns frequently; keep these
 * loose and update when they break. v0.4 will externalize selectors.
 */

(async () => {
  const wb = window.__whitebox;
  wb.log("chatgpt.com", "content script v0.3 live");

  const settings = await wb.getSettings();
  if (!settings.enabled) return;
  if (!settings.enabledSites?.chatgpt) return;

  const status = await wb.vaultStatus();
  if (!status.granted) {
    wb.log(
      "chatgpt.com",
      `vault not accessible (${status.reason || "unknown"}); open the extension popup and grant access.`,
    );
    return;
  }
  wb.log("chatgpt.com", `vault ready: ${status.vaultName}`);

  // Tear down if user disables WhiteBox mid-session via popup.
  wb.onSettingsChanged((changes) => {
    if (changes.enabled?.newValue === false) {
      wb.log("chatgpt.com", "disabled via settings change — tearing down");
      teardownAll();
    } else if (changes.enabledSites?.newValue?.chatgpt === false) {
      wb.log("chatgpt.com", "chatgpt disabled per-site — tearing down");
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
    wb.log("chatgpt.com", "teardownAll complete");
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
      const btn = ev.target.closest("button");
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
      wb.log("chatgpt.com", "bootstrap read failed:", res.error);
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
      wb.log("chatgpt.com", `injected ${bootstrap.length} chars of vault context`);

      await new Promise((r) => setTimeout(r, 30));
      submitComposer(composer);
    } catch (err) {
      wb.log("chatgpt.com", "injection error; passing through:", err.message);
      submitComposer(composer);
    }
  }

  function findComposer() {
    // ChatGPT's composer is a textarea with id="prompt-textarea" or a
    // ProseMirror contenteditable div (newer builds).
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[data-id*="chat"]') ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard]') ||
      document.querySelector('form div[contenteditable="true"]') ||
      document.querySelector("textarea") ||
      null
    );
  }

  function isSendButton(btn) {
    if (btn.getAttribute("data-testid") === "send-button") return true;
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("send")) return true;
    const text = (btn.textContent || "").trim().toLowerCase();
    if (text === "send" || text === "submit") return true;
    return false;
  }

  function isNewConversation() {
    // chatgpt.com: /   (root) or /?model=... means new chat before first
    // message; once sent, URL becomes /c/<uuid>.
    const path = location.pathname;
    if (path === "/" || path === "/chat" || path === "") return true;
    // Fallback: count assistant messages on the page.
    const assistantMessages = document.querySelectorAll(
      '[data-message-author-role="assistant"]',
    );
    return assistantMessages.length === 0;
  }

  function conversationKey() {
    const m = location.pathname.match(/\/c\/([^/?#]+)/);
    return m ? m[1] : location.pathname;
  }

  function readComposerText(composer) {
    if (composer.tagName === "TEXTAREA") return composer.value;
    return composer.innerText || composer.textContent || "";
  }

  function writeComposerText(composer, text) {
    if (composer.tagName === "TEXTAREA") {
      // Use the React-aware setter so React's state tracker sees the change.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(composer, text);
      } else {
        composer.value = text;
      }
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    // contenteditable: ProseMirror-style. Replace with <p> per line.
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
    // Find a send button near the composer.
    const form = composer.closest("form");
    const scope = form || document;
    const buttons = Array.from(scope.querySelectorAll("button"));
    const send = buttons.find(isSendButton);
    if (send && !send.disabled) {
      send.click();
      return;
    }

    // Fallback: Enter keydown on composer.
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
          site: "chatgpt.com",
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
          site: "chatgpt.com",
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
      '[data-message-author-role="assistant"]'
    );
    if (candidates.length === 0) return null;
    const last = candidates[candidates.length - 1];
    return (last.innerText || last.textContent || "").trim() || null;
  }

  function extractConversation() {
    // ChatGPT's DOM marks each message with data-message-author-role.
    const nodes = document.querySelectorAll('[data-message-author-role]');
    const turns = [];
    nodes.forEach((el, i) => {
      const role = el.getAttribute("data-message-author-role");
      const text = (el.innerText || el.textContent || "").trim();
      if (!text) return;
      if (role !== "user" && role !== "assistant") return;
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
      if (!/\/c\//.test(id) && id !== "/" && id !== "/chat") return;
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
          site: "chatgpt.com",
          capturedAt: new Date().toISOString(),
          turns,
        });
        if (res?.error) {
          wb.log("chatgpt.com", "passive log failed:", res.error);
        } else if (res?.written > 0) {
          wb.log("chatgpt.com", `passive log: wrote ${res.written} turn(s) to ${res.path}`);
        }
      } catch (err) {
        wb.log("chatgpt.com", "passive log error:", err.message || err);
      } finally {
        inflight = false;
      }
    };

    const flushInterval = setInterval(() => flush("tick"), FLUSH_MS);
    _intervals.push(flushInterval);

    registerListener(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") flush("hidden");
    });

    wb.log("chatgpt.com", "passive auto-logging enabled (30s flush)");
  }
  if (settings.passiveLog) ensurePassiveLog();
  wb.onSettingsChanged((changes) => {
    if (changes.passiveLog?.newValue === true) ensurePassiveLog();
  });

  window.addEventListener("beforeunload", teardownAll);
})();
