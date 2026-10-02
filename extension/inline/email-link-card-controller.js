import { copyPasswordResetLink } from "../shared/reset-link-copy.js";
import { MAIL_TYPES } from "../shared/mail-types.js";
import { createEmailLinkCardView } from "./email-link-card-view.js";
import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";
import { normalizeStepText, getRequestControlLabel, REQUEST_CONTROL_SELECTOR } from "../shared/step-text.js";
import { initialStepCutoff, isFreshMessage, resendCutoff, PENDING_SCAN_POLL_MS } from "../shared/mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createInlinePollingLifecycle } from "../shared/polling-lifecycle.js";

const emailLinkPanelIds = new WeakMap();
let nextEmailLinkPanelId = 1;
const MAX_PANEL_NODES = 500;
const MAX_PANEL_TEXT_UNITS = 10_000;
const MAX_MUTATION_NODES = 500;
const MAX_MUTATION_TEXT_UNITS = 10_000;

function isBoundedPanel(panel) {
  // Bound traversal before any layout or full rendered-text reads. Hidden
  // templates and non-rendered content do not consume the text budget.
  let count = 0, textUnits = 0;
  for (let node = panel; node;) {
    if (++count > MAX_PANEL_NODES) return false;
    if (node.nodeType === 3) {
      textUnits += node.data.length;
      if (textUnits > MAX_PANEL_TEXT_UNITS) return false;
    }
    const skipChildren = node.hidden || /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName);
    if (!skipChildren && node.firstChild) {
      node = node.firstChild;
      continue;
    }
    while (node !== panel && !node.nextSibling) node = node.parentNode;
    node = node === panel ? null : node.nextSibling;
  }
  return true;
}

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
  // before it. Navigation elsewhere in the panel must not switch link mail types.
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
    if (!panel || !isBoundedPanel(panel) || !panel.getClientRects().length ||
        !panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const text = panel.innerText || "";
    const mailType = isPasswordResetScreen(text) ? "passwordResetLinks"
      : matchesConfirmationPrompt(text) ? "confirmationLinks" : null;
    if (!mailType) continue;
    if (!emailLinkPanelIds.has(panel)) emailLinkPanelIds.set(panel, nextEmailLinkPanelId++);
    // Countdown changes retain the step; a new task in the same panel changes it.
    return { key: `${emailLinkPanelIds.get(panel)}:${normalizeStepText(text)}`, mailType };
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

export function mutationAffectsEmailLinkCard(records, host, document, hasActiveStep, hasDescendant = (node, selector) => node?.querySelector?.(selector)) {
  const attributeTargets = new Set();
  const panels = "main, [role=main], form, [role=dialog]";
  const relevantElements = `${panels}, input`;
  let remainingNodes = MAX_MUTATION_NODES, remainingTextUnits = MAX_MUTATION_TEXT_UNITS;
  const matchesText = (value) => /check|inbox|e-?mail|confirm|verif|activat|password|reset|\blink\b/i.test(value);
  const relevantText = (value = "") => {
    if (value.length > remainingTextUnits) return true;
    remainingTextUnits -= value.length;
    return matchesText(value);
  };
  const relevantSubtree = (root) => {
    const text = [];
    // Never aggregate an element's textContent or query its whole subtree.
    // Exhaustion queues the throttled scan rather than overlooking a prompt.
    for (let node = root; node;) {
      if (--remainingNodes < 0) return true;
      if (node.nodeType === 1 && node.matches?.(relevantElements)) return true;
      if (node.nodeType === 3) {
        const value = node.textContent || "";
        if (value.length > remainingTextUnits) return true;
        remainingTextUnits -= value.length;
        text.push(value);
      }
      if (node.firstChild) {
        node = node.firstChild;
        continue;
      }
      while (node !== root && !node.nextSibling) node = node.parentNode;
      node = node === root ? null : node.nextSibling;
    }
    return matchesText(text.join(""));
  };
  return records.some((record) => {
    const target = record.target;
    if (target === host || host?.contains(target)) return false;
    if (record.type === "attributes") {
      if (attributeTargets.has(target)) return false;
      attributeTargets.add(target);
    }
    const element = target.nodeType === 1 ? target : target.parentElement;
    const inActivePanel = hasActiveStep &&
      (element?.closest?.(panels) || !document.querySelector?.(panels));
    if (record.type === "attributes")
      return !!(target.matches?.(relevantElements) || hasDescendant(target, relevantElements));
    if (record.type === "characterData")
      return !!inActivePanel || relevantText(target.textContent || "") || relevantText(record.oldValue || "");
    if (record.type === "childList") {
      if (inActivePanel) return true;
      for (const nodes of [record.addedNodes, record.removedNodes])
        for (const node of nodes)
          if (relevantSubtree(node)) return true;
      return false;
    }
    return false;
  });
}

export function startEmailLinkCard({ browser = globalThis, detectStep = detectEmailLinkStep,
  page = getPageCoordinator(browser), detectCode = () => page.detectCodeField().ok, createView = createEmailLinkCardView } = {}) {
  const { document, location, chrome, setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createInlinePollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: 8000 });
  const { checks } = polling;
  let view, scanTimer;
  let scanPending = false;
  let nextScanAt = 0;
  let lastURL = location.href, dismissed = false, minReceivedAtMs, hasActiveStep = false, stepKey;
  let currentLinks = [];
  let mailType = "confirmationLinks";
  function isCurrentStep() {
    const step = detectStep(document);
    return step?.key === stepKey && step?.mailType === mailType;
  }
  function unmountCard() {
    scanPending = false;
    polling.cancelChecks();
    view?.host.remove();
    view = undefined;
  }
  function dismissCard() { dismissed = true; unmountCard(); }
  function restartPolling() {
    if (polling.renewAndQueueRetry()) return;
    checkForLinks();
  }
  async function checkForLinks() {
    polling.cancelScheduledCheck();
    if (!view || document.hidden || checks.busy) return;
    if (lastURL !== location.href || detectCode() || !isCurrentStep()) { syncLinkCard(); return; }
    if (polling.hasExpired()) {
      view.setStatus("Checking finished. Click ↻ to check again.");
      return;
    }
    const requestGeneration = polling.generation;
    const checkToken = checks.start();
    try {
      const collectOnly = scanPending && clock.now() < nextScanAt;
      if (!collectOnly) nextScanAt = clock.now() + 8000;
      const response = await requestInlineCheck(chrome.runtime, mailType, collectOnly);
      if (!polling.isCurrent(requestGeneration) || !view || document.hidden) return;
      if (lastURL !== location.href || detectCode() || !isCurrentStep()) { syncLinkCard(); return; }
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      scanPending = response.scanPending;
      currentLinks = selectEmailLinks(response[mailType] || [], minReceivedAtMs, clock.now());
      view.renderLinks(currentLinks);
      view.setStatus(response.warnings?.length ? `Could not check: ${response.warnings.join("; ")}` :
        currentLinks.length ? MAIL_TYPES[mailType].foundStatus : MAIL_TYPES[mailType].waitingStatus);
    } catch (error) {
      if (polling.isCurrent(requestGeneration) && view) {
        scanPending = false;
        currentLinks = [];
        view.renderLinks(currentLinks);
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(checkToken);
      if (retry === null) return;
      if (retry && view && !document.hidden) checkForLinks();
      else if (polling.isCurrent(requestGeneration) && view && !document.hidden)
        polling.schedule(checkForLinks, scanPending ? PENDING_SCAN_POLL_MS : 8000);
    }
  }
  function syncLinkCard() {
    if (lastURL !== location.href) {
      unmountCard();
      lastURL = location.href;
      dismissed = false;
      hasActiveStep = false;
      minReceivedAtMs = undefined;
    }
    if (document.hidden) { unmountCard(); return; }
    const nextStep = detectCode() ? null : detectStep(document);
    if (nextStep === null) {
      unmountCard();
      hasActiveStep = false;
      stepKey = undefined;
      minReceivedAtMs = undefined;
      polling.reset();
      return;
    }
    if (hasActiveStep && (nextStep.key !== stepKey || nextStep.mailType !== mailType)) {
      unmountCard();
      dismissed = false;
      hasActiveStep = false;
      // A changed panel can represent a different signup. IMAP arrival times
      // have one-second precision, so start with the next second to exclude
      // links delivered just before this step appeared.
      minReceivedAtMs = Math.max(minReceivedAtMs ?? -Infinity, resendCutoff(clock.now()));
      polling.reset();
    }
    if (dismissed) return;
    if (!hasActiveStep) {
      hasActiveStep = true;
      stepKey = nextStep.key;
      mailType = nextStep.mailType;
      minReceivedAtMs ??= initialStepCutoff(clock.now());
      polling.renewDeadline();
    }
    if (view) return;
    currentLinks = [];
    view = createView(document, {
      onClose: dismissCard, onRetry: restartPolling, mailType,
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
        if (mailType !== "passwordResetLinks") dismissCard();
        return true;
      },
    });
    document.documentElement.append(view.host);
    view.setStatus(MAIL_TYPES[mailType].waitingStatus);
    checkForLinks();
  }
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; syncLinkCard(); }, 250);
  }
  page.onMutation((records) => {
    if (mutationAffectsEmailLinkCard(records, view?.host, document, hasActiveStep, page.hasMutationDescendant)) scheduleScan();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && view) dismissCard(); });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.(REQUEST_CONTROL_SELECTOR);
    if (!hasActiveStep || !isEmailLinkRequestControl(control)) return;
    minReceivedAtMs = resendCutoff(clock.now());
    dismissed = false;
    unmountCard();
    polling.renewDeadline();
    syncLinkCard();
  }, true);
  page.onPageChange(scheduleScan);
  syncLinkCard();
}
