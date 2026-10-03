import { createScanSchedule } from "../shared/scan-schedule.js";
import { calculatePickerPosition, selectSuggestedCodes, messageKey, mutationAffectsPicker, isCodeRequestControl } from "./code-picker-policy.js";
import { REQUEST_CONTROL_SELECTOR } from "../shared/step-text.js";
import { readCodeStepContext } from "../shared/code-step-context.js";
import { handleCodeField } from "../shared/code-fields.js";
import { createCodePickerView } from "./code-picker-view.js";
import { initialStepCutoff, isFreshMessage, resendCutoff, CODE_PICKER_SCAN_INTERVAL_MS } from "../shared/mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createInlinePollingLifecycle } from "../shared/polling-lifecycle.js";

export function startCodePicker({ browser = globalThis, handleField = handleCodeField, page = getPageCoordinator(browser, handleField) } = {}) {
  const { document, window, location, chrome, requestAnimationFrame,
    setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createInlinePollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: CODE_PICKER_SCAN_INTERVAL_MS });
  const { checks } = polling;
  let view;
  const scanSchedule = createScanSchedule({ clock, intervalMs: CODE_PICKER_SCAN_INTERVAL_MS });
  let dismissed = false, filledStep = false, lastURL = location.href;
  let minReceivedAtMs, anchor, stepContext;
  let seenMessageKeys = new Set(), excludedMessageKeys = new Set();
  const detectCodeField = (options) => page.detectCodeField(options);
  function unmountPicker({ preserveStep = false } = {}) {
    scanSchedule.clearPending();
    polling.cancelChecks();
    view?.host.remove();
    view = undefined;
    if (!preserveStep) {
      anchor = undefined;
      stepContext = undefined;
    }
  }
  function dismissPicker() {
    dismissed = true;
    unmountPicker();
  }
  function excludeSeenMessages() {
    for (const key of seenMessageKeys) excludedMessageKeys.add(key);
  }
  function restartPolling() {
    if (polling.renewAndQueueRetry()) return;
    checkForCodes();
  }
  function positionPicker(field = detectCodeField()) {
    if (!view || !field.ok) return;
    const bounds = view.host.getBoundingClientRect();
    const { left, top } = calculatePickerPosition(field.rect, bounds.width, bounds.height, browser.innerWidth, browser.innerHeight);
    view.host.style.left = `${left}px`;
    view.host.style.top = `${top}px`;
  }
  function mountPicker(field, context = readCodeStepContext(field.stepContext)) {
    const mountedAnchor = field.anchor;
    minReceivedAtMs ??= initialStepCutoff(clock.now());
    anchor = field.anchor;
    stepContext = context;
    const mountedView = createCodePickerView(document, {
      onClose: dismissPicker,
      onRetry: restartPolling,
      onFill: (item, button) => {
        if (view !== mountedView) return;
        // Page changes may still be waiting for the throttled discovery scan.
        syncPicker();
        if (view !== mountedView) return;
        if (!isFreshMessage(item.receivedAt, clock.now(), minReceivedAtMs)) {
          view.setStatus("This code is too old to suggest. Request a new one.");
          view.disableCodeButton(button);
          positionPicker();
          return;
        }
        const result = handleField({ action: "fill", code: item.code, expectedAnchor: mountedAnchor });
        if (result.ok) {
          filledStep = true;
          unmountPicker({ preserveStep: true });
        } else {
          view.setStatus(result.error || "Select the code field and try again.");
          positionPicker();
        }
      },
    });
    view = mountedView;
    document.documentElement.append(view.host);
    restartPolling();
    positionPicker(field);
  }
  async function checkForCodes() {
    polling.cancelScheduledCheck();
    if (lastURL !== location.href) {
      syncPicker();
      return;
    }
    if (checks.busy || !view || document.hidden || !detectCodeField().ok) return;
    const checkToken = checks.start();
    const requestGeneration = polling.generation;
    let checkFailed = false;
    if (!view.hasCodes()) view.setStatus("Checking your inboxes…");
    try {
      const { collectOnly } = scanSchedule.planNextCheck();
      const response = await requestInlineCheck(chrome.runtime, "codes", collectOnly);
      if (lastURL !== location.href) {
        syncPicker();
        return;
      }
      if (!polling.isCurrent(requestGeneration) || !view) return;
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
      scanSchedule.recordResponse(response.scanPending);
      checkFailed = !!response.warnings?.length;
      for (const item of response.codes) seenMessageKeys.add(messageKey(item));
      const codes = selectSuggestedCodes(response.codes, minReceivedAtMs, clock.now(), excludedMessageKeys);
      view.renderCodes(codes, location.hostname);
      const status = response.warnings?.length
        ? `Could not check: ${response.warnings.join("; ")}`
        : codes.length
          ? location.hostname
          : "Waiting for an email code…";
      view.setStatus(status);
    } catch (error) {
      checkFailed = true;
      if (polling.isCurrent(requestGeneration) && view) {
        scanSchedule.clearPending();
        view.clearCodes();
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(checkToken);
      if (retry === null) return;
      if (retry) {
        if (view && !document.hidden) checkForCodes();
        return;
      }
      if (view) positionPicker();
      if (view && !polling.hasExpired()) {
        polling.schedule(checkForCodes, polling.isCurrent(requestGeneration)
          ? scanSchedule.pollDelayMs : 0);
      } else if (view && !view.hasCodes() && !checkFailed) {
        view.setStatus("No code found. Click ↻ to check again.");
      }
    }
  }
  function resetAttempt({ newPage = false, preserveCutoff = false } = {}) {
    excludeSeenMessages();
    unmountPicker();
    filledStep = false;
    minReceivedAtMs = preserveCutoff
      ? Math.max(minReceivedAtMs ?? -Infinity, initialStepCutoff(clock.now()))
      : undefined;
    if (newPage) {
      dismissed = false;
      seenMessageKeys = new Set();
      page.invalidateCandidates();
    }
  }
  function syncPicker({ refreshCandidates = true } = {}) {
    if (lastURL !== location.href) {
      resetAttempt({ newPage: true });
      lastURL = location.href;
    }
    if (document.hidden) {
      if (view) unmountPicker({ preserveStep: true });
      return;
    }
    if (dismissed) return;
    const field = detectCodeField({ refresh: refreshCandidates, trackedAnchor: anchor });
    if (!field.ok) {
      if (field.trackedAnchorOffscreen) {
        if (view) unmountPicker({ preserveStep: true });
      } else if (anchor) resetAttempt();
      return;
    }
    const context = refreshCandidates || !view || anchor !== field.anchor
      ? readCodeStepContext(field.stepContext)
      : stepContext;
    if (anchor && anchor !== field.anchor) resetAttempt();
    else if (stepContext && context.key !== null && stepContext.key !== null && context.key !== stepContext.key)
      resetAttempt({ preserveCutoff: true });
    else if (filledStep) return;
    if (!view && !dismissed) mountPicker(field, context);
    else {
      stepContext = { ...context, key: context.key ?? stepContext.key };
      positionPicker(field);
    }
  }
  let discoveryTimer;
  const scheduleDiscovery = () => {
    // Throttle so a page with continuous DOM updates cannot postpone detection forever.
    if (discoveryTimer) return;
    discoveryTimer = setTimeout(() => { discoveryTimer = undefined; syncPicker(); }, 150);
  };
  let positionFrame;
  const schedulePosition = () => {
    if (dismissed || document.hidden || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined;
      syncPicker({ refreshCandidates: false });
    });
  };
  page.onMutation((records) => {
    if (mutationAffectsPicker(records, view?.host, page.candidateCache?.contextRoots, stepContext?.roots, stepContext?.parent, page.candidateCache?.labelRoots)) scheduleDiscovery();
  });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.(REQUEST_CONTROL_SELECTOR);
    if (!control || !isCodeRequestControl(control) || !detectCodeField().ok) return;
    // IMAP dates have one-second precision. Codes from the resend's current
    // second cannot be distinguished from an unseen code sent just before it.
    // Start with the next second so a pending check cannot revive the old code.
    minReceivedAtMs = resendCutoff(clock.now());
    excludeSeenMessages();
    dismissed = false;
    filledStep = false;
    polling.invalidateResponses();
    view?.clearCodes();
    if (view) {
      view.setStatus("Waiting for your new code…");
      restartPolling();
    } else {
      syncPicker();
    }
  }, true);
  document.addEventListener("focusin", scheduleDiscovery);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view) {
      dismissPicker();
    }
  });
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  page.onPageChange(() => lastURL !== location.href ? syncPicker() : scheduleDiscovery());
  syncPicker();
}
