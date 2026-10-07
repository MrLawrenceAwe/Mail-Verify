import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailLinkCardHarness,
  emailLinkMessage,
  stepMutation,
} from "./support/email_link_card_harness.js";

test("revealing a pre-existing waiting prompt mounts its link card", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const text =
      mailType === "passwordResetLinks"
        ? "Reset your password. Check your email."
        : "Check your email.";
    const panel = {
      nodeType: 1,
      tagName: "MAIN",
      getClientRects: () => [{}],
      checkVisibility: () => true,
    };
    const prompt = {
      nodeType: 1,
      tagName: "P",
      hidden: true,
      parentNode: panel,
      matches: () => false,
    };
    prompt.firstChild = {
      nodeType: 3,
      data: text,
      textContent: text,
      parentNode: prompt,
    };
    panel.firstChild = prompt;
    Object.defineProperty(panel, "innerText", {
      get: () => (prompt.hidden ? "" : text),
    });
    const harness = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    assert.equal(harness.state.views.length, 0);
    assert.equal(harness.state.requests, 0);
    prompt.hidden = false;
    harness.state.mutate([
      { type: "attributes", attributeName: "hidden", target: prompt },
    ]);
    await harness.run(250);
    assert.equal(harness.state.views.length, 1);
    assert.equal(harness.state.requests, 1);
    assert.deepEqual(harness.state.views[0].links, [emailLinkMessage]);
  }
});

test("modal link cards mount in the active dialog rather than the inert document", async () => {
  let mounted;
  const modal = {
    append(host) {
      mounted = host;
    },
  };
  const harness = createEmailLinkCardHarness(null, "passwordResetLinks", modal);
  await waitForAsyncCallbacks();
  assert.equal(mounted, harness.state.views[0].host);
  assert.deepEqual(harness.state.views[0].links, [emailLinkMessage]);
});

test("unrelated mutations do not schedule a confirmation scan", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const before = harness.state.stepReads;
  harness.state.mutate([
    {
      type: "childList",
      target: { nodeType: 1, closest: () => null },
      addedNodes: [{ nodeType: 3, textContent: "Stock price changed" }],
      removedNodes: [],
    },
  ]);
  assert.equal(
    [...harness.timers.values()].some((timer) => timer.delay === 250),
    false,
  );
  assert.equal(harness.state.stepReads, before);
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.ok(harness.state.stepReads > before);
});

test("oversized mutations are coalesced into one throttled confirmation scan", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const before = harness.state.stepReads;
  const records = [
    {
      type: "childList",
      target: { nodeType: 1, closest: () => null },
      addedNodes: [{ nodeType: 3, textContent: "x".repeat(2_000_000) }],
      removedNodes: [],
    },
  ];
  for (let count = 0; count < 20; count++) harness.state.mutate(records);
  assert.equal(
    [...harness.timers.values()].filter((timer) => timer.delay === 250).length,
    1,
  );
  assert.equal(harness.state.stepReads, before);
  await harness.run(250);
  assert.equal(harness.state.stepReads, before + 1);
});
