import assert from "node:assert/strict";
import test from "node:test";
import { FakeInput, createVerificationFieldHarness } from "./verification_field_harness.js";

function run(inputs, activeElement = null, expectedAnchor = null, labelElements = new Map()) {
  const { handle } = createVerificationFieldHarness({
    document: { querySelectorAll: () => inputs, activeElement, getElementById: id => labelElements.get(id) },
  });
  return handle({ action: "fill", code: "123456", expectedAnchor });
}

test("fills labelled fields and rejects unrelated or hidden fields", () => {
  let a = new FakeInput({ autocomplete: "one-time-code" });
  assert.equal(run([a]).ok, true);
  assert.equal(a.value, "123456");
  assert.deepEqual(a.events, ["input", "change"]);
  a = new FakeInput();
  assert.equal(run([a], a).ok, false);
  const search = new FakeInput({
    name: "search",
    placeholder: "Search products",
  });
  assert.equal(run([search], search).ok, false);
  const password = new FakeInput({ type: "password", name: "password" });
  const codeField = new FakeInput({ name: "verification_code" });
  assert.equal(run([password, codeField], password).ok, true);
  assert.equal(password.value, undefined);
  assert.equal(codeField.value, "123456");
  const lonePassword = new FakeInput({ type: "password", name: "password" });
  assert.equal(run([lonePassword], lonePassword).ok, false);
  const verificationEmail = new FakeInput({ name: "verification_email" });
  const plainCode = new FakeInput({ name: "code" });
  assert.equal(run([verificationEmail, plainCode], plainCode).ok, false);
  assert.equal(plainCode.value, undefined);
  assert.equal(verificationEmail.value, undefined);
  assert.equal(run([verificationEmail], verificationEmail).ok, false);
  const promoCode = new FakeInput({
    name: "promo-code",
    placeholder: "Enter promo code",
  });
  assert.equal(run([promoCode], promoCode).ok, false);
  assert.equal(promoCode.value, undefined);
  const loginCode = new FakeInput({ name: "login-code" });
  assert.equal(run([loginCode], loginCode).ok, true);
  assert.equal(loginCode.value, "123456");
  assert.equal(run([new FakeInput(), new FakeInput()]).ok, false);
  assert.equal(
    run([new FakeInput({ autocomplete: "one-time-code", hidden: true })]).ok,
    false,
  );
  assert.equal(
    run([
      new FakeInput({
        autocomplete: "one-time-code",
        rect: { top: 900, left: 0, bottom: 920, right: 100 },
      }),
    ]).ok,
    false,
  );
});

test("inline fill stays on its mounted field when focus moves", () => {
  const mounted = new FakeInput({ name: "verification_code" });
  const focused = new FakeInput({ name: "security_code" });
  assert.equal(run([mounted, focused], focused, mounted).ok, true);
  assert.equal(mounted.value, "123456");
  assert.equal(focused.value, undefined);

  mounted.value = "";
  mounted.isConnected = false;
  assert.equal(run([mounted, focused], focused, mounted).ok, false);
  assert.equal(mounted.value, "");
  assert.equal(focused.value, undefined);
});

test("does not report success when a single code field is replaced or cleared", () => {
  for (const replace of [true, false]) {
    let current = new FakeInput({ name: "verification_code" });
    const original = current;
    original.dispatchEvent = function (event) {
      this.events.push(event.type);
      if (event.type !== "input") return;
      if (replace) {
        this.isConnected = false;
        current = new FakeInput({ name: "verification_code" });
      } else {
        this.value = "";
      }
    };
    const context = createVerificationFieldHarness({
      document: { querySelectorAll: () => [current], activeElement: original },
    });
    const result = context.handle({ action: "fill", code: "123456" });
    assert.equal(result.ok, false);
    assert.equal(original.focused, undefined);
    if (replace) assert.equal(current.value, undefined);
  }
});

test("fills split digit fields only when the group fits", () => {
  const parent = {};
  const singles = Array.from(
    { length: 6 },
    () =>
      new FakeInput({
        maxLength: 1,
        parentElement: parent,
        autocomplete: "one-time-code",
      }),
  );
  assert.equal(run(singles, singles[0]).ok, true);
  assert.equal(singles.map((x) => x.value).join(""), "123456");
  assert.equal(run(singles.slice(0, 5), singles[0]).ok, false);
  assert.equal(
    run([new FakeInput({ autocomplete: "one-time-code", maxLength: 4 })]).ok,
    false,
  );
});

