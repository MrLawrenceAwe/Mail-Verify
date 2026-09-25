export function fillCode(code, detectOnly = false) {
  // Detection is read-only; filling happens only after the user selects a code.
  const isVisible = (el) => {
    if (
      el.disabled ||
      el.readOnly ||
      el.type === "hidden" ||
      !el.getClientRects().length
    )
      return false;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return false;
    const rect = el.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    );
  };
  const getVisibleInputs = () =>
    [...document.querySelectorAll("input")].filter(isVisible);
  const inputs = getVisibleInputs();
  const getInputHints = (el) => [
    el.autocomplete,
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label"),
    ...[...(el.labels || [])].map((l) => l.textContent),
  ];
  // A bare "code" may mean a coupon, referral, or product code.
  const hasContextualCodeHint = (el) => {
    const hints = getInputHints(el).filter(Boolean).join(" ");
    if (!/\bcode\b/i.test(hints) || /coupon|promo|postal|zip|referral|product/i.test(hints)) return false;
    const context = (el.form || el.closest?.("main") || document.body)?.textContent || "";
    return /(?:check your email for a code|(?:we(?:['’]ve| have)? sent|we sent|emailed)[\s\S]{0,100}\bcode\b|verification code|sign[- ]?in code)/i.test(context);
  };
  const hasCodeHint = (el) =>
    hasContextualCodeHint(el) || getInputHints(el).some((value) =>
      /(?:^|[^\w])(?:one[-_ ]?time[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|passcode|otp|auth(?:entication)?[-_ ]?code|confirmation[-_ ]?code|sign[-_ ]?in[-_ ]?code|login[-_ ]?code)(?:$|[^\w])/i.test(
        value || "",
      ),
    );
  const hasSupportedType = (el) =>
    ["text", "tel", "number", "password", ""].includes(el.type);
  const getDigitInputs = () =>
    getVisibleInputs().filter(
      (el) => el.maxLength === 1 && hasSupportedType(el),
    );
  const focused = document.activeElement;
  const candidates = inputs.filter(
    (el) => hasSupportedType(el) && hasCodeHint(el),
  );
  const focusedCodeInput = candidates.includes(focused) ? focused : null;
  // Focus alone does not identify a code field; it may be a search or account input.
  const targetInput =
    focusedCodeInput || (candidates.length === 1 ? candidates[0] : null);
  if (detectOnly) {
    const anchor = targetInput || (candidates.length && candidates.every((el) => el.maxLength === 1) ? candidates[0] : null);
    if (!anchor) return { ok: false };
    const { top, bottom, left, right } = anchor.getBoundingClientRect();
    return { ok: true, rect: { top, bottom, left, right } };
  }
  let fields;
  if (targetInput && targetInput.maxLength === 1) {
    fields = inputs.filter(
      (el) =>
        el.maxLength === 1 &&
        hasSupportedType(el) &&
        el.form === targetInput.form &&
        el.parentElement === targetInput.parentElement,
    );
  } else if (!targetInput) {
    const digitInputs = getDigitInputs();
    if (
      digitInputs.length === code.length &&
      digitInputs.every((el) => el.form === digitInputs[0].form) &&
      digitInputs.some(hasCodeHint)
    )
      fields = digitInputs;
  }
  if (fields) {
    if (fields.length !== code.length)
      return {
        ok: false,
        error: "Select the code field on the page, then reopen Code Fill.",
      };
  } else if (
    !targetInput ||
    (targetInput.maxLength > 0 && targetInput.maxLength < code.length)
  ) {
    return {
      ok: false,
      error:
        "Click the verification-code field on the page, then reopen Code Fill. Embedded forms may not be supported.",
    };
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;
  const setInputValue = (input, value) => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (fields) {
    const digitInputs = getDigitInputs();
    const start = digitInputs.indexOf(fields[0]);
    for (let index = 0; index < code.length; index++) {
      // Input handlers may replace the fields after each digit. Resolve the
      // current group again before writing the next one.
      const currentDigitInputs = getDigitInputs();
      const group = currentDigitInputs.slice(start, start + code.length);
      if (
        group.length !== code.length ||
        !group.every(
          (el) =>
            el.form === group[0].form &&
            el.parentElement === group[0].parentElement,
        )
      ) {
        return {
          ok: false,
          error:
            "The code fields changed. Select the code field and try again.",
        };
      }
      const el = group[index];
      setInputValue(el, code[index]);
    }
    const currentDigitInputs = getDigitInputs();
    currentDigitInputs[start + code.length - 1]?.focus();
    return { ok: true };
  }
  setInputValue(targetInput, code);
  targetInput.focus();
  return { ok: true };
}
