import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailLinkCardHarness,
  emailLinkMessage,
} from "./support/email_link_card_harness.js";

test("link cards collect pending scans quickly then resume normal checks", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [],
    scanPending: true,
  });
  await harness.run(8000);
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [emailLinkMessage],
    scanPending: false,
  });
  await harness.run(1000);
  assert.deepEqual(harness.state.views.at(-1).links, [emailLinkMessage]);
  assert.equal(harness.state.collectionModes.at(-1), true);
  await harness.run(8000);
  assert.equal(harness.state.collectionModes.at(-1), false);
});

test("a slow account does not suppress normal link scans for healthy accounts", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [],
    scanPending: true,
  });
  harness.state.now += 8000;
  await harness.run(8000);
  harness.state.now += 1000;
  await harness.run(1000);
  assert.equal(harness.state.collectionModes.at(-1), true);
  harness.state.now += 7000;
  await harness.run(1000);
  assert.equal(harness.state.collectionModes.at(-1), false);
});

test("a failed inbox check removes previously offered links", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const view = harness.state.views[0];
  assert.deepEqual(view.links, [emailLinkMessage]);

  harness.state.respond = async () => ({
    ok: false,
    error: "Connect Yahoo Mail first.",
  });
  await harness.run(8000);
  assert.deepEqual(view.links, []);
  assert.match(view.status, /Connect Yahoo Mail first/);
  assert.equal(view.callbacks.onSelectLink(emailLinkMessage), false);
});

test("hides when tab is hidden and does not reset the polling deadline", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.document.hidden = true;
  harness.events.visibilitychange();
  await harness.run(250);
  assert.equal(harness.state.views[0].removed, true);
  harness.state.now += 125000;
  harness.document.hidden = false;
  harness.events.visibilitychange();
  await harness.run(250);
  assert.equal(harness.state.requests, 1);
  assert.match(harness.state.views.at(-1).status, /Checking finished/);
});

test("retry during an active check ignores its response and immediately checks again", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  let finishFirst;
  harness.state.respond = () =>
    new Promise((resolve) => {
      finishFirst = resolve;
    });
  const pending = harness.run(8000);
  const view = harness.state.views[0];
  const firstCount = harness.state.requests;
  view.callbacks.onRetry();
  assert.equal(
    harness.state.requests,
    firstCount,
    "the native client handles one request at a time",
  );
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [{ ...emailLinkMessage, uid: 3 }],
  });
  finishFirst({
    ok: true,
    confirmationLinks: [{ ...emailLinkMessage, uid: 2 }],
  });
  await pending;
  assert.equal(harness.state.requests, firstCount + 1);
  assert.equal(view.links[0].uid, 3);
  assert.equal(
    [...harness.timers.values()].some((value) => value.delay === 8000),
    true,
  );
});

test("an old check cannot consume a retry queued on a new page", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  let finishOld, finishNew;
  harness.state.respond = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  const oldPending = harness.run(8000);
  harness.location.href = "https://example.com/next";
  harness.windowEvents.popstate();
  harness.state.respond = () =>
    new Promise((resolve) => {
      finishNew = resolve;
    });
  await harness.run(250);
  harness.state.views.at(-1).callbacks.onRetry();
  finishOld({ ok: true, confirmationLinks: [] });
  await oldPending;
  assert.equal(harness.state.requests, 3);
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [{ ...emailLinkMessage, uid: 4 }],
  });
  finishNew({ ok: true, confirmationLinks: [] });
  await waitForAsyncCallbacks();
  assert.equal(harness.state.requests, 4);
  assert.equal(harness.state.views.at(-1).links[0].uid, 4);
});

test("partial account failures retain healthy links and clear after recovery", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const harness = createEmailLinkCardHarness(null, mailType);
    await waitForAsyncCallbacks();
    const view = harness.state.views[0];
    harness.state.respond = async () => ({
      ok: true,
      [mailType]: [emailLinkMessage],
      warnings: ["other@yahoo.com: Yahoo took too long to respond."],
      scanPending: false,
    });
    await harness.run(8000);
    assert.deepEqual(view.links, [emailLinkMessage]);
    assert.equal(
      view.status,
      "Some accounts could not be checked: other@yahoo.com: Yahoo took too long to respond.",
    );
    harness.state.respond = async () => ({
      ok: true,
      [mailType]: [emailLinkMessage],
      warnings: [],
      scanPending: false,
    });
    await harness.run(8000);
    assert.doesNotMatch(view.status, /could not be checked/);
    assert.equal(view.callbacks.onSelectLink(emailLinkMessage), true);
  }
});
