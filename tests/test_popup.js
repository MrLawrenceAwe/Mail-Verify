import assert from "node:assert/strict";
import test from "node:test";
import { createPopup } from "../extension/popup.js";

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

async function setup({ codes = [code], account = "test@yahoo.com" } = {}) {
  const controls = Object.fromEntries(
    [
      "checkCodes",
      "accounts",
      "addAccount",
      "codes",
      "status",
      "setup",
      "companionSetup",
      "codeResults",
      "connectForm",
      "connect",
      "password",
      "email",
      "extensionId",
      "destination",
    ].map((id) => [id, new FakeElement()]),
  );
  const scheduled = new Map();
  const state = {
    now: 1000,
    closes: 0,
    fetchCodes: async () => codes,
    failFill: false,
    failRemove: false,
    requests: [],
  };
  const tab = { id: 1, url: "https://example.com/login" };
  let nextTimer = 0;
  const client = {
    closeSession() {
      state.closes++;
    },
    async sendSessionRequest(action) {
      return action === "status"
        ? { accounts: account ? [account] : [] }
        : { codes: await state.fetchCodes() };
    },
    async sendCompanionRequest(request) {
      state.requests.push(request);
      if (state.failRemove) throw Error("Keychain unavailable");
      return { accounts: request.action === "disconnect" ? [] : [request.email] };
    },
  };
  const popup = createPopup({
    document: {
      getElementById: (id) => controls[id],
      createElement: (tag) => new FakeElement(tag),
    },
    chrome: {
      runtime: { id: "test-extension" },
      tabs: {
        query: async () => [tab],
        get: async () => {
          if (state.failFill) throw Error("Tab unavailable");
          return tab;
        },
      },
      scripting: { executeScript: async () => [{ result: { ok: true } }] },
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
  const { scheduled, state } = await setup();
  state.now += 120001;
  await [...scheduled.values()][0].callback();
  assert.equal(scheduled.size, 0, "stop after the polling deadline");
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
    const replacements = controls.codes.replacements;
    controls.checkCodes.trigger();
    const button = controls.codes.querySelectorAll("button")[0];
    await button.trigger();
    finishCheck([{ ...code, code: "654321" }]);
    await settle();
    assert.equal(
      controls.codes.replacements,
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
  }
});

test("keeps unchanged code cards and updates changed ones", async () => {
  const { controls, state } = await setup();
  const initial = controls.codes.replacements;
  state.fetchCodes = async () => [{ ...code }];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(
    controls.codes.replacements,
    initial,
    "unchanged cards retain focus",
  );
  state.fetchCodes = async () => [{ ...code, code: "654321" }];
  controls.checkCodes.trigger();
  await settle();
  assert.equal(controls.codes.replacements, initial + 1);
});

test("lets a manual retry supersede a pending check", async () => {
  const { controls, state } = await setup();
  const pending = [];
  state.fetchCodes = () => new Promise((resolve) => pending.push(resolve));
  const initial = controls.codes.replacements;
  controls.checkCodes.trigger();
  controls.checkCodes.trigger();
  pending[0]([{ ...code, code: "111111" }]);
  pending[1]([{ ...code, code: "222222" }]);
  await settle();
  assert.ok(state.closes >= 1, "manual retry interrupts the previous check");
  assert.equal(controls.codes.replacements, initial + 1);
  assert.equal(controls.codes.children[0].children[0].textContent, "222222");
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
    assert.equal(state.requests[0].action, "disconnect");
    assert.equal(state.requests[0].email, "test@yahoo.com");
    assert.equal(scheduled.size, failRemove ? 1 : 0);
    assert.equal(controls.codeResults.hidden, !failRemove);
    assert.equal(controls.checkCodes.disabled, false);
  }
});

test("connects an account without retaining the form password", async () => {
  const { controls, state } = await setup({ account: null });
  assert.equal(controls.setup.hidden, false);
  controls.email.value = "test@yahoo.com";
  controls.password.value = "app-password";
  await controls.connectForm.trigger("submit");
  await settle();
  assert.equal(controls.password.value, "");
  assert.deepEqual(state.requests[0], {
    action: "configure",
    email: "test@yahoo.com",
    password: "app-password",
  });
  assert.equal(controls.accounts.children[0].children[0].textContent, "test@yahoo.com");
  assert.equal(controls.codeResults.hidden, false);
});

test("shows multiple accounts and labels codes with their inbox", async () => {
  const { controls } = await setup({
    codes: [{ ...code, accountEmail: "test@yahoo.com" }],
  });
  assert.equal(controls.accounts.children.length, 1);
  assert.equal(controls.codes.children[0].children[1].textContent, "test@yahoo.com");
  controls.addAccount.trigger();
  assert.equal(controls.setup.hidden, false);
  assert.equal(controls.codeResults.hidden, false);
});