test("does not report success when split digits are cleared after the final input", () => {
  const parent = {};
  const digits = Array.from({ length: 6 }, (_, index) => new FakeInput({
    maxLength: 1,
    parentElement: parent,
    name: index === 0 ? "verification_code" : "",
  }));
  digits[5].dispatchEvent = function (event) {
    this.events.push(event.type);
    if (event.type === "input") for (const digit of digits) digit.value = "";
  };

  const result = run(digits, digits[0]);
  assert.equal(result.ok, false);
  assert.equal(digits.every((digit) => digit.value === ""), true);
  assert.equal(digits[5].focused, undefined);
});

test("fills split digits when each box has its own wrapper", () => {
  const group = {};
  const form = {};
  const singles = Array.from({ length: 6 }, (_, index) => new FakeInput({
    maxLength: 1,
    parentElement: { parentElement: group },
    form,
    name: index === 0 ? "verification_code" : "",
  }));
  assert.equal(run(singles, singles[0]).ok, true);
  assert.equal(singles.map((input) => input.value).join(""), "123456");
});

test("fills numeric OTP boxes without maxlength and does not fill incomplete groups", () => {
  const group = {};
  const form = {};
  const numbers = Array.from({ length: 6 }, (_, index) => new FakeInput({
    type: "number",
    parentElement: { parentElement: group },
    form,
    name: index === 0 ? "verification_code" : "",
  }));
  assert.equal(run(numbers, numbers[0]).ok, true);
  assert.equal(numbers.map((input) => input.value).join(""), "123456");
  const incomplete = numbers.slice(0, 5);
  for (const input of incomplete) input.value = "";
  assert.equal(run(incomplete, incomplete[0]).ok, false);
  assert.equal(incomplete.every((input) => input.value === ""), true);
  const single = new FakeInput({ type: "number", name: "verification_code" });
  assert.equal(run([single]).ok, true);
  assert.equal(single.value, "123456");
});

test("fills a numeric code field beside an unrelated numeric field", () => {
  const form = {};
  const code = new FakeInput({ type: "number", name: "verification_code", form });
  const age = new FakeInput({ type: "number", name: "age", form });
  assert.equal(run([code, age], code).ok, true);
  assert.equal(code.value, "123456");
  assert.equal(age.value, undefined);
});

test("fills only the selected independent numeric verification field", () => {
  for (const inline of [false, true]) {
    const form = {};
    const email = new FakeInput({ type: "number", name: "verification_code", form });
    const phone = new FakeInput({ type: "number", name: "security_code", form });
    phone.value = "654321";
    const inputs = [email, phone];
    assert.equal(run(inputs, inline ? phone : email, inline ? email : null).ok, true);
    assert.equal(email.value, "123456");
    assert.equal(phone.value, "654321");
    assert.deepEqual(phone.events, []);
  }
});

test("keeps a full numeric code field separate from a split group in the same form", () => {
  for (const digitCount of [5, 6]) {
    const form = {};
    const parentElement = { parentElement: form };
    const digits = Array.from({ length: digitCount }, (_, index) => new FakeInput({
      type: "number", form, parentElement,
      name: index === 0 ? "verification_code" : "",
    }));
    const phone = new FakeInput({
      type: "number", name: "security_code", form,
      parentElement: { parentElement: form },
    });
    const handle = createFieldHandler([...digits, phone], phone);
    const selected = handle({ action: "detect" });
    assert.equal(selected.anchor, phone);
    for (const expectedAnchor of [undefined, selected.anchor]) {
      phone.value = "";
      assert.equal(handle({ action: "fill", code: "123456", expectedAnchor }).ok, true);
      assert.equal(phone.value, "123456");
      assert.equal(digits.every(input => input.value === undefined), true);
    }
    const splitHandle = createFieldHandler([...digits, phone], digits[1]);
    assert.equal(splitHandle({ action: "detect" }).anchor, digits[0]);
    assert.equal(splitHandle({ action: "fill", code: "654321" }).ok, digitCount === 6);
    assert.equal(phone.value, "123456");
    assert.equal(digits.map(input => input.value || "").join(""), digitCount === 6 ? "654321" : "");
  }
});

