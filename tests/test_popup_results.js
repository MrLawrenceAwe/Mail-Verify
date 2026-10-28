import {
  makeVerificationCodeMessage,
  makeEmailLinkMessage,
} from "./support/mail_results.js";
import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import { formatReceivedAt } from "../extension/shared/mail-presentation.js";
import { createPopupHarness } from "./support/popup_harness.js";

const verificationCodeMessage = makeVerificationCodeMessage();
const emailLinkMessage = makeEmailLinkMessage();

test("popup codes normalize sender labels and identify the target page", async () => {
  for (const [sender, expected] of [
    [undefined, "Unknown sender"],
    ["", "Unknown sender"],
    ["  ", "Unknown sender"],
    [" auth@example.test ", "auth@example.test"],
  ]) {
    const { controls } = await createPopupHarness({
      codes: [{ ...verificationCodeMessage, sender }],
    });
    assert.equal(
      controls.results.children[0].children[2].textContent,
      expected,
    );
    assert.equal(controls.targetPage.textContent, "example.com");
    assert.equal(
      controls.results.children[0].children[4].textContent,
      formatReceivedAt(verificationCodeMessage.receivedAt),
    );
  }
});

test("ignores stale checks during a fill", async () => {
  for (const failFill of [false, true]) {
    const { controls, timers, state } = await createPopupHarness();
    let finishCheck;
    state.fetchCodes = () =>
      new Promise((resolve) => {
        finishCheck = resolve;
      });
    state.failFill = failFill;
    const replacements = controls.results.replacements;
    controls.checkCodes.trigger();
    const button = controls.results.querySelectorAll("button")[0];
    await button.trigger();
    finishCheck([{ ...verificationCodeMessage, code: "654321" }]);
    await waitForAsyncCallbacks();
    assert.equal(
      controls.results.replacements,
      replacements,
      "stale checks must not replace cards",
    );
    assert.equal(
      controls.status.textContent,
      failFill
        ? "Tab unavailable"
        : "Code filled. The website may continue automatically.",
    );
    assert.equal(timers.length, failFill ? 1 : 0);
    assert.equal(button.disabled, !failFill);
    if (!failFill)
      assert.deepEqual(state.scriptArgs.args, [
        { action: "fill", code: verificationCodeMessage.code },
      ]);
  }
});

test("keeps unchanged code cards and updates changed ones", async () => {
  const { controls, state } = await createPopupHarness();
  const initial = controls.results.replacements;
  state.fetchCodes = async () => [{ ...verificationCodeMessage }];
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(
    controls.results.replacements,
    initial,
    "unchanged cards retain focus",
  );
  state.fetchCodes = async () => [
    { ...verificationCodeMessage, code: "654321" },
  ];
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.results.replacements, initial + 1);
});

test("checking again after a fill makes unchanged codes selectable", async () => {
  const second = {
    ...verificationCodeMessage,
    code: "654321",
    sender: "other@example.com",
  };
  const { controls, state } = await createPopupHarness({
    codes: [verificationCodeMessage, second],
  });
  const buttons = controls.results.querySelectorAll("button");
  await buttons[0].trigger();
  assert.ok(buttons.every((button) => button.disabled));
  assert.equal(buttons[0].textContent, "Filled");

  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.deepEqual(controls.results.querySelectorAll("button"), buttons);
  assert.ok(buttons.every((button) => !button.disabled));
  assert.ok(buttons.every((button) => button.textContent === "Fill code"));
  await buttons[1].trigger();
  assert.equal(state.scriptArgs.args[0].code, second.code);
});

test("checking again without an HTTPS target keeps code buttons disabled", async () => {
  const { controls, state } = await createPopupHarness({
    tabUrl: "chrome://extensions/",
  });
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.disabled, true);
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.results.querySelectorAll("button")[0], button);
  assert.equal(button.disabled, true);
  assert.equal(state.scriptArgs, null);
});

