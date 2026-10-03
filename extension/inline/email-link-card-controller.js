import { createScanSchedule } from "../shared/scan-schedule.js";
import { createMutationInspection } from "./mutation-inspection.js";
import { detectEmailLinkStep } from "./email-link-step.js";
import { copyPasswordResetLink } from "../shared/reset-link-copy.js";
import { MAIL_PRESENTATION } from "../shared/mail-presentation.js";
import { createEmailLinkCardView } from "./email-link-card-view.js";
import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";
import { getRequestControlLabel, REQUEST_CONTROL_SELECTOR } from "../shared/step-text.js";
import { initialStepCutoff, isFreshMessage, resendCutoff, DEFAULT_SCAN_INTERVAL_MS } from "../shared/mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createInlinePollingLifecycle } from "../shared/polling-lifecycle.js";

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
  const panels = "main, [role=main], form, [role=dialog]";
  const relevantElements = `${panels}, input`;
  const { relevantText, relevantSubtree, shouldInspectRecord } = createMutationInspection(
    (value) => /check|inbox|e-?mail|confirm|verif|activat|password|reset|\blink\b/i.test(value),
  );
  return records.some((record) => {
    const target = record.target;
    if (!shouldInspectRecord(record, host)) return false;
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
          if (relevantSubtree(node, relevantElements, true)) return true;
      return false;
    }
    return false;
  });
}

export function startEmailLinkCard({ browser = globalThis, detectStep = detectEmailLinkStep,
  page = getPageCoordinator(browser), detectCode = () => page.detectCodeField().ok, createView = createEmailLinkCardView } = {}) {
  const { document, location, chrome, setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createInlinePollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: DEFAULT_SCAN_INTERVAL_MS });
  const { checks } = polling;
  let view, scanTimer;
  const scanSchedule = createScanSchedule({ clock, intervalMs: DEFAULT_SCAN_INTERVAL_MS });
  let lastURL = location.href, dismissed = false, minReceivedAtMs, hasActiveStep = false, stepKey;
  let currentLinks = [];
  let mailType = "confirmationLinks";
  function isCurrentStep() {
    const step = detectStep(document);
    return step?.key === stepKey && step?.mailType === mailType;
  }
  function unmountCard() {
    scanSchedule.clearPending();
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
      const collectOnly = scanSchedule.beginCheck();
      const response = await requestInlineCheck(chrome.runtime, mailType, collectOnly);
      if (!polling.isCurrent(requestGeneration) || !view || document.hidden) return;
      if (lastURL !== location.href || detectCode() || !isCurrentStep()) { syncLinkCard(); return; }
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      scanSchedule.recordResponse(response.scanPending);
      currentLinks = selectEmailLinks(response[mailType] || [], minReceivedAtMs, clock.now());
      view.renderLinks(currentLinks);
      view.setStatus(response.warnings?.length ? `Could not check: ${response.warnings.join("; ")}` :
        currentLinks.length ? MAIL_PRESENTATION[mailType].foundStatus : MAIL_PRESENTATION[mailType].waitingStatus);
    } catch (error) {
      if (polling.isCurrent(requestGeneration) && view) {
        scanSchedule.clearPending();
        currentLinks = [];
        view.renderLinks(currentLinks);
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(checkToken);
      if (retry === null) return;
      if (retry && view && !document.hidden) checkForLinks();
      else if (polling.isCurrent(requestGeneration) && view && !document.hidden)
        polling.schedule(checkForLinks, scanSchedule.pollDelay);
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
      validateAndPrepareSelection(item) {
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
    view.setStatus(MAIL_PRESENTATION[mailType].waitingStatus);
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
