import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailLinkCardHarness,
  emailLinkMessage,
  stepMutation,
} from "./support/email_link_card_harness.js";

test("renders matching mail, validates open and remains dismissed", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const view = harness.state.views[0];
  assert.deepEqual(view.links, [emailLinkMessage]);
  assert.equal(view.callbacks.acceptLinkSelection(emailLinkMessage), true);
  assert.equal(view.removed, true);
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(harness.state.views.length, 1);
});

test("reset card requests reset mail, copies on selection, and clears results on resend", async () => {
  const panel = {
    innerText: "Reset your password. Check your email",
    getClientRects: () => [{}],
    checkVisibility: () => true,
  };
  const harness = createEmailLinkCardHarness(panel, "passwordResetLinks");
  await waitForAsyncCallbacks();
  const view = harness.state.views[0];
  assert.equal(view.callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(view.links, [emailLinkMessage]);
  assert.equal(harness.state.copied, undefined);
  assert.equal(view.callbacks.acceptLinkSelection(emailLinkMessage), true);
  await view.callbacks.copyResetLink(emailLinkMessage);
  assert.equal(harness.state.copied, emailLinkMessage.url);
  assert.equal(view.removed, false);
  harness.events.click({
    target: { closest: () => ({ textContent: "Send password reset link" }) },
  });
  await waitForAsyncCallbacks();
  assert.deepEqual(harness.state.views.at(-1).links, []);
  assert.equal(
    harness.state.views.at(-1).callbacks.acceptLinkSelection(emailLinkMessage),
    false,
  );
});
