export const REQUEST_CONTROL_SELECTOR = "button, a, [role=button], input[type=button], input[type=submit]";

export function getRequestControlLabel(control) {
  return (control?.getAttribute?.("aria-label") ||
    (control?.tagName === "INPUT" ? control.value : control?.textContent) || "")
    .replace(/\s+/g, " ").trim();
}

export function normalizeStepText(text) {
  return text
    // A resend button becoming available does not start a new mail attempt.
    // Its optional object and countdown can both change when the timer ends.
    .replace(/\b(?:re-?send|send again)\b(?:\s+(?:(?:confirmation|verification|activation|password reset|reset)\s+)?(?:e-?mail|codes?|links?))?(?:\s+(?:(?:in|after)\s+)?(?:\d{1,2}:\d{2}|\d{1,3}(?:\s*(?:seconds?|minutes?|secs?|mins?|s|m))?)\b)?/gi, "# resend")
    .replace(/\b\d{1,2}:\d{2}\b/g, "#")
    .replace(/\b(?:retry|try again|expires?|wait)\s+(?:in\s+|after\s+)?\d{1,3}(?:\s*(?:seconds?|minutes?|secs?|mins?|s|m))?\b/gi, "# timer")
    .replace(/\b\d+\s*(?:seconds?|minutes?|secs?|mins?|s|m)\b/gi, "# time")
    .replace(/\s+/g, " ").trim();
}
