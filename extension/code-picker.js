import { normalizeStepText, getRequestControlLabel, REQUEST_CONTROL_SELECTOR } from "./step-text.js";
import { handleCodeField } from "./code-fields.js";
import { createCodePickerView } from "./code-picker-view.js";
import { initialStepCutoff, isFreshMessage, resendCutoff } from "./mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createPollingLifecycle, createRetryGate } from "./polling-lifecycle.js";

export function suggestionPosition(rect, width, height, viewportWidth, viewportHeight) {
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height <= viewportHeight - 8
    ? below
    : Math.max(8, rect.top - height - 4);
  return { left, top };
}

export function selectSuggestedCodes(codes, minReceivedAtMs, now = Date.now(), excludedMessageKeys = new Set()) {
  const senders = new Set();
  return codes
    .filter((item) => !excludedMessageKeys.has(messageKey(item)) && isFreshMessage(item.receivedAt, now, minReceivedAtMs))
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .filter((item) => {
      const senderKey = item.sender.trim()
        ? `sender:${item.accountEmail.toLowerCase()}:${item.sender.toLowerCase()}`
        : `message:${messageKey(item)}`;
      if (senders.has(senderKey)) return false;
      senders.add(senderKey);
      return true;
    });
}

function messageKey(item) {
  return `${item.accountEmail.toLowerCase()}:${item.uid}`;
}

function verificationStepContext(anchor) {
  const container = anchor?.form || anchor?.parentElement;
  if (!container) return { roots: [], key: "" };
  const roots = [container];
  let sibling = container.previousElementSibling;
  for (let count = 0; sibling && count < 2; count++, sibling = sibling.previousElementSibling)
    roots.push(sibling);
  const key = roots.map((root) => normalizeStepText(root.textContent || "")).join("\n");
  return { roots, parent: container.parentElement, key };
}

export function mutationAffectsPicker(records, host, contextRoots = [], stepRoots = [], stepParent) {
  const hasRelevantElement = (node) => node?.nodeType === 1 && (
    node.matches?.("input, label, form, main") ||
    node.querySelector?.("input, label, form, main")
  );
  const relevantText = (value) => /code|email|verif|sign.?in|\bsent\b|\bcheck\b/i.test(value || "");
  const changesContext = (record) => record.type === "characterData"
    ? relevantText(record.target.textContent) || relevantText(record.oldValue)
    : record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].some((node) => relevantText(node.textContent));
  return records.some((record) => {
    const target = record.target;
    if (target === host || host?.contains(target)) return false;
    if (record.type === "childList" && target === stepParent) return true;
    if (stepRoots.some((root) => root.contains?.(target)) &&
        (record.type === "characterData" || record.type === "childList")) return true;
    if (contextRoots.some((root) => root.contains?.(target)) && changesContext(record)) return true;
    if (record.type === "attributes")
      return target?.matches?.("input, label") || !!target?.querySelector?.("input");
    if (record.type === "characterData")
      return !!target?.parentElement?.closest?.("label");
    if (target?.closest?.("label")) return true;
    return [...record.addedNodes, ...record.removedNodes].some(hasRelevantElement);
  });
}

export function isCodeRequestControl(control) {
  const label = getRequestControlLabel(control);
  if (/\b(?:coupon|promo|discount|referral)\b/i.test(label)) return false;
  return /^(?:re-?send|send|request|get|email)\b/i.test(label) &&
    (/\b(?:code|otp|passcode)\b/i.test(label) || /^re-?send(?: again)?$/i.test(label));
}

export function startCodePicker({ browser = globalThis, handleField = handleCodeField, page = getPageCoordinator(browser, handleField) } = {}) {
  const { document, window, location, chrome, requestAnimationFrame,
    setTimeout, clearTimeout, Date: clock = Date } = browser;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: 2000 });
  const checks = createRetryGate();
  let view;
  let dismissed = false, filledStep = false, lastURL = location.href;
  let minReceivedAtMs, anchor, stepContext;
  let seenMessageKeys = new Set(), excludedMessageKeys = new Set();
  const detectCodeField = (options) => page.detectCodeField(options);
  function unmountPicker({ preserveStep = false } = {}) {
    polling.invalidate();
    checks.invalidate();
    polling.clear();
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
    polling.restart();
    if (checks.requestRetry()) {
      polling.invalidate();
      return;
    }
    checkForCodes();
  }
  function positionPicker(field = detectCodeField()) {
    if (!view || !field.ok) return;
    const bounds = view.host.getBoundingClientRect();
    const { left, top } = suggestionPosition(field.rect, bounds.width, bounds.height, browser.innerWidth, browser.innerHeight);
    view.host.style.left = `${left}px`;
    view.host.style.top = `${top}px`;
  }
  function mountPicker(field, context = verificationStepContext(field.anchor)) {
    const mountedAnchor = field.anchor;
    minReceivedAtMs ??= initialStepCutoff(clock.now());
    anchor = field.anchor;
    stepContext = context;
    view = createCodePickerView(document, {
      onClose: dismissPicker,
      onRetry: restartPolling,
      onFill: (item, button) => {
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
          view.setStatus("Select the code field and try again.");
          positionPicker();
        }
      },
    });
    document.documentElement.append(view.host);
    restartPolling();
    positionPicker(field);
  }
  async function checkForCodes() {
    polling.clear();
    if (lastURL !== location.href) {
      syncPicker();
      return;
    }
    if (checks.busy || !view || document.hidden || !detectCodeField().ok) return;
    const check = checks.start();
    const requestGeneration = polling.generation;
    let checkFailed = false;
    if (!view.hasCodes()) view.setStatus("Checking your inboxes…");
    try {
      const response = await requestInlineCheck(chrome.runtime, "codes");
      if (lastURL !== location.href) {
        syncPicker();
        return;
      }
      if (!polling.isCurrent(requestGeneration) || !view) return;
      if (!response?.ok) throw new Error(response?.error || "Could not check your inboxes.");
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
        view.clearCodes();
        view.setStatus(error.message);
      }
    } finally {
      const retry = checks.finish(check);
      if (retry === null) return;
      if (retry) {
        if (view && !document.hidden) checkForCodes();
        return;
      }
      if (view) positionPicker();
      if (view && !polling.expired()) {
        polling.schedule(checkForCodes, polling.isCurrent(requestGeneration) ? 2000 : 0);
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
      ? verificationStepContext(field.anchor)
      : stepContext;
    if (anchor && anchor !== field.anchor) resetAttempt();
    else if (stepContext && context.key !== stepContext.key)
      resetAttempt({ preserveCutoff: true });
    else if (filledStep) return;
    if (!view && !dismissed) mountPicker(field, context);
    else positionPicker(field);
  }
  let scanTimer;
  const scheduleScan = () => {
    // Throttle so a page with continuous DOM updates cannot postpone detection forever.
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; syncPicker(); }, 150);
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
    if (mutationAffectsPicker(records, view?.host, page.candidateCache?.contextRoots, stepContext?.roots, stepContext?.parent)) scheduleScan();
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
    polling.invalidate();
    view?.clearCodes();
    if (view) {
      view.setStatus("Waiting for your new code…");
      restartPolling();
    } else {
      syncPicker();
    }
  }, true);
  document.addEventListener("focusin", scheduleScan);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view) {
      dismissPicker();
    }
  });
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  page.onPageChange(() => lastURL !== location.href ? syncPicker() : scheduleScan());
  syncPicker();
}