test("does not spread a code across unrelated numeric fields in the same form", () => {
  const form = {};
  const inputs = [
    new FakeInput({ type: "number", name: "verification_code", form }),
    ...["age", "quantity", "year", "month", "day"].map((name) =>
      new FakeInput({ type: "number", name, form })),
  ];
  assert.equal(run(inputs, inputs[0]).ok, true);
  assert.equal(inputs[0].value, "123456");
  assert.equal(inputs.slice(1).every((input) => input.value === undefined), true);
});

test("fills named numeric digit boxes in a shared form", () => {
  const form = {};
  const group = {};
  const inputs = Array.from({ length: 6 }, (_, index) => new FakeInput({
    type: "number",
    name: index === 0 ? "verification_code" : `digit_${index + 1}`,
    form,
    parentElement: { parentElement: group },
  }));
  assert.equal(run(inputs, inputs[0]).ok, true);
  assert.equal(inputs.map((input) => input.value).join(""), "123456");
});

test("follows split fields replaced after each digit", () => {
  let rerenderParent = {};
  let current = Array.from(
    { length: 6 },
    (_, i) =>
      new FakeInput({
        maxLength: 1,
        parentElement: rerenderParent,
        name: i === 0 ? "verification_code" : "",
      }),
  );
  const original = current;
  original[0].dispatchEvent = function (event) {
    this.events.push(event.type);
    if (event.type === "input") {
      rerenderParent = {};
      current = current.map(
        (old, i) =>
          new FakeInput({
            maxLength: 1,
            parentElement: rerenderParent,
            name: i === 0 ? "verification_code" : "",
            value: old.value,
          }),
      );
    }
  };
  const rerenderCtx = {
    document: { querySelectorAll: () => current, activeElement: original[0] },
  };
  const rerenderHarness = createVerificationFieldHarness(rerenderCtx);
  assert.equal(
    rerenderHarness.handle({ action: "fill", code: "123456" }).ok,
    true,
  );
  assert.equal(current.map((x) => x.value).join(""), "123456");
});

test("stops if a rerender inserts another digit in the verification group", () => {
  const parent = {};
  let current = Array.from({ length: 6 }, (_, index) => new FakeInput({
    maxLength: 1, parentElement: parent,
    name: index === 0 ? "verification_code" : "",
  }));
  const original = current;
  original[0].dispatchEvent = function (event) {
    this.events.push(event.type);
    if (event.type === "input")
      current = [new FakeInput({ maxLength: 1, parentElement: parent }), ...original];
  };
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => current, activeElement: original[0] },
  });
  const result = context.handle({ action: "fill", code: "123456" });
  assert.equal(result.ok, false);
  assert.equal(current[0].value, undefined);
  assert.equal(original[1].value, undefined);
});

test("Indeed's Enter code requires email verification context", () => {
  const input = new FakeInput({
    labels: [{ textContent: "Enter code *" }],
    form: contextElement("FORM", [contextText("Check your email for a code. We sent a code to you. Enter code *")]),
  });
  assert.equal(run([input]).ok, true);
  input.form.firstChild.data = "Enter code to redeem a discount";
  assert.equal(run([input]).ok, false);
  input.form.firstChild.data = "We sent a code to your email";
  input.labels = [{ textContent: "Promo code" }];
  assert.equal(run([input]).ok, false);
});

test("generic code field uses verification context outside its form", () => {
  const instructions = contextElement("P", [contextText("We sent a code to your email.")]);
  const main = { textContent: "We sent a code to your email. Enter code" };
  const form = contextElement("FORM", [contextText("Enter code")], { parentElement: main, previousElementSibling: instructions });
  const input = new FakeInput({ name: "code", form });
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input, body: main },
  });
  const result = context.handle({ action: "detect" });
  assert.equal(result.ok, true);
  assert.equal(result.candidateCache.contextRoots.length, 3);
  assert.equal(result.candidateCache.contextRoots.includes(form), true);
  assert.equal(result.candidateCache.contextRoots.includes(instructions), true);
  assert.deepEqual(Array.from(result.stepContext.roots), [form, instructions]);
  assert.equal(result.stepContext.parent, main);
  instructions.firstChild.data = "Enter code to redeem a discount";
  assert.equal(context.handle({ action: "detect" }).ok, false);
});

