import assert from "node:assert/strict";
import test from "node:test";
import { createElementNode } from "./support/dom_nodes.js";
import { readCodeStepContext } from "../extension/inline/code-step-context.js";

function createStepElement(tagName, children = [], properties = {}) {
  const root = createElementNode(tagName, children, properties);
  Object.defineProperty(root, "textContent", {
    get() { assert.fail("aggregate text must not be read"); },
  });
  return root;
}
const getStyle = node => node.fakeComputedStyle || {};
const readRecipientKey = roots => readCodeStepContext({ roots }, getStyle).recipientKey;

test("step identity follows recipients across inline markup and ignores incidental text", () => {
  const instruction = () => createStepElement("P", ["We sent a code to ", createStepElement("SPAN", ["a***@example.test"])]);
  const first = readRecipientKey([createStepElement("FORM", [instruction(), createStepElement("P", ["Caps lock is off"])])]);
  const changed = readRecipientKey([createStepElement("FORM", [instruction(), createStepElement("P", ["Caps lock is on. Contact support@help.test"])])]);
  assert.notEqual(first, "[]");
  assert.equal(changed, first);
  assert.notEqual(readRecipientKey([createStepElement("P", ["Verification code for b***@example.test"])]), first);
});

test("hidden content and scripts are skipped before descendant text reads", () => {
  const forbidden = () => { assert.fail("hidden descendants must not be traversed"); };
  const hidden = [
    createStepElement("DIV", [], { hidden: true }),
    createStepElement("DIV", [], { getAttribute: name => name === "aria-hidden" ? "true" : null }),
    createStepElement("SCRIPT"), createStepElement("STYLE"), createStepElement("TEMPLATE"),
  ];
  for (const node of hidden) Object.defineProperty(node, "firstChild", { get: forbidden });
  assert.equal(readRecipientKey([createStepElement("FORM", ["Code sent to alice@example.test", ...hidden])]),
    readRecipientKey([createStepElement("P", ["Code sent to alice@example.test"])]));
});

test("CSS visibility switches change the recipient identity", () => {
  const alice = createStepElement("P", ["We sent a code to alice@example.test"]);
  const bob = createStepElement("P", ["We sent a code to bob@example.test"], { fakeComputedStyle: { display: "none" } });
  const form = createStepElement("FORM", [alice, bob]);
  assert.equal(readCodeStepContext({ roots: [form] }, getStyle).recipientKey, '["alice@example.test"]');
  alice.fakeComputedStyle = { display: "none" };
  bob.fakeComputedStyle = {};
  assert.equal(readCodeStepContext({ roots: [form] }, getStyle).recipientKey, '["bob@example.test"]');
});

test("CSS-hidden subtrees are skipped before reading descendants", () => {
  for (const fakeComputedStyle of [{ display: "none" }, { visibility: "hidden" },
    { visibility: "collapse" }, { opacity: "0" }]) {
    const hidden = createStepElement("DIV", [], { fakeComputedStyle });
    Object.defineProperty(hidden, "firstChild", { get() { assert.fail("CSS-hidden descendants must not be read"); } });
    assert.equal(readRecipientKey([createStepElement("FORM", ["Code sent to alice@example.test", hidden])]), '["alice@example.test"]');
  }
});

test("step text budget is shared across roots and rejects incomplete identities", () => {
  assert.equal(readRecipientKey([createStepElement("P", ["x".repeat(9900)]), createStepElement("P", ["x".repeat(101)])]), null);
  assert.equal(readRecipientKey([createStepElement("P", ["x".repeat(5_000_000)])]), null);
  assert.notEqual(readRecipientKey([createStepElement("P", ["x".repeat(10_000)])]), null);
});

test("step node budget stops traversal across roots", () => {
  let visits = 0;
  const roots = Array.from({ length: 600 }, () => {
    const root = createStepElement("SPAN");
    Object.defineProperty(root, "hidden", { get() { visits++; return false; } });
    return root;
  });
  assert.equal(readRecipientKey(roots), null);
  assert.equal(visits, 500);
});
