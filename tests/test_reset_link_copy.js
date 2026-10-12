import assert from "node:assert/strict";
import test from "node:test";
import { copyPasswordResetLink } from "../extension/shared/reset-link-copy.js";

test("clipboard access failures retain their cause and provide surface-specific recovery", async () => {
  for (const recoveryMessage of [
    "Use Find password reset links in the toolbar popup.",
    "Close and reopen this popup, then try again.",
  ]) {
    await assert.rejects(copyPasswordResetLink({
      async writeText() { throw new Error("Permission denied"); },
    }, "https://example.com/reset", recoveryMessage),
    (error) => error.message.includes("Permission denied") &&
      error.message.endsWith(recoveryMessage));
  }
});

test("missing clipboard write support uses the current surface's recovery message", async () => {
  for (const clipboard of [undefined, {}]) {
    await assert.rejects(copyPasswordResetLink(clipboard, "https://example.com/reset",
      "Use the toolbar popup."),
    /Clipboard unavailable.*Use the toolbar popup/);
  }
});
