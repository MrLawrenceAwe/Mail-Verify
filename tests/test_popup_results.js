import assert from "node:assert/strict";
import test from "node:test";
import { createPopupHarness, settle, code, link } from "./popup_harness.js";

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
    finishCheck([{ ...code, code: "654321" }]);
    await settle();
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
    if (!failFill) assert.deepEqual(state.scriptArgs.args, [{ action: "fill", code: code.code }]);
  }
});

test("keeps unchanged code cards and updates changed ones", async () => {
  const { controls, state } = await createPopupHarness();
  const initial = controls.results.replacements;
  state.fetchCodes = async () => [{ ...code }];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(
    controls.results.replacements,
    initial,
    "unchanged cards retain focus",
  );
  state.fetchCodes = async () => [{ ...code, code: "654321" }];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.results.replacements, initial + 1);
});

test("checking again after a fill makes unchanged codes selectable", async () => {
  const second = { ...code, code: "654321", sender: "other@example.com" };
  const { controls, state } = await createPopupHarness({ codes: [code, second] });
  const buttons = controls.results.querySelectorAll("button");
  await buttons[0].trigger();
  assert.ok(buttons.every(button => button.disabled));

  controls.checkCodes.trigger();
  await settle();
  assert.deepEqual(controls.results.querySelectorAll("button"), buttons);
  assert.ok(buttons.every(button => !button.disabled));
  await buttons[1].trigger();
  assert.equal(state.scriptArgs.args[0].code, second.code);
});

test("checking again without an HTTPS target keeps code buttons disabled", async () => {
  const { controls, state } = await createPopupHarness({ tabUrl: "chrome://extensions/" });
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.disabled, true);
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button")[0], button);
  assert.equal(button.disabled, true);
  assert.equal(state.scriptArgs, null);
});

test("finds links only on request and opens only the selected link", async () => {
  const { controls, state, timers } = await createPopupHarness();
  state.fetchConfirmationLinks = async () => [link];
  assert.deepEqual(state.opened, []);
  controls.checkConfirmationLinks.trigger();
  await settle();
  assert.equal(controls.codeContext.hidden, true);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(controls.results.children[0].children.slice(0, 4).map(line => line.textContent),
    [`Inbox: ${link.accountEmail}`, `From: ${link.sender}`, link.subject, "Initial destination: example.com"]);
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Open confirmation link ↗");
  await button.trigger();
  assert.deepEqual(state.opened, [{ url: link.url }]);
  assert.equal(timers.length, 0);
});

test("rejects codes with future or invalid arrival times before filling", async () => {
  for (const receivedAt of [1001, NaN, Infinity]) {
    const { controls, state } = await createPopupHarness({ codes: [{ ...code, receivedAt }] });
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.equal(state.scriptArgs, null);
    assert.match(controls.status.textContent, /too old/);
  }
});

test("rejects expired and unsafe links at click time", async () => {
  for (const item of [{ ...link, receivedAt: -700000 }, { ...link, url: "http://example.com/confirm" }]) {
    const { controls, state } = await createPopupHarness();
    state.fetchConfirmationLinks = async () => [item];
    controls.checkConfirmationLinks.trigger();
    await settle();
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.deepEqual(state.opened, []);
    assert.match(controls.status.textContent, /too old|not supported/);
  }
});

test("switching mail types ignores a pending code response", async () => {
  const { controls, state } = await createPopupHarness();
  let resolve;
  state.fetchCodes = () => new Promise((done) => { resolve = done; });
  controls.checkCodes.trigger();
  state.fetchConfirmationLinks = async () => [link];
  controls.checkConfirmationLinks.trigger();
  await settle();
  resolve([code]);
  await settle();
  assert.equal(controls.results.querySelectorAll("button")[0].textContent, "Open confirmation link ↗");
  state.fetchCodes = async () => [code];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.codeContext.hidden, false);
  assert.equal(controls.results.querySelectorAll("button")[0].textContent, "Fill code");
});

test("password reset links are copied only on click without opening a tab", async () => {
  const { controls, state, timers } = await createPopupHarness();
  state.fetchPasswordResetLinks = async () => [link];
  controls.checkPasswordResetLinks.trigger();
  await settle();
  assert.deepEqual(state.copied, []);
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Copy password reset link");
  await button.trigger();
  assert.deepEqual(state.copied, [link.url]);
  assert.deepEqual(state.opened, []);
  assert.equal(button.textContent, "Copy again");
  assert.match(controls.status.textContent, /copied to clipboard/);
  assert.equal(timers.length, 0);
});

