import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionClient } from "../extension/shared/companion-client.js";

const code = { code: "123456" };

test("reuses the host and ignores replies from closed ports", async () => {
  const ports = [];
  const client = createCompanionClient({
    connectNative: () => {
      const port = {
        messages: [],
        onMessage: {
          addListener(listener) {
            port.message = listener;
          },
        },
        onDisconnect: {
          addListener(listener) {
            port.disconnected = listener;
          },
        },
        postMessage(message) {
          port.messages.push(message);
        },
        disconnect() {
          port.disconnected();
        },
      };
      ports.push(port);
      return port;
    },
  });
  const status = client.sendSessionRequest("status");
  ports[0].message({ ok: true, email: "test@yahoo.com" });
  assert.equal((await status).email, "test@yahoo.com");
  const first = client.sendSessionRequest("codes");
  ports[0].message({ ok: true, codes: [code] });
  assert.equal((await first).codes[0].code, code.code);
  assert.equal(ports.length, 1, "startup and checks reuse one native host");
  const interrupted = client.sendSessionRequest("codes");
  client.closeSession();
  await assert.rejects(interrupted, /interrupted/);
  const retry = client.sendSessionRequest("codes");
  assert.equal(ports.length, 2);
  ports[0].message({ ok: true, codes: [code] });
  ports[1].message({ ok: true, codes: [] });
  assert.equal(
    (await retry).codes.length,
    0,
    "ignore responses from closed ports",
  );
});

test("rejects overlapping session requests without losing the first response", async () => {
  let reply;
  const client = createCompanionClient({
    connectNative: () => ({
      onMessage: { addListener(listener) { reply = listener; } },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  });
  const first = client.sendSessionRequest("codes");
  assert.throws(() => client.sendSessionRequest("status"), /already in progress/);
  reply({ ok: true, codes: [code] });
  assert.equal((await first).codes[0].code, code.code);
});

test("uses the same response errors for one-off and session requests", async () => {
  let reply;
  const client = createCompanionClient({
    sendNativeMessage: async () => ({ ok: false, error: "Denied" }),
    connectNative: () => ({
      onMessage: { addListener(listener) { reply = listener; } },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  });
  await assert.rejects(client.sendOneOffRequest({ action: "saveAccount" }), /Denied/);
  const request = client.sendSessionRequest("codes");
  reply({ ok: false, error: "Denied" });
  await assert.rejects(request, /Denied/);
});
