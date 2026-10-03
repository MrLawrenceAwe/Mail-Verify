import test from "node:test";
import assert from "node:assert/strict";
import { calculatePickerPosition } from "../extension/inline/code-picker-view.js";

test("suggestions sit below the field and stay within the viewport", () => {
  assert.deepEqual(calculatePickerPosition({ left: 100, top: 200, bottom: 240 }, 300, 110, 1000, 800), { left: 100, top: 244 });
  assert.deepEqual(calculatePickerPosition({ left: 900, top: 700, bottom: 740 }, 300, 110, 1000, 800), { left: 692, top: 586 });
});
