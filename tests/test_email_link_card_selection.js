import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardHarness, settle, item, stepMutation } from "./email_link_card_harness.js";

test("renders matching mail, validates open and remains dismissed", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const view = f.state.views[0];
  assert.deepEqual(view.links, [item]);
  assert.equal(view.callbacks.onSelectLink(item), true);
  assert.equal(view.removed, true);
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("reset card requests reset mail, copies on selection, and clears results on resend", async () => {
  const panel = { innerText: "Reset your password. Check your email", getClientRects: () => [{}], checkVisibility: () => true };
  const f = createEmailLinkCardHarness(panel, "passwordResetLinks"); await settle();
  const view = f.state.views[0];
  assert.equal(view.callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(view.links, [item]);
  assert.equal(f.state.copied, undefined);
  assert.equal(view.callbacks.onSelectLink(item), true);
  await view.callbacks.copyLink(item);
  assert.equal(f.state.copied, item.url);
  assert.equal(view.removed, false);
  f.events.click({ target: { closest: () => ({ textContent: "Send password reset link" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});
