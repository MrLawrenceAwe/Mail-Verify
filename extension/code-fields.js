export function handleCodeField({ action, code, candidateCache, expectedAnchor, trackedAnchor } = {}) {
  if (action !== "detect" && action !== "fill")
    return { ok: false, error: "Unsupported code field action." };
  const detectOnly = action === "detect";
  if (!detectOnly && typeof code !== "string")
    return { ok: false, error: "Missing verification code." };
  // Detection is read-only; filling happens only after the user selects a code.
  const inputVisibility = (el) => {
    if (
      el.isConnected === false ||
      el.disabled ||
      el.readOnly ||
      el.type === "hidden" ||
      !el.getClientRects().length
    )
      return "unavailable";
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return "unavailable";
    const rect = el.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    ) ? "visible" : "offscreen";
  };
  const isUsableInput = (el) => inputVisibility(el) === "visible";
  const getVisibleInputs = () =>
    [...document.querySelectorAll("input")].filter(isUsableInput);

  const getInputHints = (el) => [
    el.autocomplete,
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute("aria-label"),
    ...[...(el.labels || [])].map((label) => label.textContent),
  ];
  const contextMatches = new Map();
  const contextRoots = new Set();
  // A bare "code" may mean a coupon, referral, or product code.
  const hasContextualCodeHint = (el, hints) => {
    const hintText = hints.filter(Boolean).join(" ");
    if (!/\bcode\b/i.test(hintText) || /coupon|promo|postal|zip|referral|product/i.test(hintText)) return false;
    const container = el.form || el.parentElement;
    const roots = [container];
    // Instructions are often just before the form, but text elsewhere in
    // <main> can describe a different code field on the page.
    let sibling = container?.previousElementSibling;
    for (let count = 0; sibling && count < 2; count++, sibling = sibling.previousElementSibling)
      roots.push(sibling);
    if (container?.parentElement) contextRoots.add(container.parentElement);
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
  // maxlength is ignored by number inputs, including one-digit OTP widgets.
  const isDigitInput = (el) => hasSupportedType(el) &&
    (el.maxLength === 1 || el.type === "number");
  const getDigitInputs = (inputs = getVisibleInputs()) =>
    inputs.filter(isDigitInput);
  const isInside = (el, ancestor) => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement)
      if (parent === ancestor) return true;
    return false;
  };
  const isCodeDigit = (el) => hasCodeHint(el) || getInputHints(el).every((hint) =>
    !hint || /^(?:(?:enter )?(?:digit|character|box|cell|otp|pin|code)[\s_-]*\d*|\d)$/i.test(hint.trim()));
  const digitGroup = (anchor, digitInputs, length) => {
    for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
      const group = digitInputs.filter((el) =>
        el.form === anchor.form && isInside(el, parent));
      if (group.length === length && group.some(hasCodeHint) && group.every(isCodeDigit)) return group;
    }
    // A form can own inputs placed outside its DOM subtree via the form attribute.
    if (anchor.form) {
      const group = digitInputs.filter((el) => el.form === anchor.form);
      if (group.length === length && group.some(hasCodeHint) && group.every(isCodeDigit)) return group;
    }
    return null;
  };
  const uniqueDigitGroup = (digitInputs, length) => {
    const groups = [];
    for (const anchor of digitInputs.filter(hasCodeHint)) {
      const group = digitGroup(anchor, digitInputs, length);
      if (group && !groups.some((other) =>
        other.length === group.length && other.every((el, index) => el === group[index])))
        groups.push(group);
    }
    return groups.length === 1 ? groups[0] : null;
  };
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
  if (!detectOnly && expectedAnchor && !visibleCodeInputs.includes(expectedAnchor))
    return { ok: false, error: "The verification-code field changed. Select it and try again." };
  const focusedCodeInput = visibleCodeInputs.includes(focused) ? focused : null;
  // Focus alone does not identify a code field; it may be a search or account input.
  // An inline suggestion is bound to the field beside which it was mounted.
  const targetInput =
    (!detectOnly && expectedAnchor) || focusedCodeInput || (visibleCodeInputs.length === 1 ? visibleCodeInputs[0] : null);
  if (detectOnly) {
    const anchor = targetInput || (visibleCodeInputs.length && visibleCodeInputs.every(isDigitInput) ? visibleCodeInputs[0] : null);
    if (!anchor) return { ok: false, candidateCache: candidates,
      trackedAnchorOffscreen: !!trackedAnchor && candidates.inputs.includes(trackedAnchor) &&
        inputVisibility(trackedAnchor) === "offscreen" };
    const { top, bottom, left, right } = anchor.getBoundingClientRect();
    return { ok: true, anchor, rect: { top, bottom, left, right }, candidateCache: candidates };
  }
  const inputs = getVisibleInputs();
  const digitInputs = getDigitInputs(inputs);
  let fields;
  if (targetInput && isDigitInput(targetInput)) {
    fields = digitGroup(targetInput, digitInputs, code.length);
  } else if (!targetInput) {
    fields = uniqueDigitGroup(digitInputs, code.length);
  }
  if (!fields && (
    !targetInput ||
    targetInput.maxLength === 1 ||
    (targetInput.type === "number" && digitInputs.filter((el) =>
      el.form === targetInput.form &&
      (el === targetInput || hasCodeHint(el) || !getInputHints(el).some(Boolean))
    ).length > 1) ||
    (targetInput.maxLength > 0 && targetInput.maxLength < code.length)
  )) {
    return {
      ok: false,
      error:
        "Click the verification-code field on the page, then reopen Mail Verify. Embedded forms may not be supported.",
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
    let group = fields;
    for (let index = 0; index < code.length; index++) {
      // Input handlers may replace the fields after each digit. Resolve the
      // verification group again before writing the next one.
      const currentDigitInputs = getDigitInputs();
      group = currentDigitInputs.includes(group[index])
        ? digitGroup(group[index], currentDigitInputs, code.length)
        : uniqueDigitGroup(currentDigitInputs, code.length);
      if (!group) {
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
    const currentGroup = currentDigitInputs.includes(group[0])
      ? digitGroup(group[0], currentDigitInputs, code.length)
      : uniqueDigitGroup(currentDigitInputs, code.length);
    if (!currentGroup || currentGroup.some((input, index) => input.value !== code[index]))
      return { ok: false, error: "The verification-code fields changed while filling them. Try again." };
    currentGroup[code.length - 1].focus();
    return { ok: true };
  }
  setInputValue(targetInput, code);
  if (targetInput.isConnected === false ||
      ![...document.querySelectorAll("input")].includes(targetInput) ||
      targetInput.value !== code)
    return { ok: false, error: "The verification-code field changed while filling it. Try again." };
  targetInput.focus();
  return { ok: true };
}
