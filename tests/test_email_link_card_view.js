import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardView } from "../extension/email-link-card-view.js";

function setup(mode, callbacks = {}) {
  const element = (tag) => ({
    tag, children: [], listeners: {}, dataset: {}, style: {},
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
  });
  const controls = Object.fromEntries(["#status", "#results", "#retry", "#close"].map(id => [id, element("div")]));
  const root = { querySelector: id => controls[id] };
  const document = { createElement(tag) {
    const node = element(tag);
    node.attachShadow = () => root;
    return node;
  } };
  const view = createEmailLinkCardView(document, { mode, beforeUse: () => true, ...callbacks });
  const item = { accountEmail: "me@yahoo.com", sender: "sender@example.com", subject: "Your email", url: "https://example.com/action" };
  view.renderLinks([item]);
  const card = controls["#results"].children[0];
  return { root, controls, view, item, card, action: card.children.at(-1) };
}

test("both link-card modes show email details and their own action and guidance", () => {
  for (const mode of ["confirmationLinks", "passwordResetLinks"]) {
    const { card, action, root, item } = setup(mode);
    assert.deepEqual(card.children.slice(0, 4).map(line => line.textContent),
      [item.accountEmail, item.sender, item.subject, "Destination: example.com"]);
    if (mode === "confirmationLinks") {
      assert.equal(action.tag, "a");
      assert.equal(action.href, item.url);
      assert.equal(action.target, "_blank");
      assert.match(root.innerHTML, /Opening a link in a new tab/);
    } else {
      assert.equal(action.tag, "button");
      assert.equal(action.href, undefined);
      assert.match(root.innerHTML, /copy your reset link and paste/);
      assert.doesNotMatch(root.innerHTML, /Opening a link/);
    }
  }
});

test("reset-card action copies only an approved selection and reports success", async () => {
  let approved = false;
  const copied = [];
  const { action, item, controls } = setup("passwordResetLinks", {
    beforeUse: () => approved,
    copyLink: async item => copied.push(item.url),
  });
  await action.listeners.click();
  assert.deepEqual(copied, []);
  approved = true;
  await action.listeners.click();
  assert.deepEqual(copied, [item.url]);
  assert.equal(action.textContent, "Copied");
  assert.equal(action.disabled, false);
  assert.match(controls["#status"].textContent, /copied to clipboard/);
});


test("failed reset-card copies show the error and allow another attempt", async () => {
  const { action, controls } = setup("passwordResetLinks", {
    copyLink: async () => { throw new Error("Clipboard denied. Use the toolbar popup."); },
  });
  await action.listeners.click();
  assert.equal(action.disabled, false);
  assert.equal(action.textContent, "Copy password reset link");
  assert.match(controls["#status"].textContent, /Clipboard denied/);
});
