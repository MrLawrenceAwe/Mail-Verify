import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSupportedEmailLinkUrl } from "../extension/shared/email-link-url.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/email-link-urls.json", import.meta.url)));

test("email-link URL policy matches the companion cases", () => {
  for (const { url, supported } of cases)
    assert.equal(isSupportedEmailLinkUrl(url), supported, url);
  assert.equal(isSupportedEmailLinkUrl("https://example.com/" + "a".repeat(4096)), false);
});
