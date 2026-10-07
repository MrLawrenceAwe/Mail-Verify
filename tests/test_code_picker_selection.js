import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createCodePickerHarness } from "./support/code_picker_harness.js";

test("picker passes its mounted field to the fill action", async () => {
  const anchor = {};
  const fills = [];
  const code = {
    uid: 1,
    accountEmail: "test@yahoo.com",
    code: "123456",
    sender: "auth@example.test",
    receivedAt: 9_000,
  };
  const { results } = createCodePickerHarness({
    handleVerificationFields: (request) => {
      if (request.action === "fill") {
        fills.push(request);
        return { ok: true };
      }
      return {
        ok: true,
        anchor,
        candidateCache: { contextRoots: [] },
        rect: { top: 100, bottom: 130, left: 20, right: 200 },
      };
    },
    now: () => 10_000,
    check: async () => ({ ok: true, codes: [code] }),
  });
  await waitForAsyncCallbacks();
  results.children[0].onclick();
  assert.equal(fills.length, 1);
  assert.equal(fills[0].expectedAnchor, anchor);
});

test("selection revalidates the verification step before the queued discovery runs", async () => {
  for (const changed of [true, false]) {
    let observer,
      fills = 0;
    const form = {
      textContent: "We sent a code to alice@example.test. Resend in 30 seconds",
      contains: () => true,
    };
    const anchor = { form };
    const code = {
      uid: 1,
      accountEmail: "test@yahoo.com",
      code: "111111",
      sender: "auth@example.test",
      receivedAt: 9000,
    };
    const { timers, results } = createCodePickerHarness({
      handleVerificationFields: ({ action }) => {
        if (action === "fill") {
          fills++;
          return { ok: true };
        }
        return {
          ok: true,
          anchor,
          stepContext: { roots: [form] },
          candidateCache: { contextRoots: [] },
          rect: { top: 100, bottom: 130, left: 20, right: 200 },
        };
      },
      now: () => 10000,
      check: async () => ({ ok: true, codes: [code] }),
      onObserve: (callback) => {
        observer = callback;
      },
    });
    await waitForAsyncCallbacks();
    const button = results.children[0];
    form.textContent = changed
      ? "We sent a code to bob@example.test. Resend in 30 seconds"
      : "We sent a code to alice@example.test. Resend in 29 seconds";
    observer([{ type: "characterData", target: {} }]);
    assert.ok(timers.length, "discovery has been queued but has not run");
    button.onclick();
    assert.equal(
      fills,
      changed ? 0 : 1,
      "recipient changes block filling; countdown changes keep the selection valid",
    );
    await waitForAsyncCallbacks();
    if (changed) {
      assert.equal(
        results.childElementCount,
        0,
        "the old result is excluded from the new attempt",
      );
      button.onclick();
      assert.equal(
        fills,
        0,
        "a detached old button cannot fill the new attempt",
      );
    }
  }
});

