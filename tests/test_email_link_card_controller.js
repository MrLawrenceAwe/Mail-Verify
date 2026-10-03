import test from "node:test";
import assert from "node:assert/strict";
import { detectEmailLinkStep } from "../extension/inline/email-link-step.js";
import { startEmailLinkCard } from "../extension/inline/email-link-card-controller.js";
import { inlineRuntime } from "./mock_inline_port.js";
import { createTimerQueue } from "./timer_queue.js";

const item = { url: "https://example.com/confirm?token=abc", receivedAt: 10000, accountEmail: "me@yahoo.com", sender: "hello@example.com", uid: 1 };

const settle = () => new Promise(resolve => setImmediate(resolve));
const stepMutation = () => [{ type: "characterData", target: { nodeType: 3, textContent: "Check your email" } }];

function setup(panel = null, mailType = "confirmationLinks", modal = null) {
  const timers = createTimerQueue(), events = {}, windowEvents = {};
  const state = { now: 10000, detected: true, screenKey: "first signup", panel, code: false, requests: 0, collectionModes: [], stepReads: 0, views: [], respond: async () => ({ ok: true, [mailType]: [item], scanPending: false }) };
  state.mailType = mailType;
  const document = { hidden: false, documentElement: { append() {} }, querySelector: selector => selector === 'dialog:modal' ? modal : ({}), addEventListener(name, fn) { events[name] = fn; } };
  const location = { href: "https://example.com/verify" };
  startEmailLinkCard({
    environment: { navigator: { clipboard: { async writeText(value) { state.copied = value; } } }, document, location, window: { addEventListener(name, fn) { windowEvents[name] = fn; } },
      chrome: { runtime: inlineRuntime(async (mailType, collectOnly) => { assert.equal(mailType, state.mailType); state.collectionModes.push(collectOnly); state.requests++; return state.respond(); }) },
      Date: { now: () => state.now },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
      MutationObserver: class { constructor(fn) { state.mutate = fn; } observe() {} },
    }, detectStep: () => { state.stepReads++; return state.detected
      ? (state.panel ? detectEmailLinkStep({ querySelectorAll: () => [state.panel] }) : { key: state.screenKey, mailType: state.mailType })
      : null; }, detectCode: () => state.code,
    createView(_document, callbacks) {
      const view = { callbacks, removed: false, links: [], host: { style: {},
        hasAttribute: () => false, setAttribute() {}, showPopover() {},
        remove() { view.removed = true; }, contains() { return false; } },
        setStatus(text) { view.status = text; }, renderLinks(items) { view.links = items; } };
      state.views.push(view); return view;
    },
  });
  async function run(delay) {
    await timers.runWithDelay(delay); await settle();
  }
  return { state, document, location, events, windowEvents, run, timers };
}


test("revealing a pre-existing waiting prompt mounts its link card", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const text = mailType === "passwordResetLinks"
      ? "Reset your password. Check your email." : "Check your email.";
    const panel = { nodeType: 1, tagName: "MAIN", getClientRects: () => [{}], checkVisibility: () => true };
    const prompt = { nodeType: 1, tagName: "P", hidden: true, parentNode: panel, matches: () => false };
    prompt.firstChild = { nodeType: 3, data: text, textContent: text, parentNode: prompt };
    panel.firstChild = prompt;
    Object.defineProperty(panel, "innerText", { get: () => prompt.hidden ? "" : text });
    const f = setup(panel, mailType);
    await settle();
    assert.equal(f.state.views.length, 0);
    assert.equal(f.state.requests, 0);
    prompt.hidden = false;
    f.state.mutate([{ type: "attributes", attributeName: "hidden", target: prompt }]);
    await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.equal(f.state.requests, 1);
    assert.deepEqual(f.state.views[0].links, [item]);
  }
});

test("link cards collect pending scans quickly then resume normal checks", async () => {
  const f = setup(); await settle();
  f.state.respond = async () => ({ ok: true, confirmationLinks: [], scanPending: true });
  await f.run(8000);
  f.state.respond = async () => ({ ok: true, confirmationLinks: [item], scanPending: false });
  await f.run(1000);
  assert.deepEqual(f.state.views.at(-1).links, [item]);
  assert.equal(f.state.collectionModes.at(-1), true);
  await f.run(8000);
  assert.equal(f.state.collectionModes.at(-1), false);
});

test("a slow account does not suppress normal link scans for healthy accounts", async () => {
  const f = setup(); await settle();
  f.state.respond = async () => ({ ok: true, confirmationLinks: [], scanPending: true });
  f.state.now += 8000;
  await f.run(8000);
  f.state.now += 1000;
  await f.run(1000);
  assert.equal(f.state.collectionModes.at(-1), true);
  f.state.now += 7000;
  await f.run(1000);
  assert.equal(f.state.collectionModes.at(-1), false);
});

