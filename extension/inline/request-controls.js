export const REQUEST_CONTROL_SELECTOR =
  "button, a, [role=button], input[type=button], input[type=submit]";

export function getRequestControlLabel(control) {
  return (
    control?.getAttribute?.("aria-label") ||
    (control?.tagName === "INPUT" ? control.value : control?.textContent) ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function isPhoneOnlyRequestLabel(label) {
  return (
    /\b(?:sms|text(?:\s+message)?|phone|mobile|telephone|whatsapp|voice|call)\b/i.test(
      label,
    ) && !/\be-?mail\b/i.test(label)
  );
}

// A form owns its controls even when they live outside its DOM subtree.
function requestControlScope(element) {
  return (
    element?.form ||
    element?.closest?.("form, dialog, [role=dialog], main, [role=main]")
  );
}

export function belongsToVerificationStep(control, stepElement) {
  const controlScope = requestControlScope(control);
  // Standalone resend controls can sit beside the verification panel.
  return !controlScope || controlScope === requestControlScope(stepElement);
}
