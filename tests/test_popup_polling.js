import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPopupHarness,
  verificationCodeMessage,
  emailLinkMessage,
} from "./support/popup_harness.js";

test("polls whether codes are present or absent", async () => {
  for (const codes of [[verificationCodeMessage], []]) {
    const { timers } = await createPopupHarness({ codes });
    assert.equal(
      timers.length,
      1,
      "keep checking with or without an existing code",
    );
  }
});

test("popup collects pending results quickly without reporting an empty completed scan", async () => {
  const { state, timers, controls } = await createPopupHarness({ codes: [] });
  state.scanPending = true;
  await timers.runWithDelay(8000);
  assert.match(controls.status.textContent, /Checking/);
  state.scanPending = false;
  state.fetchCodes = async () => [verificationCodeMessage];
  await timers.runWithDelay(1000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, true);
  assert.equal(controls.results.querySelectorAll("button").length, 1);
  await timers.runWithDelay(8000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, false);
});

test("a manual popup retry starts a new scan instead of collecting a closed session", async () => {
  const { state, timers, controls } = await createPopupHarness({ codes: [] });
  state.scanPending = true;
  await timers.runWithDelay(8000);
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(state.sessionRequests.at(-1).collectOnly, false);
});

test("a slow account does not suppress normal popup scans for healthy accounts", async () => {
  const { state, timers } = await createPopupHarness({ codes: [] });
  state.scanPending = true;
  state.now += 8000;
  await timers.runWithDelay(8000);
  state.now += 1000;
  await timers.runWithDelay(1000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, true);
  state.now += 7000;
  await timers.runWithDelay(1000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, false);
});

test("stops polling after the deadline", async () => {
  const { controls, timers, state } = await createPopupHarness();
  state.now += 120001;
  await timers.takeOldest()();
  assert.equal(timers.length, 0, "stop after the polling deadline");
  assert.equal(
    controls.status.textContent,
    "Automatic checking finished. Check again for newer codes.",
  );
});

test("does not start a scheduled check after the deadline", async () => {
  const { timers, state } = await createPopupHarness();
  let requests = 0;
  state.fetchCodes = async () => {
    requests++;
    return [];
  };
  state.now += 120001;
  await timers.takeOldest()();
  assert.equal(requests, 0);
  assert.ok(state.closes >= 1);
});

test("retries temporary mail errors", async () => {
  const { controls, timers, state } = await createPopupHarness();
  state.fetchCodes = async () => {
    throw Error("Temporary mail error");
  };
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(timers.length, 1, "retry after temporary errors");
  assert.equal(controls.status.textContent, "Temporary mail error");
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("a failed link check clears earlier confirmation links", async () => {
  const { controls, state } = await createPopupHarness();
  state.fetchConfirmationLinks = async () => [emailLinkMessage];
  controls.checkConfirmationLinks.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.results.querySelectorAll("button").length, 1);
  state.fetchConfirmationLinks = async () => {
    throw Error("Temporary mail error");
  };
  controls.checkConfirmationLinks.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("lets a manual retry supersede a pending check", async () => {
  const { controls, state } = await createPopupHarness();
  const pending = [];
  state.fetchCodes = () => new Promise((resolve) => pending.push(resolve));
  const initial = controls.results.replacements;
  controls.checkCodes.trigger();
  controls.checkCodes.trigger();
  pending[0]([{ ...verificationCodeMessage, code: "111111" }]);
  pending[1]([{ ...verificationCodeMessage, code: "222222" }]);
  await waitForAsyncCallbacks();
  assert.ok(state.closes >= 1, "manual retry interrupts the previous check");
  assert.equal(controls.results.replacements, initial + 1);
  assert.equal(controls.results.children[0].children[0].textContent, "222222");
  assert.equal(controls.checkCodes.disabled, false);
});

test("waits at least two seconds between checks", async () => {
  for (const [duration, expected] of [
    [3000, 5000],
    [10000, 2000],
  ]) {
    const { controls, timers, state } = await createPopupHarness();
    state.fetchCodes = async () => {
      state.now += duration;
      return [];
    };
    controls.checkCodes.trigger();
    await waitForAsyncCallbacks();
    assert.equal([...timers.values()][0].delay, expected);
  }
});

test("finished link checks name the selected email purpose", async () => {
  for (const [control, label] of [
    ["checkConfirmationLinks", "confirmation links"],
    ["checkPasswordResetLinks", "password reset links"],
  ]) {
    const { controls, state, timers } = await createPopupHarness();
    controls[control].trigger();
    await waitForAsyncCallbacks();
    state.now += 120001;
    await timers.takeOldest()();
    assert.equal(
      controls.status.textContent,
      `Automatic checking finished. Check again for newer ${label}.`,
    );
  }
});

test("partial account failures keep popup results selectable and clear after recovery", async () => {
  for (const [control, fetchResults] of [
    ["checkCodes", "fetchCodes"],
    ["checkConfirmationLinks", "fetchConfirmationLinks"],
    ["checkPasswordResetLinks", "fetchPasswordResetLinks"],
  ]) {
    const { controls, state } = await createPopupHarness();
    state[fetchResults] = async () => [
      { ...verificationCodeMessage, url: "https://example.com/verify" },
    ];
    state.warnings = ["other@yahoo.com: Yahoo took too long to respond."];
    controls[control].trigger();
    await waitForAsyncCallbacks();
    const button = controls.results.querySelectorAll("button")[0];
    assert.equal(button.disabled, false);
    assert.equal(
      controls.status.textContent,
      "Some accounts could not be checked: other@yahoo.com: Yahoo took too long to respond.",
    );
    state.warnings = [];
    controls[control].trigger();
    await waitForAsyncCallbacks();
    assert.equal(controls.results.querySelectorAll("button")[0], button);
    assert.doesNotMatch(controls.status.textContent, /could not be checked/);
    await button.trigger();
    if (control === "checkCodes") assert.ok(state.scriptArgs);
    else if (control === "checkConfirmationLinks")
      assert.equal(state.opened.length, 1);
    else assert.deepEqual(state.copied, ["https://example.com/verify"]);
  }
});
