import assert from "node:assert/strict";
import test from "node:test";
import { readCodeStepContext } from "../extension/shared/code-step-context.js";

function element(tagName, children = [], props = {}) {
  const root = { nodeType: 1, tagName, ...props };
  const nodes = children.map(child => typeof child === "string" ? { nodeType: 3, data: child } : child);
  nodes.forEach((node, index) => { node.parentNode = root; node.nextSibling = nodes[index + 1]; });
  root.firstChild = nodes[0];
  Object.defineProperty(root, "textContent", { get() { assert.fail("aggregate text must not be read"); } });
  return root;
}
const key = roots => readCodeStepContext({ roots }).key;

test("step identity follows recipients across inline markup and ignores incidental text", () => {
  const instruction = () => element("P", ["We sent a code to ", element("SPAN", ["a***@example.test"])]);
  const first = key([element("FORM", [instruction(), element("P", ["Caps lock is off"])])]);
  const changed = key([element("FORM", [instruction(), element("P", ["Caps lock is on. Contact support@help.test"])])]);
  assert.notEqual(first, "[]");
  assert.equal(changed, first);
  assert.notEqual(key([element("P", ["Verification code for b***@example.test"])]), first);
});

test("hidden content and scripts are skipped before descendant text reads", () => {
  const forbidden = () => { assert.fail("hidden descendants must not be traversed"); };
  const hidden = [
    element("DIV", [], { hidden: true }),
    element("DIV", [], { getAttribute: name => name === "aria-hidden" ? "true" : null }),
    element("SCRIPT"), element("STYLE"), element("TEMPLATE"),
  ];
  for (const node of hidden) Object.defineProperty(node, "firstChild", { get: forbidden });
  assert.equal(key([element("FORM", ["Code sent to alice@example.test", ...hidden])]),
    key([element("P", ["Code sent to alice@example.test"])]));
});

test("step text budget is shared across roots and rejects incomplete identities", () => {
  assert.equal(key([element("P", ["x".repeat(9900)]), element("P", ["x".repeat(101)])]), null);
  assert.equal(key([element("P", ["x".repeat(5_000_000)])]), null);
  assert.notEqual(key([element("P", ["x".repeat(10_000)])]), null);
});

test("step node budget stops traversal across roots", () => {
  let visits = 0;
  const roots = Array.from({ length: 600 }, () => {
    const root = element("SPAN");
    Object.defineProperty(root, "hidden", { get() { visits++; return false; } });
    return root;
  });
  assert.equal(key(roots), null);
  assert.equal(visits, 500);
});
