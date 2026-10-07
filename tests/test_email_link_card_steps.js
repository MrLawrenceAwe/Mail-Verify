import { waitForAsyncCallbacks } from "./support/async_callbacks.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailLinkCardHarness,
  emailLinkMessage,
  stepMutation,
} from "./support/email_link_card_harness.js";

test("short-unit countdown ticks retain links and the polling deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const unit of ["s", "m"]) {
      const prompt =
        mailType === "passwordResetLinks"
          ? "Reset your password. Check your email."
          : "Check your email.";
      const panel = {
        innerText: `${prompt} Resend email in 30${unit}`,
        getClientRects: () => [{}],
        checkVisibility: () => true,
      };
      const harness = createEmailLinkCardHarness(panel, mailType);
      await waitForAsyncCallbacks();
      const view = harness.state.views[0];
      assert.deepEqual(view.links, [emailLinkMessage]);
      harness.state.now = 11000;
      panel.innerText = `${prompt} Resend email in 29${unit}`;
      harness.state.mutate(stepMutation());
      await harness.run(250);
      assert.equal(
        harness.state.views.length,
        1,
        `${mailType}: ${unit} countdown must keep the card`,
      );
      assert.deepEqual(view.links, [emailLinkMessage]);
      assert.equal(harness.state.requests, 1);
      harness.state.now = 130000;
      await harness.run(8000);
      assert.equal(
        harness.state.requests,
        1,
        "countdown must not restart the two-minute window",
      );
      assert.match(view.status, /Checking finished/);
    }
  }
});

test("countdown completion retains confirmation and reset links and the deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const countdown of [
      "Resend in 30 seconds",
      "Resend email in 30s",
      "Resend in 00:30",
      "Resend email (30)",
      "Resend email (30s)",
      "Resend email (00:30)",
    ]) {
      const prompt =
        mailType === "passwordResetLinks"
          ? "Reset your password. Check your email."
          : "Check your email.";
      const panel = {
        innerText: `${prompt} ${countdown}`,
        getClientRects: () => [{}],
        checkVisibility: () => true,
      };
      const harness = createEmailLinkCardHarness(panel, mailType);
      await waitForAsyncCallbacks();
      harness.state.now = 40000;
      panel.innerText = `${prompt} Resend email`;
      harness.state.mutate(stepMutation());
      await harness.run(250);
      assert.deepEqual(
        harness.state.views.at(-1).links,
        [emailLinkMessage],
        `${mailType}: ${countdown}`,
      );
      assert.equal(harness.state.requests, 1);
      harness.state.now = 130000;
      await harness.run(8000);
      assert.equal(
        harness.state.requests,
        1,
        "countdown completion must not extend polling",
      );
      harness.state.views.at(-1).callbacks.onRetry();
      await waitForAsyncCallbacks();
      assert.deepEqual(
        harness.state.views.at(-1).links,
        [emailLinkMessage],
        "retry retains the current link",
      );
    }
  }
});

test("incidental panel status preserves links, selection, dismissal and the polling deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt =
      mailType === "passwordResetLinks"
        ? "Password reset. Check your email."
        : "Check your email.";
    const panel = {
      innerText: `${prompt} We sent a link to me@yahoo.com.`,
      getClientRects: () => [{}],
      checkVisibility: () => true,
    };
    const harness = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    const view = harness.state.views[0];
    harness.state.now = 20000;
    panel.innerText += "\nConnection restored.";
    harness.state.mutate(stepMutation());
    await harness.run(250);
    assert.equal(harness.state.views.length, 1);
    assert.deepEqual(view.links, [emailLinkMessage]);
    assert.equal(harness.state.requests, 1);
    harness.state.now = 130000;
    await harness.run(8000);
    assert.equal(harness.state.requests, 1);
    assert.match(view.status, /Checking finished/);
    assert.equal(view.callbacks.onSelectLink(emailLinkMessage), true);
    view.callbacks.onClose();
    panel.innerText += "\nStatus updated.";
    harness.state.mutate(stepMutation());
    await harness.run(250);
    assert.equal(harness.state.views.length, 1);
  }
});

test("a dismissed card returns for a new waiting step after the old step disappears", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const harness = createEmailLinkCardHarness(null, mailType);
    await waitForAsyncCallbacks();
    harness.state.views[0].callbacks.onClose();
    harness.state.mutate(stepMutation());
    await harness.run(250);
    assert.equal(
      harness.state.views.length,
      1,
      "the current step stays dismissed",
    );
    harness.state.detected = false;
    harness.state.mutate(stepMutation());
    await harness.run(250);
    harness.state.detected = true;
    harness.state.screenKey = "new signup and recipient";
    harness.state.mutate(stepMutation());
    await harness.run(250);
    assert.equal(harness.state.views.length, 2);
    assert.equal(harness.state.views[1].removed, false);
    assert.equal(harness.state.requests, 2);
  }
});

