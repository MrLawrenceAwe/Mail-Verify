import assert from "node:assert/strict";
import test from "node:test";
import { createEmailLinkCardHarness, settle, item, stepMutation } from "./email_link_card_harness.js";

test("short-unit countdown ticks retain links and the polling deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const unit of ["s", "m"]) {
      const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
      const panel = { innerText: `${prompt} Resend email in 30${unit}`, getClientRects: () => [{}], checkVisibility: () => true };
      const f = createEmailLinkCardHarness(panel, mailType); await settle();
      const view = f.state.views[0];
      assert.deepEqual(view.links, [item]);
      f.state.now = 11000;
      panel.innerText = `${prompt} Resend email in 29${unit}`;
      f.state.mutate(stepMutation()); await f.run(250);
      assert.equal(f.state.views.length, 1, `${mailType}: ${unit} countdown must keep the card`);
      assert.deepEqual(view.links, [item]);
      assert.equal(f.state.requests, 1);
      f.state.now = 130000;
      await f.run(8000);
      assert.equal(f.state.requests, 1, "countdown must not restart the two-minute window");
      assert.match(view.status, /Checking finished/);
    }
  }
});

test("countdown completion retains confirmation and reset links and the deadline", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    for (const countdown of ["Resend in 30 seconds", "Resend email in 30s", "Resend in 00:30", "Resend email (30)", "Resend email (30s)", "Resend email (00:30)"]) {
      const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
      const panel = { innerText: `${prompt} ${countdown}`, getClientRects: () => [{}], checkVisibility: () => true };
      const f = createEmailLinkCardHarness(panel, mailType); await settle();
      f.state.now = 40000;
      panel.innerText = `${prompt} Resend email`;
      f.state.mutate(stepMutation()); await f.run(250);
      assert.deepEqual(f.state.views.at(-1).links, [item], `${mailType}: ${countdown}`);
      assert.equal(f.state.requests, 1);
      f.state.now = 130000;
      await f.run(8000);
      assert.equal(f.state.requests, 1, "countdown completion must not extend polling");
      f.state.views.at(-1).callbacks.onRetry(); await settle();
      assert.deepEqual(f.state.views.at(-1).links, [item], "retry retains the current link");
    }
  }
});

test("incidental panel status preserves links, selection, dismissal and the polling deadline", async () => {
  for (const mailType of ['confirmationLinks', 'passwordResetLinks']) {
    const prompt = mailType === 'passwordResetLinks' ? 'Password reset. Check your email.' : 'Check your email.';
    const panel = { innerText: `${prompt} We sent a link to me@yahoo.com.`,
      getClientRects: () => [{}], checkVisibility: () => true };
    const f = createEmailLinkCardHarness(panel, mailType); await settle();
    const view = f.state.views[0];
    f.state.now = 20000;
    panel.innerText += '\nConnection restored.';
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.deepEqual(view.links, [item]);
    assert.equal(f.state.requests, 1);
    f.state.now = 130000;
    await f.run(8000);
    assert.equal(f.state.requests, 1);
    assert.match(view.status, /Checking finished/);
    assert.equal(view.callbacks.onSelectLink(item), true);
    view.callbacks.onClose();
    panel.innerText += '\nStatus updated.';
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
  }
});

test("a dismissed card returns for a new waiting step after the old step disappears", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const f = createEmailLinkCardHarness(null, mailType); await settle();
    f.state.views[0].callbacks.onClose();
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1, "the current step stays dismissed");
    f.state.detected = false;
    f.state.mutate(stepMutation()); await f.run(250);
    f.state.detected = true;
    f.state.screenKey = "new signup and recipient";
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 2);
    assert.equal(f.state.views[1].removed, false);
    assert.equal(f.state.requests, 2);
  }
});

test("navigation discards a late response and code forms suppress the card", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  let finish;
  f.state.respond = () => new Promise(resolve => { finish = resolve; });
  const pending = f.run(8000);
  f.location.href = "https://example.com/done";
  f.state.detected = false;
  f.windowEvents.popstate(); await f.run(250);
  finish({ ok: true, confirmationLinks: [{ ...item, uid: 2 }] }); await pending;
  assert.equal(f.state.views[0].removed, true);
  assert.equal(f.state.views[0].links[0].uid, 1);
  f.state.detected = true; f.state.code = true;
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(f.state.views.length, 1);
});

test("resend clears old links and expiry prevents opening", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Resend email" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now += 700000;
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("input-button resends invalidate old confirmation and reset links", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
    const panel = { innerText: prompt, getClientRects: () => [{}], checkVisibility: () => true };
    const f = createEmailLinkCardHarness(panel, mailType); await settle();
    const oldView = f.state.views[0];
    assert.deepEqual(oldView.links, [item]);
    f.state.now = 11000;
    const control = { tagName: "INPUT", value: "Resend email", getAttribute: () => "" };
    f.events.click({ target: { closest(selector) {
      return selector.split(", ").includes("input[type=button]") ? control : null;
    } } });
    await settle();
    assert.equal(oldView.removed, true);
    assert.deepEqual(f.state.views.at(-1).links, []);
    assert.equal(oldView.callbacks.onSelectLink(item), false);
    f.state.now = 12000;
    const newer = { ...item, uid: 2, receivedAt: 12000 };
    f.state.respond = async () => ({ ok: true, [mailType]: [item, newer] });
    await f.run(8000);
    assert.deepEqual(f.state.views.at(-1).links, [newer]);
  }
});

