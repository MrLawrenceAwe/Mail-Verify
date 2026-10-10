import { waitForAsyncCallbacks } from "./async_callbacks.js";
import assert from "node:assert/strict";
import { detectEmailLinkStep } from "../../extension/inline/email-link-step.js";
import { startEmailLinkCard } from "../../extension/inline/email-link-card-controller.js";
import { createMockInlineRuntime } from "./mock_inline_port.js";
import { createTimerQueue } from "./timer_queue.js";

export const emailLinkMessage = {
  url: "https://example.com/confirm?token=abc",
  receivedAt: 10000,
  accountEmail: "me@yahoo.com",
  sender: "hello@example.com",
  uid: 1,
};

export const stepMutation = () => [
  {
    type: "characterData",
    target: { nodeType: 3, textContent: "Check your email" },
  },
];

export function createEmailLinkCardHarness(
  panel = null,
  mailType = "confirmationLinks",
  modal = null,
) {
  const timers = createTimerQueue(),
    events = {},
    windowEvents = {};
  const state = {
    now: 10000,
    detected: true,
    screenKey: "first signup",
    panel,
    code: false,
    requests: 0,
    collectionModes: [],
    stepReads: 0,
    views: [],
    respond: async () => ({
      ok: true,
      [mailType]: [emailLinkMessage],
      scanPending: false,
    }),
  };
  state.mailType = mailType;
  const document = {
    hidden: false,
    documentElement: { append() {} },
    querySelector: (selector) => (selector === "dialog:modal" ? modal : {}),
    addEventListener(name, fn) {
      events[name] = fn;
    },
  };
  const location = { href: "https://example.com/verify" };
  startEmailLinkCard({
    environment: {
      navigator: {
        clipboard: {
          async writeText(value) {
            state.copied = value;
          },
        },
      },
      document,
      location,
      window: {
        addEventListener(name, fn) {
          windowEvents[name] = fn;
        },
      },
      chrome: {
        runtime: createMockInlineRuntime(async (mailType, collectOnly) => {
          assert.equal(mailType, state.mailType);
          state.collectionModes.push(collectOnly);
          state.requests++;
          return state.respond();
        }),
      },
      Date: { now: () => state.now },
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      MutationObserver: class {
        constructor(fn) {
          state.mutate = fn;
        }
        observe() {}
      },
    },
    detectStep: () => {
      state.stepReads++;
      return state.detected
        ? state.panel
          ? detectEmailLinkStep({ querySelectorAll: () => [state.panel] })
          : { key: state.screenKey, mailType: state.mailType }
        : null;
    },
    detectCode: () => state.code,
    createView(_document, callbacks) {
      const view = {
        callbacks,
        removed: false,
        links: [],
        host: {
          style: {},
          hasAttribute: () => false,
          setAttribute() {},
          showPopover() {},
          remove() {
            view.removed = true;
          },
          contains() {
            return false;
          },
        },
        setStatus(text) {
          view.status = text;
        },
        renderLinks(items) {
          view.links = items;
        },
      };
      state.views.push(view);
      return view;
    },
  });
  async function run(delay) {
    await timers.runWithDelay(delay);
    await waitForAsyncCallbacks();
  }
  return { state, document, location, events, windowEvents, run, timers };
}
