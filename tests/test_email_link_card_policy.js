import test from "node:test";
import assert from "node:assert/strict";
import { isEmailLinkRequestControl, mutationAffectsEmailLinkCard, selectEmailLinks } from "../extension/inline/email-link-card-policy.js";

const item = { url: "https://example.com/confirm?token=abc", receivedAt: 10000, accountEmail: "me@yahoo.com", sender: "hello@example.com", uid: 1 };

test("recognises controls that request another confirmation message", () => {
  const control = (textContent) => ({ textContent, getAttribute: () => "" });
  for (const label of ["Resend email", "Send again", "Send confirmation email", "Request verification link"])
    assert.equal(isEmailLinkRequestControl(control(label)), true, label);
  assert.equal(isEmailLinkRequestControl(control("Contact support")), false);
});

test("ignores unrelated page mutations but scans prompt and code-field changes", () => {
  const document = { querySelector: () => ({}) };
  const outside = { nodeType: 1, textContent: "Stock price", closest: () => null,
    matches: () => false, querySelector: () => null };
  const input = { nodeType: 1, matches: (selector) => selector.includes("input") };
  const panel = { nodeType: 1, closest: () => ({}), matches: () => false };
  const mutation = (type, target, addedNodes = []) => ({ type, target, addedNodes, removedNodes: [] });
  assert.equal(mutationAffectsEmailLinkCard([mutation("attributes", outside)], null, document, true), false);
  assert.equal(mutationAffectsEmailLinkCard([mutation("childList", outside, [{ nodeType: 3, textContent: "Price changed" }])], null, document, true), false);
  assert.equal(mutationAffectsEmailLinkCard([mutation("characterData", { nodeType: 3, textContent: "Check your email" })], null, document, false), true);
  assert.equal(mutationAffectsEmailLinkCard([mutation("childList", outside, [input])], null, document, false), true);
  assert.equal(mutationAffectsEmailLinkCard([mutation("characterData", { nodeType: 3, textContent: "bob@example.com", parentElement: panel })], null, document, true), true);
});

test("large added and removed subtrees queue a scan without aggregate text or descendant queries", () => {
  const subtree = {
    nodeType: 1, matches: () => false,
    get textContent() { assert.fail("must not aggregate subtree text"); },
    querySelector() { assert.fail("must not query an unbounded subtree"); },
  };
  subtree.firstChild = { nodeType: 3, textContent: "x".repeat(2_000_000), parentNode: subtree };
  for (const changedNodes of ["addedNodes", "removedNodes"]) {
    const record = { type: "childList", target: { nodeType: 1 }, addedNodes: [], removedNodes: [] };
    record[changedNodes] = [subtree];
    assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), true);
  }
});

test("mutation node and text budgets apply across the whole batch", () => {
  let inspected = 0;
  const records = Array.from({ length: 2000 }, () => ({
    type: "childList", target: { nodeType: 1 }, removedNodes: [],
    addedNodes: [{ nodeType: 1, matches: () => false,
      get firstChild() { inspected++; return null; } }],
  }));
  assert.equal(mutationAffectsEmailLinkCard(records, null, {}, false), true);
  assert.equal(inspected, 500);

  let textReads = 0;
  const textRecords = Array.from({ length: 100 }, () => ({
    type: "characterData", target: { nodeType: 3,
      get textContent() { textReads++; return "x".repeat(1000); } }, oldValue: "",
  }));
  assert.equal(mutationAffectsEmailLinkCard(textRecords, null, {}, false), true);
  assert.equal(textReads, 11);
});

test("bounded mutation traversal preserves prompts split across nested elements", () => {
  const root = { nodeType: 1, matches: () => false };
  const span = { nodeType: 1, matches: () => false, parentNode: root };
  root.firstChild = { nodeType: 3, textContent: "e", parentNode: root, nextSibling: span };
  span.firstChild = { nodeType: 3, textContent: "mail", parentNode: span };
  const record = { type: "childList", target: { nodeType: 1 }, addedNodes: [root], removedNodes: [] };
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), true);
  span.firstChild.textContent = "Price changed";
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), false);
  span.matches = (selector) => selector.includes("input");
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), true);
});

test("selects fresh HTTPS links and omits older or unsafe candidates", () => {
  assert.deepEqual(selectEmailLinks([item, { ...item, receivedAt: 1 }, { ...item, url: "javascript:alert(1)" }, { ...item, receivedAt: 20000 }], 5000, 10000), [item]);
});

test("repeated unrelated attribute targets are inspected once per batch", () => {
  let inspections = 0;
  const target = {nodeType: 1, matches() { inspections++; return false; },
    querySelector() { assert.fail("must not query unrestricted descendants"); } };
  const records = Array.from({length: 1000}, () => ({type: "attributes", target}));
  assert.equal(mutationAffectsEmailLinkCard(records, null, {}, false), false);
  assert.equal(inspections, 1);
});


test("attribute inspection shares the batch node budget without descendant queries", () => {
  let inspected = 0;
  const records = Array.from({ length: 2000 }, () => ({
    type: "attributes", target: {
      nodeType: 1, matches: () => false,
      get firstChild() { inspected++; return null; },
      querySelector() { assert.fail("must not query unrestricted descendants"); },
    },
  }));
  assert.equal(mutationAffectsEmailLinkCard(records, null, {}, false), true);
  assert.equal(inspected, 500);
});

test("one large attribute subtree exhausts the node budget and queues discovery", () => {
  let inspected = 0;
  const root = { nodeType: 1, matches: () => false,
    querySelector() { assert.fail("must not query unrestricted descendants"); } };
  let node = root;
  for (let index = 0; index < 2000; index++) {
    const child = { nodeType: 1, matches: () => { inspected++; return false; }, parentNode: node };
    node.firstChild = child;
    node = child;
  }
  assert.equal(mutationAffectsEmailLinkCard([{ type: "attributes", target: root }], null, {}, false), true);
  assert.equal(inspected, 499);
});
