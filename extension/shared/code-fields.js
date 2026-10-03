export function handleCodeField({ action, code, candidateCache, expectedAnchor, trackedAnchor } = {}) {
  if (action !== "detect" && action !== "fill")
    return { ok: false, error: "Unsupported code field action." };
  const detectOnly = action === "detect";
  if (!detectOnly && typeof code !== "string")
    return { ok: false, error: "Missing verification code." };
  // Detection is read-only; filling happens only after the user selects a code.
  const inputVisibility = (input) => {
    if (
      input.isConnected === false ||
      input.disabled ||
      input.readOnly ||
      input.type === "hidden" ||
      !input.getClientRects().length
    )
      return "unavailable";
    if (!input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return "unavailable";
    const rect = input.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth
    ) ? "visible" : "offscreen";
  };
  const isUsableInput = (input) => inputVisibility(input) === "visible";

  const contextRoots = new Set();
  const labelRoots = new Set();
  const referencedLabels = (input) => {
    const ids = (input.getAttribute("aria-labelledby") || "").trim().split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)).filter(Boolean).map((label) => {
      labelRoots.add(label);
      return label.textContent;
    }).join(" ");
  };
  const getInputHints = (input) => [
    input.autocomplete,
    input.name,
    input.id,
    input.placeholder,
    input.getAttribute("aria-label"),
    referencedLabels(input),
    ...[...(input.labels || [])].map((label) => label.textContent),
  ];
  const verificationContext = (input) => {
    const container = input.form || input.parentElement;
    if (!container) return { roots: [], parent: undefined };
    const roots = [container];
    // Nearby instructions can identify a field; distant main content cannot.
    let sibling = container.previousElementSibling;
    for (let count = 0; sibling && count < 2; count++, sibling = sibling.previousElementSibling)
      roots.push(sibling);
    return { roots, parent: container.parentElement };
  };
  const contextMatches = new Map();
  // Keep bounded traversal inside the function Chrome serializes for popup fills.
  const readVisibleContextText = (root) => {
    let remainingNodes = 500, remainingText = 10_000;
    const parts = [];
    for (let node = root; node;) {
      if (--remainingNodes < 0) return null;
      const style = node.nodeType === 1 ? getComputedStyle(node) : null;
      const skip = node.hidden || node.getAttribute?.("aria-hidden") === "true" ||
        /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName) ||
        (style && (style.display === "none" || /^(hidden|collapse)$/.test(style.visibility) || style.opacity === "0"));
      if (!skip && node.nodeType === 3) {
        const value = node.data;
        if (value.length > remainingText) return null;
        remainingText -= value.length;
        parts.push(value);
      } else if (!skip && /^(P|DIV|FORM|BR|LI|SECTION|H[1-6])$/.test(node.tagName)) {
        parts.push(" ");
      }
      if (!skip && node.firstChild) { node = node.firstChild; continue; }
      while (node !== root && !node.nextSibling) node = node.parentNode;
      node = node === root ? null : node.nextSibling;
    }
    return parts.join("");
  };
  // A bare "code" may mean a coupon, referral, or product code.
  const hasContextualCodeHint = (input, hints) => {
    const hintText = hints.filter(Boolean).join(" ");
    if (!/\bcode\b/i.test(hintText) || /coupon|promo|postal|zip|referral|product/i.test(hintText)) return false;
    const { roots, parent } = verificationContext(input);
    if (parent) contextRoots.add(parent);
    const verificationText = /(?:check your email for a code|(?:we(?:['’]ve| have)? sent|emailed)[\s\S]{0,100}\bcode\b|verification code|sign[- ]?in code)/i;
    for (const root of roots) {
      if (!root) continue;
      contextRoots.add(root);
      if (!contextMatches.has(root))
        contextMatches.set(root, verificationText.test(readVisibleContextText(root) || ""));
      if (contextMatches.get(root)) return true;
    }
    return false;
  };
  const hasCodeHint = (input) => {
    const hints = getInputHints(input);
    return hints.some((value) =>
      /(?:^|[^\w])(?:one[-_ ]?time[-_ ]?code|verification[-_ ]?code|security[-_ ]?code|passcode|otp|auth(?:entication)?[-_ ]?code|confirmation[-_ ]?code|sign[-_ ]?in[-_ ]?code|login[-_ ]?code)(?:$|[^\w])/i.test(
        value || "",
      ),
    ) || hasContextualCodeHint(input, hints);
  };
  const hasSupportedType = (input) =>
    ["text", "tel", "number", "password", ""].includes(input.type);
  // maxlength is ignored by number inputs, including one-digit OTP widgets.
  const isPotentialDigitInput = (input) => hasSupportedType(input) &&
    (input.maxLength === 1 || input.type === "number");
  const isInside = (input, ancestor) => {
    for (let parent = input.parentElement; parent; parent = parent.parentElement)
      if (parent === ancestor) return true;
    return false;
  };
  const isCodeDigit = (input) => hasCodeHint(input) || getInputHints(input).every((hint) =>
    !hint || /^(?:(?:enter )?(?:digit|character|box|cell|otp|pin|code)[\s_-]*\d*|\d)$/i.test(hint.trim()));
  const findDigitGroup = (anchor, digitInputs, length) => {
    const matchesGroup = (group) =>
      group.length >= 4 && group.length <= 8 &&
      group.some(hasCodeHint) && group.every(isCodeDigit);
    const groupsByParent = new Map();
    const formGroup = digitInputs.filter((input) => input.form === anchor.form);
    const smallestGroup = (input) => {
      for (let parent = input.parentElement; parent; parent = parent.parentElement) {
        if (!groupsByParent.has(parent)) {
          const group = formGroup.filter((digit) => isInside(digit, parent));
          groupsByParent.set(parent, matchesGroup(group) ? group : null);
        }
        const group = groupsByParent.get(parent);
        if (group) return group;
      }
      // A form can own inputs outside its DOM subtree via the form attribute.
      return anchor.form && matchesGroup(formGroup) ? formGroup : null;
    };
    const group = smallestGroup(anchor);
    if (!group || (length !== undefined && group.length !== length)) return null;
    // Do not combine a nested OTP group with a separate full-code field or
    // another group. Establish boundaries before checking the code length.
    return group.every((input) => {
      const ownGroup = smallestGroup(input);
      return ownGroup?.length === group.length && ownGroup.every((digit, index) => digit === group[index]);
    }) ? group : null;
  };
  const focused = document.activeElement;
  const scope = document.querySelector?.('dialog:modal') || document;
  // Cache semantic candidates, including offscreen fields, for cheap scroll updates.
  // Filling always rediscovers the page so cached hints cannot authorize a fill.
  let candidates = detectOnly && candidateCache;
  if (candidates && candidates.scope !== scope) candidates = undefined;
  if (!candidates) {
    const inputs = [...scope.querySelectorAll("input")];
    candidates = {
      scope,
      inputs: inputs.filter((input) => hasSupportedType(input) && hasCodeHint(input)),
      digitInputs: inputs.filter(isPotentialDigitInput),
      contextRoots: [...contextRoots],
      labelRoots: [...labelRoots],
    };
  }
  const visibleCodeInputs = candidates.inputs.filter(isUsableInput);
  if (!detectOnly && expectedAnchor && !visibleCodeInputs.includes(expectedAnchor))
    return { ok: false, error: "The verification-code field changed. Select it and try again." };
  // A digit need not carry its own label, but its group must have a code hint.
  const focusedGroup = candidates.digitInputs.includes(focused) && isUsableInput(focused)
    ? findDigitGroup(focused, candidates.digitInputs.filter(isUsableInput)) : null;
  const focusedCodeInput = focusedGroup
    ? focusedGroup.find((input) => visibleCodeInputs.includes(input))
    : visibleCodeInputs.includes(focused) ? focused : null;
  // Focus alone does not identify a code field; it may be a search or account input.
  // An inline suggestion is bound to the field beside which it was mounted.
  const targetInput =
    (!detectOnly && expectedAnchor) || focusedCodeInput || (visibleCodeInputs.length === 1 ? visibleCodeInputs[0] : null);
  if (detectOnly) {
    let anchor = targetInput || (visibleCodeInputs.includes(trackedAnchor) ? trackedAnchor : null) ||
      (visibleCodeInputs.length && visibleCodeInputs.every(isPotentialDigitInput) ? visibleCodeInputs[0] : null);
    if (anchor && isPotentialDigitInput(anchor)) {
      const group = findDigitGroup(anchor, candidates.digitInputs.filter(isUsableInput));
      // All digits share one suggestion identity, even as focus moves between
      // them. Keep the anchor labelled so filling can validate it again.
      if (group) anchor = group.find((input) => visibleCodeInputs.includes(input));
    }
    if (!anchor) return { ok: false, candidateCache: candidates,
      trackedAnchorOffscreen: !!trackedAnchor && candidates.inputs.includes(trackedAnchor) &&
        inputVisibility(trackedAnchor) === "offscreen" };
    const { top, bottom, left, right } = anchor.getBoundingClientRect();
    return { ok: true, anchor, rect: { top, bottom, left, right },
      stepContext: verificationContext(anchor), candidateCache: candidates };
  }
  const getVisibleInputs = () =>
    [...scope.querySelectorAll("input")].filter(isUsableInput);
  const getDigitInputs = () => getVisibleInputs().filter(isPotentialDigitInput);
  const findUniqueDigitGroup = (digitInputs, length) => {
    const groups = [];
    for (const anchor of digitInputs.filter(hasCodeHint)) {
      const group = findDigitGroup(anchor, digitInputs, length);
      if (group && !groups.some((other) =>
        other.length === group.length && other.every((input, index) => input === group[index])))
        groups.push(group);
    }
    return groups.length === 1 ? groups[0] : null;
  };
  const digitInputs = getDigitInputs();
  let fields;
  if (targetInput && isPotentialDigitInput(targetInput)) {
    fields = findDigitGroup(targetInput, digitInputs, code.length);
  } else if (!targetInput) {
    fields = findUniqueDigitGroup(digitInputs, code.length);
  }
  if (!fields && (
    !targetInput ||
    targetInput.maxLength === 1 ||
    // Reject a numeric split group with the wrong digit count, but do not
    // mistake separate full-length numeric code fields for a split group.
    (targetInput.type === "number" && findDigitGroup(targetInput, digitInputs)) ||
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
        ? findDigitGroup(group[index], currentDigitInputs, code.length)
        : findUniqueDigitGroup(currentDigitInputs, code.length);
      if (!group) {
        return {
          ok: false,
          error:
            "The code fields changed. Select the code field and try again.",
        };
      }
      setInputValue(group[index], code[index]);
    }
    const currentDigitInputs = getDigitInputs();
    const currentGroup = currentDigitInputs.includes(group[0])
      ? findDigitGroup(group[0], currentDigitInputs, code.length)
      : findUniqueDigitGroup(currentDigitInputs, code.length);
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