test("finds links only on request and opens only the selected link", async () => {
  const { controls, state, timers } = await createPopupHarness();
  state.fetchConfirmationLinks = async () => [emailLinkMessage];
  assert.deepEqual(state.opened, []);
  controls.checkConfirmationLinks.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.codeContext.hidden, true);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(
    controls.results.children[0].children
      .slice(0, -1)
      .map((line) => line.textContent),
    [
      `Inbox: ${emailLinkMessage.accountEmail}`,
      `From: ${emailLinkMessage.sender}`,
      emailLinkMessage.subject,
      "Link domain: example.com",
      formatReceivedAt(emailLinkMessage.receivedAt),
    ],
  );
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Open confirmation link ↗");
  await button.trigger();
  assert.deepEqual(state.opened, [{ url: emailLinkMessage.url }]);
  assert.equal(timers.length, 0);
});

test("checking again restores unchanged link action labels", async () => {
  for (const [checkControl, fetchResults, actionLabel] of [
    ["checkConfirmationLinks", "fetchConfirmationLinks", "Open confirmation link ↗"],
    ["checkPasswordResetLinks", "fetchPasswordResetLinks", "Open reset link ↗"],
  ]) {
    const { controls, state } = await createPopupHarness();
    state[fetchResults] = async () => [emailLinkMessage];
    controls[checkControl].trigger();
    await waitForAsyncCallbacks();
    const button = controls.results.querySelectorAll("button")[0];
    await button.trigger();
    assert.equal(button.textContent, "Opened");
    assert.equal(button.disabled, true);

    controls[checkControl].trigger();
    await waitForAsyncCallbacks();
    assert.equal(controls.results.querySelectorAll("button")[0], button);
    assert.equal(button.textContent, actionLabel);
    assert.equal(button.disabled, false);
  }
});

test("rejects codes with future or invalid arrival times before filling", async () => {
  for (const receivedAt of [1001, NaN, Infinity]) {
    const { controls, state } = await createPopupHarness({
      codes: [{ ...verificationCodeMessage, receivedAt }],
    });
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.equal(state.scriptArgs, null);
    assert.match(controls.status.textContent, /no longer current/);
  }
});

test("rejects expired and unsafe links at click time", async () => {
  for (const scenario of ["expired", "unsafe"]) {
    const item = { ...emailLinkMessage };
    const { controls, state } = await createPopupHarness();
    state.fetchConfirmationLinks = async () => [item];
    controls.checkConfirmationLinks.trigger();
    await waitForAsyncCallbacks();
    if (scenario === "expired") item.receivedAt = -700000;
    else item.url = "http://example.com/confirm";
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.deepEqual(state.opened, []);
    assert.match(controls.status.textContent, /no longer current|not supported/);
  }
});

test("switching mail types ignores a pending code response", async () => {
  const { controls, state } = await createPopupHarness();
  let resolve;
  state.fetchCodes = () =>
    new Promise((done) => {
      resolve = done;
    });
  controls.checkCodes.trigger();
  state.fetchConfirmationLinks = async () => [emailLinkMessage];
  controls.checkConfirmationLinks.trigger();
  await waitForAsyncCallbacks();
  resolve([verificationCodeMessage]);
  await waitForAsyncCallbacks();
  assert.equal(
    controls.results.querySelectorAll("button")[0].textContent,
    "Open confirmation link ↗",
  );
  state.fetchCodes = async () => [verificationCodeMessage];
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.codeContext.hidden, false);
  assert.equal(
    controls.results.querySelectorAll("button")[0].textContent,
    "Fill code",
  );
});

test("reset links open only on click and stop polling after selection", async () => {
  const { controls, state, timers } = await createPopupHarness();
  state.fetchPasswordResetLinks = async () => [emailLinkMessage];
  controls.checkPasswordResetLinks.trigger();
  await waitForAsyncCallbacks();
  assert.deepEqual(state.opened, []);
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Open reset link ↗");
  await button.trigger();
  assert.deepEqual(state.opened, [{ url: emailLinkMessage.url }]);
  assert.equal(button.textContent, "Opened");
  assert.equal(button.disabled, true);
  assert.match(controls.status.textContent, /opened in a new tab/);
  assert.equal(timers.length, 0);
});

