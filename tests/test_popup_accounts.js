import { makeVerificationCodeMessage } from "./support/mail_results.js";
import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createPopupHarness } from "./support/popup_harness.js";
import { CompanionUnavailableError } from "../extension/shared/companion-client.js";

const verificationCodeMessage = makeVerificationCodeMessage();

test("saving pauses scheduled and pending checks and preserves connection feedback", async () => {
  for (const pending of [false, true]) {
    const { controls, state, timers } = await createPopupHarness();
    let finishCheck;
    if (pending) {
      state.fetchCodes = () => new Promise((resolve) => {
        finishCheck = resolve;
      });
      controls.checkCodes.trigger();
    }
    let failSave;
    state.sendOneOff = () => new Promise((_resolve, reject) => {
      failSave = reject;
    });
    const requestCount = state.sessionRequests.length;
    const replacements = controls.results.replacements;
    const saving = controls.accountForm.trigger("submit");
    if (finishCheck) finishCheck([]);
    await waitForAsyncCallbacks();
    assert.equal(timers.length, 0, "saving cancels automatic checks");
    assert.equal(controls.status.textContent, "Checking your Yahoo connection…");
    assert.equal(controls.results.replacements, replacements);
    assert.equal(state.sessionRequests.length, requestCount);

    failSave(new Error("App password rejected"));
    await saving;
    assert.equal(controls.status.textContent, "App password rejected");
    assert.equal(timers.length, 1, "failed saving resumes the existing polling window");
    state.fetchCodes = async () => [];
    await timers.runNextWithDelay(8000);
    assert.equal(state.sessionRequests.length, requestCount + 1);
    assert.equal(controls.checkCodes.disabled, false);
  }
});

test("successful saving immediately checks the updated account list", async () => {
  const { controls, state, timers } = await createPopupHarness();
  const requestCount = state.sessionRequests.length;
  await controls.accountForm.trigger("submit");
  await waitForAsyncCallbacks();
  assert.equal(state.sessionRequests.length, requestCount + 1);
  assert.equal(timers.length, 1);
});

test("failed saving after polling expires retains its error without restarting checks", async () => {
  const { controls, state, timers } = await createPopupHarness();
  let failSave;
  state.sendOneOff = () => new Promise((_resolve, reject) => {
    failSave = reject;
  });
  const saving = controls.accountForm.trigger("submit");
  state.now += 120001;
  failSave(new Error("App password rejected"));
  await saving;
  assert.equal(controls.status.textContent, "App password rejected");
  assert.equal(timers.length, 0);
});

test("shows installation guidance only for unavailable companions", async () => {
  for (const statusError of [
    new CompanionUnavailableError(),
    new Error(
      "Keychain access was denied. Unlock your login Keychain and try again.",
    ),
    new Error(
      "Mac companion took too long to respond. Check Keychain access and try again.",
    ),
  ]) {
    const { controls, timers } = await createPopupHarness({ statusError });
    assert.equal(
      controls.companionSetup.hidden,
      !(statusError instanceof CompanionUnavailableError),
    );
    assert.equal(controls.status.textContent, statusError.message);
    assert.equal(controls.accountSetup.hidden, true);
    assert.equal(controls.connectedAccountsPanel.hidden, true);
    assert.equal(timers.length, 0);
  }
});

test("removes an account and recovers from errors", async () => {
  for (const failRemove of [false, true]) {
    const { controls, timers, state } = await createPopupHarness();
    state.failRemove = failRemove;
    await controls.accounts.querySelectorAll("button")[0].trigger();
    assert.equal(state.requests[0].action, "removeAccount");
    assert.equal(state.requests[0].email, "test@yahoo.com");
    assert.equal(timers.length, failRemove ? 1 : 0);
    assert.equal(controls.connectedAccountsPanel.hidden, !failRemove);
    assert.equal(controls.checkCodes.disabled, false);
  }
});

