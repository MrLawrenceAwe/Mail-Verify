export const REQUEST_CONTROL_SELECTOR = "button, a, [role=button], input[type=button], input[type=submit]";

export function getRequestControlLabel(control) {
  return (control?.getAttribute?.("aria-label") ||
    (control?.tagName === "INPUT" ? control.value : control?.textContent) || "")
    .replace(/\s+/g, " ").trim();
}
