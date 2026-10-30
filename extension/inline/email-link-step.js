import { recipientKeyFromText } from "./recipient-identity.js";
import { findActiveModal } from "./active-modal.js";

export const EMAIL_LINK_PANEL_SELECTOR =
  "main, [role=main], form, [role=dialog], dialog";

const emailLinkPanelIds = new WeakMap();
let nextEmailLinkPanelId = 1;
const MAX_PANEL_NODES = 500;
const MAX_PANEL_TEXT_UNITS = 10_000;
const MAX_RENDERED_PANEL_TEXT_UNITS = 2_500;

function recipientIdentity(text) {
  return recipientKeyFromText(text, (context) => {
    const instruction = context
      .replace(/\s+/g, " ")
      .split(/[.!?](?:\s+|$)/)
      .at(-1);
    return (
      /\b(?:check\s+(?:your\s+)?(?:e-?mail|inbox)|sent|emailed|(?:confirmation|verification|activation|reset)\s+(?:e-?mail|link))\b/i.test(
        instruction,
      ) &&
      /\b(?:to|for|at|emailed|e-?mail(?:\s+address)?|inbox)\s*[:=-]?\s*$/i.test(instruction)
    );
  });
}

function isWithinPanelBudget(panel) {
  // Bound traversal before layout or rendered-text reads. Skip descendants of
  // hidden elements, scripts, styles, and templates; CSS and aria-hidden
  // do not affect this raw-text budget.
  let count = 0,
    textUnits = 0;
  for (let node = panel; node; ) {
    if (++count > MAX_PANEL_NODES) return false;
    if (node.nodeType === 3) {
      textUnits += node.data.length;
      if (textUnits > MAX_PANEL_TEXT_UNITS) return false;
    }
    const skipChildren =
      node.hidden || /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName);
    if (!skipChildren && node.firstChild) {
      node = node.firstChild;
      continue;
    }
    while (node !== panel && !node.nextSibling) node = node.parentNode;
    node = node === panel ? null : node.nextSibling;
  }
  return true;
}

function matchesConfirmationWaitingPrompt(text) {
  // Generic “Check your email” prompts qualify when no reset purpose is detected.
  const value = text.replace(/\s+/g, " ").trim();
  return (
    /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b/i.test(value) ||
    /\b(?:click|follow|open)\s+the\s+link\s+(?:(?:that\s+was|we(?:'ve| have)?)\s+)?sent\s+to\s+(?:(?:your\s+)?(?:e-?mail(?:\s+address)?|inbox)\b|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b)/i.test(
      value,
    ) ||
    /\be-?mail\s+has\s+been\s+sent\s+to\s+you[.!]?\s+(?:please\s+)?(?:verify|confirm|activate)\s+your\s+(?:account|e-?mail(?:\s+address)?)\b/i.test(
      value,
    ) ||
    /\be-?mail\s+has\s+been\s+sent\s+to\s+you\b.{0,160}\byour\s+account\s+may\s+need\s+verification\b/i.test(
      value,
    ) ||
    /\b(?:we(?:'ve| have)?\s+)?sent\b.{0,65}\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i.test(
      value,
    ) ||
    /\b(?:confirmation|verification|activation)\s+link\s+(?:(?:that\s+was|we(?:'ve| have)?)\s+)?sent\s+to\s+(?:your\s+)?(?:e-?mail(?:\s+address)?|inbox)\b/i.test(
      value,
    ) ||
    /\b(?:click|follow|open)\b.{0,45}\blink\b.{0,70}\b(?:confirm|verify|activate)\b.{0,30}\b(?:e-?mail|account)\b/i.test(
      value,
    )
  );
}

function matchesPasswordResetWaitingPrompt(value) {
  const passwordReset =
    /\b(?:reset|forgot|recover|change)\b.{0,35}\bpassword\b|\bpassword\b.{0,35}\b(?:reset|recovery)\b/i;
  const resetHeading =
    /^(?:(?:reset|forgot|recover|change)\s+(?:(?:your|my|the)\s+)?password|password\s+(?:reset|recovery))$/i;
  const emailSent =
    /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b|\bsent\b.{0,80}\b(?:e-?mail|link)\b|\b(?:e-?mail|link)\b.{0,40}\bsent\b|\b(?:click|follow|open)\b.{0,45}\blink\b/i;
  const confirmation =
    /\b(?:confirm|verify|activate)\b.{0,35}\b(?:e-?mail|account)\b|\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i;
  // Bind the purpose to the waiting instruction or the heading immediately
  // before it. Navigation elsewhere in the panel must not switch link mail types.
  // Join grammatical continuations across elements, while retaining line
  // boundaries for standalone headings and navigation such as Forgot password.
  const instructions = value
    .replace(/\b(to|your|my|the|a|an|for)[ \t]*\n+[ \t]*/gi, "$1 ")
    .replace(
      /\b(link|email)[ \t]*\n+[ \t]*(?=to\s+(?:reset|change|recover)\b)/gi,
      "$1 ",
    );
  const phrases = instructions
    .split(/[.!?](?:\s+|$)|\n+/)
    .map((phrase) => phrase.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return phrases.some(
    (phrase, index) =>
      emailSent.test(phrase) &&
      !confirmation.test(phrase) &&
      (passwordReset.test(phrase) ||
        resetHeading.test(phrases[index - 1] || "")),
  );
}

export function detectEmailLinkStep(document) {
  // Inspect short visible task panels, never hidden templates or the extension card.
  const modal = findActiveModal(document);
  const panels = modal
    ? [modal, ...modal.querySelectorAll(EMAIL_LINK_PANEL_SELECTOR)]
    : [...document.querySelectorAll(EMAIL_LINK_PANEL_SELECTOR)];
  if (!panels.length) panels.push(document.body);
  let detectedStep = null;
  for (const panel of panels) {
    if (detectedStep && !detectedStep.panel.contains?.(panel)) continue;
    if (
      !panel ||
      !isWithinPanelBudget(panel) ||
      !panel.getClientRects().length ||
      !panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    )
      continue;
    // Validate once before purpose matching; keep line breaks for reset headings.
    const text = (panel.innerText || "").trim();
    if (
      !text ||
      text.length > MAX_RENDERED_PANEL_TEXT_UNITS ||
      /\b(?:newsletter|unsubscribe)\b/i.test(text)
    )
      continue;
    const mailType = matchesPasswordResetWaitingPrompt(text)
      ? "passwordResetLinks"
      : matchesConfirmationWaitingPrompt(text)
        ? "confirmationLinks"
        : null;
    if (!mailType) continue;
    if (!emailLinkPanelIds.has(panel))
      emailLinkPanelIds.set(panel, nextEmailLinkPanelId++);
    // Status text and countdowns do not identify a new email request.
    // The key tracks panel and recipient; controllers compare mailType separately.
    // Prefer the waiting form inside a larger task panel, so its resend
    // controls cannot be confused with another form in the same main region.
    detectedStep = {
      key: `${emailLinkPanelIds.get(panel)}:${recipientIdentity(text)}`,
      mailType,
      panel,
    };
  }
  return detectedStep;
}
