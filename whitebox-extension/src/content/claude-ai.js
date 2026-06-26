/**
 * Content script for claude.ai — v0.2 bootstrap injection.
 *
 * Behavior:
 *   1. On page load, check settings and vault grant state.
 *   2. Watch for a "new conversation" condition (composer is present, no
 *      prior messages in the thread).
 *   3. Hook the submit path. Before the user's first message is sent,
 *      prepend the WhiteBox bootstrap (AGENTS.md + identity.md +
 *      working-style.md) into the message text.
 *   4. After first injection, stay out of the way for the rest of the
 *      conversation.
 *
 * Claude.ai's DOM changes; selectors are kept loose and fall back.
 * If injection fails, the user sends their message unchanged — we never
 * break their workflow.
 */

(async () => {
  const wb = window.__whitebox;
  if (!wb) {
    console.warn(
      "[whitebox] claude.ai content script: _shared.js did not populate window.__whitebox. Aborting. If you see this, reload the extension and refresh the tab.",
    );
    return;
  }
  wb.log("claude.ai", "content script v0.3 live");

  // --- Cleanup registry ---
  // This is a teardown registry. Content scripts can re-inject on SPA
  // navigations or when the extension reloads, so every long-lived resource
  // (intervals, listeners, observers) is registered here. teardownAll()
  // walks these arrays to release them atomically. The `teardown` array
  // holds arbitrary callbacks for one-off cleanup (e.g. removing HUD nodes).
  const _cleanup = {
    intervals: [],
    listeners: [],   // { target, event, handler, options }
    observers: [],
    teardown: [],     // arbitrary teardown callbacks
  };

  function registerInterval(id) {
    _cleanup.intervals.push(id);
    return id;
  }

  function registerListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    _cleanup.listeners.push({ target, event, handler, options });
  }

  function registerObserver(obs) {
    _cleanup.observers.push(obs);
    return obs;
  }

  let tornDown = false;
  function teardownAll() {
    if (tornDown) return;
    tornDown = true;
    _cleanup.intervals.forEach(clearInterval);
    _cleanup.intervals.length = 0;
    _cleanup.listeners.forEach(({ target, event, handler, options }) => {
      target.removeEventListener(event, handler, options);
    });
    _cleanup.listeners.length = 0;
    _cleanup.observers.forEach((obs) => obs.disconnect());
    _cleanup.observers.length = 0;
    _cleanup.teardown.forEach((fn) => { try { fn(); } catch {} });
    _cleanup.teardown.length = 0;
    document.getElementById("wb-hud")?.remove();
    document.getElementById("wb-wikibook")?.remove();
    wb.log("claude.ai", "teardownAll complete");
  }

  const settings = await wb.getSettings();
  if (!settings.enabled) {
    wb.log("claude.ai", "disabled in settings");
    return;
  }
  if (!settings.enabledSites?.claudeAi) {
    wb.log("claude.ai", "claude.ai disabled per-site");
    return;
  }

  const status = await wb.vaultStatus();
  if (!status.granted) {
    wb.log(
      "claude.ai",
      `vault not accessible (${status.reason || "unknown"}); open the extension popup and grant access.`,
    );
    return;
  }

  wb.log("claude.ai", `vault ready: ${status.vaultName}`);

  // Tear down if user disables WhiteBox mid-session via popup.
  wb.onSettingsChanged((changes) => {
    if (changes.enabled?.newValue === false) {
      wb.log("claude.ai", "disabled via settings change — tearing down");
      teardownAll();
    } else if (changes.enabledSites?.newValue?.claudeAi === false) {
      wb.log("claude.ai", "claude.ai disabled per-site — tearing down");
      teardownAll();
    }
  });

  let bootstrapCache = null;
  let injectedForThisConversation = false;
  let currentConversationKey = conversationKey();

  // Self-automation model.
  //
  // The agent owns its own context-management loop. We don't orchestrate
  // it from outside; we just provide the substrate. Two paths the agent
  // can choose between, turn by turn:
  //
  //   Structured (this file):
  //     {wb-fetch: <path>}    pull a vault file
  //     {wb-scope: <name>}    swap to a different working set
  //     {wb-context: <text>}  narrate a workflow shift, no side effect
  //
  //   Free-roam:
  //     - In MCP-connected sessions, call read_file / list_files directly.
  //     - In a browser tab, ask the user to paste a file or run
  //       `whitebox grep`. The user is the routing layer.
  //
  // Both are legitimate. Structured = repeatable, observable, auditable
  // via pills. Free-roam = exploratory, novel queries, lower ceremony.
  // Per-source guardrails (when implemented) decide which paths each
  // agent identity is allowed to take.
  //
  // Mechanism for structured: the MutationObserver watches assistant
  // replies for markers, kicks off any async fetch, pushes the resulting
  // text to pendingPrepend. On the user's next submit we drain the queue
  // and prepend it before claude.ai sees the message.
  const pendingPrepend = [];
  const seenMarkers = new Set(); // de-dupe per page session

  function pushPending(text) {
    if (!text) return;
    pendingPrepend.push(text);
  }

  function consumePending() {
    if (pendingPrepend.length === 0) return null;
    const text = pendingPrepend.join("\n\n");
    pendingPrepend.length = 0;
    return text;
  }

  // Watch for conversation transitions (claude.ai is a SPA).
  //
  // Tricky: claude.ai loads a new chat on `/new` and, once the first
  // message is submitted, transitions the URL to `/chat/<uuid>`. That
  // transition is the SAME conversation just getting its slug assigned —
  // not a new conversation. We must NOT reset the injected flag in that
  // case, otherwise every subsequent message re-injects the bootstrap.
  //
  // Reset only when:
  //   - moving from a known chat id to a different chat id, or
  //   - moving back to `/new` (user started a fresh conversation).
  const urlWatcher = registerInterval(setInterval(() => {
    const key = conversationKey();
    if (key === currentConversationKey) return;

    const wasOnNewSlug = currentConversationKey === "/new";
    const isChatId = !key.startsWith("/");
    if (wasOnNewSlug && isChatId && injectedForThisConversation) {
      // Same conversation; record the new key without resetting.
      currentConversationKey = key;
      wb.log("claude.ai", `conversation slug assigned: ${key}`);
      return;
    }

    currentConversationKey = key;
    injectedForThisConversation = false;
    wb.log("claude.ai", "new conversation detected; ready to inject");
  }, 500));

  // Main hook: listen for Enter keydowns and submit-button clicks on the
  // composer. We intercept under two conditions:
  //   1. First message of a /new conversation → inject the bootstrap.
  //   2. There's pending content from a {wb-fetch:} or {wb-scope:} the
  //      agent emitted in its previous reply → prepend it.
  // Both can be true on the same submit (rare but valid).
  function shouldIntercept() {
    const isFirstMessage =
      !injectedForThisConversation && isNewConversation();
    const hasPending = pendingPrepend.length > 0;
    return { isFirstMessage, hasPending, any: isFirstMessage || hasPending };
  }

  registerListener(
    document,
    "keydown",
    async (ev) => {
      if (tornDown) return;
      if (ev.key !== "Enter" || ev.shiftKey) return;
      const composer = findComposer();
      if (!composer) return;
      if (!composer.contains(ev.target)) return;
      const reason = shouldIntercept();
      if (!reason.any) return;

      ev.preventDefault();
      ev.stopPropagation();

      await injectAndSubmit(composer, reason);
    },
    true,
  );

  registerListener(
    document,
    "click",
    async (ev) => {
      if (tornDown) return;
      const btn = ev.target.closest("button");
      if (!btn) return;
      if (!isSendButton(btn)) return;
      const composer = findComposer();
      if (!composer) return;
      const reason = shouldIntercept();
      if (!reason.any) return;

      ev.preventDefault();
      ev.stopPropagation();

      await injectAndSubmit(composer, reason);
    },
    true,
  );

  async function loadBootstrap() {
    if (bootstrapCache) return bootstrapCache;
    const res = await wb.readBootstrap();
    if (res.error) {
      wb.log("claude.ai", "bootstrap read failed:", res.error);
      return null;
    }
    // Pull current posture so the framing knows whether to warn the agent.
    let posture = null;
    try {
      posture = await wb.lockState();
    } catch {}
    bootstrapCache = wb.buildBootstrapText(res.files || {}, posture);
    if (res.locked) {
      // Don't cache a locked-stub bootstrap — next send may happen after
      // the user unlocks.
      const cached = bootstrapCache;
      bootstrapCache = null;
      return cached;
    }
    return bootstrapCache;
  }

  async function injectAndSubmit(composer, reason) {
    try {
      let prefix = "";
      const tags = [];

      if (reason.isFirstMessage) {
        const bootstrap = await loadBootstrap();
        if (bootstrap) {
          prefix += bootstrap;
          injectedForThisConversation = true;
          tags.push(`bootstrap:${bootstrap.length}c`);
        } else {
          wb.log("claude.ai", "no bootstrap available; passing through");
        }
      }

      if (reason.hasPending) {
        const pending = consumePending();
        if (pending) {
          prefix +=
            "<!-- whitebox-vault: start (agent-requested) -->\n" +
            pending +
            "\n<!-- whitebox-vault: end -->\n\n";
          tags.push(`pending:${pending.length}c`);
        }
      }

      if (!prefix) return submitComposer(composer);

      const userText = readComposerText(composer);
      writeComposerText(composer, prefix + userText);

      wb.log("claude.ai", `prepended ${tags.join(" + ")}`);

      await new Promise((r) => setTimeout(r, 30));
      submitComposer(composer);
    } catch (err) {
      wb.log("claude.ai", "injection error; passing through:", err.message);
      submitComposer(composer);
    }
  }

  function findComposer() {
    return (
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('[role="textbox"]') ||
      null
    );
  }

  function isSendButton(btn) {
    const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (aria.includes("send")) return true;
    const text = (btn.textContent || "").trim().toLowerCase();
    if (text === "send" || text === "submit") return true;
    if (btn.querySelector('svg[aria-label*="Send" i], svg[data-icon*="send" i]'))
      return true;
    return false;
  }

  function isNewConversation() {
    // Claude.ai marks new conversations with /new in the URL. After the
    // first message lands, the URL changes to /chat/<uuid>.
    //
    // We intentionally do NOT fall back to DOM selectors here. Selectors
    // for assistant messages drift across claude.ai redesigns; when they
    // miss, the fallback returns true and we re-inject on every send.
    // The /new URL is the only reliable signal — combined with the
    // injectedForThisConversation flag, this is enough.
    return /^\/new\b/.test(location.pathname);
  }

  function conversationKey() {
    const m = location.pathname.match(/\/chat\/([^/?#]+)/);
    return m ? m[1] : location.pathname;
  }

  function readComposerText(composer) {
    return composer.innerText || composer.textContent || "";
  }

  function writeComposerText(composer, text) {
    // Clear existing content.
    while (composer.firstChild) composer.removeChild(composer.firstChild);

    // Insert each line as a <p>. Claude.ai's composer is a ProseMirror
    // document; paragraphs are the expected block structure.
    const lines = text.split("\n");
    for (const line of lines) {
      const p = document.createElement("p");
      if (line.length === 0) {
        p.appendChild(document.createElement("br"));
      } else {
        p.textContent = line;
      }
      composer.appendChild(p);
    }

    // Fire input event so any framework listening picks up the change.
    composer.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true }),
    );
  }

  function submitComposer(composer) {
    // Find and click the send button.
    const buttons = Array.from(document.querySelectorAll("button"));
    const send = buttons.find(isSendButton);
    if (send && !send.disabled) {
      send.click();
      return;
    }
    // Fallback: dispatch Enter keydown on the composer.
    composer.focus();
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

  // Handle extraction requests from the popup (for manual observation capture
  // and session-end digest).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "wb:extract-last-assistant") {
      try {
        const text = extractLastAssistantText();
        sendResponse({
          ok: !!text,
          text: text || "",
          url: location.href,
          site: "claude.ai",
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
          site: "claude.ai",
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
      return true;
    }
    return false;
  });

  function extractConversation() {
    // Claude.ai interleaves user-message bubbles and assistant responses.
    // User turns tend to be plain containers with inline text; assistant
    // turns have class hints like font-claude-response / prose.
    // We walk the likely-candidate elements in DOM order and classify.
    const candidates = document.querySelectorAll(
      '[data-testid*="message"], div[class*="font-claude"], div.prose, div[class*="user"][class*="message"]'
    );
    const turns = [];
    const seen = new Set();
    candidates.forEach((el, i) => {
      if (seen.has(el)) return;
      seen.add(el);
      const text = (el.innerText || el.textContent || "").trim();
      if (!text || text.length < 3) return;
      const cls = el.className || "";
      const testid = el.getAttribute("data-testid") || "";
      const isAssistant =
        /font-claude|prose|assistant/i.test(cls) ||
        /assistant/i.test(testid);
      const role = isAssistant ? "assistant" : "user";
      turns.push({
        id: `turn-${i}`,
        role,
        text,
      });
    });
    return turns;
  }

  function extractLastAssistantText() {
    // Assistant messages on claude.ai are styled containers with distinctive
    // classes like font-claude-response / prose. User bubbles sit in
    // different containers. Target the right-hand (non-user) message blocks.
    const candidates = [
      ...document.querySelectorAll(
        'div[class*="font-claude"], div.prose, [data-is-streaming]'
      ),
    ];
    if (candidates.length === 0) return null;
    const last = candidates[candidates.length - 1];
    return (last.innerText || last.textContent || "").trim() || null;
  }

  // Mount the unified vault-marker rewriter. Watches assistant messages for
  // any of the four supported markers and turns each into a styled pill:
  //
  //   {saved memory: <path> time:HH:MM}  pill, click to preview file
  //   {wb-fetch: <path>}                 pill + queues file for next-send prepend
  //   {wb-scope: <name>}                 pill + queues scope brief for next-send
  //   {wb-context: <text>}               render-only pill, no side effect
  //
  // All four share one MutationObserver pass and one alternation regex.
  mountVaultMarkers();

  // Mount the floating HUD. Style preset controls density and visibility.
  const hudCtl = mountHud(settings, status);

  // Listen for the popup asking us to spawn the help wikibook.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "wb:open-help-bubble") {
      openHelpWikibook(msg.pageId).catch(() => {});
    }
    return false;
  });

  // Passive auto-log of conversation turns. Off by default; opt-in via popup.
  // Track mounted state so a mid-session toggle in the popup activates the
  // logger (and its HUD notice) without forcing a tab refresh.
  let passiveLogMounted = false;
  function ensurePassiveLog() {
    if (passiveLogMounted) return;
    passiveLogMounted = true;
    mountPassiveLog(hudCtl);
  }
  if (settings.passiveLog) ensurePassiveLog();
  wb.onSettingsChanged((changes) => {
    if (changes.passiveLog?.newValue === true) ensurePassiveLog();
  });

  function mountVaultMarkers() {
    injectSavedMemoryStyles();

    // One alternation regex catches all four markers; the dispatch decides
    // which kind it is by inspecting the named groups. Order in the
    // alternation matters only for tie-breaking on identical positions.
    const MARKER_RE = new RegExp(
      "\\{saved memory:\\s*(?<savedPath>[^\\s}]+)\\s+time:(?<savedTime>\\d{1,2}:\\d{2})\\}" +
        "|\\{wb-fetch:\\s*(?<fetchPath>[^\\s}]+)\\s*\\}" +
        "|\\{wb-scope:\\s*(?<scopeName>[^\\s}]+)\\s*\\}" +
        "|\\{wb-bootstrap(?::\\s*(?<bootstrapMode>[^}]+))?\\}" +
        "|\\{wb-save\\}(?<savePayload>[\\s\\S]*?)\\{/wb-save\\}" +
        "|\\{wb-context:\\s*(?<contextText>[^}]+)\\}",
      "g",
    );
    const PILL_CLASS = "wb-saved-memory-pill"; // base styling reused
    const seen = new Set(); // de-dup `kind|key` so we don't act twice on the same marker

    // Quick string sniff before we engage the regex on a text node.
    const ANY_PATTERN =
      /\{(saved memory:|wb-fetch:|wb-scope:|wb-bootstrap|wb-save|wb-context:)/;

    function rewriteIn(root) {
      if (!root || root.nodeType !== 1) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !ANY_PATTERN.test(node.nodeValue))
            return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.classList && parent.classList.contains(PILL_CLASS))
            return NodeFilter.FILTER_REJECT;
          if (parent.closest('[contenteditable="true"], textarea, input'))
            return NodeFilter.FILTER_REJECT;
          if (parent.closest("." + PILL_CLASS)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes = [];
      let n;
      while ((n = walker.nextNode())) textNodes.push(n);

      for (const textNode of textNodes) {
        const text = textNode.nodeValue;
        MARKER_RE.lastIndex = 0;
        if (!MARKER_RE.test(text)) continue;
        MARKER_RE.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let m;
        while ((m = MARKER_RE.exec(text)) !== null) {
          if (m.index > lastIdx) {
            frag.appendChild(
              document.createTextNode(text.slice(lastIdx, m.index)),
            );
          }
          const groups = m.groups || {};
          let pill;
          if (groups.savedPath) {
            pill = buildSavedMemoryPill(groups.savedPath, groups.savedTime);
            if (markFirstSeen("saved", `${groups.savedPath}|${groups.savedTime}`)) {
              window.dispatchEvent(
                new CustomEvent("whitebox:saved", {
                  detail: { path: groups.savedPath, time: groups.savedTime },
                }),
              );
            }
          } else if (groups.fetchPath) {
            pill = buildFetchPill(groups.fetchPath);
            if (markFirstSeen("fetch", groups.fetchPath)) {
              queueFetch(groups.fetchPath);
            }
          } else if (groups.scopeName) {
            pill = buildScopePill(groups.scopeName);
            if (markFirstSeen("scope", groups.scopeName)) {
              queueScope(groups.scopeName);
            }
          } else if (groups.bootstrapMode !== undefined || /\{wb-bootstrap\}/.test(m[0])) {
            const mode = (groups.bootstrapMode || "full").trim();
            pill = buildBootstrapPill(mode);
            if (markFirstSeen("bootstrap", mode)) {
              queueBootstrapReload(mode);
            }
          } else if (groups.savePayload !== undefined) {
            const parsed = parseSavePayload(groups.savePayload);
            const dedupeKey = JSON.stringify(parsed);
            pill = buildSavePill(parsed);
            if (markFirstSeen("save", dedupeKey)) {
              performSave(parsed, pill);
            }
          } else if (groups.contextText) {
            pill = buildContextPill(groups.contextText.trim());
            // No side effect; render-only.
          }
          if (pill) frag.appendChild(pill);
          lastIdx = m.index + m[0].length;
        }
        if (lastIdx < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        textNode.parentNode.replaceChild(frag, textNode);
      }
    }

    function markFirstSeen(kind, key) {
      const k = kind + "|" + key;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }

    function basePill(extraClass, title) {
      const pill = document.createElement("span");
      pill.className = PILL_CLASS + (extraClass ? " " + extraClass : "");
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      if (title) pill.setAttribute("title", title);
      return pill;
    }

    function addIcon(pill, glyph) {
      const icon = document.createElement("span");
      icon.className = PILL_CLASS + "__icon";
      icon.textContent = glyph;
      pill.appendChild(icon);
      return icon;
    }

    function addLabel(pill, text) {
      const label = document.createElement("span");
      label.className = PILL_CLASS + "__label";
      label.textContent = text;
      pill.appendChild(label);
      return label;
    }

    function addTime(pill, text) {
      const time = document.createElement("span");
      time.className = PILL_CLASS + "__time";
      time.textContent = " " + text;
      pill.appendChild(time);
      return time;
    }

    function wireClick(pill, handler) {
      const open = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        handler();
      };
      pill.addEventListener("click", open);
      pill.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") open(ev);
      });
    }

    function buildSavedMemoryPill(filePath, timeStr) {
      const pill = basePill("", `WhiteBox: ${filePath} (saved ${timeStr})`);
      addIcon(pill, "\u25A2");
      addLabel(pill, "saved \u2192 " + filePath);
      addTime(pill, timeStr);
      wireClick(pill, () => openFileModal(filePath, "saved at " + timeStr));
      return pill;
    }

    function buildFetchPill(filePath) {
      const pill = basePill(
        "wb-saved-memory-pill--fetch",
        `WhiteBox fetched ${filePath} for the next message`,
      );
      addIcon(pill, "\u21D3"); // double down arrow = pulled in
      addLabel(pill, "fetch \u2192 " + filePath);
      wireClick(pill, () => openFileModal(filePath, "agent-requested fetch"));
      return pill;
    }

    function buildScopePill(scopeName) {
      const pill = basePill(
        "wb-saved-memory-pill--scope",
        `WhiteBox switched scope to "${scopeName}"`,
      );
      addIcon(pill, "\u2316"); // crosshair = aim/scope
      addLabel(pill, "scope \u2192 " + scopeName);
      wireClick(pill, () => openScopeModal(scopeName));
      return pill;
    }

    function buildContextPill(text) {
      const pill = basePill(
        "wb-saved-memory-pill--context",
        "WhiteBox context note (no side effect)",
      );
      // Context pill is informational; no role=button.
      pill.setAttribute("role", "note");
      pill.removeAttribute("tabindex");
      addIcon(pill, "\u00B6"); // pilcrow = note
      addLabel(pill, text.length > 60 ? text.slice(0, 60) + "\u2026" : text);
      pill.style.cursor = "default";
      return pill;
    }

    function buildBootstrapPill(mode) {
      const pill = basePill(
        "wb-saved-memory-pill--bootstrap",
        `WhiteBox: agent re-pulled bootstrap (${mode})`,
      );
      addIcon(pill, "\u21BB"); // clockwise rotation = reload
      addLabel(pill, "bootstrap" + (mode && mode !== "full" ? " (" + mode + ")" : ""));
      wireClick(pill, () => openTextModal(
        "bootstrap",
        bootstrapCache || "(bootstrap not cached yet — will load on next send)",
      ));
      return pill;
    }

    function buildSavePill(parsed) {
      // Initially shows "saving…"; performSave swaps the label on success
      // by mutating the same DOM element (we hand it the element).
      const pill = basePill(
        "wb-saved-memory-pill--save",
        "WhiteBox: agent is writing an observation",
      );
      addIcon(pill, "\u270E"); // pencil = writing
      const labelText = parsed.error
        ? `save (parse error)`
        : `saving \u2192 ${(parsed.tags || []).slice(0, 3).join(", ") || "untagged"}\u2026`;
      addLabel(pill, labelText);
      wireClick(pill, () =>
        openTextModal(
          "wb-save (pending)",
          formatSavePreview(parsed),
        ),
      );
      return pill;
    }

    function formatSavePreview(parsed) {
      if (parsed.error) {
        return `Could not parse {wb-save} payload:\n\n${parsed.error}\n\n--- raw ---\n${parsed.raw || ""}`;
      }
      const lines = [
        `tags: ${(parsed.tags || []).join(", ")}`,
        `confidence: ${parsed.confidence || "(unset)"}`,
      ];
      if (parsed.context) lines.push(`context: ${parsed.context}`);
      lines.push("");
      lines.push(parsed.body || "(empty body)");
      return lines.join("\n");
    }

    /**
     * Parse the inside of a {wb-save}…{/wb-save} fence.
     *
     * Format (mirrors the YAML-ish frontmatter used elsewhere):
     *
     *   tags: working-style, preference
     *   confidence: high
     *   context: coding-conversations   (optional)
     *   ---
     *   <verbatim body, possibly multi-line>
     *
     * The `---` separator is required so we know where frontmatter ends
     * and body begins. Without it we fall back to "everything after the
     * last key:value line is the body."
     */
    function parseSavePayload(raw) {
      const trimmed = (raw || "").trim();
      if (!trimmed) return { error: "empty payload", raw };

      let frontText, bodyText;
      const sepMatch = trimmed.match(/^([\s\S]*?)\n\s*---\s*\n([\s\S]*)$/);
      if (sepMatch) {
        frontText = sepMatch[1];
        bodyText = sepMatch[2].trim();
      } else {
        // Fallback: split at the last `key: value` line.
        const lines = trimmed.split("\n");
        let lastFrontIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^[a-zA-Z_]+:\s*\S/.test(lines[i])) lastFrontIdx = i;
          else if (lines[i].trim() === "") {
            // blank line terminates frontmatter
            break;
          }
        }
        if (lastFrontIdx < 0) return { error: "no frontmatter found", raw };
        frontText = lines.slice(0, lastFrontIdx + 1).join("\n");
        bodyText = lines.slice(lastFrontIdx + 1).join("\n").trim();
      }

      const fields = {};
      let tags = [];
      for (const line of frontText.split("\n")) {
        const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (key === "tags") {
          tags = value
            .replace(/^\[/, "")
            .replace(/\]$/, "")
            .split(/[,]+/)
            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        } else {
          fields[key] = value.trim();
        }
      }

      if (tags.length === 0) return { error: "tags required", raw };
      if (!fields.confidence)
        return { error: "confidence required", raw };
      if (!bodyText) return { error: "body required", raw };

      const VALID = ["very-low", "low", "medium", "high", "very-high"];
      if (!VALID.includes(fields.confidence)) {
        return {
          error: `confidence must be one of ${VALID.join(" / ")}`,
          raw,
        };
      }

      return {
        tags,
        confidence: fields.confidence,
        context: fields.context,
        body: bodyText,
      };
    }

    async function performSave(parsed, pillEl) {
      if (parsed.error) return; // pill already shows the parse error
      try {
        const payload = {
          source: "claude.ai",
          tags: parsed.tags,
          confidence: parsed.confidence,
          body: parsed.body,
        };
        if (parsed.context) payload.context = parsed.context;
        const res = await wb.appendObservation(payload);
        if (res.error) {
          // Friendly framing per error code so the agent can self-correct
          // and the user can see what to fix.
          let label;
          if (res.code === "VAULT_LOCKED") {
            label = "save blocked: vault locked";
            pushPending(
              "## (save blocked) vault locked\n\nA {wb-save} you tried to write was rejected because the vault is locked and your bypass tier doesn't permit writes. Tell the user the vault is locked; ask them to unlock or raise the bypass tier in the WhiteBox extension popup.",
            );
          } else if (res.code === "RATE_LIMIT") {
            label = "save blocked: rate limit";
            pushPending(
              "## (save blocked) rate limit reached\n\nThe per-session autonomous-save cap was hit. Stop attempting autonomous saves until the user resets the cap or raises it in the WhiteBox extension popup.",
            );
          } else {
            label = res.error;
          }
          updateSavePillError(pillEl, label);
          return;
        }
        // Mutate the pill from "saving…" into the standard saved-memory
        // form so the agent's output reads like an MCP-driven save.
        updateSavePillSuccess(pillEl, res.path || "observations/?.md");
        wb.log("claude.ai", `saved observation \u2192 ${res.path}${res.viaBypass ? " (via bypass)" : ""}`);
      } catch (err) {
        updateSavePillError(pillEl, err.message || String(err));
      }
    }

    function updateSavePillSuccess(pillEl, savedPath) {
      pillEl.classList.remove("wb-saved-memory-pill--save");
      const labelEl = pillEl.querySelector("." + PILL_CLASS + "__label");
      if (labelEl) labelEl.textContent = "saved \u2192 " + savedPath;
      const icon = pillEl.querySelector("." + PILL_CLASS + "__icon");
      if (icon) icon.textContent = "\u25A2";
      pillEl.setAttribute("title", `WhiteBox: saved to ${savedPath}`);
      // Re-bind click to the file-preview modal.
      const newPill = pillEl.cloneNode(true);
      pillEl.parentNode.replaceChild(newPill, pillEl);
      newPill.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openFileModal(savedPath, "agent-saved observation");
      });
    }

    function updateSavePillError(pillEl, errMsg) {
      const labelEl = pillEl.querySelector("." + PILL_CLASS + "__label");
      if (labelEl) labelEl.textContent = "save failed";
      pillEl.setAttribute("title", `WhiteBox save failed: ${errMsg}`);
      pillEl.classList.add("wb-saved-memory-pill--error");
    }

    // ───── Side-effect handlers ──────────────────────────────────────────

    async function queueFetch(filePath) {
      try {
        const res = await wb.readFile(filePath);
        if (res.error) {
          wb.log("claude.ai", `wb-fetch failed for ${filePath}:`, res.error);
          // Special framing when the cause is a locked vault — the agent
          // should know to ask the user to unlock rather than retry.
          if (res.code === "VAULT_LOCKED") {
            pushPending(
              `## (vault locked) ${filePath}\n\nThe vault is currently locked. Tell the user the vault is locked and they need to unlock it via the WhiteBox extension popup. Do not retry the fetch until they confirm.`,
            );
          } else {
            pushPending(
              `## (wb-fetch failed) ${filePath}\n\nThe agent requested this file but it could not be read: ${res.error}`,
            );
          }
          return;
        }
        const block =
          `## From ${filePath} (agent-requested via {wb-fetch:})\n\n` +
          (res.content || "(empty file)").trim();
        pushPending(block);
        wb.log(
          "claude.ai",
          `queued ${filePath} (${(res.content || "").length} chars) for next send`,
        );
      } catch (err) {
        wb.log("claude.ai", "wb-fetch error:", err.message || err);
      }
    }

    async function queueBootstrapReload(mode) {
      // Agent asked us to re-deliver the orientation pack. Same content
      // we send on first message; queued for the next user submit so it
      // arrives at the top of the next turn. `mode` is reserved for
      // future minimal/full variants; today we always send full.
      try {
        const bootstrap = await loadBootstrap();
        if (!bootstrap) {
          pushPending(
            "## (wb-bootstrap failed)\n\nNo bootstrap available — vault read failed.",
          );
          return;
        }
        pushPending(
          "## Bootstrap reload (agent-requested via {wb-bootstrap})\n\n" +
            bootstrap,
        );
        wb.log("claude.ai", `queued bootstrap reload (mode=${mode})`);
      } catch (err) {
        wb.log("claude.ai", "wb-bootstrap error:", err.message || err);
      }
    }

    async function queueScope(scopeName) {
      try {
        const brief = await buildScopeBrief(scopeName);
        if (!brief) {
          pushPending(
            `## (wb-scope failed) ${scopeName}\n\nNo \`scopes.md\` defines a scope named "${scopeName}". Add one to the vault root and try again.`,
          );
          return;
        }
        pushPending(brief);
        wb.log("claude.ai", `queued scope brief for "${scopeName}"`);
      } catch (err) {
        wb.log("claude.ai", "wb-scope error:", err.message || err);
      }
    }

    async function buildScopeBrief(scopeName) {
      const res = await wb.readFile("scopes.md");
      if (res.error || !res.content) return null;
      const scopes = parseScopesMd(res.content);
      const scope = scopes.find((s) => s.name === scopeName);
      if (!scope) return null;
      return [
        `## Scope switched: ${scopeName} (agent-requested via {wb-scope:})`,
        ``,
        `This scope includes the following paths:`,
        ...scope.includes.map((p) => `- \`${p}\``),
        ``,
        `Use \`{wb-fetch: <path>}\` to pull any specific file from this scope.`,
        `To switch again, emit \`{wb-scope: <other-name>}\`.`,
      ].join("\n");
    }

    function parseScopesMd(content) {
      const out = [];
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        const m = line.match(/^[-*]\s*`([^`]+)`\s*[\u2014\-]\s*(.+)$/);
        if (!m) continue;
        const includes = m[2]
          .split(/[,+]/)
          .map((s) => s.trim().replace(/`/g, ""))
          .filter(Boolean);
        out.push({ name: m[1], includes });
      }
      return out;
    }

    async function openScopeModal(scopeName) {
      const brief = await buildScopeBrief(scopeName);
      openTextModal(`scope: ${scopeName}`, brief || "(scope not found in scopes.md)");
    }

    function openFileModal(filePath, subtitle) {
      openTextModal(filePath, "Loading\u2026", { subtitle, fetchPath: filePath });
    }

    function openTextModal(titleText, bodyText, opts = {}) {
      const subtitleText = opts.subtitle;
      const fetchPath = opts.fetchPath;

      const overlay = document.createElement("div");
      overlay.className = "wb-saved-memory-overlay";

      const modal = document.createElement("div");
      modal.className = "wb-saved-memory-modal";

      const header = document.createElement("div");
      header.className = "wb-saved-memory-modal__header";
      const titleEl = document.createElement("div");
      titleEl.className = "wb-saved-memory-modal__title";
      titleEl.textContent = titleText;
      const metaEl = document.createElement("div");
      metaEl.className = "wb-saved-memory-modal__meta";
      if (subtitleText) metaEl.textContent = subtitleText;
      const closeBtn = document.createElement("button");
      closeBtn.className = "wb-saved-memory-modal__close";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.textContent = "\u2715";
      header.appendChild(titleEl);
      header.appendChild(metaEl);
      header.appendChild(closeBtn);

      const bodyEl = document.createElement("pre");
      bodyEl.className = "wb-saved-memory-modal__body";
      bodyEl.textContent = bodyText;

      const footer = document.createElement("div");
      footer.className = "wb-saved-memory-modal__footer";
      footer.textContent =
        "Read-only preview. Edit directly in your vault folder.";

      modal.appendChild(header);
      modal.appendChild(bodyEl);
      modal.appendChild(footer);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const dismiss = () => {
        overlay.remove();
        document.removeEventListener("keydown", onKey, true);
      };
      const onKey = (ev) => {
        if (ev.key === "Escape") {
          ev.preventDefault();
          dismiss();
        }
      };
      closeBtn.addEventListener("click", dismiss);
      overlay.addEventListener("click", (ev) => {
        if (ev.target === overlay) dismiss();
      });
      document.addEventListener("keydown", onKey, true);

      // If a fetch path was provided, replace the placeholder body with
      // the file content asynchronously.
      if (fetchPath) {
        (async () => {
          try {
            const res = await wb.readFile(fetchPath);
            if (res.error) {
              bodyEl.textContent =
                "Could not read " + fetchPath + "\n\n" + res.error;
              return;
            }
            bodyEl.textContent = res.content || "(empty file)";
          } catch (err) {
            bodyEl.textContent =
              "Could not read " +
              fetchPath +
              "\n\n" +
              (err.message || String(err));
          }
        })();
      }
    }

    // Initial sweep.
    rewriteIn(document.body);

    // Watch for new assistant content. Claude.ai streams responses, so we
    // re-scan whenever new nodes are added; the acceptNode filter rejects
    // text we've already wrapped.
    // Debounced observer — batch mutations per animation frame to avoid
    // redundant rewriteIn() calls during streaming responses.
    let pendingNodes = new Set();
    let batchScheduled = false;

    const observer = registerObserver(new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.type === "childList") {
          mut.addedNodes.forEach((node) => {
            if (node.nodeType === 1) pendingNodes.add(node);
            else if (
              node.nodeType === 3 &&
              node.parentElement &&
              node.nodeValue &&
              ANY_PATTERN.test(node.nodeValue)
            ) {
              pendingNodes.add(node.parentElement);
            }
          });
        } else if (mut.type === "characterData") {
          const node = mut.target;
          if (
            node &&
            node.parentElement &&
            node.nodeValue &&
            ANY_PATTERN.test(node.nodeValue)
          ) {
            pendingNodes.add(node.parentElement);
          }
        }
      }
      if (!batchScheduled && pendingNodes.size > 0) {
        batchScheduled = true;
        requestAnimationFrame(() => {
          const nodes = Array.from(pendingNodes);
          pendingNodes.clear();
          batchScheduled = false;
          for (const n of nodes) {
            if (n.isConnected) rewriteIn(n);
          }
        });
      }
    }));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function injectSavedMemoryStyles() {
    if (document.getElementById("wb-saved-memory-styles")) return;
    const style = document.createElement("style");
    style.id = "wb-saved-memory-styles";
    style.textContent = `
      .wb-saved-memory-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 1px 8px;
        margin: 0 2px;
        border-radius: 999px;
        background: rgba(120, 130, 150, 0.14);
        border: 1px solid rgba(120, 130, 150, 0.32);
        color: inherit;
        font-size: 0.85em;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        line-height: 1.4;
        cursor: pointer;
        user-select: none;
        vertical-align: baseline;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .wb-saved-memory-pill:hover,
      .wb-saved-memory-pill:focus {
        background: rgba(120, 130, 150, 0.24);
        border-color: rgba(120, 130, 150, 0.55);
        outline: none;
      }
      .wb-saved-memory-pill__icon {
        font-size: 0.9em;
        opacity: 0.7;
      }
      .wb-saved-memory-pill__label {
        white-space: nowrap;
      }
      .wb-saved-memory-pill__time {
        opacity: 0.6;
        font-size: 0.85em;
      }
      /* Variant: agent-requested fetch (cool blue) */
      .wb-saved-memory-pill--fetch {
        background: rgba(80, 150, 215, 0.16);
        border-color: rgba(80, 150, 215, 0.45);
      }
      .wb-saved-memory-pill--fetch:hover,
      .wb-saved-memory-pill--fetch:focus {
        background: rgba(80, 150, 215, 0.28);
        border-color: rgba(80, 150, 215, 0.65);
      }
      /* Variant: scope switch (purple) */
      .wb-saved-memory-pill--scope {
        background: rgba(155, 100, 200, 0.16);
        border-color: rgba(155, 100, 200, 0.45);
      }
      .wb-saved-memory-pill--scope:hover,
      .wb-saved-memory-pill--scope:focus {
        background: rgba(155, 100, 200, 0.28);
        border-color: rgba(155, 100, 200, 0.65);
      }
      /* Variant: bootstrap reload (warm amber) */
      .wb-saved-memory-pill--bootstrap {
        background: rgba(220, 160, 70, 0.18);
        border-color: rgba(220, 160, 70, 0.5);
      }
      .wb-saved-memory-pill--bootstrap:hover,
      .wb-saved-memory-pill--bootstrap:focus {
        background: rgba(220, 160, 70, 0.3);
        border-color: rgba(220, 160, 70, 0.7);
      }
      /* Variant: context note (muted, render-only) */
      .wb-saved-memory-pill--context {
        background: transparent;
        border-color: rgba(125, 125, 125, 0.35);
        border-style: dashed;
        opacity: 0.85;
      }
      .wb-saved-memory-pill--context:hover {
        background: transparent;
        border-color: rgba(125, 125, 125, 0.5);
      }
      /* Variant: agent writing an observation (in flight = green-pulsing) */
      .wb-saved-memory-pill--save {
        background: rgba(76, 175, 106, 0.16);
        border-color: rgba(76, 175, 106, 0.5);
        animation: wb-save-pulse 1.4s infinite;
      }
      @keyframes wb-save-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(76, 175, 106, 0.4); }
        70%  { box-shadow: 0 0 0 6px rgba(76, 175, 106, 0); }
        100% { box-shadow: 0 0 0 0 rgba(76, 175, 106, 0); }
      }
      /* Variant: save failed */
      .wb-saved-memory-pill--error {
        background: rgba(215, 90, 60, 0.16);
        border-color: rgba(215, 90, 60, 0.5);
        animation: none;
      }
      .wb-saved-memory-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483600;
      }
      .wb-saved-memory-modal {
        background: #1d1f23;
        color: #e7e7e7;
        border: 1px solid #3a3d44;
        border-radius: 10px;
        width: min(720px, 92vw);
        max-height: 80vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          sans-serif;
      }
      @media (prefers-color-scheme: light) {
        .wb-saved-memory-modal {
          background: #fafafa;
          color: #1d1f23;
          border-color: #d6d6d6;
        }
      }
      .wb-saved-memory-modal__header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(125, 125, 125, 0.25);
      }
      .wb-saved-memory-modal__title {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px;
        font-weight: 600;
        flex: 1;
        word-break: break-all;
      }
      .wb-saved-memory-modal__meta {
        font-size: 12px;
        opacity: 0.6;
      }
      .wb-saved-memory-modal__close {
        background: transparent;
        color: inherit;
        border: 0;
        font-size: 16px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
      }
      .wb-saved-memory-modal__close:hover {
        background: rgba(125, 125, 125, 0.18);
      }
      .wb-saved-memory-modal__body {
        margin: 0;
        padding: 14px 16px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
        flex: 1;
      }
      .wb-saved-memory-modal__footer {
        padding: 10px 16px;
        font-size: 11.5px;
        opacity: 0.65;
        border-top: 1px solid rgba(125, 125, 125, 0.25);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function mountHud(settings, status) {
    const style = settings.style || "office";
    if (style === "office" /* office: toast-only, no persistent HUD */) {
      injectHudStyles();
      const toast = buildHudShell({ minimal: true });
      document.body.appendChild(toast.root);
      toast.root.classList.add("wb-hud--hidden");
      const showTransient = (state, text, ms = 4000) => {
        toast.setState(state, text);
        toast.root.classList.remove("wb-hud--hidden");
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => {
          toast.root.classList.add("wb-hud--hidden");
        }, ms);
      };
      window.addEventListener("whitebox:saved", (ev) => {
        showTransient("saved", `saved \u2192 ${ev.detail.path}`);
      });
      return {
        setState: (state, text) => showTransient(state, text, 2500),
        showTransient,
        minimal: true,
      };
    }

    // Engineer + Gamer/Modder both get a persistent HUD; Gamer/Modder is
    // larger and shows extra detail.
    injectHudStyles();
    const expanded = style === "gamer-modder";
    const hud = buildHudShell({
      minimal: false,
      expanded,
      vaultName: status.vaultName || "(no vault)",
    });
    document.body.appendChild(hud.root);

    restoreHudPosition(hud.root);
    makeHudDraggable(hud.root, hud.handle);

    hud.setState("idle", expanded ? "WhiteBox" : "wb");

    refreshConflictBadge(hud);
    registerInterval(setInterval(() => refreshConflictBadge(hud), 60_000));

    refreshLockBadges(hud);
    registerInterval(setInterval(() => refreshLockBadges(hud), 5_000));

    window.addEventListener("whitebox:saved", (ev) => {
      hud.setState("saved", `saved \u2192 ${ev.detail.path}`);
      clearTimeout(hud._stateTimer);
      hud._stateTimer = setTimeout(() => hud.setState("idle"), 3500);
    });

    hud.toggleBtn.addEventListener("click", () => {
      hud.root.classList.toggle("wb-hud--collapsed");
    });

    hud.openVaultBtn?.addEventListener("click", async () => {
      // Browser can't open the local folder directly, but we can open the
      // setup tab which lets the user re-pick or inspect the vault.
      const url = chrome.runtime.getURL("src/setup/setup.html");
      chrome.runtime.sendMessage({ type: "wb:open-tab", url }).catch(() => {});
      window.open(url, "_blank");
    });

    hud.captureBtn?.addEventListener("click", async () => {
      // Trigger the capture-last-response flow as if the user hit it from
      // the popup. The content script extracts; we forward to the propose
      // tab via chrome.storage.session.
      try {
        const text = extractLastAssistantText();
        if (!text) {
          hud.setState("warn", "no assistant message yet");
          return;
        }
        await chrome.storage.session.set({
          pendingProposal: {
            source: "claude.ai",
            text,
            url: location.href,
            site: "claude.ai",
            capturedAt: new Date().toISOString(),
          },
        });
        const proposeUrl = chrome.runtime.getURL("src/propose/propose.html");
        window.open(proposeUrl, "_blank");
      } catch (err) {
        hud.setState("warn", err.message || "capture failed");
      }
    });

    return {
      setState: hud.setState,
      hud,
      minimal: false,
    };
  }

  function mountPassiveLog(hudCtl) {
    const FLUSH_INTERVAL_MS = 30_000;
    let lastFlushPromise = Promise.resolve();
    let lastTurnHash = "";
    let inflight = false;

    const flush = async (reason = "tick") => {
      if (inflight) return;
      const id = location.pathname; // /chat/<uuid> or /new
      if (!/\/chat\/|\/new\b/.test(id)) return;
      const turns = extractConversation();
      if (!turns.length) return;
      // Cap buffer to prevent unbounded growth on very long conversations.
      if (turns.length > 100) turns.splice(0, turns.length - 100);
      // Cheap dedupe — if nothing has changed since last flush, skip.
      const hash = `${id}|${turns.length}|${turns[turns.length - 1]?.text?.slice(0, 80) || ""}`;
      if (hash === lastTurnHash && reason === "tick") return;
      lastTurnHash = hash;
      inflight = true;
      try {
        if (!hudCtl.minimal) hudCtl.setState("recording", "logging\u2026");
        const res = await wb.appendConversationTurns({
          id,
          site: "claude.ai",
          capturedAt: new Date().toISOString(),
          turns,
        });
        if (res?.error) {
          wb.log("claude.ai", "passive log failed:", res.error);
          hudCtl.setState("warn", `log: ${res.error}`);
        } else if (res?.written > 0) {
          wb.log("claude.ai", `passive log: wrote ${res.written} turn${res.written === 1 ? "" : "s"} to ${res.path}`);
          hudCtl.setState("saved", `+${res.written} turn${res.written === 1 ? "" : "s"} \u2192 ${res.path}`);
          if (!hudCtl.minimal) {
            clearTimeout(hudCtl._passiveTimer);
            hudCtl._passiveTimer = setTimeout(() => hudCtl.setState("idle"), 2500);
          }
        } else {
          if (!hudCtl.minimal) hudCtl.setState("idle");
        }
      } catch (err) {
        wb.log("claude.ai", "passive log error:", err.message || err);
      } finally {
        inflight = false;
      }
    };

    // Initial state cue. In office (minimal) mode setState routes through a
    // transient toast so the user gets a one-time confirmation; engineer /
    // gamer-modder modes keep the persistent "recording" state.
    hudCtl.setState("recording", "passive log on");

    // Periodic flush.
    registerInterval(setInterval(() => {
      lastFlushPromise = lastFlushPromise.then(() => flush("tick"));
    }, FLUSH_INTERVAL_MS));

    // Flush when the tab is hidden — this is the closest signal we get to
    // "user moved away" without being able to rely on beforeunload in
    // service-worker land.
    registerListener(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        lastFlushPromise = lastFlushPromise.then(() => flush("hidden"));
      }
    });

    // Best-effort flush on teardown.
    _cleanup.teardown.push(() => flush("unload"));

    // Add a "Flush now" button into the HUD detail when we have one.
    if (!hudCtl.minimal && hudCtl.hud?.actions) {
      const btn = document.createElement("button");
      btn.className = "wb-hud__btn wb-hud__btn--ghost";
      btn.textContent = "Flush";
      btn.addEventListener("click", () => flush("manual"));
      hudCtl.hud.actions.appendChild(btn);
    }
  }

  function buildHudShell({ minimal, expanded, vaultName }) {
    const root = document.createElement("div");
    root.className = "wb-hud" + (minimal ? " wb-hud--minimal" : "");
    if (expanded) root.classList.add("wb-hud--expanded");

    const handle = document.createElement("div");
    handle.className = "wb-hud__handle";

    const dot = document.createElement("span");
    dot.className = "wb-hud__dot";
    handle.appendChild(dot);

    const label = document.createElement("span");
    label.className = "wb-hud__label";
    label.textContent = "WhiteBox";
    handle.appendChild(label);

    const lockBadge = document.createElement("span");
    lockBadge.className = "wb-hud__badge wb-hud__badge--lock";
    lockBadge.setAttribute("data-wb-help", "vault-lock");
    lockBadge.hidden = true;
    handle.appendChild(lockBadge);

    const bypassBadge = document.createElement("span");
    bypassBadge.className = "wb-hud__badge wb-hud__badge--bypass";
    bypassBadge.setAttribute("data-wb-help", "agent-bypass");
    bypassBadge.hidden = true;
    handle.appendChild(bypassBadge);

    const dangerHudBadge = document.createElement("span");
    dangerHudBadge.className = "wb-hud__badge wb-hud__badge--danger";
    dangerHudBadge.setAttribute("data-wb-help", "vault-lock");
    dangerHudBadge.hidden = true;
    dangerHudBadge.textContent = "⚠ DANGER";
    handle.appendChild(dangerHudBadge);

    const conflictBadge = document.createElement("span");
    conflictBadge.className = "wb-hud__badge wb-hud__badge--conflict";
    conflictBadge.setAttribute("data-wb-help", "audit-log");
    conflictBadge.hidden = true;
    handle.appendChild(conflictBadge);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "wb-hud__toggle";
    toggleBtn.setAttribute("aria-label", "Toggle WhiteBox HUD");
    toggleBtn.textContent = "\u2304";
    handle.appendChild(toggleBtn);

    root.appendChild(handle);

    let openVaultBtn = null;
    let captureBtn = null;
    let detail = null;

    if (!minimal) {
      detail = document.createElement("div");
      detail.className = "wb-hud__detail";

      const vaultRow = document.createElement("div");
      vaultRow.className = "wb-hud__row";
      vaultRow.innerHTML = `<span class="wb-hud__row-key">vault</span><span class="wb-hud__row-val">${escapeHtml(vaultName)}</span>`;
      detail.appendChild(vaultRow);

      const stateRow = document.createElement("div");
      stateRow.className = "wb-hud__row wb-hud__row--state";
      stateRow.innerHTML = `<span class="wb-hud__row-key">state</span><span class="wb-hud__row-val wb-hud__state-text">idle</span>`;
      detail.appendChild(stateRow);

      const actions = document.createElement("div");
      actions.className = "wb-hud__actions";
      captureBtn = document.createElement("button");
      captureBtn.className = "wb-hud__btn";
      captureBtn.textContent = "Capture";
      openVaultBtn = document.createElement("button");
      openVaultBtn.className = "wb-hud__btn wb-hud__btn--ghost";
      openVaultBtn.textContent = "Setup";
      actions.appendChild(captureBtn);
      actions.appendChild(openVaultBtn);
      detail.appendChild(actions);

      root.appendChild(detail);
    }

    function setState(name, text) {
      root.dataset.state = name;
      if (text) label.textContent = text;
      else label.textContent = "WhiteBox";
      const stateText = detail?.querySelector(".wb-hud__state-text");
      if (stateText) stateText.textContent = text || name;
    }

    return {
      root,
      handle,
      toggleBtn,
      openVaultBtn,
      captureBtn,
      conflictBadge,
      lockBadge,
      bypassBadge,
      dangerHudBadge,
      setState,
      actions: detail ? detail.querySelector(".wb-hud__actions") : null,
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]));
  }

  async function refreshConflictBadge(hud) {
    try {
      const res = await wb.listConflictsCount();
      if (res?.ok && res.count > 0) {
        hud.conflictBadge.textContent = `${res.count} conflict${res.count === 1 ? "" : "s"}`;
        hud.conflictBadge.hidden = false;
      } else {
        hud.conflictBadge.hidden = true;
      }
    } catch {}
  }

  async function refreshLockBadges(hud) {
    if (!hud.lockBadge) return;
    try {
      const state = await wb.lockState();
      if (!state) return;

      // Lock badge: only shown when a passphrase is set AND vault is locked
      if (state.hasPassphrase && !state.userUnlocked) {
        hud.lockBadge.textContent = "🔒 LOCKED";
        hud.lockBadge.title = "Vault is locked. Open the WhiteBox popup to unlock.";
        hud.lockBadge.hidden = false;
      } else {
        hud.lockBadge.hidden = true;
      }

      // Bypass badge: shown when bypass is anything other than "none"
      if (state.bypass && state.bypass !== "none") {
        hud.bypassBadge.textContent = `BYPASS: ${state.bypass}`;
        hud.bypassBadge.title =
          "Agent has elevated permissions while vault is locked.";
        hud.bypassBadge.classList.toggle(
          "wb-hud__badge--bypass-danger",
          state.bypass === "full-bypass",
        );
        hud.bypassBadge.hidden = false;
      } else {
        hud.bypassBadge.hidden = true;
      }

      // Danger badge: shown when any safety toggle is reduced
      if (state.anyDanger) {
        const reasons = Object.entries(state.danger || {})
          .filter(([, v]) => v)
          .map(([k]) => k);
        hud.dangerHudBadge.title = "Reduced safety: " + reasons.join(", ");
        hud.dangerHudBadge.hidden = false;
      } else {
        hud.dangerHudBadge.hidden = true;
      }
    } catch {}
  }

  function restoreHudPosition(root) {
    chrome.storage.local.get("hudPosition", (data) => {
      const pos = data?.hudPosition;
      if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
        root.style.left = pos.x + "px";
        root.style.top = pos.y + "px";
        root.style.right = "auto";
        root.style.bottom = "auto";
      }
    });
  }

  function makeHudDraggable(root, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    handle.addEventListener("mousedown", (ev) => {
      // Don't start a drag from the toggle button.
      if (ev.target.closest(".wb-hud__toggle")) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      originX = rect.left;
      originY = rect.top;
      root.classList.add("wb-hud--dragging");
      ev.preventDefault();
    });

    function onHudMouseMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const x = clamp(originX + dx, 4, window.innerWidth - root.offsetWidth - 4);
      const y = clamp(originY + dy, 4, window.innerHeight - root.offsetHeight - 4);
      root.style.left = x + "px";
      root.style.top = y + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
    }

    function onHudMouseUp() {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("wb-hud--dragging");
      const rect = root.getBoundingClientRect();
      chrome.storage.local.set({
        hudPosition: { x: Math.round(rect.left), y: Math.round(rect.top) },
      });
    }

    registerListener(window, "mousemove", onHudMouseMove);
    registerListener(window, "mouseup", onHudMouseUp);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function injectHudStyles() {
    if (document.getElementById("wb-hud-styles")) return;
    const style = document.createElement("style");
    style.id = "wb-hud-styles";
    style.textContent = `
      .wb-hud {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483500;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        color: #e7e7e7;
        background: rgba(28, 30, 34, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
        min-width: 140px;
        max-width: 280px;
        opacity: 0.9;
        transition: opacity 180ms ease, transform 180ms ease;
        user-select: none;
      }
      .wb-hud:hover { opacity: 1; }
      .wb-hud--dragging { opacity: 1; cursor: grabbing; }
      .wb-hud--hidden {
        opacity: 0;
        pointer-events: none;
        transform: translateY(8px);
      }
      .wb-hud--collapsed .wb-hud__detail { display: none; }
      .wb-hud--minimal .wb-hud__detail { display: none; }
      .wb-hud__handle {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px 6px 10px;
        cursor: grab;
      }
      .wb-hud--dragging .wb-hud__handle { cursor: grabbing; }
      .wb-hud__dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #888;
        flex: 0 0 auto;
        box-shadow: 0 0 0 0 rgba(120, 200, 140, 0.5);
        transition: background 180ms ease;
      }
      .wb-hud[data-state="idle"] .wb-hud__dot { background: #888; }
      .wb-hud[data-state="recording"] .wb-hud__dot {
        background: #d77b3a;
        animation: wb-hud-pulse 1.6s infinite;
      }
      .wb-hud[data-state="saved"] .wb-hud__dot {
        background: #4caf6a;
        animation: wb-hud-flash 0.8s ease-out 1;
      }
      .wb-hud[data-state="warn"] .wb-hud__dot { background: #d6883a; }
      @keyframes wb-hud-pulse {
        0%   { box-shadow: 0 0 0 0 rgba(215, 123, 58, 0.55); }
        70%  { box-shadow: 0 0 0 10px rgba(215, 123, 58, 0); }
        100% { box-shadow: 0 0 0 0 rgba(215, 123, 58, 0); }
      }
      @keyframes wb-hud-flash {
        0%   { box-shadow: 0 0 0 0 rgba(76, 175, 106, 0.7); }
        100% { box-shadow: 0 0 0 14px rgba(76, 175, 106, 0); }
      }
      .wb-hud__label {
        flex: 1;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .wb-hud__badge {
        font-size: 10.5px;
        padding: 1px 6px;
        border-radius: 999px;
        background: rgba(215, 90, 60, 0.85);
        color: white;
        font-weight: 600;
        white-space: nowrap;
      }
      .wb-hud__badge--lock {
        background: rgba(241, 200, 148, 0.95);
        color: #6a3a09;
      }
      .wb-hud__badge--bypass {
        background: rgba(155, 100, 200, 0.85);
        color: white;
      }
      .wb-hud__badge--bypass-danger {
        background: rgba(193, 74, 58, 0.92);
      }
      .wb-hud__badge--danger {
        background: rgba(193, 74, 58, 0.92);
        animation: wb-danger-flash 1.6s infinite alternate;
      }
      @keyframes wb-danger-flash {
        from { box-shadow: 0 0 0 0 rgba(193, 74, 58, 0.6); }
        to   { box-shadow: 0 0 0 6px rgba(193, 74, 58, 0); }
      }
      .wb-hud__toggle {
        background: transparent;
        color: rgba(255, 255, 255, 0.6);
        border: 0;
        padding: 0 4px;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
      }
      .wb-hud__toggle:hover { color: #fff; }
      .wb-hud--collapsed .wb-hud__toggle { transform: rotate(180deg); }
      .wb-hud__detail {
        padding: 8px 10px 10px 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .wb-hud__row {
        display: flex;
        gap: 10px;
        font-size: 11.5px;
      }
      .wb-hud__row-key {
        color: rgba(255, 255, 255, 0.5);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10.5px;
        flex: 0 0 auto;
        align-self: center;
      }
      .wb-hud__row-val {
        color: #d6d6d6;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        word-break: break-all;
      }
      .wb-hud__actions {
        display: flex;
        gap: 6px;
        margin-top: 4px;
      }
      .wb-hud__btn {
        flex: 1;
        background: rgba(255, 255, 255, 0.08);
        color: #e7e7e7;
        border: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 11.5px;
        padding: 5px 8px;
        border-radius: 4px;
        cursor: pointer;
      }
      .wb-hud__btn:hover { background: rgba(255, 255, 255, 0.14); }
      .wb-hud__btn--ghost {
        background: transparent;
      }
      .wb-hud--expanded { min-width: 220px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Help wikibook overlay. Lazy-loads help content when first opened.
  let helpModulePromise = null;
  async function openHelpWikibook(pageId) {
    if (!helpModulePromise) {
      const helpUrl = chrome.runtime.getURL("src/lib/help-content.js");
      const hoverUrl = chrome.runtime.getURL("src/lib/help-hover.js");
      helpModulePromise = Promise.all([import(helpUrl), import(hoverUrl)]);
    }
    const [helpMod, hoverMod] = await helpModulePromise;
    // Mount hover-help with a callback that re-opens the wikibook scrolled
    // to a specific page.
    hoverMod.mountHelpHover({ openWikibook: (id) => openHelpWikibook(id) });
    renderWikibook(helpMod, pageId);
  }

  function renderWikibook(helpMod, pageId) {
    injectWikibookStyles();
    let overlay = document.getElementById("wb-wikibook");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "wb-wikibook";
      overlay.innerHTML = `
        <div class="wb-wikibook__chrome" id="wb-wikibook-chrome">
          <div class="wb-wikibook__title">WhiteBox handbook</div>
          <button class="wb-wikibook__close" aria-label="Close" type="button">✕</button>
        </div>
        <div class="wb-wikibook__body">
          <aside class="wb-wikibook__sidebar"></aside>
          <main class="wb-wikibook__content"></main>
        </div>
      `;
      document.body.appendChild(overlay);

      overlay.querySelector(".wb-wikibook__close").addEventListener("click", () => overlay.remove());
      makeWikibookDraggable(overlay, overlay.querySelector("#wb-wikibook-chrome"));

      // Build sidebar (categories + pages) with hover help on each entry.
      const sidebar = overlay.querySelector(".wb-wikibook__sidebar");
      for (const cat of helpMod.HELP_CATEGORIES) {
        const catEl = document.createElement("div");
        catEl.className = "wb-wikibook__cat";
        catEl.innerHTML = `<div class="wb-wikibook__cat-label">${escapeHtml(cat.label)}</div>`;
        const pages = helpMod.HELP_PAGES.filter((p) => p.category === cat.id);
        for (const page of pages) {
          const item = document.createElement("a");
          item.className = "wb-wikibook__item";
          item.textContent = page.title;
          item.href = "#";
          item.setAttribute("data-page-id", page.id);
          item.setAttribute("data-wb-help", page.id); // hover preview
          item.addEventListener("click", (ev) => {
            ev.preventDefault();
            showWikibookPage(overlay, helpMod, page.id);
          });
          catEl.appendChild(item);
        }
        sidebar.appendChild(catEl);
      }
    }
    showWikibookPage(overlay, helpMod, pageId || helpMod.HELP_PAGES[0].id);
  }

  function showWikibookPage(overlay, helpMod, pageId) {
    const page = helpMod.findHelpPage(pageId);
    if (!page) return;
    const content = overlay.querySelector(".wb-wikibook__content");
    content.innerHTML = `
      <h1>${escapeHtml(page.title)}</h1>
      <div class="wb-wikibook__page-body">${renderHelpMarkdown(page.body)}</div>
    `;
    content.scrollTop = 0;
    overlay.querySelectorAll(".wb-wikibook__item").forEach((it) => {
      it.classList.toggle("is-active", it.getAttribute("data-page-id") === pageId);
    });
  }

  function renderHelpMarkdown(text) {
    // Tiny renderer: paragraphs, headings, fenced blocks, lists, inline `code`, **bold**.
    const lines = String(text || "").split("\n");
    const out = [];
    let inFence = false;
    let fenceBuf = [];
    let listBuf = [];
    const flushList = () => {
      if (listBuf.length) {
        out.push("<ul>" + listBuf.map((l) => `<li>${inlineFormat(l)}</li>`).join("") + "</ul>");
        listBuf = [];
      }
    };
    for (const raw of lines) {
      if (raw.startsWith("```")) {
        flushList();
        if (inFence) {
          out.push("<pre><code>" + escapeHtml(fenceBuf.join("\n")) + "</code></pre>");
          fenceBuf = [];
          inFence = false;
        } else {
          inFence = true;
        }
        continue;
      }
      if (inFence) { fenceBuf.push(raw); continue; }
      if (raw.startsWith("## ")) { flushList(); out.push("<h2>" + escapeHtml(raw.slice(3)) + "</h2>"); continue; }
      if (raw.startsWith("# ")) { flushList(); out.push("<h2>" + escapeHtml(raw.slice(2)) + "</h2>"); continue; }
      if (/^[-*]\s+/.test(raw)) { listBuf.push(raw.replace(/^[-*]\s+/, "")); continue; }
      flushList();
      if (raw.trim() === "") { out.push(""); continue; }
      out.push("<p>" + inlineFormat(raw) + "</p>");
    }
    flushList();
    return out.join("\n");
  }

  function inlineFormat(s) {
    let html = escapeHtml(s);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
  }

  function makeWikibookDraggable(root, handleEl) {
    let dragging = false;
    let startX = 0, startY = 0, originX = 0, originY = 0;
    handleEl.addEventListener("mousedown", (ev) => {
      if (ev.target.closest(".wb-wikibook__close")) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = ev.clientX; startY = ev.clientY;
      originX = rect.left; originY = rect.top;
      ev.preventDefault();
    });
    function onWbMouseMove(ev) {
      if (!dragging) return;
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      root.style.left = Math.max(8, Math.min(window.innerWidth - root.offsetWidth - 8, originX + dx)) + "px";
      root.style.top = Math.max(8, Math.min(window.innerHeight - root.offsetHeight - 8, originY + dy)) + "px";
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
    function onWbMouseUp() { dragging = false; }
    registerListener(window, "mousemove", onWbMouseMove);
    registerListener(window, "mouseup", onWbMouseUp);
  }

  function injectWikibookStyles() {
    if (document.getElementById("wb-wikibook-styles")) return;
    const style = document.createElement("style");
    style.id = "wb-wikibook-styles";
    style.textContent = `
      #wb-wikibook {
        position: fixed;
        top: 80px;
        right: 80px;
        width: min(720px, 92vw);
        height: min(560px, 80vh);
        background: #1d1f23;
        color: #e7e7e7;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 10px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
        z-index: 2147483600;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      @media (prefers-color-scheme: light) {
        #wb-wikibook { background: #fafafa; color: #1d1f23; border-color: #d6d6d6; }
      }
      .wb-wikibook__chrome {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        border-bottom: 1px solid rgba(125,125,125,0.25);
        cursor: grab;
        user-select: none;
      }
      .wb-wikibook__chrome:active { cursor: grabbing; }
      .wb-wikibook__title { flex: 1; font-weight: 600; font-size: 13px; }
      .wb-wikibook__close {
        background: transparent; color: inherit; border: 0;
        font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 4px;
      }
      .wb-wikibook__close:hover { background: rgba(125,125,125,0.18); }
      .wb-wikibook__body {
        flex: 1; display: flex; min-height: 0;
      }
      .wb-wikibook__sidebar {
        width: 200px;
        flex: 0 0 200px;
        border-right: 1px solid rgba(125,125,125,0.2);
        overflow-y: auto;
        padding: 8px 0;
      }
      .wb-wikibook__cat-label {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.55;
        padding: 8px 14px 4px 14px;
        font-weight: 600;
      }
      .wb-wikibook__item {
        display: block;
        padding: 5px 14px;
        font-size: 12.5px;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
      }
      .wb-wikibook__item:hover { background: rgba(125,125,125,0.12); }
      .wb-wikibook__item.is-active {
        background: rgba(80, 150, 215, 0.18);
        color: rgba(120, 180, 230, 1);
      }
      @media (prefers-color-scheme: light) {
        .wb-wikibook__item.is-active { background: #e6f2fb; color: #195182; }
      }
      .wb-wikibook__content {
        flex: 1; min-width: 0; overflow-y: auto;
        padding: 18px 22px;
        font-size: 13px; line-height: 1.55;
      }
      .wb-wikibook__content h1 { font-size: 18px; margin: 0 0 8px 0; }
      .wb-wikibook__content h2 { font-size: 14px; margin: 18px 0 6px 0; }
      .wb-wikibook__content p { margin: 0 0 10px 0; }
      .wb-wikibook__content ul { margin: 0 0 12px 18px; padding: 0; }
      .wb-wikibook__content li { margin: 2px 0; }
      .wb-wikibook__content code {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 12px;
        background: rgba(125,125,125,0.18);
        padding: 1px 5px;
        border-radius: 3px;
      }
      .wb-wikibook__content pre {
        background: rgba(0,0,0,0.25);
        border-radius: 5px;
        padding: 10px;
        overflow-x: auto;
        font-size: 12px;
      }
      @media (prefers-color-scheme: light) {
        .wb-wikibook__content pre { background: #f0f0f0; }
      }
      .wb-wikibook__content pre code { background: transparent; padding: 0; }
      .wb-wikibook__content a { color: rgba(120, 180, 230, 1); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Mount hover-help globally on this content script too so HUD badges
  // and other elements with data-wb-help get tooltips.
  (async () => {
    try {
      const hoverUrl = chrome.runtime.getURL("src/lib/help-hover.js");
      const mod = await import(hoverUrl);
      mod.mountHelpHover({
        openWikibook: (pageId) => openHelpWikibook(pageId),
      });
      // Register help-hover cleanup for teardown.
      if (mod.unmountHelpHover) {
        _cleanup.teardown.push(() => mod.unmountHelpHover());
      }
    } catch (err) {
      wb.log("claude.ai", "help-hover mount failed:", err.message || err);
    }
  })();

  // Single cleanup handler for page unload.
  window.addEventListener("beforeunload", teardownAll);
})();
