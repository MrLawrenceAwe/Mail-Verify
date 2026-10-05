import test from "node:test";
import assert from "node:assert/strict";
import { selectSuggestedCodes, mutationAffectsPicker, isCodeRequestControl } from "../extension/inline/code-picker-policy.js";

test("old codes are withheld while waiting for this verification attempt", () => {
  const older = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 1000 };
  const newest = { uid: 2, accountEmail: "test@yahoo.com", code: "222222", sender: "auth@example.test", receivedAt: 9000 };
  assert.deepEqual(selectSuggestedCodes([older], 5000, 10000), []);
  assert.deepEqual(selectSuggestedCodes([older, newest], 5000, 10000), [newest]);
  assert.deepEqual(selectSuggestedCodes([newest], 9500, 10000), []);
});

test("only the latest code per sender is suggested, without changing the response", () => {
  const codes = [
    { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "AUTH@example.test", receivedAt: 8000 },
    { uid: 2, accountEmail: "test@yahoo.com", code: "222222", sender: "auth@example.test", receivedAt: 9000 },
    { uid: 3, accountEmail: "test@yahoo.com", code: "333333", sender: "other@example.test", receivedAt: 9500 },
  ];
  assert.deepEqual(selectSuggestedCodes(codes, 5000, 10000).map(x => x.code), ["333333", "222222"]);
  assert.equal(codes[0].code, "111111");
});

test("codes without a sender remain separate suggestions", () => {
  const codes = [
    { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "", receivedAt: 9000 },
    { uid: 2, accountEmail: "test@yahoo.com", code: "222222", sender: "", receivedAt: 9500 },
  ];
  assert.deepEqual(selectSuggestedCodes(codes, 8000, 10000).map(item => item.code), ["222222", "111111"]);
});

