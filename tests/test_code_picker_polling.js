import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createCodePickerHarness } from "./support/code_picker_harness.js";

test("code picker collects pending scans quickly then resumes normal checks", async () => {
  const modes = [];
  const anchor = {};
  const code = {
    uid: 1,
    accountEmail: "test@yahoo.com",
    code: "123456",
    sender: "auth@example.test",
    receivedAt: 9000,
  };
  const { timers, results } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor,
      rect: { top: 100, bottom: 130, left: 20, right: 200 },
    }),
    now: () => 10000,
    check: async (_mailType, collectOnly) => {
      modes.push(collectOnly);
      return modes.length === 1
        ? { ok: true, codes: [], scanPending: true }
        : { ok: true, codes: [code], scanPending: false };
    },
  });
  await waitForAsyncCallbacks();
  await timers.runWithDelay(1000);
  await waitForAsyncCallbacks();
  assert.equal(results.childElementCount, 1);
  assert.deepEqual(modes, [false, true]);
  await timers.runWithDelay(2000);
  await waitForAsyncCallbacks();
  assert.equal(modes.at(-1), false);
});

test("a slow account does not suppress normal code scans for healthy accounts", async () => {
  const modes = [];
  const anchor = {};
  let now = 10000;
  const { timers } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor,
      rect: { top: 100, bottom: 130, left: 20, right: 200 },
    }),
    now: () => now,
    check: async (_mailType, collectOnly) => {
      modes.push(collectOnly);
      return { ok: true, codes: [], scanPending: true };
    },
  });

  await waitForAsyncCallbacks();
  now += 1000;
  await timers.runWithDelay(1000);
  await waitForAsyncCallbacks();
  now += 1000;
  await timers.runWithDelay(1000);
  await waitForAsyncCallbacks();
  assert.deepEqual(modes, [false, true, false]);
});

test("a failed inbox check removes previously offered codes", async () => {
  const code = {
    uid: 1,
    accountEmail: "test@yahoo.com",
    code: "123456",
    sender: "auth@example.test",
    receivedAt: 9_000,
  };
  let connected = true;
  const { timers, results, elements } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor: {},
      candidateCache: { contextRoots: [] },
      rect: { top: 100, bottom: 130, left: 20, right: 200 },
    }),
    now: () => 10_000,
    check: async () =>
      connected
        ? { ok: true, codes: [code] }
        : { ok: false, error: "Connect Yahoo Mail first." },
  });
  await waitForAsyncCallbacks();
  assert.equal(results.childElementCount, 1);

  connected = false;
  timers.takeNewest()();
  await waitForAsyncCallbacks();
  assert.equal(results.childElementCount, 0);
  assert.match(elements["#status"].textContent, /Connect Yahoo Mail first/);
});

test("retry during an active check ignores its response and checks again immediately", async () => {
  let resolveFirst;
  let checks = 0;
  const oldCode = {
    uid: 1,
    accountEmail: "test@yahoo.com",
    code: "111111",
    sender: "auth@example.test",
    receivedAt: 9_000,
  };
  const newCode = { ...oldCode, uid: 2, code: "222222", receivedAt: 10_000 };
  const { results, elements } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor: {},
      candidateCache: { contextRoots: [] },
      rect: { top: 100, bottom: 130, left: 20, right: 200 },
    }),
    now: () => 10_000,
    check: () =>
      ++checks === 1
        ? new Promise((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve({ ok: true, codes: [newCode] }),
  });
  elements["#retry"].onclick();
  assert.equal(checks, 1);
  resolveFirst({ ok: true, codes: [oldCode] });
  await waitForAsyncCallbacks();
  assert.equal(checks, 2);
  assert.equal(results.children[0].strong.textContent, "Fill code 222222");
});

test("returning to a hidden tab starts a check while the old one is pending", async () => {
  const requests = [];
  const anchor = {};
  const { environment, events, timers, results } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor,
      candidateCache: { contextRoots: [] },
      rect: { left: 20, right: 200, top: 100, bottom: 130 },
    }),
    now: () => 10_000,
    check: () => new Promise((resolve) => requests.push(resolve)),
  });
  assert.equal(requests.length, 1);
  environment.document.hidden = true;
  events.get("visibilitychange")();
  timers.takeOldest()();
  environment.document.hidden = false;
  events.get("visibilitychange")();
  timers.takeOldest()();
  assert.equal(requests.length, 2);
  const code = {
    uid: 1,
    accountEmail: "test@yahoo.com",
    code: "111111",
    sender: "auth@example.test",
    receivedAt: 9_000,
  };
  requests[0]({ ok: true, codes: [] });
  await waitForAsyncCallbacks();
  assert.equal(results.childElementCount, 0);
  requests[1]({ ok: true, codes: [code] });
  await waitForAsyncCallbacks();
  assert.equal(results.children[0].strong.textContent, "Fill code 111111");
});