test("a text update after resend cannot restore an earlier link", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  f.state.now = 10050;
  f.events.click({ target: { closest: () => ({ textContent: "Resend email" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.screenKey = "Confirmation email sent again";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("a send confirmation control clears old links on the same screen", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  f.events.click({ target: { closest: () => ({ textContent: "Send confirmation email", getAttribute: () => "" }) } });
  await settle();
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views[0].callbacks.onSelectLink(item), false);
});

test("a new confirmation step on the same URL clears links from the previous step", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  f.state.screenKey = "second signup";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.onSelectLink(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, confirmationLinks: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
  await f.run(8000);
  assert.deepEqual(f.state.views.at(-1).links.map(link => link.uid), [2]);
});

test("a confirmation step change excludes a link received moments before it", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 11_000;
  f.state.screenKey = "second signup";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.deepEqual(f.state.views.at(-1).links, []);
  assert.equal(f.state.views.at(-1).callbacks.onSelectLink(item), false);
});

test("a reused confirmation panel resets links when its signup changes", async () => {
  const panel = { innerText: "Check your email for alice@example.test", getClientRects: () => [{}], checkVisibility: () => true };
  const f = createEmailLinkCardHarness(panel); await settle();
  const oldView = f.state.views[0];
  assert.deepEqual(oldView.links, [item]);
  f.state.now = 20_000;
  panel.innerText = "Check your email for bob@example.test";
  f.state.mutate(stepMutation()); await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(oldView.callbacks.onSelectLink(item), false);
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 21_000;
  f.state.respond = async () => ({ ok: true, confirmationLinks: [item, { ...item, uid: 2, receivedAt: 21_000 }] });
  await f.run(8000);
  assert.deepEqual(f.state.views.at(-1).links.map(link => link.uid), [2]);
});

test("confirmation instructions select confirmation mail despite unrelated password navigation", async () => {
  const panel = { innerText: "Check your email to confirm your account. Sign in. Forgot password?",
    getClientRects: () => [{}], checkVisibility: () => true };
  const f = createEmailLinkCardHarness(panel); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "confirmationLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("line-separated reset headings select reset mail", async () => {
  const panel = { innerText: "Forgot password?\nCheck your inbox\nSign in", getClientRects: () => [{}], checkVisibility: () => true };
  const f = createEmailLinkCardHarness(panel, "passwordResetLinks"); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("reset instructions spanning continuation lines select reset mail", async () => {
  const panel = { innerText: "Check your email\nWe have sent you a link to\nreset your password",
    getClientRects: () => [{}], checkVisibility: () => true };
  const f = createEmailLinkCardHarness(panel, "passwordResetLinks"); await settle();
  assert.equal(f.state.views[0].callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views[0].links, [item]);
});

test("a purpose change with the same step key discards old results and switches requests", async () => {
  const f = createEmailLinkCardHarness(); await settle();
  const oldView = f.state.views.at(-1);
  f.state.mailType = "passwordResetLinks";
  const newer = { ...item, uid: 2, receivedAt: 11000 };
  f.state.respond = async () => ({ ok: true, passwordResetLinks: [newer] });
  f.state.mutate(stepMutation());
  await f.run(250);
  assert.equal(oldView.removed, true);
  assert.equal(f.state.views.at(-1).callbacks.mailType, "passwordResetLinks");
  assert.deepEqual(f.state.views.at(-1).links, []);
  f.state.now = 11000;
  await f.run(8000);
  assert.deepEqual(f.state.views.at(-1).links, [newer]);
});

test("parenthesised countdown ticks retain links without restarting the attempt", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const prompt = mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.";
    const panel = { innerText: `${prompt} Resend email (30)`, getClientRects: () => [{}], checkVisibility: () => true };
    const f = createEmailLinkCardHarness(panel, mailType); await settle();
    const view = f.state.views[0];
    assert.deepEqual(view.links, [item]);
    f.state.now = 11000;
    panel.innerText = `${prompt} Resend email (29)`;
    f.state.mutate(stepMutation()); await f.run(250);
    assert.equal(f.state.views.length, 1);
    assert.deepEqual(view.links, [item]);
    assert.equal(f.state.requests, 1);
  }
});

test("another form's resend retains links while the waiting form's resend clears them", async () => {
  for (const mailType of ["confirmationLinks", "passwordResetLinks"]) {
    const panel = { innerText: mailType === "passwordResetLinks" ? "Reset your password. Check your email." : "Check your email.",
      closest() { return this; }, getClientRects: () => [{}], checkVisibility: () => true };
    const f = createEmailLinkCardHarness(panel, mailType);
    await settle();
    const view = f.state.views.at(-1);
    const control = { textContent: "Resend SMS code", form: {} };
    f.events.click({ target: { closest: () => control } });
    await settle();
    assert.equal(view.removed, false);
    assert.deepEqual(view.links, [item]);
    assert.equal(view.callbacks.onSelectLink(item), true);
    // Confirmation selection dismisses the card; use a fresh setup for resend.
    const next = createEmailLinkCardHarness(panel, mailType);
    await settle();
    control.form = panel;
    control.textContent = "Resend email";
    next.events.click({ target: { closest: () => control } });
    await settle();
    assert.deepEqual(next.state.views.at(-1).links, []);
  }
});
