export function createTextNode(data) {
  return {
    nodeType: 3,
    data,
    get textContent() {
      return this.data;
    },
  };
}

// Wire explicit child nodes for bounded traversal. Each suite defines its own
// element textContent behaviour, including guards against aggregate reads.
export function createElementNode(tagName, children = [], properties = {}) {
  const element = { nodeType: 1, tagName, ...properties };
  const nodes = children.map((child) =>
    typeof child === "string" ? createTextNode(child) : child,
  );
  nodes.forEach((node, index) => {
    node.parentNode = element;
    node.nextSibling = nodes[index + 1] || null;
  });
  element.firstChild = nodes[0] || null;
  return element;
}

// Tests change firstChild.data when instructions change.
export function createTextElement(tagName, text, properties = {}) {
  return createElementNode(tagName, [text], properties);
}
