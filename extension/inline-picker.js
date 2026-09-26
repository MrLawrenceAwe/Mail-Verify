import { handleCodeField } from "./code-fields.js";
import { createInlinePickerView } from "./inline-picker-view.js";
import { MAX_CODE_AGE_MS, POLL_WINDOW_MS } from "./code-timing.js";

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
    .filter((item) => !excludedMessageKeys.has(messageKey(item)) && item.receivedAt >= minReceivedAtMs && item.receivedAt <= now && now - item.receivedAt <= MAX_CODE_AGE_MS)
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

export function mutationAffectsPicker(records, host, contextRoots = []) {
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
  const label = (control.getAttribute?.("aria-label") || control.textContent || "")
    .trim().replace(/\s+/g, " ");
  if (/\b(?:coupon|promo|discount|referral)\b/i.test(label)) return false;
  return /^(?:re-?send|send|request|get|email)\b/i.test(label) &&
    (/\b(?:code|otp|passcode)\b/i.test(label) || /^re-?send(?: again)?$/i.test(label));
}

export function startInlinePicker({ browser = globalThis, handleField = handleCodeField } = {}) {
  const { document, window, location, chrome, MutationObserver, requestAnimationFrame,
    setTimeout, clearTimeout, Date: clock = Date } = browser;
  let view, pollTimer, pollDeadline = 0, checking = false;
  let dismissed = false, attemptGeneration = 0, lastURL = location.href;
  let minReceivedAtMs, anchor;
  let seenMessageKeys = new Set(), excludedMessageKeys = new Set();
  let candidateCache;
  const detectCodeField = () => {
    const field = handleField({ action: "detect", candidateCache });
    candidateCache = field.candidateCache;
    return field;
  };
  function unmountPicker() {
    attemptGeneration++;
    clearTimeout(pollTimer);
    view?.host.remove();
    view = undefined;
    anchor = undefined;
  }
  function dismissPicker() {
    dismissed = true;
    unmountPicker();
  }
  function excludeSeenMessages() {
    for (const key of seenMessageKeys) excludedMessageKeys.add(key);
  }
  function restartPolling() {
    pollDeadline = clock.now() + POLL_WINDOW_MS;
    checkForCodes();
  }
  function positionPicker(field = detectCodeField()) {
    if (!view || !field.ok) return;
    const bounds = view.host.getBoundingClientRect();
    const { left, top } = suggestionPosition(field.rect, bounds.width, bounds.height, browser.innerWidth, browser.innerHeight);
    view.host.style.left = `${left}px`;
    view.host.style.top = `${top}px`;
  }
  function mountPicker(field) {
    minReceivedAtMs ??= clock.now() - 5_000;
    anchor = field.anchor;
    view = createInlinePickerView(document, {
      onClose: dismissPicker,
      onRetry: restartPolling,
      onFill: (item, button) => {
        if (clock.now() - item.receivedAt > MAX_CODE_AGE_MS) {
          view.setStatus("This code is too old to suggest. Request a new one.");
          view.disableCodeButton(button);
          positionPicker();
          return;
        }
        const result = handleField({ action: "fill", code: item.code });
        if (result.ok) {
          dismissPicker();
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
    clearTimeout(pollTimer);
    if (lastURL !== location.href) {
      syncPicker();
      return;
    }
    if (checking || !view || document.hidden || !detectCodeField().ok) return;
    checking = true;
    const requestGeneration = attemptGeneration;
    let checkFailed = false;
    if (!view.hasCodes()) view.setStatus("Checking Yahoo Mail…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "yahoo-inline-codes" });
      if (lastURL !== location.href) {
        syncPicker();
        return;
      }
      if (requestGeneration !== attemptGeneration || !view) return;
      if (!response?.ok) throw new Error(response?.error || "Could not check Yahoo.");
      checkFailed = !!response.warnings?.length;
      for (const item of response.codes) seenMessageKeys.add(messageKey(item));
      const codes = selectSuggestedCodes(response.codes, minReceivedAtMs, clock.now(), excludedMessageKeys);
      view.renderCodes(codes, location.hostname);
      const status = response.warnings?.length
        ? `Could not check: ${response.warnings.join("; ")}`
        : codes.length
          ? location.hostname
          : "Waiting for a Yahoo email code…";
      view.setStatus(status);
    } catch (error) {
      checkFailed = true;
      if (requestGeneration === attemptGeneration && view) view.setStatus(error.message);
    } finally {
      checking = false;
      if (view) positionPicker();
      if (view && clock.now() < pollDeadline) {
        pollTimer = setTimeout(checkForCodes, requestGeneration === attemptGeneration ? 2000 : 0);
      } else if (view && !view.hasCodes() && !checkFailed) {
        view.setStatus("No code found. Click ↻ to check again.");
      }
    }
  }
  function resetAttempt({ newPage = false } = {}) {
    excludeSeenMessages();
    unmountPicker();
    minReceivedAtMs = undefined;
    if (newPage) {
      dismissed = false;
      seenMessageKeys = new Set();
      candidateCache = undefined;
    }
  }
  function syncPicker({ refreshCandidates = true } = {}) {
    if (lastURL !== location.href) {
      resetAttempt({ newPage: true });
      lastURL = location.href;
    }
    if (document.hidden) {
      unmountPicker();
      return;
    }
    if (dismissed) return;
    if (refreshCandidates) candidateCache = undefined;
    const field = detectCodeField();
    if (!field.ok) {
      if (view) resetAttempt();
      return;
    }
    if (view && anchor !== field.anchor) resetAttempt();
    if (!view && !dismissed) mountPicker(field);
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
  new MutationObserver((records) => {
    if (mutationAffectsPicker(records, view?.host, candidateCache?.contextRoots)) scheduleScan();
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true,
    attributeFilter: ["type", "name", "id", "placeholder", "autocomplete", "aria-label", "hidden", "style", "class", "disabled", "readonly", "maxlength", "for"],
  });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("button, a, [role=button]");
    if (!control || !isCodeRequestControl(control) || !detectCodeField().ok) return;
    // IMAP dates have one-second precision. Codes from the resend's current
    // second cannot be distinguished from an unseen code sent just before it.
    // Start with the next second so a pending check cannot revive the old code.
    minReceivedAtMs = Math.floor(clock.now() / 1000) * 1000 + 1000;
    excludeSeenMessages();
    dismissed = false;
    attemptGeneration++;
    view?.clearCodes();
    if (view) {
      view.setStatus("Waiting for your new code…");
      restartPolling();
    } else {
      syncPicker();
    }
  }, true);
  document.addEventListener("focusin", scheduleScan);
  document.addEventListener("visibilitychange", scheduleScan);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view) {
      dismissPicker();
    }
  });
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("popstate", scheduleScan);
  window.addEventListener("hashchange", scheduleScan);
  window.navigation?.addEventListener("currententrychange", syncPicker);
  syncPicker();
}
