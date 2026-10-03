// Step tracking reads bounded DOM text, never aggregate element textContent.
// An incomplete context cannot establish that the recipient changed.
export function readCodeStepContext({ roots, parent }) {
  let remainingNodes = 500, remainingText = 10_000;
  const parts = [];
  for (const root of roots) {
    for (let node = root; node;) {
      if (--remainingNodes < 0) return { roots, parent, key: null };
      const skip = node.hidden || node.getAttribute?.("aria-hidden") === "true" ||
        /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName);
      if (!skip && node.nodeType === 3) {
        const value = node.data;
        if (value.length > remainingText) return { roots, parent, key: null };
        remainingText -= value.length;
        parts.push(value);
      } else if (!skip && /^(P|DIV|FORM|BR|LI|SECTION|H[1-6])$/.test(node.tagName)) {
        parts.push(" ");
      }
      if (!skip && node.firstChild) { node = node.firstChild; continue; }
      while (node !== root && !node.nextSibling) node = node.parentNode;
      node = node === root ? null : node.nextSibling;
    }
    parts.push(" ");
  }
  // Status messages and countdowns do not identify a new verification request.
  // Include masked addresses, but ignore changes in spelling/case or ordering.
  const text = parts.join("");
  const addresses = text.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~•…-]{1,128}@[a-z0-9_*•…-]{1,63}(?:\.[a-z0-9_*•…-]{1,63}){1,8}/gi);
  const recipients = [];
  for (const match of addresses) {
    const instruction = text.slice(Math.max(0, match.index - 180), match.index);
    if (/\b(?:code|otp|passcode|sent|emailed)\b[^.!?\n]{0,150}\b(?:to|for|at)\s*[:=-]?\s*$/i.test(instruction) ||
        /\bemailed\s*$/i.test(instruction)) recipients.push(match[0].toLowerCase());
  }
  const key = JSON.stringify([...new Set(recipients)].sort());
  return { roots, parent, key };
}
