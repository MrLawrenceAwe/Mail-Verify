import { handleCodeField } from "./code-fields.js";
import { MAX_CODE_AGE_MS, POLL_WINDOW_MS } from "./code-timing.js";
import { requestInlineCheck } from "./inline-client.js";

const confirmationPanelIds = new WeakMap();
let nextConfirmationPanelId = 1;

export function isConfirmationScreen(text) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 2500 || /\b(?:reset|forgot|change)\b.{0,35}\bpassword\b|\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  return /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b/i.test(value) ||
    /\b(?:we(?:'ve| have)?\s+)?sent\b.{0,65}\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i.test(value) ||
    /\b(?:click|follow|open)\b.{0,45}\blink\b.{0,70}\b(?:confirm|verify|activate)\b.{0,30}\b(?:e-?mail|account)\b/i.test(value);
}

export function confirmationScreenKey(document) {
  // Inspect short visible task panels, never hidden templates or the extension card.
  const panels = [...document.querySelectorAll("main, [role=main], form, [role=dialog]")];
  if (!panels.length) panels.push(document.body);
  const panel = panels.find((panel) => panel && panel.getClientRects().length &&
    panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    isConfirmationScreen(panel.innerText || ""));
  if (!panel) return null;
  if (!confirmationPanelIds.has(panel)) confirmationPanelIds.set(panel, nextConfirmationPanelId++);
  // Keep countdown updates within one step, but distinguish a new signup
  // shown inside the same panel element.
  const text = (panel.innerText || "")
    .replace(/\b\d{1,2}:\d{2}\b/g, "#")
    .replace(/\b(?:re-?send|send again|retry|try again|expires?|wait)\s+(?:in\s+|after\s+)?\d{1,3}(?:\s*(?:seconds?|minutes?|secs?|mins?|s|m))?\b/gi, "# timer")
    .replace(/\b\d+\s*(?:seconds?|minutes?|secs?|mins?)\b/gi, "# time")
    .replace(/\s+/g, " ").trim();
  return `${confirmationPanelIds.get(panel)}:${text}`;
}

export function detectConfirmationScreen(document) {
  return confirmationScreenKey(document) !== null;
}

export function selectConfirmationLinks(items, since, now) {
  return items.filter((item) => {
    if (!Number.isFinite(item.receivedAt) || item.receivedAt < since || item.receivedAt > now || now - item.receivedAt > MAX_CODE_AGE_MS) return false;
    try {
      const url = new URL(item.url);
      return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.port && !/[\s\\]/.test(item.url);
    } catch { return false; }
  }).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);
}

export function isConfirmationRequestControl(control) {
  const label = (control?.getAttribute?.("aria-label") ||
    (control?.tagName === "INPUT" ? control.value : control?.textContent) || "")
    .replace(/\s+/g, " ").trim();
  if (/^(?:re-?send|send again)\b/i.test(label)) return true;
  return /^(?:send|request|get|email)\b/i.test(label) &&
    /\b(?:confirm(?:ation)?|verif(?:y|ication)|activat(?:e|ion))\b/i.test(label) &&
    /\b(?:e-?mail|link)\b/i.test(label);
}

