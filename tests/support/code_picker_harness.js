import { startCodePicker } from "../../extension/inline/code-picker-controller.js";
import { createMockInlineRuntime } from "./mock_inline_port.js";
import { createTimerQueue } from "./timer_queue.js";

export function createCodePickerHarness({
  detectOrFillCodeFields,
  now = Date.now,
  check,
  activeElement,
  onMount = () => {},
  onRemove = () => {},
  onObserve = () => {},
  onFrame = (fn) => fn(),
  getControls = () => [],
}) {
  const events = new Map(),
    timers = createTimerQueue();
  const results = {
    dataset: {},
    children: [],
    get childElementCount() {
      return this.children.length;
    },
    replaceChildren() {
      this.children = [];
    },
    append(child) {
      this.children.push(child);
    },
  };
  const elements = {
    "#results": results,
    "#status": {},
    "#close": {},
    "#retry": {},
  };
  const environment = {
    Date: { now },
    location: { href: "https://example.test", hostname: "example.test" },
    innerWidth: 1200,
    innerHeight: 800,
    getComputedStyle: (node) => node.fakeComputedStyle || {},
    document: {
      activeElement,
      hidden: false,
      documentElement: { append: onMount },
      querySelectorAll: getControls,
      addEventListener: (name, fn) => events.set(name, fn),
      createElement: () => {
        const strong = {},
          small = {};
        return {
          strong,
          small,
          dataset: {},
          attributes: {},
          style: {},
          attachShadow: () => ({ querySelector: (id) => elements[id] }),
          getBoundingClientRect: () => ({ width: 240, height: 60 }),
          contains: () => false,
          remove: onRemove,
          querySelector: (selector) => (selector === "small" ? small : strong),
          addEventListener() {},
          setAttribute(name, value) {
            this.attributes[name] = value;
          },
          hasAttribute: () => false,
          showPopover() {},
        };
      },
    },
    window: {
      addEventListener: (name, fn) => events.set(name, fn),
      navigation: {
        addEventListener: (name, fn) => events.set(`navigation:${name}`, fn),
      },
    },
    MutationObserver: class {
      constructor(callback) {
        onObserve(callback);
      }
      observe() {}
    },
    requestAnimationFrame: onFrame,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    chrome: { runtime: createMockInlineRuntime(check) },
  };
  const detectOrFill = (request) => {
    const result = detectOrFillCodeFields(request);
    for (const root of result.stepContext?.roots || []) {
      // Model text nodes so production traversal never needs a mock-only fallback.
      if (
        Object.hasOwn(root, "textContent") &&
        !Object.hasOwn(root, "nodeType")
      ) {
        root.nodeType = 1;
        root.tagName = "FORM";
        Object.defineProperty(root, "firstChild", {
          get: () => ({
            nodeType: 3,
            data: root.textContent,
            parentNode: root,
          }),
        });
      }
    }
    return request.action === "detect"
      ? { stepContext: { roots: [], parent: undefined }, ...result }
      : result;
  };
  startCodePicker({ environment, detectOrFillCodeFields: detectOrFill });
  return { environment, events, timers, results, elements };
}
