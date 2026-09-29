import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSupportedConfirmationUrl } from "../extension/confirmation-url.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/confirmation-urls.json", import.meta.url)));

test("confirmation URL policy matches the companion cases", () => {
  for (const { url, supported } of cases)
    assert.equal(isSupportedConfirmationUrl(url), supported, url);
  assert.equal(isSupportedConfirmationUrl("https://example.com/" + "a".repeat(4096)), false);
});
