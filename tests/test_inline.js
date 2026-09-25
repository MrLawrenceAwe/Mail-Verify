import test from "node:test";
import assert from "node:assert/strict";
import { suggestionPosition, freshCodes, mutationAffectsPicker } from "../extension/inline.js";

test("suggestions sit below the field and stay within the viewport", () => {
  assert.deepEqual(suggestionPosition({ left: 100, top: 200, bottom: 240 }, 300, 110, 1000, 800), { left: 100, top: 244 });
  assert.deepEqual(suggestionPosition({ left: 900, top: 700, bottom: 740 }, 300, 110, 1000, 800), { left: 692, top: 586 });
});

test("old codes are withheld while waiting for this verification attempt", () => {
  const older = { code: "111111", sender: "auth@example.test", receivedAt: 1000 };
  const newest = { code: "222222", sender: "auth@example.test", receivedAt: 9000 };
  assert.deepEqual(freshCodes([older], 5000, 10000), []);
  assert.deepEqual(freshCodes([older, newest], 5000, 10000), [newest]);
  assert.deepEqual(freshCodes([newest], 9500, 10000), []);
});

test("only the latest code per sender is suggested, without changing the response", () => {
  const codes = [
    { code: "111111", sender: "AUTH@example.test", receivedAt: 8000 },
    { code: "222222", sender: "auth@example.test", receivedAt: 9000 },
    { code: "333333", sender: "other@example.test", receivedAt: 9500 },
  ];
  assert.deepEqual(freshCodes(codes, 5000, 10000).map(x => x.code), ["333333", "222222"]);
  assert.equal(codes[0].code, "111111");
});

test("resend excludes an already seen message but accepts a new UID in the same second", () => {
  const old = { uid: 7, code: "111111", sender: "auth@example.test", receivedAt: 9000 };
  const newer = { uid: 8, code: "222222", sender: "auth@example.test", receivedAt: 9000 };
  assert.deepEqual(freshCodes([old, newer], 9000, 9500, new Set([7])), [newer]);
});

test("same sender and UID in separate accounts remain distinct", () => {
  const codes = [
    { uid: 7, code: "111111", sender: "auth@example.test", accountEmail: "one@yahoo.com", receivedAt: 9000 },
    { uid: 7, code: "222222", sender: "auth@example.test", accountEmail: "two@yahoo.com", receivedAt: 9100 },
  ];
  assert.deepEqual(freshCodes(codes, 8000, 10000).map(x => x.code), ["222222", "111111"]);
  assert.deepEqual(freshCodes(codes, 8000, 10000, new Set(["one@yahoo.com:7"])).map(x => x.code), ["222222"]);
});

test("a new verification field on the same URL starts a fresh code window", async () => {
  const { default: vm } = await import("node:vm");
  const { readFileSync } = await import("node:fs");
  const events = new Map(), timers = [];
  let observer, now = 10_000, visible = true, anchor = {}, responses = [], warnings = [];
  const results = {
    dataset: {}, children: [],
    get childElementCount() { return this.children.length; },
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
  };
  const elements = { "#results": results, "#status": {}, "#close": {}, "#retry": {} };
  const context = vm.createContext({
    fillCode: () => ({ ok: visible, anchor, candidates: {}, contextRoots: [], rect: { top: 100, bottom: 130, left: 20 } }),
    Date: { now: () => now },
    location: { href: "https://example.test", hostname: "example.test" },
    innerWidth: 1200, innerHeight: 800,
    document: {
      hidden: false,
      documentElement: { append() {} },
      addEventListener: (name, fn) => events.set(name, fn),
      createElement: () => {
        const strong = {}, small = {};
        return {
          strong, small, dataset: {}, style: {},
          attachShadow: () => ({ querySelector: id => elements[id] }),
          getBoundingClientRect: () => ({ width: 240, height: 60 }),
          contains: () => false,
          remove() {},
          querySelector: selector => selector === "small" ? small : strong,
          addEventListener() {},
          setAttribute() {},
        };
      },
    },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    requestAnimationFrame: fn => fn(),
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    chrome: { runtime: { sendMessage: async () => ({ ok: true, codes: responses, warnings }) } },
  });
  const source = readFileSync(new URL("../extension/inline.js", import.meta.url), "utf8")
    .replace(/^import .*\n/, "").replaceAll("export function ", "function ");
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  const rescan = () => {
    observer([{ type: "attributes", target: { matches: () => true } }]);
    timers.pop()();
  };
  responses = [{ uid: 1, code: "111111", sender: "auth@example.test", receivedAt: 9000 }];
  vm.runInContext(source + "\nstartInlinePicker();", context);
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
  responses = [responses[0], { uid: 2, code: "222222", sender: "auth@example.test", receivedAt: 9000 }];
  events.get("click")({ target: { closest: () => ({ textContent: "Resend code" }) } });
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
  responses = [{ uid: 3, code: "333333", sender: "auth@example.test", receivedAt: 20_000 }];
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
  const { default: vm } = await import("node:vm");
  const { readFileSync } = await import("node:fs");
  const events = new Map(), frames = [], timers = [];
  let observer, discoveries = 0, detections = 0, visible = false, mounted;
  const cached = { inputs: [], contextRoots: [] };
  const elements = Object.fromEntries(["#status", "#results", "#close", "#retry"].map(id => [id, {
    dataset: {}, childElementCount: 0,
  }]));
  const context = vm.createContext({
    fillCode: (_code, _detect, candidates) => {
      detections++;
      if (!candidates) discoveries++;
      return { ok: visible, candidates: cached, contextRoots: [], rect: { top: 100, bottom: 130, left: 20 } };
    },
    location: { href: "https://example.test", hostname: "example.test" },
    innerWidth: 1200, innerHeight: 800,
    document: {
      hidden: false,
      documentElement: { append: node => { mounted = node; } },
      addEventListener: (name, fn) => events.set(name, fn),
      createElement: () => ({
        dataset: {}, style: {},
        attachShadow: () => ({ querySelector: id => elements[id] }),
        getBoundingClientRect: () => ({ width: 240, height: 60 }),
        remove: () => { mounted = undefined; },
      }),
    },
    window: { addEventListener: (name, fn) => events.set(name, fn) },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    chrome: { runtime: { sendMessage: () => new Promise(() => {}) } },
  });
  const source = readFileSync(new URL("../extension/inline.js", import.meta.url), "utf8")
    .replace(/^import .*\n/, "").replaceAll("export function ", "function ");
  vm.runInContext(source + "\nstartInlinePicker();", context);
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
