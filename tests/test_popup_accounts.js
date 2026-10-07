import assert from "node:assert/strict";
import test from "node:test";
import { createPopupHarness, settle, code } from "./popup_harness.js";

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
  state.fetchCodes = async () => { checks++; return []; };
  await controls.accounts.querySelectorAll("button")[0].trigger();
  await settle();
  assert.equal(checks, 1);
  assert.equal(controls.accounts.children[0].children[0].textContent, "other@yahoo.com");
  assert.equal(timers.length, 1);
});

test("does not remove an account while another account is being added", async () => {
  const { controls, state } = await createPopupHarness();
  let finishAdd;
  state.sendOneOff = () => new Promise((resolve) => { finishAdd = resolve; });
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
  await settle();
  assert.equal(controls.password.value, "");
  assert.deepEqual(state.requests[0], {
    action: "saveAccount",
    email: "test@yahoo.com",
    password: "app-password",
  });
  assert.equal(controls.accounts.children[0].children[0].textContent, "test@yahoo.com");
  assert.equal(controls.connectedAccountsPanel.hidden, false);
});

test("shows multiple accounts and labels codes with their inbox", async () => {
  const { controls } = await createPopupHarness({
    codes: [{ ...code, accountEmail: "test@yahoo.com" }],
  });
  assert.equal(controls.accounts.children.length, 1);
  assert.equal(controls.results.children[0].children[1].textContent, "test@yahoo.com");
  controls.showAccountSetup.trigger();
  assert.equal(controls.accountSetup.hidden, false);
  assert.equal(controls.connectedAccountsPanel.hidden, false);
});