test("unrelated verification text elsewhere in main does not identify a generic field", () => {
  const main = { textContent: "Verification code for account settings. Redeem your gift code." };
  const couponInstructions = contextElement("P", [contextText("Redeem your gift code.")]);
  const form = contextElement("FORM", [contextText("Code")], { parentElement: main, previousElementSibling: couponInstructions });
  const input = new FakeInput({ name: "code", form });
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input, body: main },
  });
  assert.equal(context.handle({ action: "detect" }).ok, false);
  couponInstructions.firstChild.data = "We sent a code to your email.";
  assert.equal(context.handle({ action: "detect" }).ok, true);
});

test("explicit hints skip page text and generic hints read shared context once", () => {
  const explicit = new FakeInput({ autocomplete: "one-time-code", form: {
    get textContent() { throw new Error("unneeded context read"); },
  } });
  assert.equal(run([explicit]).ok, true);
  let reads = 0;
  const text = { nodeType: 3, get data() { reads++; return "We sent a code to your email"; } };
  const form = { nodeType: 1, tagName: "FORM", firstChild: text,
    get textContent() { throw new Error("aggregate context read"); } };
  text.parentNode = form;
  const inputs = [new FakeInput({ name: "code", form }), new FakeInput({ name: "code", form })];
  run(inputs);
  assert.equal(reads, 1);
});

test("automatic detection does not fill or dispatch events", () => {
  const input = new FakeInput({ autocomplete: "one-time-code" });
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input },
  });
  assert.equal(context.handle({ action: "detect" }).ok, true);
  assert.equal(input.value, undefined);
  assert.deepEqual(input.events, []);
});

test("opening a modal invalidates cached background code fields and restricts filling", () => {
  const background = new FakeInput({ autocomplete: 'one-time-code' });
  const inside = new FakeInput({ autocomplete: 'one-time-code' });
  let modal = null;
  const dialog = { querySelectorAll: () => [inside] };
  const document = { activeElement: null, querySelector: () => modal,
    querySelectorAll: () => [background, inside] };
  const handle = createVerificationFieldHarness({
    document,
  }).handle;
  const initial = handle({ action: 'detect', trackedAnchor: background });
  modal = dialog;
  const detected = handle({ action: 'detect', candidateCache: initial.candidateCache });
  assert.equal(detected.anchor, inside);
  assert.equal(handle({ action: 'fill', code: '123456', expectedAnchor: background }).ok, false);
  assert.equal(handle({ action: 'fill', code: '123456' }).ok, true);
  assert.equal(inside.value, '123456');
  assert.equal(background.value, undefined);
});

test("serialized filling uses the active stacked modal and rejects the inactive field", () => {
  const inactiveInput = new FakeInput({ autocomplete: 'one-time-code' });
  const activeInput = new FakeInput({ autocomplete: 'one-time-code' });
  const inactive = { querySelectorAll: () => [inactiveInput] };
  const active = { querySelectorAll: () => [activeInput] };
  activeInput.closest = () => active;
  const document = { activeElement: activeInput, querySelector: () => inactive,
    querySelectorAll: () => [inactiveInput, activeInput],
    elementFromPoint: () => ({ closest: () => active }) };
  const handle = createVerificationFieldHarness({
    document,
  }).handle;
  assert.equal(handle({ action: 'detect' }).anchor, activeInput);
  assert.equal(handle({ action: 'fill', code: '123456', expectedAnchor: inactiveInput }).ok, false);
  assert.equal(handle({ action: 'fill', code: '123456' }).ok, true);
  assert.equal(activeInput.value, '123456');
  assert.equal(inactiveInput.value, undefined);
  document.activeElement = null;
  assert.equal(handle({ action: 'detect' }).anchor, activeInput);
});

