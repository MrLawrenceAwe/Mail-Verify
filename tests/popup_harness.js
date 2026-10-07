import { createTimerQueue } from "./timer_queue.js";
import assert from "node:assert/strict";
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

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const code = {
  code: "123456",
  accountEmail: "test@yahoo.com",
  sender: "sender@example.com",
  subject: "Sign in",
  receivedAt: 1000,
};

export async function createPopupHarness({ codes = [code], account = "test@yahoo.com", remainingAccountEmails = [], tabUrl = "https://example.com/login", clipboardAvailable = true } = {}) {
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


export const link = { ...code, url: "https://example.com/confirm?token=secret" };
