import test from "node:test";
import assert from "node:assert/strict";
import { detectEmailLinkStep, matchesPasswordResetWaitingPrompt } from "../extension/inline/email-link-step.js";

function detectedMailType(text) {
  const panel = { innerText: text, getClientRects: () => [{}], checkVisibility: () => true };
  return detectEmailLinkStep({ querySelectorAll: () => [panel] })?.mailType;
}

test("classifies confirmation prompts without treating resets, newsletters or long pages as confirmation", () => {
  for (const text of ["Check your inbox", "We've sent a verification email", "Follow the link in your email to confirm your account"])
    assert.equal(detectedMailType(text), "confirmationLinks", text);
  for (const text of ["Reset your password. Check your email", "Check your email for our newsletter", "Welcome to our website", "x".repeat(2501) + " Check your email"])
    assert.notEqual(detectedMailType(text), "confirmationLinks", text);
});

test("large panels are rejected before layout and rendered-text extraction", () => {
  const panel = {
    nodeType: 1,
    get innerText() { assert.fail("must not extract a large panel's rendered text"); },
    getClientRects() { assert.fail("must not request layout for a large panel"); },
  };
  panel.firstChild = { nodeType: 3, data: "x".repeat(10001), parentNode: panel };
  assert.equal(detectEmailLinkStep({ querySelectorAll: () => [panel] }), null);
});

test("panel traversal stops at its node budget and still checks a later short panel", () => {
  let inspected = 0;
  const large = {
    nodeType: 1,
    get innerText() { assert.fail("must not read oversized panels"); },
    getClientRects() { assert.fail("must not lay out oversized panels"); },
  };
  let previous;
  for (let index = 0; index < 2000; index++) {
    const node = { nodeType: 1, parentNode: large,
      get firstChild() { inspected++; return null; } };
    if (previous) previous.nextSibling = node;
    else large.firstChild = node;
    previous = node;
  }
  const small = { nodeType: 1, innerText: "Check your email", getClientRects: () => [{}], checkVisibility: () => true };
  assert.equal(detectEmailLinkStep({ querySelectorAll: () => [large, small] }).mailType, "confirmationLinks");
  assert.ok(inspected < 500);
});

test("large body fallback is bounded, while hidden templates do not reject a short panel", () => {
  const body = { nodeType: 1, firstChild: { nodeType: 3, data: "x".repeat(10001) } };
  assert.equal(detectEmailLinkStep({ querySelectorAll: () => [], body }), null);
  const panel = { nodeType: 1, innerText: "Reset your password. Check your email",
    getClientRects: () => [{}], checkVisibility: () => true };
  const template = { nodeType: 1, tagName: "TEMPLATE", parentNode: panel,
    get firstChild() { assert.fail("must not traverse template content"); } };
  panel.firstChild = template;
  template.nextSibling = { nodeType: 3, data: panel.innerText, parentNode: panel };
  assert.equal(detectEmailLinkStep({ querySelectorAll: () => [panel] }).mailType, "passwordResetLinks");
});

test("distinguishes replacement confirmation panels with identical text", () => {
  const panel = () => ({ innerText: "Check your email", getClientRects: () => [{}], checkVisibility: () => true });
  let current = panel();
  const document = { querySelectorAll: () => [current] };
  const first = detectEmailLinkStep(document);
  assert.deepEqual(detectEmailLinkStep(document), first);
  current = panel();
  assert.notDeepEqual(detectEmailLinkStep(document), first);
});

test("countdown changes keep the same confirmation step", () => {
  const panel = { innerText: "Check your email. Resend in 30 seconds", getClientRects: () => [{}], checkVisibility: () => true };
  const document = { querySelectorAll: () => [panel] };
  const first = detectEmailLinkStep(document);
  panel.innerText = "Check your email. Resend in 29 seconds";
  assert.deepEqual(detectEmailLinkStep(document), first);
});