test("navigation discards a late response and code forms suppress the card", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  let finish;
  harness.state.respond = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = harness.run(8000);
  harness.location.href = "https://example.com/done";
  harness.state.detected = false;
  harness.windowEvents.popstate();
  await harness.run(250);
  finish({
    ok: true,
    confirmationLinks: [{ ...emailLinkMessage, uid: 2 }],
  });
  await pending;
  assert.equal(harness.state.views[0].removed, true);
  assert.equal(harness.state.views[0].links[0].uid, 1);
  harness.state.detected = true;
  harness.state.code = true;
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(harness.state.views.length, 1);
});

test("resend clears old links and expiry prevents opening", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.events.click({
    target: { closest: () => ({ textContent: "Resend email" }) },
  });
  await waitForAsyncCallbacks();
  assert.deepEqual(harness.state.views.at(-1).links, []);
  harness.state.now += 700000;
  assert.equal(
    harness.state.views.at(-1).callbacks.onSelectLink(emailLinkMessage),
    false,
  );
});

test("input-button resends invalidate old confirmation and reset links", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt =
      mailType === "passwordResetLinks"
        ? "Reset your password. Check your email."
        : "Check your email.";
    const panel = {
      innerText: prompt,
      getClientRects: () => [{}],
      checkVisibility: () => true,
    };
    const harness = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    const oldView = harness.state.views[0];
    assert.deepEqual(oldView.links, [emailLinkMessage]);
    harness.state.now = 11000;
    const control = {
      tagName: "INPUT",
      value: "Resend email",
      getAttribute: () => "",
    };
    harness.events.click({
      target: {
        closest(selector) {
          return selector.split(", ").includes("input[type=button]")
            ? control
            : null;
        },
      },
    });
    await waitForAsyncCallbacks();
    assert.equal(oldView.removed, true);
    assert.deepEqual(harness.state.views.at(-1).links, []);
    assert.equal(
      oldView.callbacks.onSelectLink(emailLinkMessage),
      false,
    );
    harness.state.now = 12000;
    const newer = { ...emailLinkMessage, uid: 2, receivedAt: 12000 };
    harness.state.respond = async () => ({
      ok: true,
      [mailType]: [emailLinkMessage, newer],
    });
    await harness.run(8000);
    assert.deepEqual(harness.state.views.at(-1).links, [newer]);
  }
});

test("a text update after resend cannot restore an earlier link", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.state.now = 10050;
  harness.events.click({
    target: { closest: () => ({ textContent: "Resend email" }) },
  });
  await waitForAsyncCallbacks();
  assert.deepEqual(harness.state.views.at(-1).links, []);
  harness.state.screenKey = "Confirmation email sent again";
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.deepEqual(harness.state.views.at(-1).links, []);
  assert.equal(
    harness.state.views.at(-1).callbacks.onSelectLink(emailLinkMessage),
    false,
  );
});

test("a send confirmation control clears old links on the same screen", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  harness.events.click({
    target: {
      closest: () => ({
        textContent: "Send confirmation email",
        getAttribute: () => "",
      }),
    },
  });
  await waitForAsyncCallbacks();
  assert.deepEqual(harness.state.views.at(-1).links, []);
  assert.equal(
    harness.state.views[0].callbacks.onSelectLink(emailLinkMessage),
    false,
  );
});

test("a new confirmation step on the same URL clears links from the previous step", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const oldView = harness.state.views[0];
  assert.deepEqual(oldView.links, [emailLinkMessage]);
  harness.state.now = 20_000;
  harness.state.screenKey = "second signup";
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.onSelectLink(emailLinkMessage), false);
  assert.deepEqual(harness.state.views.at(-1).links, []);
  harness.state.now = 21_000;
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [
      emailLinkMessage,
      { ...emailLinkMessage, uid: 2, receivedAt: 21_000 },
    ],
  });
  await harness.run(8000);
  assert.deepEqual(
    harness.state.views.at(-1).links.map((link) => link.uid),
    [2],
  );
});

test("a confirmation step change excludes a link received moments before it", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const oldView = harness.state.views[0];
  assert.deepEqual(oldView.links, [emailLinkMessage]);
  harness.state.now = 11_000;
  harness.state.screenKey = "second signup";
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(oldView.removed, true);
  assert.deepEqual(harness.state.views.at(-1).links, []);
  assert.equal(
    harness.state.views.at(-1).callbacks.onSelectLink(emailLinkMessage),
    false,
  );
});

