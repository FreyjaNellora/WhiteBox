/**
 * Hover-help bubble.
 *
 * Drop this into any context (popup, content script, options page) and
 * call mountHelpHover(). It scans the DOM for any element with a
 * `data-wb-help="<page-id>"` attribute and shows a small bubble next to
 * it on hover, with the page's title and a short body preview.
 *
 * UX:
 *   - Hover element → bubble appears next to it after a short delay.
 *   - Mouse off element → bubble persists 250ms (grace), then dismisses.
 *   - Mouse onto the bubble → cancels the dismiss; bubble stays open.
 *   - Click "Open this page →" inside the bubble → spawns the full
 *     wikibook overlay scrolled to that page (via the openWikibook
 *     callback supplied at mount time).
 *   - Mouse off the bubble for 250ms → dismiss.
 *
 * The bubble is a fixed-position div appended to document.body. It does
 * NOT take focus and click-through is preserved on areas it doesn't
 * cover. Position is computed to avoid screen edges.
 */

import { findHelpPage } from "./help-content.js";

const BUBBLE_ID = "wb-help-hover-bubble";
const STYLE_ID = "wb-help-hover-styles";

let dismissTimer = null;
let currentPageId = null;
let openWikibookCallback = null;

export function mountHelpHover(options = {}) {
  if (typeof document === "undefined") return; // not in a DOM context
  injectStyles();
  openWikibookCallback = options.openWikibook || null;

  // Use event delegation so dynamically added elements work too.
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
}

export function unmountHelpHover() {
  document.removeEventListener("mouseover", onMouseOver, true);
  document.removeEventListener("mouseout", onMouseOut, true);
  document.removeEventListener("focusin", onFocusIn, true);
  document.removeEventListener("focusout", onFocusOut, true);
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  currentPageId = null;
  openWikibookCallback = null;
  const bubble = document.getElementById(BUBBLE_ID);
  if (bubble) bubble.remove();
  const style = document.getElementById(STYLE_ID);
  if (style) style.remove();
}

function onMouseOver(ev) {
  const el = findHelpAnchor(ev.target);
  if (!el) return;
  showBubbleFor(el);
}

function onMouseOut(ev) {
  const fromAnchor = findHelpAnchor(ev.target);
  const toAnchor = findHelpAnchor(ev.relatedTarget);
  const toBubble = isInBubble(ev.relatedTarget);
  if (!fromAnchor) return;
  // If we moved onto the bubble or another anchor for the same page, keep it.
  if (toBubble) return;
  if (toAnchor && toAnchor.getAttribute("data-wb-help") === currentPageId)
    return;
  scheduleDismiss();
}

function onFocusIn(ev) {
  const el = findHelpAnchor(ev.target);
  if (!el) return;
  showBubbleFor(el);
}

function onFocusOut(ev) {
  const el = findHelpAnchor(ev.target);
  if (!el) return;
  scheduleDismiss();
}

function findHelpAnchor(node) {
  if (!node || node.nodeType !== 1) return null;
  if (typeof node.closest !== "function") return null;
  return node.closest("[data-wb-help]");
}

function isInBubble(node) {
  if (!node || node.nodeType !== 1) return false;
  if (typeof node.closest !== "function") return false;
  return Boolean(node.closest("#" + BUBBLE_ID));
}

function showBubbleFor(el) {
  const pageId = el.getAttribute("data-wb-help");
  if (!pageId) return;
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (currentPageId === pageId) {
    repositionBubble(el);
    return;
  }
  currentPageId = pageId;
  const page = findHelpPage(pageId);
  if (!page) return;
  renderBubble(page, el);
}

function scheduleDismiss() {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    const b = document.getElementById(BUBBLE_ID);
    if (b) b.remove();
    currentPageId = null;
    dismissTimer = null;
  }, 250);
}