test("status messages and unrelated contact addresses retain the email request identity", () => {
  for (const prompt of ["Check your email", "Reset your password. Check your email"]) {
    const panel = { innerText: `${prompt}\nWe sent a link to preview@yahoo.com.`,
      getClientRects: () => [{}], checkVisibility: () => true };
    const document = { querySelectorAll: () => [panel] };
    const first = detectEmailLinkStep(document);
    panel.innerText += '\nConnection restored.\nContact support@example.test for help. Email help@example.test.';
    assert.deepEqual(detectEmailLinkStep(document), first);
    panel.innerText = panel.innerText.replace('preview@yahoo.com', 'another@yahoo.com');
    assert.notEqual(detectEmailLinkStep(document).key, first.key);
  }
});

test("an active native modal takes precedence over background waiting panels", () => {
  const modal = { innerText: 'Password reset. Check your email.',
    getClientRects: () => [{}], checkVisibility: () => true };
  const background = { innerText: 'Check your email',
    getClientRects: () => [{}], checkVisibility: () => true };
  assert.equal(detectEmailLinkStep({ querySelector: () => modal,
    querySelectorAll: () => [background] }).mailType, 'passwordResetLinks');
});

test("detects reset email waiting screens while excluding request and new-password forms", () => {
  for (const text of ["Reset your password. Check your inbox", "Password reset link sent to your email", "We sent a link to reset your password", "Follow the link in your email to change your password"])
    assert.equal(matchesPasswordResetWaitingPrompt(text), true, text);
  for (const text of ["Forgot password? Enter your email", "Choose a new password", "Check your email", "Reset password newsletter. Check your email", "x".repeat(2501)])
    assert.equal(matchesPasswordResetWaitingPrompt(text), false, text);
});

test("reset intent must belong to the email instruction or its heading", () => {
  for (const innerText of [
    "Check your email. Sign in. Forgot password?",
    "Check your email. Contact support. Reset password",
  ]) assert.equal(matchesPasswordResetWaitingPrompt(innerText), false, innerText);
  for (const innerText of [
    "Forgot password? Check your inbox for the reset link",
    "Check your email for a password reset link. Sign in",
    "We sent you a link to reset your password. Sign in",
  ]) assert.equal(matchesPasswordResetWaitingPrompt(innerText), true, innerText);
});

test("line-separated navigation still cannot select reset mail type", () => {
  for (const text of [
    "Check your email\nForgot password?",
    "Check your email\nSign in\nReset password",
    "Check your email to confirm your account\nForgot password?",
  ]) {
    assert.equal(matchesPasswordResetWaitingPrompt(text), false, text);
    assert.equal(detectedMailType(text), "confirmationLinks", text);
  }
});

test("step detection reads each visible panel once and returns its purpose separately", () => {
  let reads = 0;
  const panel = {
    get innerText() { reads++; return "Reset your password. Check your email."; },
    getClientRects: () => [{}], checkVisibility: () => true,
  };
  const step = detectEmailLinkStep({ querySelectorAll: () => [panel] });
  assert.equal(reads, 1);
  assert.equal(step.mailType, "passwordResetLinks");
  assert.doesNotMatch(step.key, /^passwordResetLinks:/);
});

test("unrelated password navigation cannot override explicit confirmation instructions", () => {
  for (const text of [
    "Check your email to confirm your account. Sign in. Forgot password?",
    "Check your inbox to verify your email. Forgot password?",
    "We sent an activation email. Sign in. Forgot password?",
  ]) {
    assert.equal(matchesPasswordResetWaitingPrompt(text), false, text);
    assert.equal(detectedMailType(text), "confirmationLinks", text);
  }
});

test("line-separated headings and continuation lines retain reset intent", () => {
  for (const text of [
    "Forgot password?\nCheck your inbox\nSign in",
    "Check your email\nWe have sent you a link to\nreset your password",
    "Check your inbox\nWe sent you a\nlink to\nreset your\npassword",
    "Check your email\nWe sent you a link\nto reset your password",
  ]) {
    assert.equal(matchesPasswordResetWaitingPrompt(text), true, text);
    assert.equal(detectedMailType(text), "passwordResetLinks", text);
  }
});
