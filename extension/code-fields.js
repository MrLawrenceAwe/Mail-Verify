export function handleCodeField({ action, code, candidateCache } = {}) {
  if (action !== "detect" && action !== "fill")
    return { ok: false, error: "Unsupported code field action." };
  const detectOnly = action === "detect";
  if (!detectOnly && typeof code !== "string")
    return { ok: false, error: "Missing verification code." };
  // Detection is read-only; filling happens only after the user selects a code.
  const isUsableInput = (el) => {
    if (
      el.isConnected === false ||
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
    [...document.querySelectorAll("input")].filter(isUsableInput);

  const getInputHints = (el) => [
    el.autocomplete,
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label"),
    ...[...(el.labels || [])].map((l) => l.textContent),
  ];
  const contextMatches = new Map();
  const contextRoots = new Set();
  // A bare "code" may mean a coupon, referral, or product code.
  const hasContextualCodeHint = (el, hints) => {
    const hintText = hints.filter(Boolean).join(" ");
    if (!/\bcode\b/i.test(hintText) || /coupon|promo|postal|zip|referral|product/i.test(hintText)) return false;
    const page = el.closest?.("main") || document.body;
    const roots = el.form && el.form !== page ? [el.form, page] : [page];
    const verificationText = /(?:check your email for a code|(?:we(?:['’]ve| have)? sent|emailed)[\s\S]{0,100}\bcode\b|verification code|sign[- ]?in code)/i;
    for (const root of roots) {
      if (!root) continue;
      contextRoots.add(root);
      if (!contextMatches.has(root))
        contextMatches.set(root, verificationText.test(root.textContent || ""));
      if (contextMatches.get(root)) return true;
    }
    return false;
  };
  const hasCodeHint = (el) => {
    const hints = getInputHints(el);
    return hints.some((value) =>
      /(?:^|[^\w])(?:one[-_ ]?time[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|passcode|otp|auth(?:entication)?[-_ ]?code|confirmation[-_ ]?code|sign[-_ ]?in[-_ ]?code|login[-_ ]?code)(?:$|[^\w])/i.test(
        value || "",
      ),
    ) || hasContextualCodeHint(el, hints);
  };
  const hasSupportedType = (el) =>
    ["text", "tel", "number", "password", ""].includes(el.type);
  const isDigitInput = (el) => el.maxLength === 1 && hasSupportedType(el);
  const getDigitInputs = (inputs = getVisibleInputs()) =>
    inputs.filter(isDigitInput);
  const focused = document.activeElement;
  // Cache semantic candidates, including offscreen fields, for cheap scroll updates.
  // Filling always rediscovers the page so cached hints cannot authorize a fill.
  const candidates = detectOnly && candidateCache ? candidateCache : {
    inputs: [...document.querySelectorAll("input")].filter(
      (el) => hasSupportedType(el) && hasCodeHint(el),
    ),
    contextRoots: [...contextRoots],
  };
  const visibleCodeInputs = candidates.inputs.filter(isUsableInput);
  const focusedCodeInput = visibleCodeInputs.includes(focused) ? focused : null;
  // Focus alone does not identify a code field; it may be a search or account input.
  const targetInput =
    focusedCodeInput || (visibleCodeInputs.length === 1 ? visibleCodeInputs[0] : null);
  if (detectOnly) {
    const anchor = targetInput || (visibleCodeInputs.length && visibleCodeInputs.every((el) => el.maxLength === 1) ? visibleCodeInputs[0] : null);
    if (!anchor) return { ok: false, candidateCache: candidates };
    const { top, bottom, left, right } = anchor.getBoundingClientRect();
    return { ok: true, anchor, rect: { top, bottom, left, right }, candidateCache: candidates };
  }
  const inputs = getVisibleInputs();
  let fields;
  if (targetInput && targetInput.maxLength === 1) {
    fields = inputs.filter(
      (el) =>
        isDigitInput(el) &&
        el.form === targetInput.form &&
        el.parentElement === targetInput.parentElement,
    );
  } else if (!targetInput) {
    const digitInputs = getDigitInputs(inputs);
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
    const digitInputs = getDigitInputs(inputs);
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
