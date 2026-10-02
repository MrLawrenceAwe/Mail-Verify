import test from "node:test";
import assert from "node:assert/strict";
import { registerInlineRequests } from "../extension/background.js";

function setup(nativeResponse = { ok: true, codes: [], scanPending: false }) {
  let listener, onMessage, checks = 0, closed = 0, idle;
  const nativeRequests = [];
  const chrome = {
    runtime: {
      id: "extension",
      onConnect: { addListener(fn) { listener = fn; } },
      connectNative() {
        checks++;
        return {
          onMessage: { addListener(fn) { onMessage = fn; } },
          onDisconnect: { addListener() {} },
          postMessage(request) { nativeRequests.push(request); queueMicrotask(() => onMessage(nativeResponse)); },
          disconnect() { closed++; },
        };
      },
    },
    tabs: { query: async () => [{ id: 1 }] },
  };
  registerInlineRequests(chrome, { setTimeout(fn) { idle = fn; return 1; }, clearTimeout() { idle = undefined; } });
  const sender = { id: "extension", frameId: 0, url: "https://secure.indeed.com/auth", tab: { id: 1 } };
  const request = (overrides = {}, mailType = "codes", collectOnly = false) => new Promise(resolve => {
    let handleMessage;
    listener({
      name: "mail-verify-inline",
      sender: { ...sender, ...overrides },
      onMessage: { addListener(fn) { handleMessage = fn; } },
      postMessage: resolve,
    });
    handleMessage({ mailType, collectOnly });
  });
  return { request, nativeRequests, expire() { idle(); }, get checks() { return checks; }, get closed() { return closed; } };
}

test("background rejects inactive tabs, frames, and non-HTTPS senders", async () => {
  const fixture = setup();
  for (const sender of [{ tab: { id: 2 } }, { frameId: 1 }, { url: "http://example.com" }, { id: "other" }]) {
    assert.equal((await fixture.request(sender)).ok, false);
  }
  assert.equal(fixture.checks, 0);
});

test("background rejects unknown checks without opening the companion", async () => {
  const fixture = setup();
  assert.deepEqual(await fixture.request({}, "accounts"), { ok: false, error: "Unknown mail check." });
  assert.equal(fixture.checks, 0);
});

test("automatic checks reuse the connection and close it after polling stops", async () => {
  const fixture = setup();
  const responses = await Promise.all([fixture.request(), fixture.request()]);
  assert.ok(responses.every(result => result.ok));
  assert.equal(fixture.checks, 1);
  assert.equal(fixture.closed, 0);
  await fixture.request();
  assert.equal(fixture.checks, 1);
  fixture.expire();
  assert.equal(fixture.closed, 1);
  await fixture.request();
  assert.equal(fixture.checks, 2);
});

test("automatic checks pass partial account warnings to the picker", async () => {
  const warnings = ["one@yahoo.com: Yahoo took too long to respond."];
  const result = await setup({ ok: true, codes: [], warnings, scanPending: false }).request();
  assert.deepEqual(result, { ok: true, codes: [], warnings, scanPending: false });
});

test("background forwards collection mode and pending status across the native bridge", async () => {
  const f = setup({ ok: true, confirmationLinks: [], scanPending: true });
  const result = await f.request({}, "confirmationLinks", true);
  assert.equal(result.scanPending, true);
  assert.deepEqual(f.nativeRequests, [{ action: "confirmationLinks", collectOnly: true }]);
});


test("link requests use their own result type and enforce active tab access", async () => {
  const confirmationLinks = [{ url: "https://example.com/confirm", receivedAt: 1000 }];
  const fixture = setup({ ok: true, confirmationLinks, scanPending: false });
  assert.deepEqual(await fixture.request({}, "confirmationLinks"), { ok: true, confirmationLinks, warnings: [], scanPending: false });
  assert.equal((await fixture.request({ tab: { id: 2 } }, "confirmationLinks")).ok, false);
});


test("password reset requests return reset links and enforce active tab access", async () => {
  const passwordResetLinks = [{ url: "https://example.com/reset", receivedAt: 1000 }];
  const fixture = setup({ ok: true, passwordResetLinks, scanPending: false });
  assert.deepEqual(await fixture.request({}, "passwordResetLinks"), { ok: true, passwordResetLinks, warnings: [], scanPending: false });
  assert.equal((await fixture.request({ tab: { id: 2 } }, "passwordResetLinks")).ok, false);
});
