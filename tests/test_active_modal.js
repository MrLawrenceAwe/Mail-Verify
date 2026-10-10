import test from "node:test";
import assert from "node:assert/strict";
import { findActiveModal } from "../extension/inline/active-modal.js";
import { suggestionMountRoot } from "../extension/inline/suggestion-mount.js";

test("modal selection and mounting follow focus rather than DOM order", () => {
  const inactive = {}, active = {};
  const document = {
    activeElement: { closest: () => active },
    querySelector: () => inactive,
  };
  assert.equal(findActiveModal(document), active);
  assert.equal(suggestionMountRoot(document), active);
});

test("the active backdrop identifies the modal after focus is lost", () => {
  const inactive = {}, active = {};
  const document = {
    activeElement: { closest: () => null },
    elementFromPoint: () => ({ closest: () => active }),
    querySelector: () => inactive,
  };
  assert.equal(findActiveModal(document), active);
});