test("reset copy rejects expired links and reports clipboard failures", async () => {
  for (const scenario of ["expired", "unsafe", "denied"]) {
    const { controls, state } = await createPopupHarness();
    state.fetchPasswordResetLinks = async () => [{ ...link,
      receivedAt: scenario === "expired" ? -700000 : link.receivedAt,
      url: scenario === "unsafe" ? "http://example.com/reset" : link.url }];
    state.failCopy = scenario === "denied";
    controls.checkPasswordResetLinks.trigger();
    await settle();
    const button = controls.results.querySelectorAll("button")[0];
    await button.trigger();
    assert.deepEqual(state.copied, []);
    assert.deepEqual(state.opened, []);
    assert.equal(button.disabled, false);
    assert.match(controls.status.textContent, /too old|not supported|Clipboard denied/);
  }
});

test("reset links can be recopied and another account selected after an unchanged check", async () => {
  const { controls, state } = await createPopupHarness();
  const second = { ...link, accountEmail: "second@yahoo.com", url: "https://example.com/reset?token=second" };
  state.fetchPasswordResetLinks = async () => [link, second];
  controls.checkPasswordResetLinks.trigger();
  await settle();
  const buttons = controls.results.querySelectorAll("button");
  await buttons[0].trigger();
  assert.ok(buttons.every(button => !button.disabled));
  await buttons[0].trigger();
  controls.checkPasswordResetLinks.trigger();
  await settle();
  assert.deepEqual(controls.results.querySelectorAll("button"), buttons);
  assert.ok(buttons.every(button => !button.disabled));
  await buttons[1].trigger();
  assert.deepEqual(state.copied, [link.url, link.url, second.url]);
  assert.deepEqual(state.opened, []);
});

test("reset copy locks results only while the clipboard write is pending", async () => {
  const { controls, state } = await createPopupHarness();
  let finishCopy;
  state.copyWait = new Promise(resolve => { finishCopy = resolve; });
  state.fetchPasswordResetLinks = async () => [link];
  controls.checkPasswordResetLinks.trigger();
  await settle();
  const button = controls.results.querySelectorAll("button")[0];
  const pending = button.trigger();
  await settle();
  assert.equal(button.disabled, true);
  assert.equal(controls.checkPasswordResetLinks.disabled, true);
  finishCopy();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(controls.checkPasswordResetLinks.disabled, false);
});

test("popup guidance follows the selected action and clears when returning to codes", async () => {
  const { controls } = await createPopupHarness();
  assert.equal(controls.linkGuidance.hidden, true);
  controls.checkConfirmationLinks.trigger();
  await settle();
  assert.equal(controls.linkGuidance.hidden, false);
  assert.match(controls.linkGuidance.textContent, /Opening a link in a new tab/);
  controls.checkPasswordResetLinks.trigger();
  await settle();
  assert.match(controls.linkGuidance.textContent, /sender and initial destination before copying/);
  assert.doesNotMatch(controls.linkGuidance.textContent, /open|confirm/i);
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.linkGuidance.hidden, true);
  assert.equal(controls.linkGuidance.textContent, "");
});

test("unavailable popup clipboard gives recovery guidance and keeps links selectable", async () => {
  const { controls, state } = await createPopupHarness({ clipboardAvailable: false });
  state.fetchPasswordResetLinks = async () => [link];
  controls.checkPasswordResetLinks.trigger();
  await settle();
  const button = controls.results.querySelectorAll("button")[0];
  await button.trigger();
  assert.deepEqual(state.copied, []);
  assert.deepEqual(state.opened, []);
  assert.equal(button.disabled, false);
  assert.match(controls.status.textContent, /Clipboard unavailable.*Close and reopen this popup/);
  assert.doesNotMatch(controls.status.textContent, /Try copying again from the popup/);
});


test("popup link results identify inbox and missing sender without empty subject rows", async () => {
  for (const [control, fetchResults] of [
    ["checkConfirmationLinks", "fetchConfirmationLinks"],
    ["checkPasswordResetLinks", "fetchPasswordResetLinks"],
  ]) {
    const { controls, state } = await createPopupHarness();
    state[fetchResults] = async () => [{ ...link, sender: "", subject: "" }];
    controls[control].trigger();
    await settle();
    const card = controls.results.children[0];
    assert.deepEqual(card.children.slice(0, -1).map(line => line.textContent), [
      `Inbox: ${link.accountEmail}`, "From: Unknown sender", "Initial destination: example.com",
    ]);
  }
});
