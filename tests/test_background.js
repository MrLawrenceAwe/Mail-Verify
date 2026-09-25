import test from "node:test";
import assert from "node:assert/strict";
import { registerInlineRequests } from "../extension/background.js";

function setup() {
  let listener, onMessage, checks = 0, closed = 0, idle;
  const chrome = {
    runtime: {
      id: "extension",
      onMessage: { addListener(fn) { listener = fn; } },
      connectNative() {
        checks++;
        return {
          onMessage: { addListener(fn) { onMessage = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() { queueMicrotask(() => onMessage({ ok: true, codes: [] })); },
          disconnect() { closed++; },
        };
      },
    },
    tabs: { query: async () => [{ id: 1 }] },
  };
  registerInlineRequests(chrome, { setTimeout(fn) { idle = fn; return 1; }, clearTimeout() { idle = undefined; } });
  const sender = { id: "extension", frameId: 0, url: "https://secure.indeed.com/auth", tab: { id: 1 } };
  const request = (overrides = {}) => new Promise(resolve => listener(
    { type: "yahoo-inline-codes" }, { ...sender, ...overrides }, resolve));
  return { request, expire() { idle(); }, get checks() { return checks; }, get closed() { return closed; } };
}

test("background rejects inactive tabs, frames, and non-HTTPS senders", async () => {
  const fixture = setup();
  for (const sender of [{ tab: { id: 2 } }, { frameId: 1 }, { url: "http://example.com" }, { id: "other" }]) {
    assert.equal((await fixture.request(sender)).ok, false);
  }
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
