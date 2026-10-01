import test from "node:test";
import assert from "node:assert/strict";
import { suggestionPosition, selectSuggestedCodes, mutationAffectsPicker, isCodeRequestControl, startInlinePicker } from "../extension/inline-picker.js";
import { inlineRuntime } from "./mock_inline_port.js";
import { createFakeTimers } from "./fake_timers.js";

function pickerBrowser({ handleField, now = Date.now, check, onMount = () => {},
  onRemove = () => {}, onObserve = () => {}, onFrame = (fn) => fn() }) {
  const events = new Map(), timers = createFakeTimers();
  const results = {
    dataset: {}, children: [],
    get childElementCount() { return this.children.length; },
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
  };
  const elements = { "#results": results, "#status": {}, "#close": {}, "#retry": {} };
  const browser = {
    Date: { now },
    location: { href: "https://example.test", hostname: "example.test" },
    innerWidth: 1200, innerHeight: 800,
    document: {
      hidden: false,
      documentElement: { append: onMount },
      addEventListener: (name, fn) => events.set(name, fn),
      createElement: () => {
        const strong = {}, small = {};
        return {
          strong, small, dataset: {}, style: {},
          attachShadow: () => ({ querySelector: id => elements[id] }),
          getBoundingClientRect: () => ({ width: 240, height: 60 }),
          contains: () => false,
          remove: onRemove,
          querySelector: selector => selector === "small" ? small : strong,
          addEventListener() {},
          setAttribute() {},
        };
      },
    },
    window: {
      addEventListener: (name, fn) => events.set(name, fn),
      navigation: { addEventListener: (name, fn) => events.set(`navigation:${name}`, fn) },
    },
    MutationObserver: class { constructor(callback) { onObserve(callback); } observe() {} },
    requestAnimationFrame: onFrame,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    chrome: { runtime: inlineRuntime(check) },
  };
  startInlinePicker({ browser, handleField });
  return { browser, events, timers, results, elements };
}

test("suggestions sit below the field and stay within the viewport", () => {
  assert.deepEqual(suggestionPosition({ left: 100, top: 200, bottom: 240 }, 300, 110, 1000, 800), { left: 100, top: 244 });
  assert.deepEqual(suggestionPosition({ left: 900, top: 700, bottom: 740 }, 300, 110, 1000, 800), { left: 692, top: 586 });
});

test("picker repositions using the current viewport after resize", () => {
  const frames = [];
  const anchor = {};
  let mounted;
  const { browser, events } = pickerBrowser({
    handleField: () => ({
      ok: true, anchor,
      rect: { left: 900, top: 100, bottom: 130 },
    }),
    onMount: node => { mounted = node; },
    onFrame: fn => { frames.push(fn); return frames.length; },
    check: () => new Promise(() => {}),
  });
  assert.equal(mounted.style.left, "900px");
  browser.innerWidth = 1000;
  browser.innerHeight = 150;
  events.get("resize")();
  frames.shift()();
  assert.equal(mounted.style.left, "752px");
  assert.equal(mounted.style.top, "36px");
});

test("picker passes its mounted field to the fill action", async () => {
  const anchor = {};
  const fills = [];
  const code = { uid: 1, accountEmail: "test@yahoo.com", code: "123456", sender: "auth@example.test", receivedAt: 9_000 };
  const { results } = pickerBrowser({
    handleField: (request) => {
      if (request.action === "fill") {
        fills.push(request);
        return { ok: true };
      }
      return { ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } };
    },
    now: () => 10_000,
    check: async () => ({ ok: true, codes: [code] }),
  });
  await new Promise(resolve => setImmediate(resolve));
  results.children[0].onclick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].expectedAnchor, anchor);
});

