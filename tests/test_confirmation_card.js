import test from "node:test";
import assert from "node:assert/strict";
import { confirmationScreenKey, isConfirmationRequestControl, isConfirmationScreen, selectConfirmationLinks, startConfirmationCard } from "../extension/confirmation-card.js";

const item = { url: "https://example.com/confirm?token=abc", receivedAt: 10000, accountEmail: "me@yahoo.com", sender: "hello@example.com", uid: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const timers = new Map(), events = {}, windowEvents = {};
  let id = 0;
  const state = { now: 10000, detected: true, screenKey: "first signup", code: false, requests: 0, views: [], respond: async () => ({ ok: true, links: [item] }) };
  const document = { hidden: false, documentElement: { append() {} }, addEventListener(name, fn) { events[name] = fn; } };
  const location = { href: "https://example.com/verify" };
  startConfirmationCard({
    browser: { document, location, window: { addEventListener(name, fn) { windowEvents[name] = fn; } },
      chrome: { runtime: { async sendMessage(message) { assert.equal(message.type, "mail-verify-inline-links"); state.requests++; return state.respond(); } } },
      Date: { now: () => state.now },
      setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, delay }); return key; }, clearTimeout(key) { timers.delete(key); },
      MutationObserver: class { constructor(fn) { state.mutate = fn; } observe() {} },
    }, detect: () => state.detected, getScreenKey: () => state.screenKey, detectCode: () => state.code,
    createView(_document, callbacks) {
      const view = { callbacks, removed: false, links: [], host: { remove() { view.removed = true; }, contains() { return false; } },
        setStatus(text) { view.status = text; }, renderLinks(items) { view.links = items; } };
      state.views.push(view); return view;
    },
  });
  async function run(delay) {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `timer ${delay} exists`);
    timers.delete(entry[0]); await entry[1].fn(); await settle();
  }
  return { state, document, location, events, windowEvents, run, timers };
}

test("recognises confirmation prompts but rejects resets, newsletters and long pages", () => {
  for (const text of ["Check your inbox", "We've sent a verification email", "Follow the link in your email to confirm your account"])
    assert.equal(isConfirmationScreen(text), true, text);
  for (const text of ["Reset your password. Check your email", "Check your email for our newsletter", "Welcome to our website", "x".repeat(2501) + " Check your email"])
    assert.equal(isConfirmationScreen(text), false, text);
});

test("distinguishes replacement confirmation panels with identical text", () => {
  const panel = () => ({ innerText: "Check your email", getClientRects: () => [{}], checkVisibility: () => true });
  let current = panel();
  const document = { querySelectorAll: () => [current] };
  const first = confirmationScreenKey(document);
  assert.equal(confirmationScreenKey(document), first);
  current = panel();
  assert.notEqual(confirmationScreenKey(document), first);
});

test("recognises controls that request another confirmation message", () => {
  const control = (textContent) => ({ textContent, getAttribute: () => "" });
  for (const label of ["Resend email", "Send again", "Send confirmation email", "Request verification link"])
    assert.equal(isConfirmationRequestControl(control(label)), true, label);
  assert.equal(isConfirmationRequestControl(control("Contact support")), false);
});

test("selects fresh HTTPS links and omits older or unsafe candidates", () => {
  assert.deepEqual(selectConfirmationLinks([item, { ...item, receivedAt: 1 }, { ...item, url: "javascript:alert(1)" }, { ...item, receivedAt: 20000 }], 5000, 10000), [item]);
});

test("renders matching mail, validates open and remains dismissed", async () => {
  const f = setup(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);
  assert.equal(view.callbacks.canOpen(item), true);
  assert.equal(view.removed, true);
  f.state.mutate([{ target: {} }]); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("hides when tab is hidden and does not reset the polling deadline", async () => {
  const f = setup(); await settle();
  f.document.hidden = true; f.events.visibilitychange(); await f.run(250);
  assert.equal(f.state.views[0].removed, true);
  f.state.now += 125000;
  f.document.hidden = false; f.events.visibilitychange(); await f.run(250);
  assert.equal(f.state.requests, 1);
  assert.match(f.state.views.at(-1).status, /Checking finished/);
});

test("navigation discards a late response and code forms suppress the card", async () => {
  const f = setup(); await settle();
  let finish;
  f.state.respond = () => new Promise(resolve => { finish = resolve; });
  const pending = f.run(8000);
  f.location.href = "https://example.com/done";
  f.state.detected = false;
  f.windowEvents.popstate(); await f.run(250);
  finish({ ok: true, links: [{ ...item, uid: 2 }] }); await pending;
  assert.equal(f.state.views[0].removed, true);
  assert.equal(f.state.views[0].links[0].uid, 1);
  f.state.detected = true; f.state.code = true;
  f.state.mutate([{ target: {} }]); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("resend clears old links and expiry prevents opening", async () => {
  const f = setup(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Resend email" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now += 700000;
  assert.equal(f.state.views.at(-1).callbacks.canOpen(item), false);
});

test("a send confirmation control clears old links on the same screen", async () => {
  const f = setup(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Send confirmation email", getAttribute: () => "" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views[0].callbacks.canOpen(item), false);
});

test("a new confirmation step on the same URL clears links from the previous step", async () => {
  const f = setup(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  f.state.screenKey = "second signup";
  f.state.respond = async () => ({ ok: true, links: [item, { ...item, uid: 2, receivedAt: 20_000 }] });
  f.state.mutate([{ target: {} }]); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.canOpen(item), false);
  assert.deepEqual(f.state.views.at(-1).links.map(link => link.uid), [2]);
});

test("retry during an active check ignores its response and immediately checks again", async () => {
  const f = setup(); await settle();
  let finishFirst;
  f.state.respond = () => new Promise(resolve => { finishFirst = resolve; });
  const pending = f.run(8000);
  const view = f.state.views[0];
  const firstCount = f.state.requests;
  view.callbacks.onRetry();
  assert.equal(f.state.requests, firstCount, "the native client handles one request at a time");
  f.state.respond = async () => ({ ok: true, links: [{ ...item, uid: 3 }] });
  finishFirst({ ok: true, links: [{ ...item, uid: 2 }] });
  await pending;
  assert.equal(f.state.requests, firstCount + 1);
  assert.equal(view.links[0].uid, 3);
  assert.equal([...f.timers.values()].some(value => value.delay === 8000), true);
});

test("an old check cannot consume a retry queued on a new page", async () => {
  const f = setup(); await settle();
  let finishOld, finishNew;
  f.state.respond = () => new Promise(resolve => { finishOld = resolve; });
  const oldPending = f.run(8000);
  f.location.href = "https://example.com/next";
  f.windowEvents.popstate();
  f.state.respond = () => new Promise(resolve => { finishNew = resolve; });
  await f.run(250);
  f.state.views.at(-1).callbacks.onRetry();
  finishOld({ ok: true, links: [] });
  await oldPending;
  assert.equal(f.state.requests, 3);
  f.state.respond = async () => ({ ok: true, links: [{ ...item, uid: 4 }] });
  finishNew({ ok: true, links: [] });
  await settle();
  assert.equal(f.state.requests, 4);
  assert.equal(f.state.views.at(-1).links[0].uid, 4);
});
