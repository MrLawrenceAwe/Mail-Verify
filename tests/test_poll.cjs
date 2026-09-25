const assert = require("node:assert/strict");

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
  append(child) {
    this.children.push(child);
  }
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
  sender: "sender@example.com",
  subject: "Sign in",
  receivedAt: 1000,
};

(async () => {
  const { createPopup } = await import("../extension/popup.js");
  const { createCompanionClient } =
    await import("../extension/companion-client.js");

  async function setup({ codes = [code], account = "test@yahoo.com" } = {}) {
    const controls = Object.fromEntries(
      [
        "checkCodes",
        "removeAccount",
        "codes",
        "status",
        "setup",
        "companionSetup",
        "codeResults",
        "accountEmail",
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
          ? { email: account }
          : { codes: await state.fetchCodes() };
      },
      async sendCompanionRequest(request) {
        state.requests.push(request);
        if (state.failRemove) throw Error("Keychain unavailable");
        return { email: request.email };
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

  for (const codes of [[code], []]) {
    const { scheduled } = await setup({ codes });
    assert.equal(
      scheduled.size,
      1,
      "keep checking with or without an existing code",
    );
  }
  {
    const { scheduled, state } = await setup();
    state.now += 120001;
    await [...scheduled.values()][0].callback();
    assert.equal(scheduled.size, 0, "stop after the polling deadline");
  }
  {
    const { controls, scheduled, state } = await setup();
    state.fetchCodes = async () => {
      throw Error("Temporary mail error");
    };
    controls.checkCodes.trigger();
    await settle();
    assert.equal(scheduled.size, 1, "retry after temporary errors");
    assert.equal(controls.status.textContent, "Temporary mail error");
  }
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
  {
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
  }
  {
    const { controls, state } = await setup();
    const pending = [];
    state.fetchCodes = () => new Promise((resolve) => pending.push(resolve));
    const initial = controls.codes.replacements;
    controls.checkCodes.trigger();
    controls.checkCodes.trigger();
    pending[0]([{ ...code, code: "111111" }]);
    pending[1]([{ ...code, code: "222222" }]);
    await settle();
    assert.equal(state.closes, 1, "manual retry interrupts the previous check");
    assert.equal(controls.codes.replacements, initial + 1);
    assert.equal(controls.codes.children[0].children[0].textContent, "222222");
    assert.equal(controls.checkCodes.disabled, false);
  }
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
  for (const failRemove of [false, true]) {
    const { controls, scheduled, state } = await setup();
    state.failRemove = failRemove;
    await controls.removeAccount.trigger();
    assert.equal(state.requests[0].action, "disconnect");
    assert.equal(scheduled.size, failRemove ? 1 : 0);
    assert.equal(controls.codeResults.hidden, !failRemove);
    assert.equal(controls.removeAccount.disabled, false);
  }
  {
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
    assert.equal(controls.accountEmail.textContent, "test@yahoo.com");
    assert.equal(controls.codeResults.hidden, false);
  }
  {
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
  }
  console.log(
    "Popup polling, fill races, account controls, and companion session cases passed.",
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
