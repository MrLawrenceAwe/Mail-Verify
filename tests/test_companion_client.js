import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompanionClient,
  CompanionUnavailableError,
} from "../extension/shared/companion-client.js";
import { createTimerQueue } from "./support/timer_queue.js";

const code = { code: "123456" };

test("distinguishes unavailable native hosts from operational status errors", async () => {
  const unavailable = createCompanionClient({
    connectNative() {
      throw new Error("Host not installed");
    },
  });
  assert.throws(
    () => unavailable.sendSessionRequest("status"),
    CompanionUnavailableError,
  );

  let reply, disconnect;
  const client = createCompanionClient(
    {
      connectNative: () => ({
        onMessage: {
          addListener(listener) {
            reply = listener;
          },
        },
        onDisconnect: {
          addListener(listener) {
            disconnect = listener;
          },
        },
        postMessage() {},
        disconnect() {},
      }),
    },
    createTimerQueue(),
  );
  const denied = client.sendSessionRequest("status");
  reply({
    ok: false,
    error: "Keychain access was denied. Unlock your login Keychain.",
  });
  await assert.rejects(
    denied,
    (error) =>
      !(error instanceof CompanionUnavailableError) &&
      /Keychain access was denied/.test(error.message),
  );

  const missingHost = client.sendSessionRequest("status");
  disconnect();
  await assert.rejects(missingHost, CompanionUnavailableError);
});

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
      onMessage: {
        addListener(listener) {
          reply = listener;
        },
      },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  });
  const first = client.sendSessionRequest("codes");
  assert.throws(
    () => client.sendSessionRequest("status"),
    /already in progress/,
  );
  reply({ ok: true, codes: [code] });
  assert.equal((await first).codes[0].code, code.code);
});

test("uses the same response errors for one-off and session requests", async () => {
  let reply;
  const client = createCompanionClient({
    connectNative: () => ({
      onMessage: {
        addListener(listener) {
          reply = listener;
        },
      },
      onDisconnect: { addListener() {} },
      postMessage() {},
      disconnect() {},
    }),
  });
  const oneOff = client.sendOneOffRequest({ action: "saveAccount" });
  reply({ ok: false, error: "Denied" });
  await assert.rejects(oneOff, /Denied/);
  const request = client.sendSessionRequest("codes");
  reply({ ok: false, error: "Denied" });
  await assert.rejects(request, /Denied/);
});

test("silent hosts time out, disconnect, and allow a fresh request", async () => {
  const timers = createTimerQueue();
  const ports = [];
  const client = createCompanionClient(
    {
      connectNative() {
        const port = {
          onMessage: {
            addListener(fn) {
              port.reply = fn;
            },
          },
          onDisconnect: {
            addListener(fn) {
              port.disconnected = fn;
            },
          },
          postMessage(request) {
            port.request = request;
          },
          disconnect() {
            port.closed = true;
            port.disconnected();
          },
        };
        ports.push(port);
        return port;
      },
    },
    timers,
  );
  const stalled = client.sendSessionRequest("status");
  const rejected = assert.rejects(stalled, /too long/);
  await timers.runWithDelay(35_000);
  await rejected;
  assert.equal(ports[0].closed, true);
  const retry = client.sendSessionRequest("codes");
  ports[0].reply({ ok: true, codes: [code] });
  ports[1].reply({ ok: true, codes: [] });
  assert.deepEqual((await retry).codes, []);
  assert.equal(timers.length, 0);
  client.closeSession();
  const save = client.sendOneOffRequest({
    action: "saveAccount",
    email: "test@yahoo.com",
    password: "unused",
  });
  assert.equal(ports[2].request.email, "test@yahoo.com");
  const saveRejected = assert.rejects(save, /too long/);
  await timers.runWithDelay(60_000);
  await saveRejected;
  assert.equal(ports[2].closed, true);
  assert.equal(timers.length, 0);
});
