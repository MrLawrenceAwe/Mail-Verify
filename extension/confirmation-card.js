import { createConfirmationView } from "./confirmation-card-view.js";
import { isSupportedConfirmationUrl } from "./confirmation-url.js";
import { normalizeStepText } from "./step-text.js";
import { isFreshMessage } from "./mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createPollingLifecycle, createRetryGate } from "./polling-lifecycle.js";

const confirmationPanelIds = new WeakMap();
let nextConfirmationPanelId = 1;

export function isConfirmationScreen(text) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 2500 || /\b(?:reset|forgot|change)\b.{0,35}\bpassword\b|\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  return /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b/i.test(value) ||
    /\b(?:we(?:'ve| have)?\s+)?sent\b.{0,65}\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i.test(value) ||
    /\b(?:click|follow|open)\b.{0,45}\blink\b.{0,70}\b(?:confirm|verify|activate)\b.{0,30}\b(?:e-?mail|account)\b/i.test(value);
}

export function getConfirmationStepKey(document) {
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
  const text = normalizeStepText(panel.innerText || "");
  return `${confirmationPanelIds.get(panel)}:${text}`;
}

export function selectConfirmationLinks(items, minReceivedAtMs, now) {
  return items.filter((item) => {
    if (!isFreshMessage(item.receivedAt, now, minReceivedAtMs)) return false;
    return isSupportedConfirmationUrl(item.url);
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

export function mutationAffectsConfirmation(records, host, document, screenActive) {
  const panels = "main, [role=main], form, [role=dialog]";
  const relevantElements = `${panels}, input`;
  const relevantText = (value) => /check|inbox|e-?mail|confirm|verif|activat|\blink\b/i.test(value || "");
  return records.some((record) => {
    const target = record.target;
    if (target === host || host?.contains(target)) return false;
    const element = target.nodeType === 1 ? target : target.parentElement;
    const inActivePanel = screenActive &&
      (element?.closest?.(panels) || !document.querySelector?.(panels));
    if (record.type === "attributes")
      return !!(target.matches?.(relevantElements) || target.querySelector?.(relevantElements));
    if (record.type === "characterData")
      return !!inActivePanel || relevantText(target.textContent) || relevantText(record.oldValue);
    if (record.type === "childList")
      return !!inActivePanel || [...record.addedNodes, ...record.removedNodes].some((node) =>
        relevantText(node.textContent) || (node.nodeType === 1 &&
          (node.matches?.(relevantElements) || node.querySelector?.(relevantElements))));
    return false;
  });
}

export function startConfirmationCard({ browser = globalThis, getStepKey = getConfirmationStepKey,
  page = getPageCoordinator(browser), detectCode = () => page.detectCodeField().ok, createView = createConfirmationView } = {}) {
  const { document, location, chrome, setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: 8000 });
  const checks = createRetryGate();
  let view, scanTimer;
  let lastURL = location.href, dismissed = false, minReceivedAtMs, screenActive = false, stepKey;
  let currentItems = [];
  function unmount() {
    polling.invalidate();
    checks.invalidate();
    polling.clear();
    view?.host.remove();
    view = undefined;
  }
  function dismiss() { dismissed = true; unmount(); }
  function restart() {
    polling.restart();
    if (checks.requestRetry()) {
      // Ignore the current response and run one new check as soon as it ends.
      polling.invalidate();
      return;
    }
    check();
  }
  async function check() {
    polling.clear();
    if (!view || document.hidden || checks.busy) return;
    if (lastURL !== location.href || detectCode() || getStepKey(document) !== stepKey) { sync(); return; }
    if (polling.expired()) {
      view.setStatus("Checking finished. Click ↻ to check again.");
      return;
    }
    const attempt = polling.generation;
    const checkToken = checks.start();
    try {
      const response = await requestInlineCheck(chrome.runtime, "links");
      if (!polling.isCurrent(attempt) || !view || document.hidden) return;
      if (lastURL !== location.href || detectCode() || getStepKey(document) !== stepKey) { sync(); return; }
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      currentItems = selectConfirmationLinks(response.links || [], minReceivedAtMs, clock.now());
      view.renderLinks(currentItems);
      view.setStatus(response.warnings?.length ? `Could not check: ${response.warnings.join("; ")}` :
        currentItems.length ? "Choose the email for this signup." : "Waiting for your confirmation email…");
    } catch (error) {
      if (polling.isCurrent(attempt) && view) {
        currentItems = [];
        view.renderLinks(currentItems);
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(checkToken);
      if (retry === null) return;
      if (retry && view && !document.hidden) check();
      else if (polling.isCurrent(attempt) && view && !document.hidden) polling.schedule(check);
    }
  }
  function sync() {
    if (lastURL !== location.href) {
      unmount();
      lastURL = location.href;
      dismissed = false;
      screenActive = false;
      minReceivedAtMs = undefined;
    }
    if (document.hidden) { unmount(); return; }
    const nextStepKey = detectCode() ? null : getStepKey(document);
    const matches = nextStepKey !== null;
    if (!matches) {
      unmount();
      screenActive = false;
      stepKey = undefined;
      minReceivedAtMs = undefined;
      polling.reset();
      return;
    }
    if (screenActive && nextStepKey !== stepKey) {
      unmount();
      dismissed = false;
      screenActive = false;
      // A changed panel can represent a different signup. IMAP arrival times
      // have one-second precision, so start with the next second to exclude
      // links delivered just before this step appeared.
      minReceivedAtMs = Math.max(minReceivedAtMs ?? -Infinity, Math.floor(clock.now() / 1000) * 1000 + 1000);
      polling.reset();
    }
    if (dismissed) return;
    if (!screenActive) {
      screenActive = true;
      stepKey = nextStepKey;
      minReceivedAtMs ??= clock.now() - 5000;
      polling.restart();
    }
    if (view) return;
    currentItems = [];
    view = createView(document, {
      onClose: dismiss, onRetry: restart,
      beforeOpen(item) {
        if (document.hidden || lastURL !== location.href || detectCode() || getStepKey(document) !== stepKey ||
            !currentItems.some((current) => current.accountEmail === item.accountEmail &&
              current.uid === item.uid && current.url === item.url) ||
            !selectConfirmationLinks([item], minReceivedAtMs, clock.now()).length) {
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
  page.onMutation((records) => {
    if (mutationAffectsConfirmation(records, view?.host, document, screenActive)) scheduleScan();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && view) dismiss(); });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("button, a, [role=button], input[type=submit]");
    if (!screenActive || !isConfirmationRequestControl(control)) return;
    minReceivedAtMs = Math.floor(clock.now() / 1000) * 1000 + 1000;
    dismissed = false;
    unmount();
    polling.restart();
    sync();
  }, true);
  page.onPageChange(scheduleScan);
  sync();
}
