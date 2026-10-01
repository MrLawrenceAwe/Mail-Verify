import { copyPasswordResetLink } from "./reset-link-copy.js";
import { MAIL_MODES } from "./mail-modes.js";
import { createEmailLinkCardView } from "./email-link-card-view.js";
import { isSupportedEmailLinkUrl } from "./email-link-url.js";
import { normalizeStepText, getRequestControlLabel, REQUEST_CONTROL_SELECTOR } from "./step-text.js";
import { initialStepCutoff, isFreshMessage, resendCutoff } from "./mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createPollingLifecycle, createRetryGate } from "./polling-lifecycle.js";

const emailLinkPanelIds = new WeakMap();
let nextEmailLinkPanelId = 1;

function matchesConfirmationPrompt(text) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 2500 || /\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  return /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b/i.test(value) ||
    /\b(?:we(?:'ve| have)?\s+)?sent\b.{0,65}\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i.test(value) ||
    /\b(?:click|follow|open)\b.{0,45}\blink\b.{0,70}\b(?:confirm|verify|activate)\b.{0,30}\b(?:e-?mail|account)\b/i.test(value);
}

export function isPasswordResetScreen(text) {
  const value = text.trim();
  if (!value || value.length > 2500 || /\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  const passwordReset = /\b(?:reset|forgot|recover|change)\b.{0,35}\bpassword\b|\bpassword\b.{0,35}\b(?:reset|recovery)\b/i;
  const resetHeading = /^(?:(?:reset|forgot|recover|change)\s+(?:(?:your|my|the)\s+)?password|password\s+(?:reset|recovery))$/i;
  const emailSent = /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b|\bsent\b.{0,80}\b(?:e-?mail|link)\b|\b(?:e-?mail|link)\b.{0,40}\bsent\b|\b(?:click|follow|open)\b.{0,45}\blink\b/i;
  const confirmation = /\b(?:confirm|verify|activate)\b.{0,35}\b(?:e-?mail|account)\b|\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i;
  // Bind the purpose to the waiting instruction or the heading immediately
  // before it. Navigation elsewhere in the panel must not switch link modes.
  // Join grammatical continuations across elements, while retaining line
  // boundaries for standalone headings and navigation such as Forgot password.
  const instructions = value
    .replace(/\b(to|your|my|the|a|an|for)[ \t]*\n+[ \t]*/gi, "$1 ")
    .replace(/\b(link|email)[ \t]*\n+[ \t]*(?=to\s+(?:reset|change|recover)\b)/gi, "$1 ");
  const phrases = instructions.split(/[.!?](?:\s+|$)|\n+/)
    .map(phrase => phrase.replace(/\s+/g, " ").trim()).filter(Boolean);
  return phrases.some((phrase, index) => emailSent.test(phrase) && !confirmation.test(phrase) &&
    (passwordReset.test(phrase) || resetHeading.test(phrases[index - 1] || "")));
}

export function detectEmailLinkStep(document) {
  // Inspect short visible task panels, never hidden templates or the extension card.
  const panels = [...document.querySelectorAll("main, [role=main], form, [role=dialog]")];
  if (!panels.length) panels.push(document.body);
  for (const panel of panels) {
    if (!panel?.getClientRects().length ||
        !panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const text = panel.innerText || "";
    const mode = isPasswordResetScreen(text) ? "passwordResetLinks"
      : matchesConfirmationPrompt(text) ? "confirmationLinks" : null;
    if (!mode) continue;
    if (!emailLinkPanelIds.has(panel)) emailLinkPanelIds.set(panel, nextEmailLinkPanelId++);
    // Countdown changes retain the step; a new task in the same panel changes it.
    return { key: `${emailLinkPanelIds.get(panel)}:${normalizeStepText(text)}`, mode };
  }
  return null;
}

export function selectEmailLinks(items, minReceivedAtMs, now) {
  return items.filter((item) => {
    if (!isFreshMessage(item.receivedAt, now, minReceivedAtMs)) return false;
    return isSupportedEmailLinkUrl(item.url);
  }).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);
}

export function isEmailLinkRequestControl(control) {
  const label = getRequestControlLabel(control);
  if (/^(?:re-?send|send again)\b/i.test(label)) return true;
  return /^(?:send|request|get|email)\b/i.test(label) &&
    /\b(?:confirm(?:ation)?|verif(?:y|ication)|activat(?:e|ion)|reset|password)\b/i.test(label) &&
    /\b(?:e-?mail|link)\b/i.test(label);
}

export function mutationAffectsEmailLinkCard(records, host, document, screenActive) {
  const panels = "main, [role=main], form, [role=dialog]";
  const relevantElements = `${panels}, input`;
  const relevantText = (value) => /check|inbox|e-?mail|confirm|verif|activat|password|reset|\blink\b/i.test(value || "");
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

export function startEmailLinkCard({ browser = globalThis, detectStep = detectEmailLinkStep,
  page = getPageCoordinator(browser), detectCode = () => page.detectCodeField().ok, createView = createEmailLinkCardView } = {}) {
  const { document, location, chrome, setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: 8000 });
  const checks = createRetryGate();
  let view, scanTimer;
  let lastURL = location.href, dismissed = false, minReceivedAtMs, screenActive = false, stepKey;
  let currentLinks = [];
  let mode = "confirmationLinks";
  function isCurrentStep() {
    const step = detectStep(document);
    return step?.key === stepKey && step?.mode === mode;
  }
  function unmountCard() {
    polling.invalidate();
    checks.invalidate();
    polling.clear();
    view?.host.remove();
    view = undefined;
  }
  function dismissCard() { dismissed = true; unmountCard(); }
  function restartPolling() {
    polling.restart();
    if (checks.requestRetry()) {
      // Ignore the current response and run one new check as soon as it ends.
      polling.invalidate();
      return;
    }
    checkForLinks();
  }
  async function checkForLinks() {
    polling.clear();
    if (!view || document.hidden || checks.busy) return;
    if (lastURL !== location.href || detectCode() || !isCurrentStep()) { syncLinkCard(); return; }
    if (polling.expired()) {
      view.setStatus("Checking finished. Click ↻ to check again.");
      return;
    }
    const requestGeneration = polling.generation;
    const checkToken = checks.start();
    try {
      const response = await requestInlineCheck(chrome.runtime, mode);
      if (!polling.isCurrent(requestGeneration) || !view || document.hidden) return;
      if (lastURL !== location.href || detectCode() || !isCurrentStep()) { syncLinkCard(); return; }
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      currentLinks = selectEmailLinks(response[mode] || [], minReceivedAtMs, clock.now());
      view.renderLinks(currentLinks);
      view.setStatus(response.warnings?.length ? `Could not check: ${response.warnings.join("; ")}` :
        currentLinks.length ? MAIL_MODES[mode].foundStatus : MAIL_MODES[mode].waitingStatus);
    } catch (error) {
      if (polling.isCurrent(requestGeneration) && view) {
        currentLinks = [];
        view.renderLinks(currentLinks);
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(checkToken);
      if (retry === null) return;
      if (retry && view && !document.hidden) checkForLinks();
      else if (polling.isCurrent(requestGeneration) && view && !document.hidden) polling.schedule(checkForLinks);
    }
  }
  function syncLinkCard() {
    if (lastURL !== location.href) {
      unmountCard();
      lastURL = location.href;
      dismissed = false;
      screenActive = false;
      minReceivedAtMs = undefined;
    }
    if (document.hidden) { unmountCard(); return; }
    const nextStep = detectCode() ? null : detectStep(document);
    if (nextStep === null) {
      unmountCard();
      screenActive = false;
      stepKey = undefined;
      minReceivedAtMs = undefined;
      polling.reset();
      return;
    }
    if (screenActive && (nextStep.key !== stepKey || nextStep.mode !== mode)) {
      unmountCard();
      dismissed = false;
      screenActive = false;
      // A changed panel can represent a different signup. IMAP arrival times
      // have one-second precision, so start with the next second to exclude
      // links delivered just before this step appeared.
      minReceivedAtMs = Math.max(minReceivedAtMs ?? -Infinity, resendCutoff(clock.now()));
      polling.reset();
    }
    if (dismissed) return;
    if (!screenActive) {
      screenActive = true;
      stepKey = nextStep.key;
      mode = nextStep.mode;
      minReceivedAtMs ??= initialStepCutoff(clock.now());
      polling.restart();
    }
    if (view) return;
    currentLinks = [];
    view = createView(document, {
      onClose: dismissCard, onRetry: restartPolling, mode,
      async copyLink(item) {
        await copyPasswordResetLink(browser.navigator?.clipboard, item.url,
          "Clipboard unavailable. Use Find password reset links in the toolbar popup.");
      },
      beforeUse(item) {
        if (document.hidden || lastURL !== location.href || detectCode() || !isCurrentStep() ||
            !currentLinks.some((current) => current.accountEmail === item.accountEmail &&
              current.uid === item.uid && current.url === item.url) ||
            !selectEmailLinks([item], minReceivedAtMs, clock.now()).length) {
          view?.setStatus("This link is no longer current. Request a new email or check again.");
          return false;
        }
        if (mode !== "passwordResetLinks") dismissCard();
        return true;
      },
    });
    document.documentElement.append(view.host);
    view.setStatus(MAIL_MODES[mode].waitingStatus);
    checkForLinks();
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; syncLinkCard(); }, 250);
  }
  page.onMutation((records) => {
    if (mutationAffectsEmailLinkCard(records, view?.host, document, screenActive)) scheduleScan();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && view) dismissCard(); });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.(REQUEST_CONTROL_SELECTOR);
    if (!screenActive || !isEmailLinkRequestControl(control)) return;
    minReceivedAtMs = resendCutoff(clock.now());
    dismissed = false;
    unmountCard();
    polling.restart();
    syncLinkCard();
  }, true);
  page.onPageChange(scheduleScan);
  syncLinkCard();
}
