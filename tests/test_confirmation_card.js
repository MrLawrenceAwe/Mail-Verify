import test from "node:test";
import assert from "node:assert/strict";
import { getConfirmationStepKey, isConfirmationRequestControl, isConfirmationScreen, isPasswordResetScreen, mutationAffectsConfirmation, selectConfirmationLinks, startConfirmationCard } from "../extension/confirmation-card.js";
import { inlineRuntime } from "./mock_inline_port.js";
import { createFakeTimers } from "./fake_timers.js";

const item = { url: "https://example.com/confirm?token=abc", receivedAt: 10000, accountEmail: "me@yahoo.com", sender: "hello@example.com", uid: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));
const stepMutation = () => [{ type: "characterData", target: { nodeType: 3, textContent: "Check your email" } }];

function setup(panel = null, kind = "links") {
  const timers = createFakeTimers(), events = {}, windowEvents = {};
  const state = { now: 10000, detected: true, screenKey: "first signup", panel, code: false, requests: 0, stepReads: 0, views: [], respond: async () => ({ ok: true, [kind]: [item] }) };
  state.kind = kind;
  const document = { hidden: false, documentElement: { append() {} }, querySelector: () => ({}), addEventListener(name, fn) { events[name] = fn; } };
  const location = { href: "https://example.com/verify" };
  startConfirmationCard({
    browser: { navigator: { clipboard: { async writeText(value) { state.copied = value; } } }, document, location, window: { addEventListener(name, fn) { windowEvents[name] = fn; } },
      chrome: { runtime: inlineRuntime(async (kind) => { assert.equal(kind, state.kind); state.requests++; return state.respond(); }) },
      Date: { now: () => state.now },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      MutationObserver: class { constructor(fn) { state.mutate = fn; } observe() {} },
    }, getStepKey: () => { state.stepReads++; return state.detected
      ? (state.panel ? getConfirmationStepKey({ querySelectorAll: () => [state.panel] }) : state.screenKey)
      : null; }, detectCode: () => state.code,
    createView(_document, callbacks) {
      const view = { callbacks, removed: false, links: [], host: { remove() { view.removed = true; }, contains() { return false; } },
        setStatus(text) { view.status = text; }, renderLinks(items) { view.links = items; } };
      state.views.push(view); return view;
    },
  });
  async function run(delay) {
    await timers.run(delay); await settle();
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
  const first = getConfirmationStepKey(document);
  assert.equal(getConfirmationStepKey(document), first);
  current = panel();
  assert.notEqual(getConfirmationStepKey(document), first);
});

test("countdown changes keep the same confirmation step", () => {
  const panel = { innerText: "Check your email. Resend in 30 seconds", getClientRects: () => [{}], checkVisibility: () => true };
  const document = { querySelectorAll: () => [panel] };
  const first = getConfirmationStepKey(document);
  panel.innerText = "Check your email. Resend in 29 seconds";
  assert.equal(getConfirmationStepKey(document), first);
});

test("recognises controls that request another confirmation message", () => {
  const control = (textContent) => ({ textContent, getAttribute: () => "" });
  for (const label of ["Resend email", "Send again", "Send confirmation email", "Request verification link"])
    assert.equal(isConfirmationRequestControl(control(label)), true, label);
  assert.equal(isConfirmationRequestControl(control("Contact support")), false);
});

test("ignores unrelated page mutations but scans prompt and code-field changes", () => {
  const document = { querySelector: () => ({}) };
  const outside = { nodeType: 1, textContent: "Stock price", closest: () => null,
    matches: () => false, querySelector: () => null };
  const input = { nodeType: 1, matches: (selector) => selector.includes("input") };
  const panel = { nodeType: 1, closest: () => ({}), matches: () => false };
  const mutation = (type, target, addedNodes = []) => ({ type, target, addedNodes, removedNodes: [] });
  assert.equal(mutationAffectsConfirmation([mutation("attributes", outside)], null, document, true), false);
  assert.equal(mutationAffectsConfirmation([mutation("childList", outside, [{ nodeType: 3, textContent: "Price changed" }])], null, document, true), false);
  assert.equal(mutationAffectsConfirmation(stepMutation(), null, document, false), true);
  assert.equal(mutationAffectsConfirmation([mutation("childList", outside, [input])], null, document, false), true);
  assert.equal(mutationAffectsConfirmation([mutation("characterData", { nodeType: 3, textContent: "bob@example.com", parentElement: panel })], null, document, true), true);
});

test("unrelated mutations do not schedule a confirmation scan", async () => {
  const f = setup(); await settle();
  const before = f.state.stepReads;
  f.state.mutate([{ type: "childList", target: { nodeType: 1, closest: () => null },
    addedNodes: [{ nodeType: 3, textContent: "Stock price changed" }], removedNodes: [] }]);
  assert.equal([...f.timers.values()].some((timer) => timer.delay === 250), false);
  assert.equal(f.state.stepReads, before);
  f.state.mutate(stepMutation());
  await f.run(250);
  assert.ok(f.state.stepReads > before);
});

test("selects fresh HTTPS links and omits older or unsafe candidates", () => {
  assert.deepEqual(selectConfirmationLinks([item, { ...item, receivedAt: 1 }, { ...item, url: "javascript:alert(1)" }, { ...item, receivedAt: 20000 }], 5000, 10000), [item]);
});

