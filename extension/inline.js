import { fillCode } from "./fill-code.js";
import { createSuggestionView } from "./inline-view.js";

export function suggestionPosition(rect, width, height, viewportWidth, viewportHeight) {
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height <= viewportHeight - 8
    ? below : Math.max(8, rect.top - height - 4);
  return { left, top };
}

export function freshCodes(codes, since, now = Date.now(), excludedUids = new Set()) {
  const senders = new Set();
  return codes
    .filter((item) => !excludedUids.has(codeIdentity(item)) && item.receivedAt >= since && item.receivedAt <= now && now - item.receivedAt <= 600_000)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .filter((item) => {
      const sender = item.sender.trim()
        ? `sender:${item.accountEmail.toLowerCase()}:${item.sender.toLowerCase()}`
        : `message:${codeIdentity(item)}`;
      if (senders.has(sender)) return false;
      senders.add(sender);
      return true;
    });
}

function codeIdentity(item) {
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

export function startInlinePicker({ browser = globalThis, fill = fillCode } = {}) {
  const { document, window, location, chrome, MutationObserver, requestAnimationFrame,
    setTimeout, clearTimeout, innerWidth, innerHeight, Date: clock = Date } = browser;
  let view, timer, deadline = 0, checking = false;
  let dismissed = false, generation = 0, lastURL = location.href;
  let requestStartedAt, anchor;
  let knownUids = new Set(), excludedUids = new Set();
  let candidates;
  const locate = () => {
    const field = fill("", true, candidates);
    candidates = field.candidates;
    return field;
  };
  function remove() {
    generation++;
    clearTimeout(timer);
    view?.host.remove();
    view = undefined;
    anchor = undefined;
  }
  function position(field = locate()) {
    if (!view || !field.ok) return;
    const bounds = view.host.getBoundingClientRect();
    const { left, top } = suggestionPosition(field.rect, bounds.width, bounds.height, innerWidth, innerHeight);
    view.host.style.left = `${left}px`;
    view.host.style.top = `${top}px`;
  }
  function mount(field) {
    requestStartedAt ??= clock.now() - 5_000;
    anchor = field.anchor;
    view = createSuggestionView(document, {
      onClose: () => { dismissed = true; remove(); },
      onRetry: () => { deadline = clock.now() + 120_000; check(); },
      onFill: (item, button) => {
        if (clock.now() - item.receivedAt > 600_000) {
          view.status.textContent = "Code expired. Request a new one.";
          button.disabled = true;
          position();
          return;
        }
        const result = fill(item.code);
        if (result.ok) { dismissed = true; remove(); }
        else { view.status.textContent = "Select the code field and try again."; position(); }
      },
    });
    document.documentElement.append(view.host);
    deadline = clock.now() + 120_000;
    position(field);
    check();
  }
  async function check() {
    clearTimeout(timer);
    if (checking || !view || document.hidden || !locate().ok) return;
    checking = true;
    const current = generation;
    let checkFailed = false;
    if (!view.results.childElementCount) view.status.textContent = "Checking Yahoo Mail…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "yahoo-inline-codes" });
      if (current !== generation || !view) return;
      if (!response?.ok) throw new Error(response?.error || "Could not check Yahoo.");
      checkFailed = !!response.warnings?.length;
      for (const item of response.codes) knownUids.add(codeIdentity(item));
      const codes = freshCodes(response.codes, requestStartedAt, clock.now(), excludedUids);
      view.renderCodes(codes, location.hostname);
      view.status.textContent = response.warnings?.length
        ? `Could not check: ${response.warnings.join("; ")}`
        : codes.length ? location.hostname : "Waiting for a Yahoo email code…";
    } catch (error) {
      checkFailed = true;
      if (current === generation && view) view.status.textContent = error.message;
    } finally {
      checking = false;
      if (view) position();
      if (view && clock.now() < deadline)
        timer = setTimeout(check, current === generation ? 2000 : 0);
      else if (view && !view.results.childElementCount && !checkFailed) view.status.textContent = "No code found. Click ↻ to check again.";
    }
  }
  function resetAttempt({ newPage = false } = {}) {
    if (!newPage) for (const uid of knownUids) excludedUids.add(uid);
    remove();
    requestStartedAt = undefined;
    if (newPage) {
      dismissed = false;
      knownUids = new Set();
      excludedUids = new Set();
      candidates = undefined;
    }
  }
  function scan(refresh = true) {
    if (lastURL !== location.href) {
      resetAttempt({ newPage: true });
      lastURL = location.href;
    }
    if (document.hidden) { remove(); return; }
    if (dismissed) return;
    if (refresh) candidates = undefined;
    const field = locate();
    if (!field.ok) {
      if (view) resetAttempt();
      return;
    }
    if (view && anchor !== field.anchor) resetAttempt();
    if (!view && !dismissed) mount(field);
    else position(field);
  }
  let scanTimer;
  const scheduleScan = () => {
    // Throttle so a page with continuous DOM updates cannot postpone detection forever.
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = undefined; scan(); }, 150);
  };
  let positionFrame;
  const schedulePosition = () => {
    if (dismissed || document.hidden || positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined;
      scan(false);
    });
  };
  new MutationObserver((records) => {
    if (mutationAffectsPicker(records, view?.host, candidates?.contextRoots)) scheduleScan();
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true,
    attributeFilter: ["type", "name", "id", "placeholder", "autocomplete", "aria-label", "hidden", "style", "class", "disabled", "readonly", "maxlength", "for"],
  });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("button, a, [role=button]");
    if (!control ||
        !/^(?:send (?:a )?(?:new|another) code|resend(?: (?:the )?code)?)$/i.test((control.textContent || "").trim()) || !locate().ok) return;
    // IMAP dates have one-second precision. Codes from the resend's current
    // second cannot be distinguished from an unseen code sent just before it.
    // Start with the next second so a pending check cannot revive the old code.
    requestStartedAt = Math.floor(clock.now() / 1000) * 1000 + 1000;
    for (const uid of knownUids) excludedUids.add(uid);
    dismissed = false;
    generation++;
    view?.clearCodes();
    deadline = clock.now() + 120_000;
    if (view) { view.status.textContent = "Waiting for your new code…"; check(); }
    else scan();
  }, true);
  document.addEventListener("focusin", scheduleScan);
  document.addEventListener("visibilitychange", scheduleScan);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view) { dismissed = true; remove(); }
  });
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("popstate", scheduleScan);
  scan();
}
