import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardView } from "../extension/inline/email-link-card-view.js";
import { formatReceivedAt } from "../extension/shared/mail-presentation.js";

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
    receivedAt: 1000,
  };
  view.renderLinks([item]);
  const card = controls["#results"].children[0];
  return { root, controls, view, item, card, action: card.children.at(-1) };
}

test("both link-card mail types show email details and their own action and guidance", () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const { card, action, root, item } = setup(mailType);
    assert.deepEqual(
      card.children.slice(0, -1).map((line) => line.textContent),
      [
        `Inbox: ${item.accountEmail}`,
        `From: ${item.sender}`,
        item.subject,
        "Link domain: example.com",
        formatReceivedAt(item.receivedAt),
      ],
    );
    assert.equal(action.tag, "a");
    assert.equal(action.href, item.url);
    assert.equal(action.target, "_blank");
    assert.equal(action.rel, "noopener noreferrer");
    assert.match(root.innerHTML, /new tab/);
  }
});

test("both link types block rejected selections for primary and middle clicks", () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    let approved = false;
    const { action } = setup(mailType, { acceptLinkSelection: () => approved });
    for (const eventName of ["click", "auxclick"]) {
      let prevented = false;
      action.listeners[eventName]({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
      approved = true;
      prevented = false;
      action.listeners[eventName]({ preventDefault() { prevented = true; } });
      assert.equal(prevented, false);
      approved = false;
    }
  }
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
        "Link domain: example.com",
        formatReceivedAt(item.receivedAt),
      ],
    );
  }
});