test("reset opening rejects expired or unsafe links and recovers from tab errors", async () => {
  for (const scenario of ["expired", "unsafe", "failed"]) {
    const { controls, state } = await createPopupHarness();
    const item = { ...emailLinkMessage };
    state.fetchPasswordResetLinks = async () => [item];
    state.failOpen = scenario === "failed";
    controls.checkPasswordResetLinks.trigger();
    await waitForAsyncCallbacks();
    const button = controls.results.querySelectorAll("button")[0];
    if (scenario === "expired") item.receivedAt = -700000;
    else if (scenario === "unsafe") item.url = "http://example.com/reset";
    await button.trigger();
    assert.deepEqual(state.opened, []);
    assert.equal(button.disabled, false);
    assert.match(controls.status.textContent, /no longer current|not supported|Tab unavailable/);
    if (state.failOpen) {
      state.failOpen = false;
      await button.trigger();
      assert.deepEqual(state.opened, [{url: emailLinkMessage.url}]);
    }
  }
});

test("reset opening prevents duplicate selections while tab creation is pending", async () => {
  const { controls, state } = await createPopupHarness();
  let finishOpen;
  state.openWait = new Promise((resolve) => { finishOpen = resolve; });
  state.fetchPasswordResetLinks = async () => [emailLinkMessage];
  controls.checkPasswordResetLinks.trigger();
  await waitForAsyncCallbacks();
  const button = controls.results.querySelectorAll("button")[0];
  const pending = button.trigger();
  await waitForAsyncCallbacks();
  assert.equal(button.disabled, true);
  assert.equal(controls.checkPasswordResetLinks.disabled, true);
  await button.trigger();
  finishOpen();
  await pending;
  assert.deepEqual(state.opened, [{url: emailLinkMessage.url}]);
  assert.equal(controls.checkPasswordResetLinks.disabled, false);
});

test("popup guidance follows the selected action and clears when returning to codes", async () => {
  const { controls } = await createPopupHarness();
  assert.equal(controls.linkGuidance.hidden, true);
  controls.checkConfirmationLinks.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.linkGuidance.hidden, false);
  assert.match(
    controls.linkGuidance.textContent,
    /Opening a link in a new tab/,
  );
  controls.checkPasswordResetLinks.trigger();
  await waitForAsyncCallbacks();
  assert.match(
    controls.linkGuidance.textContent,
    /reset link opens in a new tab/,
  );
  controls.checkCodes.trigger();
  await waitForAsyncCallbacks();
  assert.equal(controls.linkGuidance.hidden, true);
  assert.equal(controls.linkGuidance.textContent, "");
});

test("popup link results identify inbox and missing sender without empty subject rows", async () => {
  for (const [control, fetchResults] of [
    ["checkConfirmationLinks", "fetchConfirmationLinks"],
    ["checkPasswordResetLinks", "fetchPasswordResetLinks"],
  ]) {
    const { controls, state } = await createPopupHarness();
    state[fetchResults] = async () => [
      { ...emailLinkMessage, sender: "", subject: "" },
    ];
    controls[control].trigger();
    await waitForAsyncCallbacks();
    const card = controls.results.children[0];
    assert.deepEqual(
      card.children.slice(0, -1).map((line) => line.textContent),
      [
        `Inbox: ${emailLinkMessage.accountEmail}`,
        "From: Unknown sender",
        "Link domain: example.com",
        formatReceivedAt(emailLinkMessage.receivedAt),
      ],
    );
  }
});

test("unsupported link results cannot prevent valid popup results from rendering", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const valid of [false, true]) {
      const { controls, state } = await createPopupHarness();
      const items = [
        { ...emailLinkMessage, url: "https://exa^mple.com/confirm" },
        { ...emailLinkMessage, url: "http://example.com/confirm" },
        ...(valid ? [emailLinkMessage] : []),
      ];
      const checkButton = mailType === "confirmationLinks"
        ? controls.checkConfirmationLinks
        : controls.checkPasswordResetLinks;
      if (mailType === "confirmationLinks")
        state.fetchConfirmationLinks = async () => items;
      else state.fetchPasswordResetLinks = async () => items;
      checkButton.trigger();
      await waitForAsyncCallbacks();
      const buttons = controls.results.querySelectorAll("button");
      assert.equal(buttons.length, valid ? 1 : 0);
      assert.doesNotMatch(controls.status.textContent, /Invalid URL/);
      if (valid) {
        await buttons[0].trigger();
        assert.deepEqual(state.opened, [{ url: emailLinkMessage.url }]);
      } else {
        assert.match(controls.status.textContent, /No recent/);
      }
    }
  }
});
