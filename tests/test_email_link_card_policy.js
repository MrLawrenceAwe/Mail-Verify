import test from "node:test";
import assert from "node:assert/strict";
import {
  isEmailLinkRequestControl,
  mutationAffectsEmailLinkCard,
  selectEmailLinks,
} from "../extension/inline/email-link-card-policy.js";

const item = {
  url: "https://example.com/confirm?token=abc",
  receivedAt: 10000,
  accountEmail: "me@yahoo.com",
  sender: "hello@example.com",
  uid: 1,
};

test("recognises controls that request another confirmation message", () => {
  const control = (textContent) => ({ textContent, getAttribute: () => "" });
  for (const label of [
    "Resend email",
    "Resend email and SMS code",
    "Send again",
    "Send confirmation email",
    "Request verification link",
  ])
    assert.equal(isEmailLinkRequestControl(control(label)), true, label);
  assert.equal(isEmailLinkRequestControl(control("Contact support")), false);
  for (const label of [
    "Resend SMS code",
    "Resend text message",
    "Resend phone verification",
    "Send again via WhatsApp",
  ])
    assert.equal(isEmailLinkRequestControl(control(label)), false, label);
});

test("ignores unrelated page mutations but scans prompt and code-field changes", () => {
  const document = { querySelector: () => ({}) };
  const outside = {
    nodeType: 1,
    textContent: "Stock price",
    closest: () => null,
    matches: () => false,
    querySelector: () => null,
  };
  const input = {
    nodeType: 1,
    matches: (selector) => selector.includes("input"),
  };
  const panel = { nodeType: 1, closest: () => ({}), matches: () => false };
  const mutation = (type, target, addedNodes = []) => ({
    type,
    target,
    addedNodes,
    removedNodes: [],
  });
  assert.equal(
    mutationAffectsEmailLinkCard(
      [mutation("attributes", outside)],
      null,
      document,
      true,
    ),
    false,
  );
  assert.equal(
    mutationAffectsEmailLinkCard(
      [
        mutation("childList", outside, [
          { nodeType: 3, textContent: "Price changed" },
        ]),
      ],
      null,
      document,
      true,
    ),
    false,
  );
  assert.equal(
    mutationAffectsEmailLinkCard(
      [
        mutation("characterData", {
          nodeType: 3,
          textContent: "Check your email",
        }),
      ],
      null,
      document,
      false,
    ),
    true,
  );
  assert.equal(
    mutationAffectsEmailLinkCard(
      [mutation("childList", outside, [input])],
      null,
      document,
      false,
    ),
    true,
  );
  assert.equal(
    mutationAffectsEmailLinkCard(
      [
        mutation("characterData", {
          nodeType: 3,
          textContent: "bob@example.com",
          parentElement: panel,
        }),
      ],
      null,
      document,
      true,
    ),
    true,
  );
});

test("visibility changes discover existing confirmation and reset prompts", () => {
  for (const attributeName of ["hidden", "class", "style"]) {
    for (const text of [
      "Check your email",
      "Password reset link sent to your inbox",
    ]) {
      const prompt = { nodeType: 1, matches: () => false };
      prompt.firstChild = {
        nodeType: 3,
        textContent: text,
        parentNode: prompt,
      };
      const record = { type: "attributes", attributeName, target: prompt };
      assert.equal(
        mutationAffectsEmailLinkCard([record], null, {}, false),
        true,
        `${attributeName}: ${text}`,
      );
      assert.equal(
        mutationAffectsEmailLinkCard([record], prompt, {}, false),
        false,
        "extension controls must remain excluded",
      );
    }
  }
});

test("bounded mutation traversal preserves prompts split across nested elements", () => {
  const root = { nodeType: 1, matches: () => false };
  const span = { nodeType: 1, matches: () => false, parentNode: root };
  root.firstChild = {
    nodeType: 3,
    textContent: "e",
    parentNode: root,
    nextSibling: span,
  };
  span.firstChild = { nodeType: 3, textContent: "mail", parentNode: span };
  const record = {
    type: "childList",
    target: { nodeType: 1 },
    addedNodes: [root],
    removedNodes: [],
  };
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), true);
  span.firstChild.textContent = "Price changed";
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), false);
  span.matches = (selector) => selector.includes("input");
  assert.equal(mutationAffectsEmailLinkCard([record], null, {}, false), true);
});

test("selects fresh HTTPS links and omits older or unsafe candidates", () => {
  assert.deepEqual(
    selectEmailLinks(
      [
        item,
        { ...item, receivedAt: 1 },
        { ...item, url: "javascript:alert(1)" },
        { ...item, receivedAt: 20000 },
      ],
      5000,
      10000,
    ),
    [item],
  );
});
