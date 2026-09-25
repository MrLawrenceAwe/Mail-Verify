import { fillCode } from "./fill-code.js";

export function suggestionPosition(rect, width, height, viewportWidth, viewportHeight) {
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height <= viewportHeight - 8
    ? below : Math.max(8, rect.top - height - 4);
  return { left, top };
}

export function freshCodes(codes, since, now = Date.now()) {
  const senders = new Set();
  return codes
    .filter((item) => item.receivedAt >= since && item.receivedAt <= now && now - item.receivedAt <= 600_000)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .filter((item) => {
      const sender = item.sender.toLowerCase();
      if (senders.has(sender)) return false;
      senders.add(sender);
      return true;
    });
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

export function startInlinePicker() {
  let host, status, results, timer, deadline = 0, checking = false;
  let dismissed = false, generation = 0, lastURL = location.href;
  let requestStartedAt;
  let contextRoots = [];
  let candidates;
  const locate = () => {
    const field = fillCode("", true, candidates);
    candidates = field.candidates;
    contextRoots = field.contextRoots;
    return field;
  };
  function remove() {
    generation++;
    clearTimeout(timer);
    host?.remove();
    host = undefined;
  }
  function position(field = locate()) {
    if (!host || !field.ok) return;
    const bounds = host.getBoundingClientRect();
    const { left, top } = suggestionPosition(field.rect, bounds.width, bounds.height, innerWidth, innerHeight);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }
  function mount(field) {
    requestStartedAt ??= Date.now() - 5_000;
    host = document.createElement("div");
    host.dataset.yahooCodeFill = "suggestion";
    host.style.cssText = "position:fixed;z-index:2147483647;left:0;top:0";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      :host { all:initial; }
      section { box-sizing:border-box; width:240px; max-width:calc(100vw - 16px); max-height:45vh; overflow:auto; padding:4px; border:1px solid #d3d3ca; border-radius:8px; background:#f3f3eb; color:#343746; box-shadow:0 2px 8px #0002; font:14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      button { font:inherit; cursor:pointer; border:0; }
      button:focus-visible { outline:2px solid #163fa9; outline-offset:2px; }
      .code { width:100%; display:flex; gap:8px; align-items:center; text-align:left; border-radius:5px; padding:6px 8px; background:#6096f4; color:white; }
      .code:hover { background:#477fdf; }
      .code + .code { margin-top:4px; }
      .code:disabled { opacity:.6; }
      svg { width:24px; height:20px; flex:none; }
      strong { display:block; font-size:14px; font-weight:500; }
      small { display:block; font-size:11px; margin-top:0; }
      .controls { display:flex; align-items:center; gap:4px; padding:0 3px; }
      #status { flex:1; font-size:10px; margin:2px 0; overflow-wrap:anywhere; }
      #retry, #close { color:#555d6b; background:transparent; padding:1px 4px; border-radius:3px; line-height:18px; }
      #retry:hover, #close:hover { background:#0001; }
      [hidden] { display:none !important; }
    </style><section aria-label="Yahoo Mail code suggestions"><div id="results"></div><div class="controls"><p id="status" role="status"></p><button id="retry" title="Check Yahoo again" aria-label="Check Yahoo again">↻</button><button id="close" aria-label="Dismiss code suggestions">×</button></div></section>`;
    status = root.querySelector("#status");
    results = root.querySelector("#results");
    root.querySelector("#close").onclick = () => { dismissed = true; remove(); };
    root.querySelector("#retry").onclick = () => { deadline = Date.now() + 120_000; check(); };
    document.documentElement.append(host);
    deadline = Date.now() + 120_000;
    position(field);
    check();
  }
  async function check() {
    clearTimeout(timer);
    if (checking || !host || document.hidden || !locate().ok) return;
    checking = true;
    const current = generation;
    if (!results.childElementCount) status.textContent = "Checking Yahoo Mail…";
    try {
      const response = await chrome.runtime.sendMessage({ type: "yahoo-inline-codes" });
      if (current !== generation || !host) return;
      if (!response?.ok) throw new Error(response?.error || "Could not check Yahoo.");
      const codes = freshCodes(response.codes, requestStartedAt);
      // Preserve keyboard focus on unchanged suggestions during polling.
      const key = JSON.stringify(codes);
      if (results.dataset.codes !== key) {
        results.dataset.codes = key;
        results.replaceChildren();
        for (const item of codes) {
          const button = document.createElement("button");
          button.className = "code";
          button.innerHTML = `<svg viewBox="0 0 36 28" aria-hidden="true"><path fill="currentColor" d="M2 2h32L18 14zM1 5l12 10L1 25zm34 0v20L23 15zM3 27l12-10 3 3 3-3 12 10z"/></svg><span><strong></strong><small>From Yahoo Mail</small></span>`;
          button.querySelector("strong").textContent = `Fill code ${item.code}`;
          button.title = `${item.sender}\n${item.subject}\nFill on ${location.hostname}`;
          button.setAttribute("aria-label", `Fill code ${item.code} from ${item.sender}. ${item.subject}. On ${location.hostname}`);
          button.addEventListener("mousedown", (event) => event.preventDefault());
          button.onclick = () => {
            if (Date.now() - item.receivedAt > 600_000) {
              status.textContent = "Code expired. Request a new one.";
              button.disabled = true;
              position();
              return;
            }
            const result = fillCode(item.code);
            if (result.ok) { dismissed = true; remove(); }
            else { status.textContent = "Select the code field and try again."; position(); }
          };
          results.append(button);
        }
      }
      status.textContent = codes.length ? location.hostname : "Waiting for a Yahoo email code…";
    } catch (error) {
      if (current === generation && host) status.textContent = error.message;
    } finally {
      checking = false;
      if (host) position();
      if (host && Date.now() < deadline)
        timer = setTimeout(check, current === generation ? 2000 : 0);
      else if (host && !results.childElementCount) status.textContent = "No code found. Click ↻ to check again.";
    }
  }
  function scan(refresh = true) {
    if (lastURL !== location.href) { remove(); dismissed = false; lastURL = location.href; requestStartedAt = undefined; candidates = undefined; }
    if (document.hidden) { remove(); return; }
    if (dismissed) return;
    if (refresh) candidates = undefined;
    const field = locate();
    if (!field.ok) { if (host) remove(); return; }
    if (!host && !dismissed) mount(field);
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
    if (mutationAffectsPicker(records, host, contextRoots)) scheduleScan();
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true,
    attributeFilter: ["type", "name", "id", "placeholder", "autocomplete", "aria-label", "hidden", "style", "class", "disabled", "readonly", "maxlength", "for"],
  });
  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("button, a, [role=button]");
    if (!control ||
        !/^(?:send (?:a )?(?:new|another) code|resend(?: (?:the )?code)?)$/i.test((control.textContent || "").trim()) || !locate().ok) return;
    // A resend invalidates the previous suggestion immediately, including any
    // old response already in flight. IMAP dates have one-second precision.
    requestStartedAt = Math.floor(Date.now() / 1000) * 1000;
    dismissed = false;
    generation++;
    results?.replaceChildren();
    if (results) delete results.dataset.codes;
    deadline = Date.now() + 120_000;
    if (host) { status.textContent = "Waiting for your new code…"; check(); }
    else scan();
  }, true);
  document.addEventListener("focusin", scheduleScan);
  document.addEventListener("visibilitychange", scheduleScan);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && host) { dismissed = true; remove(); }
  });
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("popstate", scheduleScan);
  scan();
}
