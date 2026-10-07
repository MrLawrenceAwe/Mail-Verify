import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardHarness, settle, item } from "./email_link_card_harness.js";

test("link cards collect pending scans quickly then resume normal checks", async () => {
  const f = createEmailLinkCardHarness(); await settle();
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
  const f = createEmailLinkCardHarness(); await settle();
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

test("a failed inbox check removes previously offered links", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);

  f.state.respond = async () => ({ ok: false, error: "Connect Yahoo Mail first." });
  await f.run(8000);
  assert.deepEqual(view.links, []);
  assert.match(view.status, /Connect Yahoo Mail first/);
  assert.equal(view.callbacks.onSelectLink(item), false);
});

test("hides when tab is hidden and does not reset the polling deadline", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  f.document.hidden = true; f.events.visibilitychange(); await f.run(250);
  assert.equal(f.state.views[0].removed, true);
  f.state.now += 125000;
  f.document.hidden = false; f.events.visibilitychange(); await f.run(250);
  assert.equal(f.state.requests, 1);
  assert.match(f.state.views.at(-1).status, /Checking finished/);
});

test("retry during an active check ignores its response and immediately checks again", async () => {
  const f = createEmailLinkCardHarness(); await settle();
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
  const f = createEmailLinkCardHarness(); await settle();
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

test("partial account failures retain healthy links and clear after recovery", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const f = createEmailLinkCardHarness(null, mailType);
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