function renderBubble(page, anchorEl) {
  let bubble = document.getElementById(BUBBLE_ID);
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = BUBBLE_ID;
    bubble.setAttribute("role", "tooltip");
    document.body.appendChild(bubble);

    // Mouse on the bubble cancels dismiss; mouse off schedules it again.
    bubble.addEventListener("mouseenter", () => {
      if (dismissTimer) {
        clearTimeout(dismissTimer);
        dismissTimer = null;
      }
    });
    bubble.addEventListener("mouseleave", scheduleDismiss);
  }

  const preview = previewBody(page.body);
  bubble.innerHTML = `
    <div class="${BUBBLE_ID}__title"></div>
    <div class="${BUBBLE_ID}__body"></div>
    <div class="${BUBBLE_ID}__footer">
      <button class="${BUBBLE_ID}__open" type="button">Open full page →</button>
    </div>
  `;
  bubble.querySelector(`.${BUBBLE_ID}__title`).textContent = page.title;
  bubble.querySelector(`.${BUBBLE_ID}__body`).textContent = preview;
  const openBtn = bubble.querySelector(`.${BUBBLE_ID}__open`);
  openBtn.addEventListener("click", () => {
    if (openWikibookCallback) {
      openWikibookCallback(page.id);
    } else {
      // Fallback: send a message to the content script (works from popup
      // when a tab has the wikibook overlay capability).
      try {
        chrome.tabs?.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, {
              type: "wb:open-help-bubble",
              pageId: page.id,
            });
          }
        });
        if (typeof window !== "undefined" && window.close) window.close();
      } catch {}
    }
  });

  repositionBubble(anchorEl);
}

function previewBody(body) {
  // Strip leading heading lines, take the first 220 chars of paragraph text.
  const trimmed = String(body || "")
    .split("\n")
    .filter((l) => !l.startsWith("##") && !l.startsWith("---"))
    .join("\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
  if (trimmed.length <= 220) return trimmed;
  return trimmed.slice(0, 220).replace(/\s\S*$/, "") + "…";
}

function repositionBubble(anchorEl) {
  const bubble = document.getElementById(BUBBLE_ID);
  if (!bubble || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const bw = 280;
  // Default: position to the right of the anchor.
  let left = rect.right + 8;
  let top = rect.top;
  // If we'd run off the right edge, position to the left instead.
  if (left + bw > window.innerWidth - 8) {
    left = rect.left - bw - 8;
  }
  // If we'd run off the left edge too, fall back to centering below.
  if (left < 8) {
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, rect.left));
    top = rect.bottom + 8;
  }
  // Clamp top so we don't run off the bottom.
  const bh = bubble.offsetHeight || 140;
  if (top + bh > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - bh - 8);
  }
  if (top < 8) top = 8;
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${BUBBLE_ID} {
      position: fixed;
      width: 280px;
      max-width: 90vw;
      background: #1d1f23;
      color: #e7e7e7;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 8px;
      padding: 10px 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      line-height: 1.5;
      z-index: 2147483647;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      animation: wb-help-bubble-in 120ms ease-out;
    }
    @keyframes wb-help-bubble-in {
      from { opacity: 0; transform: translateY(2px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-color-scheme: light) {
      #${BUBBLE_ID} {
        background: #fdfdfd;
        color: #1d1f23;
        border-color: #d6d6d6;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      }
    }
    .${BUBBLE_ID}__title {
      font-weight: 600;
      font-size: 12.5px;
      margin-bottom: 4px;
    }
    .${BUBBLE_ID}__body {
      font-size: 11.5px;
      opacity: 0.85;
      margin-bottom: 8px;
      white-space: pre-wrap;
    }
    .${BUBBLE_ID}__footer {
      display: flex;
      justify-content: flex-end;
      border-top: 1px solid rgba(125,125,125,0.2);
      padding-top: 6px;
      margin-top: 4px;
    }
    .${BUBBLE_ID}__open {
      background: transparent;
      color: inherit;
      border: 0;
      font-size: 11px;
      cursor: pointer;
      opacity: 0.85;
      padding: 2px 0;
    }
    .${BUBBLE_ID}__open:hover {
      opacity: 1;
      text-decoration: underline;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}