test("short-unit countdown ticks retain links and the polling deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const unit of ["s", "m"]) {
      const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
      const panel = { innerText: `${prompt} Resend email in 30${unit}`, getClientRects: () => [{}], checkVisibility: () => true };
      const f = setup(panel, mailType); await settle();
      const view = f.state.views[0];
      assert.deepEqual(view.links, [item]);
      f.state.now = 11000;
      panel.innerText = `${prompt} Resend email in 29${unit}`;
      f.state.mutate(stepMutation()); await f.run(250);
      assert.equal(f.state.views.length, 1, `${mailType}: ${unit} countdown must keep the card`);
      assert.deepEqual(view.links, [item]);
      assert.equal(f.state.requests, 1);
      f.state.now = 130000;
      await f.run(8000);
      assert.equal(f.state.requests, 1, "countdown must not restart the two-minute window");
      assert.match(view.status, /Checking finished/);
    }
  }
});

test("countdown completion retains confirmation and reset links and the deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const countdown of ["Resend in 30 seconds", "Resend email in 30s", "Resend in 00:30", "Resend email (30)", "Resend email (30s)", "Resend email (00:30)"]) {
      const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
      const panel = { innerText: `${prompt} ${countdown}`, getClientRects: () => [{}], checkVisibility: () => true };
      const f = setup(panel, mailType); await settle();
      f.state.now = 40000;
      panel.innerText = `${prompt} Resend email`;
      f.state.mutate(stepMutation()); await f.run(250);
      assert.deepEqual(f.state.views.at(-1).links, [item], `${mailType}: ${countdown}`);
      assert.equal(f.state.requests, 1);
      f.state.now = 130000;
      await f.run(8000);
      assert.equal(f.state.requests, 1, "countdown completion must not extend polling");
      f.state.views.at(-1).callbacks.onRetry(); await settle();
      assert.deepEqual(f.state.views.at(-1).links, [item], "retry retains the current link");
    }
  }
});

test("incidental panel status preserves links, selection, dismissal and the polling deadline", async () => {
  for (const mailType of ['confirmationLinks', 'passwordResetLinks']) {
    const prompt = mailType === 'passwordResetLinks' ? 'Password reset. Check your email.' : 'Check your email.';
    const panel = { innerText: `${prompt} We sent a link to me@yahoo.com.`,
      getClientRects: () => [{}], checkVisibility: () => true };
    const f = setup(panel, mailType); await settle();
    const view = f.state.views[0];
    f.state.now = 20000;
    panel.innerText += '\nConnection restored.';
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.deepEqual(view.links, [item]);
    assert.equal(f.state.requests, 1);
    f.state.now = 130000;
    await f.run(8000);
    assert.equal(f.state.requests, 1);
    assert.match(view.status, /Checking finished/);
    assert.equal(view.callbacks.onSelectLink(item), true);
    view.callbacks.onClose();
    panel.innerText += '\nStatus updated.';
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
  }
});