test("a successful fill allows a new code field on the same URL", async () => {
  let observer, now = 10_000, anchor = {};
  let mounts = 0;
  const oldCode = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9_000 };
  const newCode = { ...oldCode, uid: 2, code: "222222", receivedAt: 20_000 };
  let codes = [oldCode];
  const { timers, results } = pickerBrowser({
    handleField: (request) => request.action === "fill"
      ? { ok: true }
      : { ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } },
    now: () => now,
    check: async () => ({ ok: true, codes }),
    onMount: () => { mounts++; },
    onObserve: callback => { observer = callback; },
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  results.children[0].onclick();
  now = 21_000;
  anchor = {};
  codes = [oldCode, newCode];
  observer([{ type: "attributes", target: { matches: () => true } }]);
  timers.pop()();
  await flush();
  assert.equal(mounts, 2);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

test("a successful fill keeps the same field closed until a resend", async () => {
  let observer, now = 10_000;
  const anchor = {};
  const oldCode = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9_000 };
  const newCode = { ...oldCode, uid: 2, code: "222222", receivedAt: 22_000 };
  let codes = [oldCode], mounts = 0;
  const { events, timers, results } = pickerBrowser({
    handleField: (request) => request.action === "fill"
      ? { ok: true }
      : { ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } },
    now: () => now,
    check: async () => ({ ok: true, codes }),
    onMount: () => { mounts++; },
    onObserve: callback => { observer = callback; },
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  results.children[0].onclick();
  observer([{ type: "attributes", target: { matches: () => true } }]);
  timers.pop()();
  assert.equal(mounts, 1);
  now = 21_000;
  codes = [oldCode, newCode];
  events.get("click")({ target: { closest: () => ({ textContent: "Resend code" }) } });
  now = 23_000;
  await flush();
  assert.equal(mounts, 2);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

test("a failed inbox check removes previously offered codes", async () => {
  const code = { uid: 1, accountEmail: "test@yahoo.com", code: "123456", sender: "auth@example.test", receivedAt: 9_000 };
  let connected = true;
  const { timers, results, elements } = pickerBrowser({
    handleField: () => ({ ok: true, anchor: {}, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => 10_000,
    check: async () => connected
      ? { ok: true, codes: [code] }
      : { ok: false, error: "Connect Yahoo Mail first." },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.childElementCount, 1);

  connected = false;
  timers.pop()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.childElementCount, 0);
  assert.match(elements["#status"].textContent, /Connect Yahoo Mail first/);
});

test("retry during an active check ignores its response and checks again immediately", async () => {
  let resolveFirst;
  let checks = 0;
  const oldCode = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9_000 };
  const newCode = { ...oldCode, uid: 2, code: "222222", receivedAt: 10_000 };
  const { results, elements } = pickerBrowser({
    handleField: () => ({ ok: true, anchor: {}, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => 10_000,
    check: () => ++checks === 1
      ? new Promise(resolve => { resolveFirst = resolve; })
      : Promise.resolve({ ok: true, codes: [newCode] }),
  });
  elements["#retry"].onclick();
  assert.equal(checks, 1);
  resolveFirst({ ok: true, codes: [oldCode] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 2);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

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
  for (const textContent of ["Resend code", "Send another verification code", "Request a new code", "Get a new OTP", "Resend"])
    assert.equal(isCodeRequestControl({ textContent }), true, textContent);
  assert.equal(isCodeRequestControl({ textContent: "Send promo code" }), false);
  assert.equal(isCodeRequestControl({ textContent: "Continue" }), false);
  assert.equal(isCodeRequestControl({ textContent: "", getAttribute: () => "Resend verification code" }), true);
  assert.equal(isCodeRequestControl({ tagName: "INPUT", value: "Resend code", getAttribute: () => null }), true);
  assert.equal(isCodeRequestControl({ tagName: "INPUT", value: "Send promo code", getAttribute: () => null }), false);
});

test("resend input clears the old suggestion and waits for newer mail", async () => {
  let now = 9500;
  const oldCode = { uid: 7, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  let codes = [oldCode];
  const { events, timers, results } = pickerBrowser({
    handleField: () => ({ ok: true, anchor: {}, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => now,
    check: async () => ({ ok: true, codes }),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(results.childElementCount, 1);
  const resend = { tagName: "INPUT", value: "Resend code", getAttribute: () => null };
  events.get("click")({ target: {
    closest: selector => selector.includes("input[type=submit]") ? resend : null,
  } });
  assert.equal(results.childElementCount, 0);
  await flush();
  assert.equal(results.childElementCount, 0);
  now = 11_000;
  codes = [oldCode, { ...oldCode, uid: 8, code: "222222", receivedAt: 10_000 }];
  timers.pop()();
  await flush();
  assert.equal(results.childElementCount, 1);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

test("resend before the first check returns does not revive an unseen old code", async () => {
  const requests = [];
  let now = 9500;
  const { events, timers, results } = pickerBrowser({
    handleField: () => ({ ok: true, anchor: {}, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => now,
    check: () => new Promise(resolve => requests.push(resolve)),
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const oldCode = { uid: 7, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  assert.equal(requests.length, 1);
  events.get("click")({ target: { closest: () => ({ textContent: "Send another verification code" }) } });
  requests.shift()({ ok: true, codes: [oldCode] });
  await flush();
  assert.equal(requests.length, 1);
  requests.shift()({ ok: true, codes: [oldCode] });
  await flush();
  assert.equal(results.childElementCount, 0);
  now = 10500;
  timers.pop()();
  const newCode = { uid: 8, accountEmail: "test@yahoo.com", code: "222222", sender: "auth@example.test", receivedAt: 10000 };
  requests.shift()({ ok: true, codes: [oldCode, newCode] });
  await flush();
  assert.equal(results.childElementCount, 1);
});

test("new route clears suggestions even when the code field is reused", async () => {
  let now = 10_000;
  const oldCode = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  let responses = [oldCode];
  const anchor = {};
  const { browser, events, timers, results } = pickerBrowser({
    handleField: () => ({ ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => now,
    check: async () => ({ ok: true, codes: responses }),
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  await flush();
  assert.equal(results.childElementCount, 1);
  now = 10_500;
  browser.location.href = "https://example.test/second-step";
  events.get("navigation:currententrychange")();
  await flush();
  assert.equal(results.childElementCount, 0);
  responses = [{ ...oldCode, uid: 2, code: "222222", receivedAt: 11_000 }];
  now = 12_000;
  timers.pop()();
  await flush();
  assert.equal(results.childElementCount, 1);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

test("scrolling away and back keeps a code from the same verification step", async () => {
  let now = 10_000, visible = true;
  const anchor = {
    parentElement: { textContent: "Enter the verification code" },
    getClientRects: () => [1],
    checkVisibility: () => true,
    getBoundingClientRect: () => visible
      ? { left: 20, right: 120, top: 100, bottom: 130 }
      : { left: 20, right: 120, top: -130, bottom: -100 },
  };
  const code = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9_000 };
  const { events, results } = pickerBrowser({
    handleField: () => ({ ok: visible, anchor, trackedAnchorOffscreen: !visible,
      candidateCache: { inputs: [anchor], contextRoots: [] }, rect: anchor.getBoundingClientRect() }),
    now: () => now,
    check: async () => ({ ok: true, codes: [code] }),
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(results.childElementCount, 1);
  visible = false;
  events.get("scroll")();
  now = 30_000;
  visible = true;
  events.get("scroll")();
  await flush();
  assert.equal(results.childElementCount, 1);
  assert.equal(results.children[0].strong.textContent, "Fill code 111111");
});

test("returning to a hidden tab starts a check while the old one is pending", async () => {
  const requests = [];
  const anchor = {};
  const { browser, events, timers, results } = pickerBrowser({
    handleField: () => ({ ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { left: 20, top: 100, bottom: 130 } }),
    now: () => 10_000,
    check: () => new Promise(resolve => requests.push(resolve)),
  });
  assert.equal(requests.length, 1);
  browser.document.hidden = true;
  events.get("visibilitychange")();
  timers.shift()();
  browser.document.hidden = false;
  events.get("visibilitychange")();
  timers.shift()();
  assert.equal(requests.length, 2);
  const code = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9_000 };
  requests[0]({ ok: true, codes: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.childElementCount, 0);
  requests[1]({ ok: true, codes: [code] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(results.children[0].strong.textContent, "Fill code 111111");
});

test("countdown completion retains codes without starting a new attempt", async () => {
  for (const countdown of ["Resend in 30 seconds", "Resend code in 30s", "Resend in 00:30"]) {
    let observer, now = 10_000;
    const form = { textContent: `We sent a code to alice@example.test. ${countdown}`, contains: () => true };
    const anchor = { form };
    const code = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
    let requests = 0;
    const { timers, results, elements } = pickerBrowser({
      handleField: () => ({ ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
      now: () => now,
      check: async () => { requests++; return { ok: true, codes: [code] }; },
      onObserve: callback => { observer = callback; },
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    await flush();
    now = 40_000;
    form.textContent = "We sent a code to alice@example.test. Resend code";
    observer([{ type: "characterData", target: {} }]);
    await timers.run(150);
    await flush();
    assert.equal(results.children[0]?.strong.textContent, "Fill code 111111", countdown);
    assert.equal(requests, 1, "countdown completion must not trigger a new attempt");
    elements["#retry"].onclick();
    await flush();
    assert.equal(results.children[0]?.strong.textContent, "Fill code 111111", "retry retains the same code");
  }
});

test("changed verification instructions reset codes on the same field and URL", async () => {
  let observer, now = 10_000, mounts = 0;
  const parent = {};
  const form = { textContent: "We sent a code to alice@example.test. Resend in 30 seconds", contains: () => true, parentElement: parent };
  const anchor = { form };
  const oldCode = { uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  let responses = [oldCode];
  const { timers, results } = pickerBrowser({
    handleField: () => ({ ok: true, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => now,
    check: async () => ({ ok: true, codes: responses }),
    onObserve: callback => { observer = callback; },
    onMount: () => { mounts++; },
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const changeInstructions = (text) => {
    form.textContent = text;
    observer([{ type: "characterData", target: {} }]);
    timers.pop()();
  };
  await flush();
  assert.equal(results.childElementCount, 1);
  changeInstructions("We sent a code to alice@example.test. Resend in 29 seconds");
  assert.equal(mounts, 1);
  changeInstructions("We sent a code to alice@example.test. Resend in 28");
  changeInstructions("We sent a code to alice@example.test. Resend in 27");
  assert.equal(mounts, 1);
  assert.equal(results.children[0].strong.textContent, "Fill code 111111");
  now = 20_000;
  changeInstructions("We sent a code to bob@example.test. Resend in 30 seconds");
  await flush();
  assert.equal(mounts, 2);
  assert.equal(results.childElementCount, 0);
  responses = [oldCode, { ...oldCode, uid: 2, code: "222222", receivedAt: 21_000 }];
  now = 22_000;
  timers.pop()();
  await flush();
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
  now = 30_000;
  form.previousElementSibling = { textContent: "Verification code for charlie@example.test" };
  observer([{ type: "childList", target: parent, addedNodes: [], removedNodes: [] }]);
  timers.pop()();
  await flush();
  assert.equal(mounts, 3);
  assert.equal(results.childElementCount, 0);
});

test("a new verification field on the same URL starts a fresh code window", async () => {
  let observer, now = 10_000, visible = true, anchor = {}, responses = [], warnings = [];
  responses = [{ uid: 1, accountEmail: "test@yahoo.com", code: "111111", sender: "auth@example.test", receivedAt: 9000 }];
  const { events, timers, results, elements } = pickerBrowser({
    handleField: () => ({ ok: visible, anchor, candidateCache: { contextRoots: [] }, rect: { top: 100, bottom: 130, left: 20 } }),
    now: () => now,
    check: async () => ({ ok: true, codes: responses, warnings }),
    onObserve: callback => { observer = callback; },
  });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const rescan = () => {
    observer([{ type: "attributes", target: { matches: () => true } }]);
    timers.pop()();
  };
  await flush();
  assert.equal(results.childElementCount, 1);
  warnings = ["one@yahoo.com: Yahoo took too long to respond."];
  timers.pop()();
  await flush();
  assert.match(elements["#status"].textContent, /Could not check: one@yahoo\.com/);
  const originalResponses = responses;
  responses = [];
  now = 131_000;
  timers.pop()();
  await flush();
  assert.match(elements["#status"].textContent, /Could not check: one@yahoo\.com/);
  responses = originalResponses;
  warnings = [];
  now = 9500;
  responses = [responses[0], { uid: 2, accountEmail: "test@yahoo.com", code: "222222", sender: "auth@example.test", receivedAt: 10000 }];
  events.get("click")({ target: { closest: () => ({ textContent: "Resend code" }) } });
  await flush();
  assert.equal(results.childElementCount, 0);
  now = 10500;
  timers.pop()();
  await flush();
  assert.equal(results.childElementCount, 1);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
  visible = false;
  rescan();
  now = 20_000;
  visible = true;
  anchor = {};
  rescan();
  await flush();
  assert.equal(results.childElementCount, 0);
  responses = [{ uid: 3, accountEmail: "test@yahoo.com", code: "333333", sender: "auth@example.test", receivedAt: 20_000 }];
  timers.pop()();
  await flush();
  assert.equal(results.childElementCount, 1);
  now = 30_000;
  anchor = {};
  rescan();
  await flush();
  assert.equal(results.childElementCount, 0);
});

test("page mutations only rescan when fields or their form can change", () => {
  const node = (tag, hasInput = false) => ({
    nodeType: 1,
    matches: (selector) => selector.split(", ").includes(tag),
    querySelector: () => hasInput ? {} : null,
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
  assert.equal(mutationAffectsPicker([{ type: "characterData", target: { textContent: "new code" } }], null, context), true);
  assert.equal(mutationAffectsPicker([{ type: "characterData", target: { textContent: "clock" } }], null, context), false);
});

test("scroll positioning uses animation frames and cached candidates; mutations rediscover", async () => {
  const frames = [];
  let observer, discoveries = 0, detections = 0, visible = false, mounted;
  const anchor = {};
  const cached = { inputs: [], contextRoots: [] };
  const { events, timers, elements } = pickerBrowser({
    handleField: ({ candidateCache: candidates }) => {
      detections++;
      if (!candidates) discoveries++;
      return { ok: visible, anchor, trackedAnchorOffscreen: !visible && !!candidates,
        candidateCache: cached, rect: { top: 100, bottom: 130, left: 20 } };
    },
    onMount: node => { mounted = node; },
    onRemove: () => { mounted = undefined; },
    onObserve: callback => { observer = callback; },
    onFrame: fn => { frames.push(fn); return frames.length; },
    check: () => new Promise(() => {}),
  });
  assert.equal(discoveries, 1);
  for (let i = 0; i < 20; i++) events.get("scroll")();
  assert.equal(frames.length, 1);
  assert.equal(timers.length, 0);
  frames.shift()();
  assert.equal(discoveries, 1);
  visible = true;
  events.get("scroll")();
  frames.shift()();
  assert.equal(mounted.style.top, "134px");
  assert.equal(discoveries, 1);
  visible = false;
  events.get("scroll")();
  frames.shift()();
  assert.equal(mounted, undefined);
  observer([{ type: "attributes", target: { matches: () => true } }]);
  timers.shift()();
  assert.equal(discoveries, 2);
  visible = true;
  events.get("scroll")();
  frames.shift()();
  elements["#close"].onclick();
  const before = detections;
  events.get("scroll")();
  assert.equal(frames.length, 0);
  assert.equal(detections, before);
});
