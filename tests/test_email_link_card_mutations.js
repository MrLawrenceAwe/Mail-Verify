import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardHarness, settle, item, stepMutation } from "./email_link_card_harness.js";

test("revealing a pre-existing waiting prompt mounts its link card", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const text = mailType === "passwordResetLinks"
      ? "Reset your password. Check your email." : "Check your email.";
    const panel = { nodeType: 1, tagName: "MAIN", getClientRects: () => [{}], checkVisibility: () => true };
    const prompt = { nodeType: 1, tagName: "P", hidden: true, parentNode: panel, matches: () => false };
    prompt.firstChild = { nodeType: 3, data: text, textContent: text, parentNode: prompt };
    panel.firstChild = prompt;
    Object.defineProperty(panel, "innerText", { get: () => prompt.hidden ? "" : text });
    const f = createEmailLinkCardHarness(panel, mailType);
    await settle();
    assert.equal(f.state.views.length, 0);
    assert.equal(f.state.requests, 0);
    prompt.hidden = false;
    f.state.mutate([{ type: "attributes", attributeName: "hidden", target: prompt }]);
    await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.equal(f.state.requests, 1);
    assert.deepEqual(f.state.views[0].links, [item]);
  }
});

test("modal link cards mount in the active dialog rather than the inert document", async () => {
  let mounted;
  const modal = { append(host) { mounted = host; } };
  const f = createEmailLinkCardHarness(null, 'passwordResetLinks', modal); await settle();
  assert.equal(mounted, f.state.views[0].host);
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("unrelated mutations do not schedule a confirmation scan", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const before = f.state.stepReads;
  f.state.mutate([{ type: "childList", target: { nodeType: 1, closest: () => null },
    addedNodes: [{ nodeType: 3, textContent: "Stock price changed" }], removedNodes: [] }]);
  assert.equal([...f.timers.values()].some((timer) => timer.delay === 250), false);
  assert.equal(f.state.stepReads, before);
  f.state.mutate(stepMutation());
  await f.run(250);
  assert.ok(f.state.stepReads > before);
});

test("oversized mutations are coalesced into one throttled confirmation scan", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const before = f.state.stepReads;
  const records = [{ type: "childList", target: { nodeType: 1, closest: () => null },
    addedNodes: [{ nodeType: 3, textContent: "x".repeat(2_000_000) }], removedNodes: [] }];
  for (let count = 0; count < 20; count++) f.state.mutate(records);
  assert.equal([...f.timers.values()].filter((timer) => timer.delay === 250).length, 1);
  assert.equal(f.state.stepReads, before);
  await f.run(250);
  assert.equal(f.state.stepReads, before + 1);
});
