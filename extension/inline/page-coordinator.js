import { handleCodeField } from "../shared/code-fields.js";

const coordinators = new WeakMap();

export function getPageCoordinator(browser, handleField = handleCodeField) {
  const { document, window, MutationObserver } = browser;
  if (coordinators.has(document)) return coordinators.get(document);

  const mutationListeners = new Set();
  const pageListeners = new Set();
  let candidateCache;
  let descendantCache = new WeakMap();
  const coordinator = {
    get candidateCache() { return candidateCache; },
    hasMutationDescendant(node, selector) {
      if (!node?.querySelector) return false;
      let matches = descendantCache.get(node);
      if (!matches) descendantCache.set(node, matches = new Map());
      if (!matches.has(selector)) matches.set(selector, !!node.querySelector(selector));
      return matches.get(selector);
    },
    detectCodeField({ refresh = false, trackedAnchor } = {}) {
      if (refresh) candidateCache = undefined;
      const field = handleField({ action: "detect", candidateCache, trackedAnchor });
      candidateCache = field.candidateCache;
      return field;
    },
    invalidateCandidates() { candidateCache = undefined; },
    onMutation(listener) { mutationListeners.add(listener); },
    onPageChange(listener) { pageListeners.add(listener); },
  };
  coordinators.set(document, coordinator);

  new MutationObserver((records) => {
    if (records.some(record => record.type === "childList" || record.attributeName === "role"))
      descendantCache = new WeakMap();
    if (document.hidden) { candidateCache = undefined; return; }
    for (const listener of mutationListeners) listener(records);
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true,
    attributeFilter: ["role", "type", "name", "id", "placeholder", "autocomplete", "aria-label", "hidden", "style", "class", "disabled", "readonly", "maxlength", "for"],
  });
  const notifyPageChange = () => {
    for (const listener of pageListeners) listener();
  };
  document.addEventListener("visibilitychange", notifyPageChange);
  window.addEventListener("popstate", notifyPageChange);
  window.addEventListener("hashchange", notifyPageChange);
  window.navigation?.addEventListener("currententrychange", notifyPageChange);
  return coordinator;
}