export function createConfirmationView(document, { onClose, onRetry, canOpen }) {
  const host = document.createElement("div");
  host.dataset.mailVerify = "confirmation";
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    :host { all:initial; }
    section { box-sizing:border-box;width:320px;max-width:calc(100vw - 32px);max-height:55vh;overflow:auto;padding:16px;border:1px solid #d3dcea;border-radius:14px;background:#fff;color:#26344d;box-shadow:0 6px 28px #162c482b;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { display:flex;align-items:center;gap:8px; } strong { flex:1;font-size:14px; }
    button { border:0;background:#edf2fa;border-radius:6px;padding:4px 8px;color:#26344d;font:inherit;cursor:pointer; }
    button:focus-visible,a:focus-visible { outline:2px solid #225bd3;outline-offset:2px; }
    p { margin:8px 0;overflow-wrap:anywhere; } small { font-size:11px;color:#5c687c; }
    article { border-top:1px solid #e2e8f1;padding-top:8px;margin-top:10px; }
    a { display:block;background:#2763dc;color:white;text-decoration:none;padding:8px 10px;border-radius:7px;text-align:center; }
  </style><section aria-label="Mail Verify confirmation links"><header><strong>Mail Verify confirmation links</strong><button id="retry" aria-label="Check mail again">↻</button><button id="close" aria-label="Dismiss confirmation links">×</button></header><p id="status" role="status" aria-live="polite"></p><div id="results"></div><small>Check the sender and destination. Opening a link may confirm your account.</small></section>`;
  root.querySelector("#close").onclick = onClose;
  root.querySelector("#retry").onclick = onRetry;
  const results = root.querySelector("#results");
  let rendered;
  return {
    host,
    setStatus(text) { root.querySelector("#status").textContent = text; },
    renderLinks(items) {
      const key = JSON.stringify(items);
      if (key === rendered) return;
      rendered = key;
      results.replaceChildren();
      for (const item of items) {
        const card = document.createElement("article");
        for (const text of [item.accountEmail, item.sender, item.subject, `Destination: ${new URL(item.url).hostname}`]) {
          const line = document.createElement("p");
          line.textContent = text;
          card.append(line);
        }
        const link = document.createElement("a");
        link.textContent = "Open confirmation link ↗";
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.addEventListener("click", (event) => { if (!canOpen(item)) event.preventDefault(); });
        link.addEventListener("auxclick", (event) => { if (!canOpen(item)) event.preventDefault(); });
        card.append(link);
        results.append(card);
      }
    },
  };
}

export function startConfirmationCard({ browser = globalThis, detect = detectConfirmationScreen,
  getScreenKey = detect === detectConfirmationScreen ? confirmationScreenKey : () => "",
  detectCode = () => handleCodeField({ action: "detect" }).ok, createView = createConfirmationView } = {}) {
  const { document, window, location, chrome, MutationObserver, setTimeout, clearTimeout, Date: clock = Date } = browser;
  let view, timer, scanTimer, generation = 0, activeAttempt, inFlight = false, retryAfterFlight = false;
  let lastURL = location.href, dismissed = false, since, deadline = 0, screenActive = false, screenKey;
  let currentItems = [];
  function unmount() {
    generation++;
    inFlight = false;
    activeAttempt = undefined;
    retryAfterFlight = false;
    clearTimeout(timer);
    view?.host.remove();
    view = undefined;
  }
  function dismiss() { dismissed = true; unmount(); }
  function restart() {
    deadline = clock.now() + POLL_WINDOW_MS;
    if (inFlight) {
      // Ignore the current response and run one new check as soon as it ends.
      generation++;
      retryAfterFlight = true;
      return;
    }
    check();
  }
  async function check() {
    clearTimeout(timer);
    if (!view || document.hidden || inFlight) return;
    if (lastURL !== location.href || !detect(document) || detectCode() || getScreenKey(document) !== screenKey) { sync(); return; }
    if (clock.now() >= deadline) {
      view.setStatus("Checking finished. Click ↻ to check again.");
      return;
    }
    const attempt = generation;
    inFlight = true;
    activeAttempt = attempt;
    try {
      const response = await requestInlineCheck(chrome.runtime, "links");
      if (attempt !== generation || !view || document.hidden) return;
      if (lastURL !== location.href || !detect(document) || detectCode() || getScreenKey(document) !== screenKey) { sync(); return; }
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      currentItems = selectConfirmationLinks(response.links || [], since, clock.now());
      view.renderLinks(currentItems);
      view.setStatus(response.warnings?.length ? `Could not check: ${response.warnings.join("; ")}` :
        currentItems.length ? "Choose the email for this signup." : "Waiting for your confirmation email…");
    } catch (error) {
      if (attempt === generation && view) {
        currentItems = [];
        view.renderLinks(currentItems);
        view.setStatus(error.message);
      }
    } finally {
      if (activeAttempt === attempt && retryAfterFlight && view && !document.hidden) {
        retryAfterFlight = false;
        inFlight = false;
        activeAttempt = undefined;
        check();
      } else if (activeAttempt === attempt && attempt === generation) {
        inFlight = false;
        activeAttempt = undefined;
        if (view && !document.hidden) timer = setTimeout(check, 8000);
      }
    }
  }
  function sync() {
    if (lastURL !== location.href) {
      unmount();
      lastURL = location.href;
      dismissed = false;
      screenActive = false;
      since = undefined;
    }
    if (document.hidden) { unmount(); return; }
    const matches = detect(document) && !detectCode();
    const nextScreenKey = matches ? getScreenKey(document) : undefined;
    if (!matches) {
      unmount();
      screenActive = false;
      screenKey = undefined;
      since = undefined;
      deadline = 0;
      return;
    }
    if (screenActive && nextScreenKey !== screenKey) {
      unmount();
      dismissed = false;
      screenActive = false;
      // A changed panel can represent a different signup. IMAP arrival times
      // have one-second precision, so start with the next second to exclude
      // links delivered just before this step appeared.
      since = Math.max(since ?? -Infinity, Math.floor(clock.now() / 1000) * 1000 + 1000);
      deadline = 0;
    }
    if (dismissed) return;
    if (!screenActive) {
      screenActive = true;
      screenKey = nextScreenKey;
      since ??= clock.now() - 5000;
      deadline = clock.now() + POLL_WINDOW_MS;
    }
    if (view) return;
    currentItems = [];
    view = createView(document, {
      onClose: dismiss, onRetry: restart,
      canOpen(item) {
        if (document.hidden || lastURL !== location.href || !detect(document) || detectCode() ||
            getScreenKey(document) !== screenKey ||
            !currentItems.some((current) => current.accountEmail === item.accountEmail &&
              current.uid === item.uid && current.url === item.url) ||
            !selectConfirmationLinks([item], since, clock.now()).length) {
          view?.setStatus("This link is no longer current. Request a new email or check again.");
          return false;
        }
        dismiss();
        return true;
      },
    });
    document.documentElement.append(view.host);
    view.setStatus("Waiting for your confirmation email…");
    check();
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; sync(); }, 250);
  }
  new MutationObserver((records) => {
    if (records.some((record) => record.target !== view?.host && !view?.host.contains(record.target))) scheduleScan();
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["hidden", "class", "style"] });
  document.addEventListener("visibilitychange", scheduleScan);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && view) dismiss(); });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("button, a, [role=button], input[type=submit]");
    if (!screenActive || !isConfirmationRequestControl(control)) return;
    since = Math.floor(clock.now() / 1000) * 1000 + 1000;
    dismissed = false;
    unmount();
    deadline = clock.now() + POLL_WINDOW_MS;
    sync();
  }, true);
  window.addEventListener("popstate", scheduleScan);
  window.addEventListener("hashchange", scheduleScan);
  window.navigation?.addEventListener("currententrychange", scheduleScan);
  sync();
}