test("modal link cards mount in the active dialog rather than the inert document", async () => {
  let mounted;
  const modal = { append(host) { mounted = host; } };
  const f = setup(null, 'passwordResetLinks', modal); await settle();
  assert.equal(mounted, f.state.views[0].host);
  assert.deepEqual(f.state.views[0].links, [item]);
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

test("oversized mutations are coalesced into one throttled confirmation scan", async () => {
  const f = setup(); await settle();
  const before = f.state.stepReads;
  const records = [{ type: "childList", target: { nodeType: 1, closest: () => null },
    addedNodes: [{ nodeType: 3, textContent: "x".repeat(2_000_000) }], removedNodes: [] }];
  for (let count = 0; count < 20; count++) f.state.mutate(records);
  assert.equal([...f.timers.values()].filter((timer) => timer.delay === 250).length, 1);
  assert.equal(f.state.stepReads, before);
  await f.run(250);
  assert.equal(f.state.stepReads, before + 1);
});

test("renders matching mail, validates open and remains dismissed", async () => {
  const f = setup(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);
  assert.equal(view.callbacks.onSelectLink(item), true);
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
  assert.equal(view.callbacks.onSelectLink(item), false);
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
  finish({ ok: true, confirmationLinks: [{ ...item, uid: 2 }] }); await pending;
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
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("input-button resends invalidate old confirmation and reset links", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
    const panel = { innerText: prompt, getClientRects: () => [{}], checkVisibility: () => true };
    const f = setup(panel, mailType); await settle();
    const oldView = f.state.views[0];
    assert.deepEqual(oldView.links, [item]);
    f.state.now = 11000;
    const control = { tagName: "INPUT", value: "Resend email", getAttribute: () => "" };
    f.events.click({ target: { closest(selector) {
      return selector.split(", ").includes("input[type=button]") ? control : null;
    } } });
    await settle();
    assert.equal(oldView.removed, true);
    assert.deepEqual(f.state.views.at(-1).links, []);
    assert.equal(oldView.callbacks.onSelectLink(item), false);
    f.state.now = 12000;
    const newer = { ...item, uid: 2, receivedAt: 12000 };
    f.state.respond = async () => ({ ok: true, [mailType]: [item, newer] });
    await f.run(8000);
    assert.deepEqual(f.state.views.at(-1).links, [newer]);
  }
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
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("a send confirmation control clears old links on the same screen", async () => {
  const f = setup(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Send confirmation email", getAttribute: () => "" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views[0].callbacks.onSelectLink(item), false);
});

test("a new confirmation step on the same URL clears links from the previous step", async () => {
  const f = setup(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  f.state.screenKey = "second signup";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.onSelectLink(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, confirmationLinks: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
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
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
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
  assert.equal(oldView.callbacks.onSelectLink(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, confirmationLinks: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
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
  f.state.respond = async () => ({ ok: true, confirmationLinks: [{ ...item, uid: 3 }] });
  finishFirst({ ok: true, confirmationLinks: [{ ...item, uid: 2 }] });
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
  finishOld({ ok: true, confirmationLinks: [] });
  await oldPending;
  assert.equal(f.state.requests, 3);
  f.state.respond = async () => ({ ok: true, confirmationLinks: [{ ...item, uid: 4 }] });
  finishNew({ ok: true, confirmationLinks: [] });
  await settle();
  assert.equal(f.state.requests, 4);
  assert.equal(f.state.views.at(-1).links[0].uid, 4);
});

test("reset card requests reset mail, copies on selection, and clears results on resend", async () => {
  const panel = { innerText: "Reset your password. Check your email", getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel, "passwordResetLinks"); await settle();
  const view = f.state.views[0];
  assert.equal(view.callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(view.links, [item]);
  assert.equal(f.state.copied, undefined);
  assert.equal(view.callbacks.onSelectLink(item), true);
  await view.callbacks.copyLink(item);
  assert.equal(f.state.copied, item.url);
  assert.equal(view.removed, false);
  f.events.click({ target: { closest: () => ({ textContent: "Send password reset link" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("confirmation instructions select confirmation mail despite unrelated password navigation", async () => {
  const panel = { innerText: "Check your email to confirm your account. Sign in. Forgot password?",
    getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "confirmationLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("line-separated reset headings select reset mail", async () => {
  const panel = { innerText: "Forgot password?\nCheck your inbox\nSign in", getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel, "passwordResetLinks"); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("reset instructions spanning continuation lines select reset mail", async () => {
  const panel = { innerText: "Check your email\nWe have sent you a link to\nreset your password",
    getClientRects: () => [{}], checkVisibility: () => true };
  const f = setup(panel, "passwordResetLinks"); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("a purpose change with the same step key discards old results and switches requests", async () => {
  const f = setup(); await settle();
  const oldView = f.state.views.at(-1);
  f.state.mailType = "passwordResetLinks";
  const newer = { ...item, uid: 2, receivedAt: 11000 };
  f.state.respond = async () => ({ ok: true, passwordResetLinks: [newer] });
  f.state.mutate(stepMutation());
  await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(f.state.views.at(-1).callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 11000;
  await f.run(8000);
  assert.deepEqual(f.state.views.at(-1).links, [newer]);
});


test("parenthesised countdown ticks retain links without restarting the attempt", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
    const panel = { innerText: `${prompt} Resend email (30)`, getClientRects: () => [{}], checkVisibility: () => true };
    const f = setup(panel, mailType); await settle();
    const view = f.state.views[0];
    assert.deepEqual(view.links, [item]);
    f.state.now = 11000;
    panel.innerText = `${prompt} Resend email (29)`;
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.deepEqual(view.links, [item]);
    assert.equal(f.state.requests, 1);
  }
});

test("partial account failures retain healthy links and clear after recovery", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const f = setup(null, mailType);
    await settle();
    const view = f.state.views[0];
    f.state.respond = async () => ({ ok: true, [mailType]: [item],
      warnings: ["other@yahoo.com: Yahoo took too long to respond."], scanPending: false });
    await f.run(8000);
    assert.deepEqual(view.links, [item]);
    assert.equal(view.status, "Some accounts could not be checked: other@yahoo.com: Yahoo took too long to respond.");
    f.state.respond = async () => ({ ok: true, [mailType]: [item], warnings: [], scanPending: false });
    await f.run(8000);
    assert.doesNotMatch(view.status, /could not be checked/);
    assert.equal(view.callbacks.onSelectLink(item), true);
  }
});
