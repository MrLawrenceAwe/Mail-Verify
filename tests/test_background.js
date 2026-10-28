import test from "node:test";
import assert from "node:assert/strict";
import { registerInlineRequests } from "../extension/background.js";
import { createTimerQueue } from "./support/timer_queue.js";
import { createMockNativeRuntime } from "./support/mock_native_runtime.js";

function setup(nativeResponse = { ok: true, codes: [], scanPending: false }) {
  let listener;
  const timers = createTimerQueue();
  const nativeRuntime = createMockNativeRuntime((request, port) => {
    queueMicrotask(() => {
      port.reply(
        typeof nativeResponse === "function" ? nativeResponse(request) : nativeResponse,
      );
    });
  });
  const chrome = {
    runtime: {
      id: "extension",
      onConnect: {
        addListener(fn) {
          listener = fn;
        },
      },
      connectNative: nativeRuntime.connectNative,
    },
    tabs: { query: async () => [{ id: 1 }] },
  };
  registerInlineRequests(chrome, timers);
  const sender = {
    id: "extension",
    frameId: 0,
    url: "https://secure.indeed.com/auth",
    tab: { id: 1 },
  };
  const request = (overrides = {}, mailType = "codes", collectOnly = false) =>
    new Promise((resolve) => {
      let handleMessage;
      listener({
        name: "mail-verify-inline",
        sender: { ...sender, ...overrides },
        onMessage: {
          addListener(fn) {
            handleMessage = fn;
          },
        },
        postMessage: resolve,
      });
      handleMessage({ mailType, collectOnly });
    });
  return {
    request,
    nativeRequests: nativeRuntime.requests,
    expire() {
      return timers.runNextWithDelay(15_000);
    },
    get connectionsOpened() {
      return nativeRuntime.ports.length;
    },
    get closed() {
      return nativeRuntime.ports.filter((port) => port.closed).length;
    },
  };
}

test("background rejects inactive tabs, frames, and non-HTTPS senders", async () => {
  const fixture = setup();
  for (const sender of [
    { tab: { id: 2 } },
    { frameId: 1 },
    { url: "http://example.com" },
    { id: "other" },
  ]) {
    assert.equal((await fixture.request(sender)).ok, false);
  }
  assert.equal(fixture.connectionsOpened, 0);
});

test("background rejects unknown checks without opening the companion", async () => {
  const fixture = setup();
  assert.deepEqual(await fixture.request({}, "accounts"), {
    ok: false,
    error: "Unknown mail check.",
  });
  assert.equal(fixture.connectionsOpened, 0);
});

test("automatic checks reuse the connection and close it after polling stops", async () => {
  const fixture = setup();
  const responses = await Promise.all([fixture.request(), fixture.request()]);
  assert.ok(responses.every((result) => result.ok));
  assert.equal(fixture.connectionsOpened, 1);
  assert.equal(fixture.nativeRequests.length, 1);
  assert.equal(fixture.closed, 0);
  await fixture.request();
  assert.equal(fixture.connectionsOpened, 1);
  assert.equal(fixture.nativeRequests.length, 2);
  await fixture.expire();
  assert.equal(fixture.closed, 1);
  await fixture.request();
  assert.equal(fixture.connectionsOpened, 2);
  assert.equal(fixture.nativeRequests.length, 3);
});

test("automatic checks pass partial account warnings to the picker", async () => {
  const warnings = ["one@yahoo.com: Yahoo took too long to respond."];
  const result = await setup({
    ok: true,
    codes: [],
    warnings,
    scanPending: false,
  }).request();
  assert.deepEqual(result, {
    ok: true,
    codes: [],
    warnings,
    scanPending: false,
  });
});

test("background forwards collection mode and pending status across the native bridge", async () => {
  const harness = setup({ ok: true, confirmationLinks: [], scanPending: true });
  const result = await harness.request({}, "confirmationLinks", true);
  assert.equal(result.scanPending, true);
  assert.deepEqual(harness.nativeRequests, [
    { action: "confirmationLinks", collectOnly: true },
  ]);
});

test("link requests use their own result type and enforce active tab access", async () => {
  const confirmationLinks = [
    { url: "https://example.com/confirm", receivedAt: 1000 },
  ];
  const fixture = setup({ ok: true, confirmationLinks, scanPending: false });
  assert.deepEqual(await fixture.request({}, "confirmationLinks"), {
    ok: true,
    confirmationLinks,
    warnings: [],
    scanPending: false,
  });
  assert.equal(
    (await fixture.request({ tab: { id: 2 } }, "confirmationLinks")).ok,
    false,
  );
});

test("password reset requests return reset links and enforce active tab access", async () => {
  const passwordResetLinks = [
    { url: "https://example.com/reset", receivedAt: 1000 },
  ];
  const fixture = setup({ ok: true, passwordResetLinks, scanPending: false });
  assert.deepEqual(await fixture.request({}, "passwordResetLinks"), {
    ok: true,
    passwordResetLinks,
    warnings: [],
    scanPending: false,
  });
  assert.equal(
    (await fixture.request({ tab: { id: 2 } }, "passwordResetLinks")).ok,
    false,
  );
});

test("concurrent mail types keep native responses and session lifetimes separate", async () => {
  const results = {
    codes: [{ code: "123456", receivedAt: 1000 }],
    confirmationLinks: [{ url: "https://example.com/confirm", receivedAt: 2000 }],
    passwordResetLinks: [{ url: "https://example.com/reset", receivedAt: 3000 }],
  };
  const fixture = setup(({ action }) => ({
    ok: true,
    [action]: results[action],
    scanPending: false,
  }));
  const mailTypes = Object.keys(results);
  const responses = await Promise.all(
    mailTypes.map((type) => fixture.request({}, type)),
  );
  for (const [index, type] of mailTypes.entries()) {
    assert.deepEqual(responses[index], {
      ok: true,
      [type]: results[type],
      warnings: [],
      scanPending: false,
    });
  }
  assert.equal(fixture.connectionsOpened, 3);
  assert.deepEqual(fixture.nativeRequests.map(({ action }) => action), mailTypes);
  await fixture.expire();
  assert.equal(fixture.closed, 1);
  const reset = await fixture.request({}, "passwordResetLinks");
  assert.deepEqual(reset.passwordResetLinks, results.passwordResetLinks);
  assert.equal(fixture.connectionsOpened, 3, "closing codes preserves the reset session");
  const codes = await fixture.request();
  assert.deepEqual(codes.codes, results.codes);
  assert.equal(fixture.connectionsOpened, 4, "codes reconnect independently");
});