test("detection reports generic code context for later page updates", () => {
  const form = { textContent: "Enter code", contains: () => true };
  const input = new FakeInput({ name: "code", form });
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input },
  });
  const result = context.handle({ action: "detect" });
  assert.equal(result.ok, false);
  assert.equal(result.candidateCache.contextRoots[0], form);
});

test("cached detection tracks offscreen candidates without rescanning unrelated inputs", () => {
  let queries = 0;
  const input = new FakeInput({ autocomplete: "one-time-code", rect: { top: 900, bottom: 930, left: 0, right: 100 } });
  const unrelated = new FakeInput({ name: "search" });
  unrelated.getClientRects = () => { throw new Error("Unrelated fields need no layout reads"); };
  const context = createVerificationFieldHarness({
    input,
    document: { querySelectorAll: () => { queries++; return [input, unrelated]; }, activeElement: null },
  });
  context.field = context.handle({ action: "detect", trackedAnchor: input });
  assert.equal(context.field.ok, false);
  assert.equal(context.field.trackedAnchorOffscreen, true);
  input.rect = { top: 100, bottom: 130, left: 0, right: 100 };
  context.field = context.handle({ action: "detect", candidateCache: context.field.candidateCache, trackedAnchor: input });
  assert.equal(context.field.ok, true);
  assert.equal(queries, 1);
  input.isConnected = false;
  context.field = context.handle({ action: "detect", candidateCache: context.field.candidateCache, trackedAnchor: input });
  assert.equal(context.field.ok, false);
  assert.equal(context.field.trackedAnchorOffscreen, false);
  input.isConnected = true;
  input.autocomplete = "";
  context.field = context.handle({ action: "detect" });
  assert.equal(context.field.ok, false);
  assert.equal(queries, 2);
});

test("cached detection returns current step roots for explicit code fields", () => {
  const older = { textContent: "Older unrelated instructions" };
  const previous = { textContent: "Email verification", previousElementSibling: older };
  const instructions = { textContent: "We sent a code", previousElementSibling: previous };
  const parent = {};
  const form = { previousElementSibling: instructions, parentElement: parent };
  const input = new FakeInput({ autocomplete: "one-time-code", form });
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input },
  });
  context.field = context.handle({ action: "detect" });
  assert.deepEqual(Array.from(context.field.stepContext.roots), [form, instructions, previous]);
  assert.equal(context.field.stepContext.parent, parent);
  const replacement = { textContent: "Code for a different signup" };
  form.previousElementSibling = replacement;
  const next = context.handle({ action: "detect", candidateCache: context.field.candidateCache });
  assert.deepEqual(Array.from(next.stepContext.roots), [form, replacement]);
});

test("detects and fills fields named by multiple aria-labelledby references", () => {
  const labels = new Map([
    ["purpose", { textContent: "Verification" }],
    ["field", { textContent: "code" }],
  ]);
  const input = new FakeInput();
  input.getAttribute = name => name === "aria-labelledby" ? "missing purpose field" : null;
  const context = createVerificationFieldHarness({
    document: { querySelectorAll: () => [input], activeElement: input, getElementById: id => labels.get(id) },
  });
  const detect = context.handle;
  // The accessible name joins references in their specified order.
  assert.equal(detect({ action: "detect" }).ok, true);
  assert.equal(run([input], input, input, labels).ok, true);
  assert.equal(input.value, "123456");
  assert.deepEqual(Array.from(detect({ action: "detect" }).candidateCache.labelRoots), [...labels.values()]);
  labels.get("purpose").textContent = "Product";
  assert.equal(detect({ action: "detect" }).ok, false);
  input.value = "";
  assert.equal(run([input], input, input, labels).ok, false);
  assert.equal(input.value, "");
});

function contextElement(tagName, children = [], props = {}) {
  const node = { nodeType: 1, tagName, ...props };
  node.firstChild = children[0] || null;
  children.forEach((child, index) => {
    child.parentNode = node;
    child.nextSibling = children[index + 1] || null;
  });
  Object.defineProperty(node, "textContent", {
    get: () => children.map(child => child.textContent).join(""),
  });
  return node;
}
function contextText(data) { return { nodeType: 3, data, get textContent() { return this.data; } }; }

function createFieldHandler(inputs, activeElement = null) {
  return createVerificationFieldHarness({
    document: { querySelectorAll: () => inputs, activeElement },
  }).handle;
}

