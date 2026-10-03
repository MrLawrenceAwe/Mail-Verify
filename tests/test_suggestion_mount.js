import test from "node:test";
import assert from "node:assert/strict";
import { mountSuggestion } from "../extension/inline/suggestion-mount.js";

test("moving a suggestion into and out of a modal manages its top-layer state", () => {
  const background = { append(host) { host.parentNode = this; } };
  const dialog = { append(host) { host.parentNode = this; } };
  let activeModal = dialog;
  const document = { documentElement: background, querySelector: () => activeModal };
  const attributes = new Map();
  const host = {
    style: { position:"fixed", left:"20px", top:"100px", right:"", bottom:"" },
    hasAttribute: name => attributes.has(name),
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: name => attributes.delete(name),
    showPopover() { this.inTopLayer = true; },
    hidePopover() { this.inTopLayer = false; },
  };
  mountSuggestion(document, host);
  assert.equal(host.parentNode, dialog);
  assert.equal(host.inTopLayer, true);
  assert.equal(attributes.get("popover"), "manual");
  assert.equal(host.style.left, "20px");
  assert.equal(host.style.top, "100px");
  assert.equal(host.style.margin, "0");
  activeModal = null;
  mountSuggestion(document, host);
  assert.equal(host.parentNode, background);
  assert.equal(host.inTopLayer, false);
  assert.equal(attributes.has("popover"), false);
});
