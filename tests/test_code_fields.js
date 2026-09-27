import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { handleCodeField } from "../extension/code-fields.js";

// Chrome serializes this function into the page; evaluate the exported function
// in an isolated DOM context to verify it has no module-scope dependencies.
class FakeInput {
  constructor(props = {}) {
    Object.assign(
      this,
      {
        type: "text",
        maxLength: -1,
        name: "",
        id: "",
        placeholder: "",
        autocomplete: "",
        labels: [],
        form: null,
        parentElement: null,
        events: [],
      },
      props,
    );
  }
  getClientRects() {
    return [1];
  }
  getBoundingClientRect() {
    return this.rect || { top: 0, left: 0, bottom: 20, right: 100 };
  }
  checkVisibility() {
    return !this.hidden;
  }
  getAttribute() {
    return "";
  }
  set value(value) {
    this._value = value;
  }
  get value() {
    return this._value;
  }
  dispatchEvent(event) {
    this.events.push(event.type);
  }
  focus() {
    this.focused = true;
  }
}
function run(inputs, activeElement = null, expectedAnchor = null) {
  const ctx = {
    expectedAnchor,
    document: { querySelectorAll: () => inputs, activeElement },
    HTMLInputElement: FakeInput,
    innerHeight: 800,
    innerWidth: 1200,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
  };
  vm.createContext(ctx);
  return vm.runInContext(`(${handleCodeField.toString()})({ action: "fill", code: "123456", expectedAnchor })`, ctx);
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
    const context = vm.createContext({
      document: { querySelectorAll: () => [current], activeElement: original },
      HTMLInputElement: FakeInput, innerHeight: 800, innerWidth: 1200,
      Event: class { constructor(type) { this.type = type; } },
    });
    const result = vm.runInContext(`(${handleCodeField.toString()})({ action: "fill", code: "123456" })`, context);
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
    HTMLInputElement: FakeInput,
    innerHeight: 800,
    innerWidth: 1200,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
  };
  vm.createContext(rerenderCtx);
  assert.equal(
    vm.runInContext(`(${handleCodeField.toString()})({ action: "fill", code: "123456" })`, rerenderCtx).ok,
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
  const context = vm.createContext({
    document: { querySelectorAll: () => current, activeElement: original[0] },
    HTMLInputElement: FakeInput, innerHeight: 800, innerWidth: 1200,
    Event: class { constructor(type) { this.type = type; } },
  });
  const result = vm.runInContext(`(${handleCodeField.toString()})({ action: "fill", code: "123456" })`, context);
  assert.equal(result.ok, false);
  assert.equal(current[0].value, undefined);
  assert.equal(original[1].value, undefined);
});

test("Indeed's Enter code requires email verification context", () => {
  const input = new FakeInput({
    labels: [{ textContent: "Enter code *" }],
    form: { textContent: "Check your email for a code. We sent a code to you. Enter code *" },
  });
  assert.equal(run([input]).ok, true);
  input.form.textContent = "Enter code to redeem a discount";
  assert.equal(run([input]).ok, false);
  input.form.textContent = "We sent a code to your email";
  input.labels = [{ textContent: "Promo code" }];
  assert.equal(run([input]).ok, false);
});

test("generic code field uses verification context outside its form", () => {
  const instructions = { textContent: "We sent a code to your email." };
  const main = { textContent: "We sent a code to your email. Enter code" };
  const form = { textContent: "Enter code", parentElement: main, previousElementSibling: instructions };
  const input = new FakeInput({ name: "code", form });
  const context = vm.createContext({
    document: { querySelectorAll: () => [input], activeElement: input, body: main },
    innerHeight: 800,
    innerWidth: 1200,
  });
  const result = vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context);
  assert.equal(result.ok, true);
  assert.equal(result.candidateCache.contextRoots.length, 3);
  assert.equal(result.candidateCache.contextRoots.includes(form), true);
  assert.equal(result.candidateCache.contextRoots.includes(instructions), true);
  instructions.textContent = "Enter code to redeem a discount";
  assert.equal(vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context).ok, false);
});

test("unrelated verification text elsewhere in main does not identify a generic field", () => {
  const main = { textContent: "Verification code for account settings. Redeem your gift code." };
  const couponInstructions = { textContent: "Redeem your gift code." };
  const form = { textContent: "Code", parentElement: main, previousElementSibling: couponInstructions };
  const input = new FakeInput({ name: "code", form });
  const context = vm.createContext({
    document: { querySelectorAll: () => [input], activeElement: input, body: main },
    innerHeight: 800, innerWidth: 1200,
  });
  assert.equal(vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context).ok, false);
  couponInstructions.textContent = "We sent a code to your email.";
  assert.equal(vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context).ok, true);
});

test("explicit hints skip page text and generic hints read shared context once", () => {
  const explicit = new FakeInput({ autocomplete: "one-time-code", form: {
    get textContent() { throw new Error("unneeded context read"); },
  } });
  assert.equal(run([explicit]).ok, true);
  let reads = 0;
  const form = { get textContent() { reads++; return "We sent a code to your email"; } };
  const inputs = [new FakeInput({ name: "code", form }), new FakeInput({ name: "code", form })];
  run(inputs);
  assert.equal(reads, 1);
});

test("automatic detection does not fill or dispatch events", () => {
  const input = new FakeInput({ autocomplete: "one-time-code" });
  const context = vm.createContext({
    document: { querySelectorAll: () => [input], activeElement: input },
    innerHeight: 800, innerWidth: 1200,
  });
  assert.equal(vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context).ok, true);
  assert.equal(input.value, undefined);
  assert.deepEqual(input.events, []);
});

test("detection reports generic code context for later page updates", () => {
  const form = { textContent: "Enter code", contains: () => true };
  const input = new FakeInput({ name: "code", form });
  const context = vm.createContext({
    document: { querySelectorAll: () => [input], activeElement: input },
    innerHeight: 800, innerWidth: 1200,
  });
  const result = vm.runInContext(`(${handleCodeField.toString()})({ action: "detect" })`, context);
  assert.equal(result.ok, false);
  assert.equal(result.candidateCache.contextRoots[0], form);
});


test("cached detection tracks offscreen candidates without rescanning unrelated inputs", () => {
  let queries = 0;
  const input = new FakeInput({ autocomplete: "one-time-code", rect: { top: 900, bottom: 930, left: 0, right: 100 } });
  const unrelated = new FakeInput({ name: "search" });
  unrelated.getClientRects = () => { throw new Error("Unrelated fields need no layout reads"); };
  const context = vm.createContext({
    document: { querySelectorAll: () => { queries++; return [input, unrelated]; }, activeElement: null },
    innerHeight: 800, innerWidth: 1200,
  });
  vm.runInContext(`var detect = (${handleCodeField.toString()}); var field = detect({ action: "detect" });`, context);
  assert.equal(context.field.ok, false);
  input.rect = { top: 100, bottom: 130, left: 0, right: 100 };
  vm.runInContext('field = detect({ action: "detect", candidateCache: field.candidateCache });', context);
  assert.equal(context.field.ok, true);
  assert.equal(queries, 1);
  input.isConnected = false;
  vm.runInContext('field = detect({ action: "detect", candidateCache: field.candidateCache });', context);
  assert.equal(context.field.ok, false);
  input.isConnected = true;
  input.autocomplete = "";
  vm.runInContext('field = detect({ action: "detect" });', context);
  assert.equal(context.field.ok, false);
  assert.equal(queries, 2);
});
