import assert from "node:assert/strict";
import test from "node:test";
import { copyPasswordResetLink } from "../extension/reset-link-copy.js";

test("clipboard access failures retain their cause and provide retry guidance", async () => {
  await assert.rejects(copyPasswordResetLink({
    async writeText() { throw new Error("Permission denied"); },
  }, "https://example.com/reset", "Clipboard unavailable"),
  /Could not copy password reset link.*Permission denied.*Try copying again/);
});

test("missing clipboard write support uses the current surface's recovery message", async () => {
  for (const clipboard of [undefined, {}]) {
    await assert.rejects(copyPasswordResetLink(clipboard, "https://example.com/reset",
      "Clipboard unavailable. Use the toolbar popup."),
    /Clipboard unavailable.*Use the toolbar popup/);
  }
});