test("renders matching mail, validates open and remains dismissed", async () => {
  const f = setup(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);
  assert.equal(view.callbacks.beforeUse(item), true);
  assert.equal(view.removed, true);
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("a failed inbox check removes previously offered links", async () => {
  const f = setup(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);

  f.state.respond = async () => ({ ok: false, error: "Connect Yahoo Mail first." });
  await f.run(8000);
  assert.deepEqual(view.links, []);
  assert.match(view.status, /Connect Yahoo Mail first/);
  assert.equal(view.callbacks.beforeUse(item), false);
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
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("resend clears old links and expiry prevents opening", async () => {
  const f = setup(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Resend email" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now += 700000;
  assert.equal(f.state.views.at(-1).callbacks.beforeUse(item), false);
});

test("a text update after resend cannot restore an earlier link", async () => {
  const f = setup(); await settle();
  f.state.now = 10050;
  f.events.click({ target: { closest: () => ({ textContent: "Resend email" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.screenKey = "Confirmation email sent again";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.beforeUse(item), false);
});

test("a send confirmation control clears old links on the same screen", async () => {
  const f = setup(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Send confirmation email", getAttribute: () => "" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views[0].callbacks.beforeUse(item), false);
});

test("a new confirmation step on the same URL clears links from the previous step", async () => {
  const f = setup(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  f.state.screenKey = "second signup";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.beforeUse(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, links: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
  await f.run(8000);
  assert.deepEqual(f.state.views.at(-1).links.map(link => link.uid), [2]);
});

test("a confirmation step change excludes a link received moments before it", async () => {
  const f = setup(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 11_000;
  f.state.screenKey = "second signup";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.beforeUse(item), false);
});

test("a reused confirmation panel resets links when its signup changes", async () => {
  const panel = { innerText: "Check your email for alice@example.test", getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  panel.innerText = "Check your email for bob@example.test";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.beforeUse(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, links: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
  await f.run(8000);
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


test("detects reset email waiting screens while excluding request and new-password forms", () => {
  for (const text of ["Reset your password. Check your inbox", "Password reset link sent to your email", "We sent a link to reset your password", "Follow the link in your email to change your password"])
    assert.equal(isPasswordResetScreen(text), true, text);
  for (const text of ["Forgot password? Enter your email", "Choose a new password", "Check your email", "Reset password newsletter. Check your email", "x".repeat(2501)])
    assert.equal(isPasswordResetScreen(text), false, text);
});

test("reset card requests reset mail, copies on selection, and clears results on resend", async () => {
  const panel = { innerText: "Reset your password. Check your email", getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel, "resetLinks"); await settle();
  const view = f.state.views[0];
  assert.equal(view.callbacks.mode, "resetLinks");
  assert.deepEqual(view.links, [item]);
  assert.equal(f.state.copied, undefined);
  assert.equal(view.callbacks.beforeUse(item), true);
  await view.callbacks.copyLink(item);
  assert.equal(f.state.copied, item.url);
  assert.equal(view.removed, false);
  f.events.click({ target: { closest: () => ({ textContent: "Send password reset link" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.beforeUse(item), false);
});


test("an unrelated forgot-password prompt cannot override explicit confirmation instructions", async () => {
  for (const innerText of [
    "Check your email to confirm your account. Sign in. Forgot password?",
    "Check your inbox to verify your email. Forgot password?",
    "We sent an activation email. Sign in. Forgot password?",
  ]) {
    assert.equal(isPasswordResetScreen(innerText), false, innerText);
    const panel = { innerText, getClientRects: () => [{}], checkVisibility: () => true };
    const f = setup(panel); await settle();
    assert.equal(f.state.views[0].callbacks.mode, "links");
    assert.deepEqual(f.state.views[0].links, [item]);
  }
});

test("reset intent must belong to the email instruction or its heading", () => {
  for (const innerText of [
    "Check your email. Sign in. Forgot password?",
    "Check your email. Contact support. Reset password",
  ]) assert.equal(isPasswordResetScreen(innerText), false, innerText);
  for (const innerText of [
    "Forgot password? Check your inbox for the reset link",
    "Check your email for a password reset link. Sign in",
    "We sent you a link to reset your password. Sign in",
  ]) assert.equal(isPasswordResetScreen(innerText), true, innerText);
});


test("line-separated reset headings retain reset mode after step text normalization", async () => {
  const panel = { innerText: "Forgot password?\nCheck your inbox\nSign in", getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel, "resetLinks"); await settle();
  assert.equal(f.state.views[0].callbacks.mode, "resetLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});


test("reset instructions spanning continuation lines use reset mode", async () => {
  for (const innerText of [
    "Check your email\nWe have sent you a link to\nreset your password",
    "Check your inbox\nWe sent you a\nlink to\nreset your\npassword",
    "Check your email\nWe sent you a link\nto reset your password",
  ]) {
    assert.equal(isPasswordResetScreen(innerText), true, innerText);
    assert.equal(isConfirmationScreen(innerText), false, innerText);
    const panel = { innerText, getClientRects: () => [{}], checkVisibility: () => true };
    const f = setup(panel, "resetLinks"); await settle();
    assert.equal(f.state.views[0].callbacks.mode, "resetLinks");
    assert.deepEqual(f.state.views[0].links, [item]);
  }
});

test("line-separated navigation still cannot select reset mode", () => {
  for (const text of [
    "Check your email\nForgot password?",
    "Check your email\nSign in\nReset password",
    "Check your email to confirm your account\nForgot password?",
  ]) {
    assert.equal(isPasswordResetScreen(text), false, text);
    assert.equal(isConfirmationScreen(text), true, text);
  }
});
