import test from "node:test";
import assert from "node:assert/strict";
import { calculatePickerPosition } from "../extension/inline/code-picker-position.js";

test("suggestions sit below the field and stay within the viewport", () => {
  assert.deepEqual(
    calculatePickerPosition(
      { left: 100, right: 400, top: 200, bottom: 240 },
      300,
      110,
      1000,
      800,
      [],
    ),
    { left: 100, top: 244 },
  );
  assert.deepEqual(
    calculatePickerPosition(
      { left: 900, right: 990, top: 700, bottom: 740 },
      300,
      110,
      1000,
      800,
      [],
    ),
    { left: 692, top: 586 },
  );
});

test("picker avoids resend controls below the field in a narrow window", () => {
  const field = { left: 70, right: 330, top: 353, bottom: 401 };
  const controls = [{ left: 70, right: 255, top: 403, bottom: 425 }];
  assert.deepEqual(
    calculatePickerPosition(field, 240, 76, 400, 600, controls),
    { left: 70, top: 273 },
  );
});

test("picker moves beside the field when controls block both vertical positions", () => {
  const field = { left: 350, right: 500, top: 200, bottom: 240 };
  const controls = [
    { left: 350, right: 650, top: 80, bottom: 195 },
    { left: 350, right: 650, top: 244, bottom: 360 },
  ];
  const position = calculatePickerPosition(
    field,
    240,
    100,
    1000,
    800,
    controls,
  );
  assert.deepEqual(position, { left: 106, top: 200 });
});
