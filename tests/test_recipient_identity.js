import assert from "node:assert/strict";
import test from "node:test";
import { recipientKeyFromText } from "../extension/inline/recipient-identity.js";

test("recipient identities normalise, deduplicate and sort ordinary and masked addresses", () => {
  const key = recipientKeyFromText(
    "Sent to Z***@Example.Test. Sent to alice@example.test. Sent to z***@example.test.",
    instruction => /sent to\s*$/i.test(instruction),
  );
  assert.equal(key, '["alice@example.test","z***@example.test"]');
});

test("recipient classifiers receive bounded context and can exclude unrelated addresses", () => {
  const contexts = [];
  const key = recipientKeyFromText(
    "x".repeat(200) + " Sent to me@example.test. Contact support@help.test.",
    instruction => { contexts.push(instruction); return /sent to\s*$/i.test(instruction); },
  );
  assert.equal(key, '["me@example.test"]');
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(context => context.length <= 180));
  assert.equal(recipientKeyFromText("No recipient", () => true), "[]");
});