test("focusing an unlabelled digit selects its own OTP group for detection and fill", () => {
  const form = {};
  const groups = Array.from({ length: 2 }, () => {
    const parentElement = { parentElement: form };
    return Array.from({ length: 6 }, (_, index) => new FakeInput({
      maxLength: 1, form, parentElement,
      name: index === 0 ? "verification_code" : "",
    }));
  });
  const inputs = groups.flat();
  const initial = createFieldHandler(inputs)({ action: "detect" });
  assert.equal(initial.anchor, groups[0][0]);
  const focusedDetect = createFieldHandler(inputs, groups[1][2]);
  for (const candidateCache of [undefined, initial.candidateCache]) {
    const selected = focusedDetect({ action: "detect", candidateCache, trackedAnchor: initial.anchor });
    assert.equal(selected.anchor, groups[1][0]);
    assert.equal(focusedDetect({ action: "fill", code: "123456", expectedAnchor: selected.anchor }).ok, true);
    assert.equal(groups[0].every(input => input.value === undefined), true);
    assert.equal(groups[1].map(input => input.value).join(""), "123456");
  }
  // The popup has no expected anchor and must also respect the focused group.
  groups[1].forEach(input => { input.value = ""; });
  assert.equal(focusedDetect({ action: "fill", code: "654321" }).ok, true);
  assert.equal(groups[1].map(input => input.value).join(""), "654321");
});

test("hidden instructions and non-rendered content cannot qualify a generic code field", () => {
  for (const [tagName, props] of [
    ["P", { hidden: true }], ["P", { getAttribute: () => "true" }],
    ["SCRIPT", {}], ["STYLE", {}], ["TEMPLATE", {}],
    ["P", { fakeComputedStyle: { display: "none" } }],
    ["P", { fakeComputedStyle: { visibility: "hidden" } }],
    ["P", { fakeComputedStyle: { opacity: "0" } }],
  ]) {
    const form = contextElement("FORM", [
      contextElement(tagName, [contextText("We sent a verification code to your email.")], props),
      contextText("Code"),
    ]);
    const input = new FakeInput({ name: "code", form });
    const detect = createFieldHandler([input], input);
    assert.equal(detect({ action: "detect" }).ok, false, tagName);
    assert.equal(detect({ action: "fill", code: "123456" }).ok, false, tagName);
    assert.equal(input.value, undefined);
  }
});

test("generic context retains visible instructions and rejects incomplete traversal", () => {
  const instruction = "We sent a verification code to your email.";
  for (const children of [
    [contextText(instruction), ...Array.from({ length: 500 }, () => contextText("x"))],
    [contextText(instruction), contextText("x".repeat(10_000))],
  ]) {
    const input = new FakeInput({ name: "code", form: contextElement("FORM", children) });
    const detect = createFieldHandler([input]);
    assert.equal(detect({ action: "detect" }).ok, false);
    assert.equal(detect({ action: "fill", code: "123456" }).ok, false);
    assert.equal(input.value, undefined);
    input.autocomplete = "one-time-code";
    assert.equal(detect({ action: "detect" }).ok, true);
  }
  const form = contextElement("FORM", [
    contextElement("P", [contextText("Verification code")], { hidden: true }),
    contextElement("P", [contextText("We sent a "), contextElement("SPAN", [contextText("code")]), contextText(" to your email.")]),
  ]);
  const input = new FakeInput({ name: "code", form });
  assert.equal(createFieldHandler([input])({ action: "detect" }).ok, true);
  assert.equal(run([input]).ok, true);
});

test("unlabelled numeric fields need a validated OTP group to take focus", () => {
  const parentElement = {};
  const code = new FakeInput({ name: "verification_code" });
  const unrelated = Array.from({ length: 6 }, () => new FakeInput({ maxLength: 1, parentElement }));
  const detect = createFieldHandler([code, ...unrelated], unrelated[2]);
  assert.equal(detect({ action: "detect" }).anchor, code);
  assert.equal(detect({ action: "fill", code: "123456" }).ok, true);
  assert.equal(code.value, "123456");
  assert.equal(unrelated.every(input => input.value === undefined), true);
});
