import { detectOrFillCodeFields } from "../shared/code-fields.js";
import { recipientKeyFromText } from "./recipient-identity.js";

// Step tracking reads bounded DOM text, never aggregate element textContent.
// An incomplete context cannot establish that the recipient changed.
export function readCodeStepContext({ roots, parent }, getStyle) {
  const text = detectOrFillCodeFields({
    action: "readContextText",
    roots,
    getStyle,
  });
  if (text === null) return { roots, parent, recipientKey: null };
  // Status messages and countdowns do not identify a new verification request.
  // Include masked addresses, but ignore changes in spelling/case or ordering.
  const recipientKey = recipientKeyFromText(
    text,
    (instruction) =>
      /\b(?:code|otp|passcode|sent|emailed)\b[^.!?\n]{0,150}\b(?:to|for|at)\s*[:=-]?\s*$/i.test(
        instruction,
      ) || /\bemailed\s*$/i.test(instruction),
  );
  return { roots, parent, recipientKey };
}
