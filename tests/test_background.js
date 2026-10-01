import test from "node:test";
import assert from "node:assert/strict";
import { registerInlineRequests } from "../extension/background.js";

function setup(nativeResponse = { ok: true, codes: [] }) {
  let listener, onMessage, checks = 0, closed = 0, idle;
  const chrome = {
    runtime: {
      id: "extension",
      onConnect: { addListener(fn) { listener = fn; } },
      connectNative() {
        checks++;
        return {
          onMessage: { addListener(fn) { onMessage = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() { queueMicrotask(() => onMessage(nativeResponse)); },
          disconnect() { closed++; },
        };
      },
    },
    tabs: { query: async () => [{ id: 1 }] },
  };
  registerInlineRequests(chrome, { setTimeout(fn) { idle = fn; return 1; }, clearTimeout() { idle = undefined; } });
  const sender = { id: "extension", frameId: 0, url: "https://secure.indeed.com/auth", tab: { id: 1 } };
  const request = (overrides = {}, kind = "codes") => new Promise(resolve => {
    let handleMessage;
    listener({
      name: "mail-verify-inline",
      sender: { ...sender, ...overrides },
      onMessage: { addListener(fn) { handleMessage = fn; } },
      postMessage: resolve,
    });
    handleMessage({ kind });
  });
  return { request, expire() { idle(); }, get checks() { return checks; }, get closed() { return closed; } };
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
  const result = await setup({ ok: true, codes: [], warnings }).request();
  assert.deepEqual(result, { ok: true, codes: [], warnings });
});


test("link requests use their own result type and enforce active tab access", async () => {
  const links = [{ url: "https://example.com/confirm", receivedAt: 1000 }];
  const fixture = setup({ ok: true, links });
  assert.deepEqual(await fixture.request({}, "links"), { ok: true, links, warnings: [] });
  assert.equal((await fixture.request({ tab: { id: 2 } }, "links")).ok, false);
});


test("password reset requests return reset links and enforce active tab access", async () => {
  const resetLinks = [{ url: "https://example.com/reset", receivedAt: 1000 }];
  const fixture = setup({ ok: true, resetLinks });
  assert.deepEqual(await fixture.request({}, "resetLinks"), { ok: true, resetLinks, warnings: [] });
  assert.equal((await fixture.request({ tab: { id: 2 } }, "resetLinks")).ok, false);
});
