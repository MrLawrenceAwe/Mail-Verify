import { normalizeStepText } from "../shared/step-text.js";

const emailLinkPanelIds = new WeakMap();
let nextEmailLinkPanelId = 1;
const MAX_PANEL_NODES = 500;
const MAX_PANEL_TEXT_UNITS = 10_000;

function isBoundedPanel(panel) {
  // Bound traversal before any layout or full rendered-text reads. Hidden
  // templates and non-rendered content do not consume the text budget.
  let count = 0, textUnits = 0;
  for (let node = panel; node;) {
    if (++count > MAX_PANEL_NODES) return false;
    if (node.nodeType === 3) {
      textUnits += node.data.length;
      if (textUnits > MAX_PANEL_TEXT_UNITS) return false;
    }
    const skipChildren = node.hidden || /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName);
    if (!skipChildren && node.firstChild) {
      node = node.firstChild;
      continue;
    }
    while (node !== panel && !node.nextSibling) node = node.parentNode;
    node = node === panel ? null : node.nextSibling;
  }
  return true;
}

function matchesConfirmationPrompt(text) {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 2500 || /\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  return /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b/i.test(value) ||
    /\b(?:we(?:'ve| have)?\s+)?sent\b.{0,65}\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i.test(value) ||
    /\b(?:click|follow|open)\b.{0,45}\blink\b.{0,70}\b(?:confirm|verify|activate)\b.{0,30}\b(?:e-?mail|account)\b/i.test(value);
}

export function matchesPasswordResetWaitingPrompt(text) {
  const value = text.trim();
  if (!value || value.length > 2500 || /\b(?:newsletter|unsubscribe)\b/i.test(value)) return false;
  const passwordReset = /\b(?:reset|forgot|recover|change)\b.{0,35}\bpassword\b|\bpassword\b.{0,35}\b(?:reset|recovery)\b/i;
  const resetHeading = /^(?:(?:reset|forgot|recover|change)\s+(?:(?:your|my|the)\s+)?password|password\s+(?:reset|recovery))$/i;
  const emailSent = /\bcheck\s+(?:your\s+)?(?:e-?mail|inbox)\b|\bsent\b.{0,80}\b(?:e-?mail|link)\b|\b(?:e-?mail|link)\b.{0,40}\bsent\b|\b(?:click|follow|open)\b.{0,45}\blink\b/i;
  const confirmation = /\b(?:confirm|verify|activate)\b.{0,35}\b(?:e-?mail|account)\b|\b(?:confirmation|verification|activation)\s+(?:e-?mail|link)\b/i;
  // Bind the purpose to the waiting instruction or the heading immediately
  // before it. Navigation elsewhere in the panel must not switch link mail types.
  // Join grammatical continuations across elements, while retaining line
  // boundaries for standalone headings and navigation such as Forgot password.
  const instructions = value
    .replace(/\b(to|your|my|the|a|an|for)[ \t]*\n+[ \t]*/gi, "$1 ")
    .replace(/\b(link|email)[ \t]*\n+[ \t]*(?=to\s+(?:reset|change|recover)\b)/gi, "$1 ");
  const phrases = instructions.split(/[.!?](?:\s+|$)|\n+/)
    .map(phrase => phrase.replace(/\s+/g, " ").trim()).filter(Boolean);
  return phrases.some((phrase, index) => emailSent.test(phrase) && !confirmation.test(phrase) &&
    (passwordReset.test(phrase) || resetHeading.test(phrases[index - 1] || "")));
}

export function detectEmailLinkStep(document) {
  // Inspect short visible task panels, never hidden templates or the extension card.
  const panels = [...document.querySelectorAll("main, [role=main], form, [role=dialog]")];
  if (!panels.length) panels.push(document.body);
  for (const panel of panels) {
    if (!panel || !isBoundedPanel(panel) || !panel.getClientRects().length ||
        !panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const text = panel.innerText || "";
    const mailType = matchesPasswordResetWaitingPrompt(text) ? "passwordResetLinks"
      : matchesConfirmationPrompt(text) ? "confirmationLinks" : null;
    if (!mailType) continue;
    if (!emailLinkPanelIds.has(panel)) emailLinkPanelIds.set(panel, nextEmailLinkPanelId++);
    // Countdown changes retain the step; a new task in the same panel changes it.
    return { key: `${emailLinkPanelIds.get(panel)}:${normalizeStepText(text)}`, mailType };
  }
  return null;
}