test("a reused confirmation panel resets links when its signup changes", async () => {
  const panel = {
    innerText: "Check your email for alice@example.test",
    getClientRects: () => [{}],
    checkVisibility: () => true,
  };
  const harness = createEmailLinkCardHarness(panel);
  await waitForAsyncCallbacks();
  const oldView = harness.state.views[0];
  assert.deepEqual(oldView.links, [emailLinkMessage]);
  harness.state.now = 20_000;
  panel.innerText = "Check your email for bob@example.test";
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.onSelectLink(emailLinkMessage), false);
  assert.deepEqual(harness.state.views.at(-1).links, []);
  harness.state.now = 21_000;
  harness.state.respond = async () => ({
    ok: true,
    confirmationLinks: [
      emailLinkMessage,
      { ...emailLinkMessage, uid: 2, receivedAt: 21_000 },
    ],
  });
  await harness.run(8000);
  assert.deepEqual(
    harness.state.views.at(-1).links.map((link) => link.uid),
    [2],
  );
});

test("confirmation instructions select confirmation mail despite unrelated password navigation", async () => {
  const panel = {
    innerText:
      "Check your email to confirm your account. Sign in. Forgot password?",
    getClientRects: () => [{}],
    checkVisibility: () => true,
  };
  const harness = createEmailLinkCardHarness(panel);
  await waitForAsyncCallbacks();
  assert.equal(harness.state.views[0].callbacks.mailType, "confirmationLinks");
  assert.deepEqual(harness.state.views[0].links, [emailLinkMessage]);
});

test("line-separated reset headings select reset mail", async () => {
  const panel = {
    innerText: "Forgot password?\nCheck your inbox\nSign in",
    getClientRects: () => [{}],
    checkVisibility: () => true,
  };
  const harness = createEmailLinkCardHarness(panel, "passwordResetLinks");
  await waitForAsyncCallbacks();
  assert.equal(harness.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(harness.state.views[0].links, [emailLinkMessage]);
});

test("reset instructions spanning continuation lines select reset mail", async () => {
  const panel = {
    innerText:
      "Check your email\nWe have sent you a link to\nreset your password",
    getClientRects: () => [{}],
    checkVisibility: () => true,
  };
  const harness = createEmailLinkCardHarness(panel, "passwordResetLinks");
  await waitForAsyncCallbacks();
  assert.equal(harness.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(harness.state.views[0].links, [emailLinkMessage]);
});

test("a purpose change with the same step key discards old results and switches requests", async () => {
  const harness = createEmailLinkCardHarness();
  await waitForAsyncCallbacks();
  const oldView = harness.state.views.at(-1);
  harness.state.mailType = "passwordResetLinks";
  const newer = { ...emailLinkMessage, uid: 2, receivedAt: 11000 };
  harness.state.respond = async () => ({
    ok: true,
    passwordResetLinks: [newer],
  });
  harness.state.mutate(stepMutation());
  await harness.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(
    harness.state.views.at(-1).callbacks.mailType,
    "passwordResetLinks",
  );
  assert.deepEqual(harness.state.views.at(-1).links, []);
  harness.state.now = 11000;
  await harness.run(8000);
  assert.deepEqual(harness.state.views.at(-1).links, [newer]);
});

test("parenthesised countdown ticks retain links without restarting the attempt", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt =
      mailType === "passwordResetLinks"
        ? "Reset your password. Check your email."
        : "Check your email.";
    const panel = {
      innerText: `${prompt} Resend email (30)`,
      getClientRects: () => [{}],
      checkVisibility: () => true,
    };
    const harness = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    const view = harness.state.views[0];
    assert.deepEqual(view.links, [emailLinkMessage]);
    harness.state.now = 11000;
    panel.innerText = `${prompt} Resend email (29)`;
    harness.state.mutate(stepMutation());
    await harness.run(250);
    assert.equal(harness.state.views.length, 1);
    assert.deepEqual(view.links, [emailLinkMessage]);
    assert.equal(harness.state.requests, 1);
  }
});

test("another form's resend retains links while the waiting form's resend clears them", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const panel = {
      innerText:
        mailType === "passwordResetLinks"
          ? "Reset your password. Check your email."
          : "Check your email.",
      closest() {
        return this;
      },
      getClientRects: () => [{}],
      checkVisibility: () => true,
    };
    const harness = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    const view = harness.state.views.at(-1);
    const control = { textContent: "Resend SMS code", form: {} };
    harness.events.click({ target: { closest: () => control } });
    await waitForAsyncCallbacks();
    assert.equal(view.removed, false);
    assert.deepEqual(view.links, [emailLinkMessage]);
    assert.equal(view.callbacks.onSelectLink(emailLinkMessage), true);
    // Confirmation selection dismisses the card; use a fresh setup for resend.
    const next = createEmailLinkCardHarness(panel, mailType);
    await waitForAsyncCallbacks();
    control.form = panel;
    control.textContent = "Resend email";
    next.events.click({ target: { closest: () => control } });
    await waitForAsyncCallbacks();
    assert.deepEqual(next.state.views.at(-1).links, []);
  }
});