test("checks remaining accounts immediately after removal", async () => {
  const { controls, timers, state } = await createPopupHarness({
    remainingAccountEmails: ["other@yahoo.com"],
  });
  let checks = 0;
  state.fetchCodes = async () => {
    checks++;
    return [];
  };
  await controls.accounts.querySelectorAll("button")[0].trigger();
  await waitForAsyncCallbacks();
  assert.equal(checks, 1);
  assert.equal(
    controls.accounts.children[0].children[0].textContent,
    "other@yahoo.com",
  );
  assert.equal(timers.length, 1);
});

test("does not remove an account while another account is being added", async () => {
  const { controls, state } = await createPopupHarness();
  let finishAdd;
  state.sendOneOff = () =>
    new Promise((resolve) => {
      finishAdd = resolve;
    });
  controls.showAccountSetup.trigger();
  controls.email.value = "two@yahoo.com";
  controls.password.value = "new-password";
  const adding = controls.accountForm.trigger("submit");
  assert.equal(controls.accounts.querySelectorAll("button")[0].disabled, true);
  await controls.accounts.querySelectorAll("button")[0].trigger();
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].action, "saveAccount");
  finishAdd({ accountEmails: ["test@yahoo.com", "two@yahoo.com"] });
  await adding;
  assert.equal(controls.accounts.querySelectorAll("button")[0].disabled, false);
});

test("connects an account without retaining the form password", async () => {
  const { controls, state } = await createPopupHarness({ account: null });
  assert.equal(controls.accountSetup.hidden, false);
  controls.email.value = "test@yahoo.com";
  controls.password.value = "app-password";
  await controls.accountForm.trigger("submit");
  await waitForAsyncCallbacks();
  assert.equal(controls.password.value, "");
  assert.deepEqual(state.requests[0], {
    action: "saveAccount",
    email: "test@yahoo.com",
    password: "app-password",
  });
  assert.equal(
    controls.accounts.children[0].children[0].textContent,
    "test@yahoo.com",
  );
  assert.equal(controls.connectedAccountsPanel.hidden, false);
});

test("shows the connected account and inbox label while account setup opens", async () => {
  const { controls } = await createPopupHarness({
    codes: [{ ...verificationCodeMessage, accountEmail: "test@yahoo.com" }],
  });
  assert.equal(controls.accounts.children.length, 1);
  assert.equal(
    controls.results.children[0].children[1].textContent,
    "test@yahoo.com",
  );
  controls.showAccountSetup.trigger();
  assert.equal(controls.accountSetup.hidden, false);
  assert.equal(controls.connectedAccountsPanel.hidden, false);
});

test("account operations and result selection disable all conflicting controls", async () => {
  for (const operation of ["save", "remove", "select"]) {
    const { controls, state } = await createPopupHarness();
    controls.showAccountSetup.trigger();
    let rejectOperation;
    const pending = new Promise((_resolve, reject) => {
      rejectOperation = reject;
    });
    state.sendOneOff = () => pending;
    const resultButton = controls.results.querySelectorAll("button")[0];
    const removeButton = controls.accounts.querySelectorAll("button")[0];
    if (operation === "select") state.fillWait = pending;
    const action = operation === "save"
      ? controls.accountForm.trigger("submit")
      : operation === "remove"
        ? removeButton.trigger()
        : resultButton.trigger();
    await waitForAsyncCallbacks();
    const buttons = [
      controls.saveAccountSubmit,
      controls.showAccountSetup,
      controls.checkCodes,
      controls.checkConfirmationLinks,
      controls.checkPasswordResetLinks,
      removeButton,
      resultButton,
    ];
    assert.ok(buttons.every((button) => button.disabled));
    rejectOperation(new Error("Operation failed"));
    await action;
    assert.ok(buttons.every((button) => !button.disabled));
  }
});

test("a failed account save retains the disabled state of codes without a target page", async () => {
  const { controls, state } = await createPopupHarness({ tabUrl: "chrome://extensions" });
  state.sendOneOff = async () => { throw new Error("App password rejected"); };
  await controls.accountForm.trigger("submit");
  assert.equal(controls.results.querySelectorAll("button")[0].disabled, true);
  assert.equal(controls.saveAccountSubmit.disabled, false);
});
