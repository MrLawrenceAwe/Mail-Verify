const MAX_MUTATION_NODES = 500;
const MAX_MUTATION_TEXT_UNITS = 10_000;

// One inspector owns the budgets and attribute deduplication for a mutation batch.
// Exhaustion requests a scan rather than dropping potentially relevant changes.
export function createMutationInspection(matchesText) {
  const attributeTargets = new Set();
  let remainingNodes = MAX_MUTATION_NODES;
  let remainingTextUnits = MAX_MUTATION_TEXT_UNITS;
  function inspectNode() {
    return --remainingNodes >= 0;
  }
  function relevantText(value = "") {
    if (value.length > remainingTextUnits) return true;
    remainingTextUnits -= value.length;
    return matchesText(value);
  }
  function relevantSubtree(root, selector, inspectText = false) {
    const text = [];
    // Inspect individual text nodes; never aggregate element textContent or
    // query unrestricted descendants inside a mutation observer.
    for (let node = root; node;) {
      if (!inspectNode()) return true;
      if (node.nodeType === 1 && node.matches?.(selector)) return true;
      if (inspectText && node.nodeType === 3) {
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
    return inspectText && matchesText(text.join(""));
  }
  function shouldInspectRecord(record, host) {
    const target = record.target;
    if (target === host || host?.contains(target)) return false;
    if (record.type === "attributes") {
      if (attributeTargets.has(target)) return false;
      attributeTargets.add(target);
    }
    return true;
  }
  return { inspectNode, relevantText, relevantSubtree, shouldInspectRecord };
}
