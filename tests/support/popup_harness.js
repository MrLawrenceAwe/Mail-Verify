import { makeVerificationCodeMessage } from "./mail_results.js";
import { waitForAsyncCallbacks } from "./async_callbacks.js";
import { createTimerQueue } from "./timer_queue.js";
import assert from "node:assert/strict";
import { createPopupController } from "../../extension/popup/popup-controller.js";

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

export async function createPopupHarness({
  codes = [makeVerificationCodeMessage()],
  account = "test@yahoo.com",
  remainingAccountEmails = [],
  tabUrl = "https://example.com/login",
  statusError,
} = {}) {
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
      "targetPage",
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
      if (action === "status" && statusError) throw statusError;
      return action === "status"
        ? { accountEmails: account ? [account] : [] }
        : action === "passwordResetLinks"
          ? {
              passwordResetLinks: await state.fetchPasswordResetLinks(),
              scanPending: state.scanPending,
              warnings: state.warnings,
            }
          : action === "confirmationLinks"
            ? {
                confirmationLinks: await state.fetchConfirmationLinks(),
                scanPending: state.scanPending,
                warnings: state.warnings,
              }
            : {
                codes: await state.fetchCodes(),
                scanPending: state.scanPending,
                warnings: state.warnings,
              };
    },
    async sendOneOffRequest(request) {
      state.requests.push(request);
      if (state.sendOneOff) return state.sendOneOff(request);
      if (state.failRemove) throw Error("Keychain unavailable");
      return {
        accountEmails:
          request.action === "removeAccount"
            ? remainingAccountEmails
            : [request.email],
      };
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
        create: async (options) => {
          if (state.failOpen) throw Error("Tab unavailable");
          if (state.openWait) await state.openWait;
          state.opened.push(options);
        },
        get: async () => {
          if (state.failFill) throw Error("Tab unavailable");
          return tab;
        },
      },
      scripting: {
        executeScript: async (args) => {
          state.scriptArgs = args;
          return [{ result: { ok: true } }];
        },
      },
    },
    client,
    clock: { now: () => state.now },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await popup.initialize();
  await waitForAsyncCallbacks();
  return { controls, timers, state };
}
