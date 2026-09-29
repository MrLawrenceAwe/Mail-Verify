import assert from "node:assert/strict";
import test from "node:test";
import { createPopupController } from "../extension/popup-controller.js";

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

async function setup({ codes = [code], account = "test@yahoo.com", remainingAccountEmails = [] } = {}) {
  const controls = Object.fromEntries(
    [
      "checkCodes",
      "checkLinks",
      "accounts",
      "addAccount",
      "results",
      "status",
      "accountSetup",
      "companionSetup",
      "connectedAccountPanel",
      "addAccountForm",
      "addAccountSubmit",
      "password",
      "email",
      "extensionId",
      "destination",
      "codeContext",
    ].map((id) => [id, new FakeElement()]),
  );
  const scheduled = new Map();
  const state = {
    now: 1000,
    closes: 0,
    fetchCodes: async () => codes,
    fetchLinks: async () => [],
    opened: [],
    failFill: false,
    failRemove: false,
    scriptArgs: null,
    requests: [],
    sendOneOff: null,
  };
  const tab = { id: 1, url: "https://example.com/login" };
  let nextTimer = 0;
  const client = {
    closeSession() {
      state.closes++;
    },
    async sendSessionRequest(action) {
      return action === "status"
        ? { accountEmails: account ? [account] : [] }
        : action === "links" ? { links: await state.fetchLinks() } : { codes: await state.fetchCodes() };
    },
    async sendOneOffRequest(request) {
      state.requests.push(request);
      if (state.sendOneOff) return state.sendOneOff(request);
      if (state.failRemove) throw Error("Keychain unavailable");
      return { accountEmails: request.action === "removeAccount" ? remainingAccountEmails : [request.email] };
    },
  };
  const popup = createPopupController({
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
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => scheduled.delete(id),
  });
  await popup.initialize();
  await settle();
  return { controls, scheduled, state };
}

test("polls whether codes are present or absent", async () => {
  for (const codes of [[code], []]) {
    const { scheduled } = await setup({ codes });
    assert.equal(
      scheduled.size,
      1,
      "keep checking with or without an existing code",
    );
  }
});

test("stops polling after the deadline", async () => {
  const { controls, scheduled, state } = await setup();
  state.now += 120001;
  await [...scheduled.values()][0].callback();
  assert.equal(scheduled.size, 0, "stop after the polling deadline");
  assert.equal(controls.status.textContent, "Automatic checking finished. Check again for newer codes.");
});

test("does not start a scheduled check after the deadline", async () => {
  const { scheduled, state } = await setup();
  let requests = 0;
  state.fetchCodes = async () => {
    requests++;
    return [];
  };
  state.now += 120001;
  await [...scheduled.values()][0].callback();
  assert.equal(requests, 0);
  assert.ok(state.closes >= 1);
});

