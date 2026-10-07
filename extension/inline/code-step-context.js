import { recipientKeyFromText } from "./recipient-identity.js";

// Step tracking reads bounded DOM text, never aggregate element textContent.
// An incomplete context cannot establish that the recipient changed.
export function readCodeStepContext(
  { roots, parent },
  getStyle = getComputedStyle,
) {
  let remainingNodes = 500,
    remainingText = 10_000;
  const parts = [];
  for (const root of roots) {
    for (let node = root; node; ) {
      if (--remainingNodes < 0) return { roots, parent, recipientKey: null };
      const explicitlyHidden =
        node.hidden ||
        node.getAttribute?.("aria-hidden") === "true" ||
        /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName);
      const style =
        !explicitlyHidden && node.nodeType === 1 ? getStyle(node) : null;
      const skip =
        explicitlyHidden ||
        (style &&
          (style.display === "none" ||
            /^(hidden|collapse)$/.test(style.visibility) ||
            style.opacity === "0"));
      if (!skip && node.nodeType === 3) {
        const value = node.data;
        if (value.length > remainingText)
          return { roots, parent, recipientKey: null };
        remainingText -= value.length;
        parts.push(value);
      } else if (
        !skip &&
        /^(P|DIV|FORM|BR|LI|SECTION|H[1-6])$/.test(node.tagName)
      ) {
        parts.push(" ");
      }
      if (!skip && node.firstChild) {
        node = node.firstChild;
        continue;
      }
      while (node !== root && !node.nextSibling) node = node.parentNode;
      node = node === root ? null : node.nextSibling;
    }
    parts.push(" ");
  }
  // Status messages and countdowns do not identify a new verification request.
  // Include masked addresses, but ignore changes in spelling/case or ordering.
  const text = parts.join("");
  const recipientKey = recipientKeyFromText(
    text,
    (instruction) =>
      /\b(?:code|otp|passcode|sent|emailed)\b[^.!?\n]{0,150}\b(?:to|for|at)\s*[:=-]?\s*$/i.test(
        instruction,
      ) || /\bemailed\s*$/i.test(instruction),
  );
  return { roots, parent, recipientKey };
}