test("switching CSS-hidden recipients blocks the previous code before discovery runs", async () => {
  for (const hiddenStyle of [
    { display: "none" },
    { visibility: "hidden" },
    { opacity: "0" },
  ]) {
    let fills = 0,
      observer,
      now = 10000;
    const form = { nodeType: 1, tagName: "FORM", contains: () => true };
    const alice = {
      nodeType: 1,
      tagName: "P",
      parentNode: form,
      fakeComputedStyle: {},
    };
    const bob = {
      nodeType: 1,
      tagName: "P",
      parentNode: form,
      fakeComputedStyle: hiddenStyle,
    };
    form.firstChild = alice;
    alice.nextSibling = bob;
    alice.firstChild = {
      nodeType: 3,
      data: "We sent a code to alice@example.test",
      parentNode: alice,
    };
    bob.firstChild = {
      nodeType: 3,
      data: "We sent a code to bob@example.test",
      parentNode: bob,
    };
    const anchor = {};
    const oldCode = {
      uid: 1,
      accountEmail: "test@yahoo.com",
      code: "111111",
      sender: "auth@example.test",
      receivedAt: 9000,
    };
    const newCode = { ...oldCode, uid: 2, code: "222222", receivedAt: 20000 };
    let codes = [oldCode];
    const { results, timers } = createCodePickerHarness({
      handleVerificationFields: ({ action }) => {
        if (action === "fill") {
          fills++;
          return { ok: true };
        }
        return {
          ok: true,
          anchor,
          rect: { top: 100, bottom: 130, left: 20, right: 200 },
          stepContext: { roots: [form] },
        };
      },
      now: () => now,
      check: async () => ({ ok: true, codes }),
      onObserve: (callback) => {
        observer = callback;
      },
    });

    await waitForAsyncCallbacks();
    const button = results.children[0];
    assert.ok(button);
    now = 20000;
    codes = [oldCode, newCode];
    alice.fakeComputedStyle = hiddenStyle;
    bob.fakeComputedStyle = {};
    observer([
      {
        type: "attributes",
        attributeName: "class",
        target: { matches: () => true },
      },
    ]);
    button.onclick();
    assert.equal(
      fills,
      0,
      "selection must revalidate the visible recipient immediately",
    );
    await waitForAsyncCallbacks();
    assert.equal(results.children.length, 1);
    assert.equal(results.children[0].strong.textContent, "Fill code 222222");
    await timers.runWithDelay(150);
    await waitForAsyncCallbacks();
    button.onclick();
    assert.equal(fills, 0, "the detached old selection stays blocked");
    results.children[0].onclick();
    assert.equal(fills, 1, "the new recipient's fresh code can be filled");
  }
});

test("failed fills retain specific field guidance and use a fallback when absent", async () => {
  for (const error of [
    "The verification-code fields changed while filling them. Try again.",
    undefined,
  ]) {
    const anchor = {};
    const { results, elements } = createCodePickerHarness({
      handleVerificationFields: ({ action }) =>
        action === "fill"
          ? { ok: false, error }
          : {
              ok: true,
              anchor,
              rect: { top: 100, bottom: 130, left: 20, right: 200 },
            },
      now: () => 10000,
      check: async () => ({
        ok: true,
        codes: [
          {
            uid: 1,
            accountEmail: "test@yahoo.com",
            code: "123456",
            sender: "auth@example.test",
            receivedAt: 9000,
          },
        ],
      }),
    });
    await waitForAsyncCallbacks();
    results.children[0].onclick();
    assert.equal(
      elements["#status"].textContent,
      error || "Select the code field and try again.",
    );
    assert.equal(results.childElementCount, 1);
  }
});

test("visible code suggestions distinguish senders and inboxes without hovering", async () => {
  const codes = [
    {
      uid: 1,
      accountEmail: "first@yahoo.com",
      sender: "login@example.test",
      code: "111111",
      receivedAt: 9000,
    },
    {
      uid: 2,
      accountEmail: "first@yahoo.com",
      sender: "security@other.test",
      code: "222222",
      receivedAt: 9000,
    },
    {
      uid: 3,
      accountEmail: "second@yahoo.com",
      sender: "",
      code: "333333",
      receivedAt: 9000,
    },
  ];
  const { results } = createCodePickerHarness({
    handleVerificationFields: () => ({
      ok: true,
      anchor: {},
      rect: { top: 100, bottom: 130, left: 20, right: 200 },
    }),
    now: () => 10000,
    check: async () => ({ ok: true, codes }),
  });
  await waitForAsyncCallbacks();
  assert.deepEqual(
    results.children.map((button) => button.small.textContent),
    [
      "login@example.test · first@yahoo.com",
      "security@other.test · first@yahoo.com",
      "Unknown sender · second@yahoo.com",
    ],
  );
  const unknownSenderButton = results.children[2];
  assert.match(unknownSenderButton.title, /Unknown sender/);
  assert.match(
    unknownSenderButton.attributes["aria-label"],
    /from Unknown sender/,
  );
});
