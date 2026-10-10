import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardView } from "../extension/inline/email-link-card-view.js";

function setup(mailType, callbacks = {}) {
  const element = (tag) => ({
    tag,
    children: [],
    listeners: {},
    dataset: {},
    style: {},
    append(child) {
      this.children.push(child);
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener(event, listener) {
      this.listeners[event] = listener;
    },
  });
  const controls = Object.fromEntries(
    ["#status", "#results", "#retry", "#close"].map((id) => [
      id,
      element("div"),
    ]),
  );
  const root = { querySelector: (id) => controls[id] };
  const document = {
    createElement(tag) {
      const node = element(tag);
      node.attachShadow = () => root;
      return node;
    },
  };
  const view = createEmailLinkCardView(document, {
    mailType,
    acceptLinkSelection: () => true,
    ...callbacks,
  });
  const item = {
    accountEmail: "me@yahoo.com",
    sender: "sender@example.com",
    subject: "Your email",
    url: "https://example.com/action",
  };
  view.renderLinks([item]);
  const card = controls["#results"].children[0];
  return { root, controls, view, item, card, action: card.children.at(-1) };
}

test("both link-card mail types show email details and their own action and guidance", () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const { card, action, root, item } = setup(mailType);
    assert.deepEqual(
      card.children.slice(0, 4).map((line) => line.textContent),
      [
        `Inbox: ${item.accountEmail}`,
        `From: ${item.sender}`,
        item.subject,
        "Initial destination host: example.com",
      ],
    );
    if (mailType === "confirmationLinks") {
      assert.equal(action.tag, "a");
      assert.equal(action.href, item.url);
      assert.equal(action.target, "_blank");
      assert.match(root.innerHTML, /Opening a link in a new tab/);
    } else {
      assert.equal(action.tag, "button");
      assert.equal(action.href, undefined);
      assert.match(
        root.innerHTML,
        /sender and initial destination host before copying/,
      );
      assert.doesNotMatch(root.innerHTML, /Opening a link/);
    }
  }
});

test("reset-card action copies only an approved selection and reports success", async () => {
  let approved = false;
  const copied = [];
  const { action, item, controls } = setup("passwordResetLinks", {
    acceptLinkSelection: () => approved,
    copyResetLink: async (item) => copied.push(item.url),
  });
  await action.listeners.click();
  assert.deepEqual(copied, []);
  approved = true;
  await action.listeners.click();
  assert.deepEqual(copied, [item.url]);
  assert.equal(action.textContent, "Copy again");
  assert.equal(action.disabled, false);
  assert.match(controls["#status"].textContent, /copied to clipboard/);
  await action.listeners.click();
  assert.deepEqual(copied, [item.url, item.url]);
  assert.equal(action.textContent, "Copy again");
});

test("failed reset-card copies show the error and allow another attempt", async () => {
  const { action, controls } = setup("passwordResetLinks", {
    copyResetLink: async () => {
      throw new Error("Clipboard denied. Use the toolbar popup.");
    },
  });
  await action.listeners.click();
  assert.equal(action.disabled, false);
  assert.equal(action.textContent, "Copy password reset link");
  assert.match(controls["#status"].textContent, /Clipboard denied/);
});

test("link cards identify inbox and missing sender without empty subject rows", () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const { view, controls, item } = setup(mailType);
    view.renderLinks([{ ...item, sender: "  ", subject: " " }]);
    const card = controls["#results"].children[0];
    assert.deepEqual(
      card.children.slice(0, -1).map((line) => line.textContent),
      [
        `Inbox: ${item.accountEmail}`,
        "From: Unknown sender",
        "Initial destination host: example.com",
      ],
    );
  }
});
