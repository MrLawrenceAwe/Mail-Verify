import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompanionClient,
  CompanionUnavailableError,
} from "../extension/shared/companion-client.js";
import { createTimerQueue } from "./support/timer_queue.js";
import { createMockNativeRuntime } from "./support/mock_native_runtime.js";

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

  const runtime = createMockNativeRuntime();
  const client = createCompanionClient(runtime, createTimerQueue());
  const denied = client.sendSessionRequest("status");
  runtime.ports[0].reply({
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
  runtime.ports[0].disconnect();
  await assert.rejects(missingHost, CompanionUnavailableError);
});

test("reuses the host and ignores replies from closed ports", async () => {
  const runtime = createMockNativeRuntime();
  const { ports } = runtime;
  const client = createCompanionClient(runtime, createTimerQueue());
  const status = client.sendSessionRequest("status");
  ports[0].reply({ ok: true, accountEmails: ["test@yahoo.com"] });
  assert.deepEqual((await status).accountEmails, ["test@yahoo.com"]);
  const first = client.sendSessionRequest("codes");
  ports[0].reply({ ok: true, codes: [code] });
  assert.equal((await first).codes[0].code, code.code);
  assert.equal(ports.length, 1, "startup and checks reuse one native host");
  const interrupted = client.sendSessionRequest("codes");
  client.closeSession();
  await assert.rejects(interrupted, /interrupted/);
  const retry = client.sendSessionRequest("codes");
  assert.equal(ports.length, 2);
  ports[0].deliverLateReply({ ok: true, codes: [code] });
  ports[1].reply({ ok: true, codes: [] });
  assert.equal(
    (await retry).codes.length,
    0,
    "ignore responses from closed ports",
  );
});

test("rejects overlapping session requests without losing the first response", async () => {
  const runtime = createMockNativeRuntime();
  const client = createCompanionClient(runtime, createTimerQueue());
  const first = client.sendSessionRequest("codes");
  assert.throws(
    () => client.sendSessionRequest("status"),
    /already in progress/,
  );
  runtime.ports.at(-1).reply({ ok: true, codes: [code] });
  assert.equal((await first).codes[0].code, code.code);
});

test("uses the same response errors for one-off and session requests", async () => {
  const runtime = createMockNativeRuntime();
  const client = createCompanionClient(runtime, createTimerQueue());
  const oneOff = client.sendOneOffRequest({ action: "saveAccount" });
  runtime.ports.at(-1).reply({ ok: false, error: "Denied" });
  await assert.rejects(oneOff, /Denied/);
  const request = client.sendSessionRequest("codes");
  runtime.ports.at(-1).reply({ ok: false, error: "Denied" });
  await assert.rejects(request, /Denied/);

  const unclassified = client.sendSessionRequest("codes");
  runtime.ports.at(-1).reply({ ok: false, error: "Unsupported request." });
  await assert.rejects(unclassified, { message: "Unsupported request." });

  for (const request of [
    () => client.sendSessionRequest("confirmationLinks"),
    () => client.sendOneOffRequest({ action: "saveAccount" }),
  ]) {
    const unsupported = request();
    runtime.ports.at(-1).reply({
      ok: false,
      errorCode: "unsupportedRequest",
      error: "This action is unavailable.",
    });
    await assert.rejects(
      unsupported,
      /Unsupported request.*close the popup.*Install Companion\.command.*chrome:\/\/extensions.*refresh affected website tabs.*reopen the popup/,
    );
  }
});

test("silent hosts time out, disconnect, and allow a fresh request", async () => {
  const timers = createTimerQueue();
  const runtime = createMockNativeRuntime();
  const { ports } = runtime;
  const client = createCompanionClient(runtime, timers);
  const stalled = client.sendSessionRequest("status");
  const rejected = assert.rejects(stalled, /too long/);
  await timers.runNextWithDelay(35_000);
  await rejected;
  assert.equal(ports[0].closed, true);
  const retry = client.sendSessionRequest("codes");
  ports[0].deliverLateReply({ ok: true, codes: [code] });
  ports[1].reply({ ok: true, codes: [] });
  assert.deepEqual((await retry).codes, []);
  assert.equal(timers.length, 0);
  client.closeSession();
  const save = client.sendOneOffRequest({
    action: "saveAccount",
    email: "test@yahoo.com",
    password: "unused",
  });
  assert.equal(ports[2].messages[0].email, "test@yahoo.com");
  const saveRejected = assert.rejects(save, /too long/);
  await timers.runNextWithDelay(60_000);
  await saveRejected;
  assert.equal(ports[2].closed, true);
  assert.equal(timers.length, 0);
});
