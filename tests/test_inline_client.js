import test from "node:test";
import assert from "node:assert/strict";
import { requestInlineCheck } from "../extension/inline/inline-client.js";

function runtime() {
  let message, disconnect, sent, closed = false;
  return {
    connect({ name }) {
      assert.equal(name, "mail-verify-inline");
      return {
        onMessage: { addListener(fn) { message = fn; } },
        onDisconnect: { addListener(fn) { disconnect = fn; } },
        postMessage(value) { sent = value; },
        disconnect() { closed = true; },
      };
    },
    respond(value) { message(value); },
    drop() { disconnect(); },
    get sent() { return sent; },
    get closed() { return closed; },
  };
}

test("inline check keeps its port open until the response arrives", async () => {
  const chromeRuntime = runtime();
  const pending = requestInlineCheck(chromeRuntime, "codes");
  assert.deepEqual(chromeRuntime.sent, { mailType: "codes", collectOnly: false });
  assert.equal(chromeRuntime.closed, false);
  chromeRuntime.respond({ ok: true, codes: [] });
  assert.deepEqual(await pending, { ok: true, codes: [] });
  assert.equal(chromeRuntime.closed, true);
});

test("collection requests preserve their mode and pending scan status", async () => {
  const chromeRuntime = runtime();
  const pending = requestInlineCheck(chromeRuntime, "confirmationLinks", true);
  assert.deepEqual(chromeRuntime.sent, { mailType: "confirmationLinks", collectOnly: true });
  chromeRuntime.respond({ ok: true, confirmationLinks: [], scanPending: true });
  assert.equal((await pending).scanPending, true);
});

test("inline check reports a disconnected service worker", async () => {
  const chromeRuntime = runtime();
  const pending = requestInlineCheck(chromeRuntime, "confirmationLinks");
  chromeRuntime.drop();
  await assert.rejects(pending, /disconnected/);
});
