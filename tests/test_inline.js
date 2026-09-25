import test from "node:test";
import assert from "node:assert/strict";
import { suggestionPosition, freshCodes } from "../extension/inline.js";

test("suggestions sit below the field and stay within the viewport", () => {
  assert.deepEqual(suggestionPosition({ left: 100, top: 200, bottom: 240 }, 300, 110, 1000, 800), { left: 100, top: 244 });
  assert.deepEqual(suggestionPosition({ left: 900, top: 700, bottom: 740 }, 300, 110, 1000, 800), { left: 692, top: 586 });
});

test("old codes are withheld while waiting for this verification attempt", () => {
  const older = { code: "111111", sender: "auth@example.test", receivedAt: 1000 };
  const newest = { code: "222222", sender: "auth@example.test", receivedAt: 9000 };
  assert.deepEqual(freshCodes([older], 5000, 10000), []);
  assert.deepEqual(freshCodes([older, newest], 5000, 10000), [newest]);
  assert.deepEqual(freshCodes([newest], 9500, 10000), []);
});

test("only the latest code per sender is suggested, without changing the response", () => {
  const codes = [
    { code: "111111", sender: "AUTH@example.test", receivedAt: 8000 },
    { code: "222222", sender: "auth@example.test", receivedAt: 9000 },
    { code: "333333", sender: "other@example.test", receivedAt: 9500 },
  ];
  assert.deepEqual(freshCodes(codes, 5000, 10000).map(x => x.code), ["333333", "222222"]);
  assert.equal(codes[0].code, "111111");
});