test("UID exclusion distinguishes two messages received in the same second", () => {
  const old = { uid: 7, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  const newer = { uid: 8, accountEmail: "test@yahoo.com", code: "222222", sender: "auth@example.test", receivedAt: 9000 };
  assert.deepEqual(selectSuggestedCodes([old, newer], 9000, 9500, new Set(["test@yahoo.com:7"])), [newer]);
});

test("same sender and UID in separate accounts remain distinct", () => {
  const codes = [
    { uid: 7, code: "111111", sender: "auth@example.test", accountEmail: "one@yahoo.com", receivedAt: 9000 },
    { uid: 7, code: "222222", sender: "auth@example.test", accountEmail: "two@yahoo.com", receivedAt: 9100 },
  ];
  assert.deepEqual(selectSuggestedCodes(codes, 8000, 10000).map(x => x.code), ["222222", "111111"]);
  assert.deepEqual(selectSuggestedCodes(codes, 8000, 10000, new Set(["one@yahoo.com:7"])).map(x => x.code), ["222222"]);
});

test("recognises common resend labels without treating coupon requests as email codes", () => {
  for (const textContent of ["Resend code", "Resend email and SMS code", "Send another verification code", "Request a new code", "Get a new OTP", "Resend", "Resend email", "Resend e-mail", "Resend verification email", "Resend confirmation e-mail", "Resend security email", "Resend authentication email", "Send again"])
    assert.equal(isCodeRequestControl({ textContent }), true, textContent);
  for (const textContent of ["Resend invoice", "Resend invoice email", "Resend message", "Send email", "Send promo code again", "Resend SMS code", "Send phone verification code", "Resend text message", "Request mobile code"])
    assert.equal(isCodeRequestControl({ textContent }), false, textContent);
  assert.equal(isCodeRequestControl({ textContent: "Send promo code" }), false);
  assert.equal(isCodeRequestControl({ textContent: "Continue" }), false);
  assert.equal(isCodeRequestControl({ textContent: "", getAttribute: () => "Resend verification code" }), true);
  assert.equal(isCodeRequestControl({ tagName: "INPUT", value: "Resend code", getAttribute: () => null }), true);
  assert.equal(isCodeRequestControl({ tagName: "INPUT", value: "Send promo code", getAttribute: () => null }), false);
});

test("page mutations only rescan when fields or their form can change", () => {
  const node = (tag, hasInput = false) => ({
    nodeType: 1,
    matches: (selector) => selector.split(", ").includes(tag),
    firstChild: hasInput ? { nodeType: 1, matches: selector => selector.includes("input") } : null,
    closest: () => null,
  });
  const unrelated = node("div");
  const input = node("input");
  const labelChild = { ...node("span"), closest: (selector) => selector.includes("label") ? {} : null };
  assert.equal(mutationAffectsPicker([{ type: "attributes", target: unrelated }]), false);
  assert.equal(mutationAffectsPicker([{ type: "childList", target: unrelated, addedNodes: [node("span")], removedNodes: [] }]), false);
  assert.equal(mutationAffectsPicker([{ type: "childList", target: unrelated, addedNodes: [input], removedNodes: [] }]), true);
  assert.equal(mutationAffectsPicker([{ type: "attributes", target: node("div", true) }]), true);
  assert.equal(mutationAffectsPicker([{ type: "characterData", target: { parentElement: labelChild } }]), true);
  const context = [{ contains: () => true }];
  assert.equal(mutationAffectsPicker([{ type: "characterData", target: { textContent: "new code" } }], { fieldContextRoots: context }), true);
  assert.equal(mutationAffectsPicker([{ type: "characterData", target: { textContent: "clock" } }], { fieldContextRoots: context }), false);
});

test("repeated unrelated attribute targets are inspected once per batch", () => {
  let visits = 0;
  const target = {nodeType: 1, matches: () => false, get firstChild() { visits++; return null; } };
  const records = Array.from({length: 1000}, () => ({type: "attributes", target}));
  assert.equal(mutationAffectsPicker(records), false);
  assert.equal(visits, 1);
});

test("picker bounds added and removed subtrees without aggregate text or queries", () => {
  const root = {
    nodeType: 1, matches: () => false,
    get textContent() { assert.fail("must not aggregate element text"); },
    querySelector() { assert.fail("must not query an unrestricted subtree"); },
  };
  root.firstChild = { nodeType: 3, textContent: "x".repeat(1_000_000), parentNode: root };
  const context = [{ contains: () => true }];
  for (const changed of ["addedNodes", "removedNodes"]) {
    const record = { type: "childList", target: {}, addedNodes: [], removedNodes: [] };
    record[changed] = [root];
    assert.equal(mutationAffectsPicker([record], { fieldContextRoots: context }), true);
  }
});

test("picker node budget covers the whole batch including attribute descendants", () => {
  for (const type of ["childList", "attributes"]) {
    let visits = 0;
    const records = Array.from({ length: 2000 }, () => {
      const root = { nodeType: 1, matches: () => false,
        querySelector() { assert.fail("must traverse with a budget"); },
        get firstChild() { visits++; return null; } };
      return { type, target: type === "attributes" ? root : {}, addedNodes: [root], removedNodes: [] };
    });
    assert.equal(mutationAffectsPicker(records), true);
    assert.equal(visits, 500);
  }
});

test("picker text budget includes current and previous text across records", () => {
  let reads = 0;
  const records = Array.from({ length: 100 }, () => ({
    type: "characterData", target: { nodeType: 3,
      get textContent() { reads++; return "x".repeat(1000); } },
    oldValue: "y".repeat(1000),
  }));
  assert.equal(mutationAffectsPicker(records, { fieldContextRoots: [{ contains: () => true }] }), true);
  assert.equal(reads, 6);
});

test("picker bounded traversal preserves nested fields and split context prompts", () => {
  const root = { nodeType: 1, matches: () => false };
  const span = { nodeType: 1, matches: () => false, parentNode: root };
  root.firstChild = { nodeType: 3, textContent: "e", parentNode: root, nextSibling: span };
  span.firstChild = { nodeType: 3, textContent: "mail", parentNode: span };
  const record = { type: "childList", target: {}, addedNodes: [root], removedNodes: [] };
  const context = [{ contains: () => true }];
  assert.equal(mutationAffectsPicker([record], { fieldContextRoots: context }), true);
  span.firstChild.textContent = "Price changed";
  assert.equal(mutationAffectsPicker([record], { fieldContextRoots: context }), false);
  span.matches = selector => selector.includes("input");
  assert.equal(mutationAffectsPicker([record]), true);
});

test("referenced accessible labels invalidate detection for any text change", () => {
  const text = { nodeType: 3, textContent: "Username" };
  const root = { contains: node => node === text };
  for (const record of [
    { type: "characterData", target: text, oldValue: "OTP" },
    { type: "childList", target: root, addedNodes: [], removedNodes: [] },
    { type: "attributes", attributeName: "id", target: root },
  ]) assert.equal(mutationAffectsPicker([record], { labelRoots: [root] }), true);
});
