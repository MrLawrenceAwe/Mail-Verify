import { createTimerQueue } from "./timer_queue.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createPopupController } from "../extension/popup/popup-controller.js";

class FakeElement {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.hidden = true;
    this.value = "";
    this.textContent = "";
    this.replacements = 0;
    this.classList = { toggle() {} };
  }
  append(...children) {
    this.children.push(...children);
  }
  setAttribute() {}
  focus() {}
  replaceChildren() {
    this.children = [];
    this.replacements++;
  }
  addEventListener(event, listener) {
    this.listeners[event] = listener;
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  trigger(event = "click") {
    return this.listeners[event]({ preventDefault() {} });
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const code = {
  code: "123456",
  accountEmail: "test@yahoo.com",
  sender: "sender@example.com",
  subject: "Sign in",
  receivedAt: 1000,
};

async function setup({ codes = [code], account = "test@yahoo.com", remainingAccountEmails = [], tabUrl = "https://example.com/login", clipboardAvailable = true } = {}) {
  const controls = Object.fromEntries(
    [
      "checkCodes",
      "checkConfirmationLinks",
      "checkPasswordResetLinks",
      "accounts",
      "showAccountSetup",
      "results",
      "status",
      "accountSetup",
      "companionSetup",
      "connectedAccountsPanel",
      "accountForm",
      "saveAccountSubmit",
      "password",
      "email",
      "destination",
      "codeContext",
      "codePageHelp",
      "linkGuidance",
    ].map((id) => [id, new FakeElement()]),
  );
  const timers = createTimerQueue();
  const state = {
    now: 1000,
    closes: 0,
    fetchCodes: async () => codes,
    fetchConfirmationLinks: async () => [],
    fetchPasswordResetLinks: async () => [],
    copied: [],
    failCopy: false,
    opened: [],
    failFill: false,
    failRemove: false,
    scriptArgs: null,
    requests: [],
    sessionRequests: [],
    scanPending: false,
    warnings: [],
    sendOneOff: null,
  };
  const tab = { id: 1, url: tabUrl };
  const client = {
    closeSession() {
      state.closes++;
    },
    async sendSessionRequest(action, collectOnly = false) {
      state.sessionRequests.push({ action, collectOnly });
      return action === "status"
        ? { accountEmails: account ? [account] : [] }
        : action === "passwordResetLinks" ? { passwordResetLinks: await state.fetchPasswordResetLinks(), scanPending: state.scanPending, warnings: state.warnings }
        : action === "confirmationLinks" ? { confirmationLinks: await state.fetchConfirmationLinks(), scanPending: state.scanPending, warnings: state.warnings }
        : { codes: await state.fetchCodes(), scanPending: state.scanPending, warnings: state.warnings };
    },
    async sendOneOffRequest(request) {
      state.requests.push(request);
      if (state.sendOneOff) return state.sendOneOff(request);
      if (state.failRemove) throw Error("Keychain unavailable");
      return { accountEmails: request.action === "removeAccount" ? remainingAccountEmails : [request.email] };
    },
  };
  const popup = createPopupController({
    clipboard: clipboardAvailable ? { async writeText(value) { if (state.failCopy) throw Error("Clipboard denied"); if (state.copyWait) await state.copyWait; state.copied.push(value); } } : null,
    document: {
      getElementById: (id) => controls[id],
      createElement: (tag) => new FakeElement(tag),
    },
    chrome: {
      runtime: { id: "test-extension" },
      tabs: {
        query: async () => [tab],
        create: async (options) => { state.opened.push(options); },
        get: async () => {
          if (state.failFill) throw Error("Tab unavailable");
          return tab;
        },
      },
      scripting: { executeScript: async (args) => {
        state.scriptArgs = args;
        return [{ result: { ok: true } }];
      } },
    },
    client,
    clock: { now: () => state.now },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await popup.initialize();
  await settle();
  return { controls, timers, state };
}

test("polls whether codes are present or absent", async () => {
  for (const codes of [[code], []]) {
    const { timers } = await setup({ codes });
    assert.equal(
      timers.length,
      1,
      "keep checking with or without an existing code",
    );
  }
});

test("popup collects pending results quickly without reporting an empty completed scan", async () => {
  const { state, timers, controls } = await setup({ codes: [] });
  state.scanPending = true;
  await timers.runWithDelay(8000);
  assert.match(controls.status.textContent, /Checking/);
  state.scanPending = false;
  state.fetchCodes = async () => [code];
  await timers.runWithDelay(1000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, true);
  assert.equal(controls.results.querySelectorAll("button").length, 1);
  await timers.runWithDelay(8000);
  assert.equal(state.sessionRequests.at(-1).collectOnly, false);
});

test("a manual popup retry starts a new scan instead of collecting a closed session", async () => {
  const { state, timers, controls } = await setup({ codes: [] });
  state.scanPending = true;
  await timers.runWithDelay(8000);
  controls.checkCodes.trigger(); await settle();
  assert.equal(state.sessionRequests.at(-1).collectOnly, false);
});

test("a slow account does not suppress normal popup scans for healthy accounts", async () => {
  const { state, timers } = await setup({ codes: [] });
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
  const { controls, timers, state } = await setup();
  state.now += 120001;
  await timers.takeOldest()();
  assert.equal(timers.length, 0, "stop after the polling deadline");
  assert.equal(controls.status.textContent, "Automatic checking finished. Check again for newer codes.");
});

test("does not start a scheduled check after the deadline", async () => {
  const { timers, state } = await setup();
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
  const { controls, timers, state } = await setup();
  state.fetchCodes = async () => {
    throw Error("Temporary mail error");
  };
  controls.checkCodes.trigger();
  await settle();
  assert.equal(timers.length, 1, "retry after temporary errors");
  assert.equal(controls.status.textContent, "Temporary mail error");
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("a failed link check clears earlier confirmation links", async () => {
  const { controls, state } = await setup();
  state.fetchConfirmationLinks = async () => [link];
  controls.checkConfirmationLinks.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button").length, 1);
  state.fetchConfirmationLinks = async () => { throw Error("Temporary mail error"); };
  controls.checkConfirmationLinks.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("ignores stale checks during a fill", async () => {
  for (const failFill of [false, true]) {
    const { controls, timers, state } = await setup();
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
  const { controls, state } = await setup();
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
  const { controls, state } = await setup({ codes: [code, second] });
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
  const { controls, state } = await setup({ tabUrl: "chrome://extensions/" });
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.disabled, true);
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button")[0], button);
  assert.equal(button.disabled, true);
  assert.equal(state.scriptArgs, null);
});

test("lets a manual retry supersede a pending check", async () => {
  const { controls, state } = await setup();
  const pending = [];
  state.fetchCodes = () => new Promise((resolve) => pending.push(resolve));
  const initial = controls.results.replacements;
  controls.checkCodes.trigger();
  controls.checkCodes.trigger();
  pending[0]([{ ...code, code: "111111" }]);
  pending[1]([{ ...code, code: "222222" }]);
  await settle();
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
    const { controls, timers, state } = await setup();
    state.fetchCodes = async () => {
      state.now += duration;
      return [];
    };
    controls.checkCodes.trigger();
    await settle();
    assert.equal([...timers.values()][0].delay, expected);
  }
});

test("removes an account and recovers from errors", async () => {
  for (const failRemove of [false, true]) {
    const { controls, timers, state } = await setup();
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
  const { controls, timers, state } = await setup({
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
  const { controls, state } = await setup();
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
  const { controls, state } = await setup({ account: null });
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
  const { controls } = await setup({
    codes: [{ ...code, accountEmail: "test@yahoo.com" }],
  });
  assert.equal(controls.accounts.children.length, 1);
  assert.equal(controls.results.children[0].children[1].textContent, "test@yahoo.com");
  controls.showAccountSetup.trigger();
  assert.equal(controls.accountSetup.hidden, false);
  assert.equal(controls.connectedAccountsPanel.hidden, false);
});

const link = { ...code, url: "https://example.com/confirm?token=secret" };
test("finds links only on request and opens only the selected link", async () => {
  const { controls, state, timers } = await setup();
  state.fetchConfirmationLinks = async () => [link];
  assert.deepEqual(state.opened, []);
  controls.checkConfirmationLinks.trigger();
  await settle();
  assert.equal(controls.codeContext.hidden, true);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(controls.results.children[0].children.slice(0, 4).map(line => line.textContent),
    [link.accountEmail, link.sender, link.subject, "Initial destination: example.com"]);
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Open confirmation link ↗");
  await button.trigger();
  assert.deepEqual(state.opened, [{ url: link.url }]);
  assert.equal(timers.length, 0);
});

test("rejects codes with future or invalid arrival times before filling", async () => {
  for (const receivedAt of [1001, NaN, Infinity]) {
    const { controls, state } = await setup({ codes: [{ ...code, receivedAt }] });
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.equal(state.scriptArgs, null);
    assert.match(controls.status.textContent, /too old/);
  }
});

test("rejects expired and unsafe links at click time", async () => {
  for (const item of [{ ...link, receivedAt: -700000 }, { ...link, url: "http://example.com/confirm" }]) {
    const { controls, state } = await setup();
    state.fetchConfirmationLinks = async () => [item];
    controls.checkConfirmationLinks.trigger();
    await settle();
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.deepEqual(state.opened, []);
    assert.match(controls.status.textContent, /too old|not supported/);
  }
});

test("switching mail types ignores a pending code response", async () => {
  const { controls, state } = await setup();
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
  const { controls, state, timers } = await setup();
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
    const { controls, state } = await setup();
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
  const { controls, state } = await setup();
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
  const { controls, state } = await setup();
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
  const { controls } = await setup();
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

test("finished link checks name the selected email purpose", async () => {
  for (const [control, label] of [
    ["checkConfirmationLinks", "confirmation links"],
    ["checkPasswordResetLinks", "password reset links"],
  ]) {
    const { controls, state, timers } = await setup();
    controls[control].trigger();
    await settle();
    state.now += 120001;
    await timers.takeOldest()();
    assert.equal(controls.status.textContent, `Automatic checking finished. Check again for newer ${label}.`);
  }
});


test("unavailable popup clipboard gives recovery guidance and keeps links selectable", async () => {
  const { controls, state } = await setup({ clipboardAvailable: false });
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

test("partial account failures keep popup results selectable and clear after recovery", async () => {
  for (const [control, fetchResults] of [
    ["checkCodes", "fetchCodes"],
    ["checkConfirmationLinks", "fetchConfirmationLinks"],
    ["checkPasswordResetLinks", "fetchPasswordResetLinks"],
  ]) {
    const { controls, state } = await setup();
    state[fetchResults] = async () => [{ ...code, url: "https://example.com/verify" }];
    state.warnings = ["other@yahoo.com: Yahoo took too long to respond."];
    controls[control].trigger();
    await settle();
    const button = controls.results.querySelectorAll("button")[0];
    assert.equal(button.disabled, false);
    assert.equal(controls.status.textContent, "Some accounts could not be checked: other@yahoo.com: Yahoo took too long to respond.");
    state.warnings = [];
    controls[control].trigger();
    await settle();
    assert.equal(controls.results.querySelectorAll("button")[0], button);
    assert.doesNotMatch(controls.status.textContent, /could not be checked/);
    await button.trigger();
    if (control === "checkCodes") assert.ok(state.scriptArgs);
    else if (control === "checkConfirmationLinks") assert.equal(state.opened.length, 1);
    else assert.deepEqual(state.copied, ["https://example.com/verify"]);
  }
});