test("retries temporary mail errors", async () => {
  const { controls, scheduled, state } = await setup();
  state.fetchCodes = async () => {
    throw Error("Temporary mail error");
  };
  controls.checkCodes.trigger();
  await settle();
  assert.equal(scheduled.size, 1, "retry after temporary errors");
  assert.equal(controls.status.textContent, "Temporary mail error");
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("a failed link check clears earlier confirmation links", async () => {
  const { controls, state } = await setup();
  state.fetchLinks = async () => [link];
  controls.checkLinks.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button").length, 1);
  state.fetchLinks = async () => { throw Error("Temporary mail error"); };
  controls.checkLinks.trigger();
  await settle();
  assert.equal(controls.results.querySelectorAll("button").length, 0);
});

test("ignores stale checks during a fill", async () => {
  for (const failFill of [false, true]) {
    const { controls, scheduled, state } = await setup();
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
    assert.equal(scheduled.size, failFill ? 1 : 0);
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
    const { controls, scheduled, state } = await setup();
    state.fetchCodes = async () => {
      state.now += duration;
      return [];
    };
    controls.checkCodes.trigger();
    await settle();
    assert.equal([...scheduled.values()][0].delay, expected);
  }
});

test("removes an account and recovers from errors", async () => {
  for (const failRemove of [false, true]) {
    const { controls, scheduled, state } = await setup();
    state.failRemove = failRemove;
    await controls.accounts.querySelectorAll("button")[0].trigger();
    assert.equal(state.requests[0].action, "removeAccount");
    assert.equal(state.requests[0].email, "test@yahoo.com");
    assert.equal(scheduled.size, failRemove ? 1 : 0);
    assert.equal(controls.connectedAccountPanel.hidden, !failRemove);
    assert.equal(controls.checkCodes.disabled, false);
  }
});

test("checks remaining accounts immediately after removal", async () => {
  const { controls, scheduled, state } = await setup({
    remainingAccountEmails: ["other@yahoo.com"],
  });
  let checks = 0;
  state.fetchCodes = async () => { checks++; return []; };
  await controls.accounts.querySelectorAll("button")[0].trigger();
  await settle();
  assert.equal(checks, 1);
  assert.equal(controls.accounts.children[0].children[0].textContent, "other@yahoo.com");
  assert.equal(scheduled.size, 1);
});

test("does not remove an account while another account is being added", async () => {
  const { controls, state } = await setup();
  let finishAdd;
  state.sendOneOff = () => new Promise((resolve) => { finishAdd = resolve; });
  controls.addAccount.trigger();
  controls.email.value = "two@yahoo.com";
  controls.password.value = "new-password";
  const adding = controls.addAccountForm.trigger("submit");
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
  await controls.addAccountForm.trigger("submit");
  await settle();
  assert.equal(controls.password.value, "");
  assert.deepEqual(state.requests[0], {
    action: "saveAccount",
    email: "test@yahoo.com",
    password: "app-password",
  });
  assert.equal(controls.accounts.children[0].children[0].textContent, "test@yahoo.com");
  assert.equal(controls.connectedAccountPanel.hidden, false);
});

test("shows multiple accounts and labels codes with their inbox", async () => {
  const { controls } = await setup({
    codes: [{ ...code, accountEmail: "test@yahoo.com" }],
  });
  assert.equal(controls.accounts.children.length, 1);
  assert.equal(controls.results.children[0].children[1].textContent, "test@yahoo.com");
  controls.addAccount.trigger();
  assert.equal(controls.accountSetup.hidden, false);
  assert.equal(controls.connectedAccountPanel.hidden, false);
});

const link = { ...code, url: "https://example.com/confirm?token=secret" };
test("finds links only on request and opens only the selected link", async () => {
  const { controls, state, scheduled } = await setup();
  state.fetchLinks = async () => [link];
  assert.deepEqual(state.opened, []);
  controls.checkLinks.trigger();
  await settle();
  assert.equal(controls.codeContext.hidden, true);
  assert.deepEqual(state.opened, []);
  const button = controls.results.querySelectorAll("button")[0];
  assert.equal(button.textContent, "Open confirmation link ↗");
  await button.trigger();
  assert.deepEqual(state.opened, [{ url: link.url }]);
  assert.equal(scheduled.size, 0);
});

test("rejects expired and unsafe links at click time", async () => {
  for (const item of [{ ...link, receivedAt: -700000 }, { ...link, url: "http://example.com/confirm" }]) {
    const { controls, state } = await setup();
    state.fetchLinks = async () => [item];
    controls.checkLinks.trigger();
    await settle();
    await controls.results.querySelectorAll("button")[0].trigger();
    assert.deepEqual(state.opened, []);
    assert.match(controls.status.textContent, /too old|not supported/);
  }
});

test("switching modes ignores a pending code response", async () => {
  const { controls, state } = await setup();
  let resolve;
  state.fetchCodes = () => new Promise((done) => { resolve = done; });
  controls.checkCodes.trigger();
  state.fetchLinks = async () => [link];
  controls.checkLinks.trigger();
  await settle();
  resolve([code]);
  await settle();
  assert.equal(controls.results.querySelectorAll("button")[0].textContent, "Open confirmation link ↗");
  state.fetchCodes = async () => [code];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.codeContext.hidden, false);
  assert.match(controls.results.querySelectorAll("button")[0].textContent, /Fill on/);
});
