// Build an explicit element/text-node pair for bounded DOM traversal.
// Tests change firstChild.data when instructions change.
export function createTextElement(tagName, text, properties = {}) {
  const element = { nodeType: 1, tagName, ...properties };
  element.firstChild = { nodeType: 3, data: text, parentNode: element };
  return element;
}
