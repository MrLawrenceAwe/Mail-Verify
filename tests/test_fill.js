import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fillCode } from "../extension/fill-code.js";

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
function run(inputs, activeElement = null) {
  const ctx = {
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
  return vm.runInContext(`(${fillCode.toString()})("123456")`, ctx);
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

test("follows split fields replaced after each digit", () => {
  const rerenderParent = {};
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
    if (event.type === "input")
      current = current.map(
        (old, i) =>
          new FakeInput({
            maxLength: 1,
            parentElement: rerenderParent,
            name: i === 0 ? "verification_code" : "",
            value: old.value,
          }),
      );
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
    vm.runInContext(`(${fillCode.toString()})("123456")`, rerenderCtx).ok,
    true,
  );
  assert.equal(current.map((x) => x.value).join(""), "123456");
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
  assert.equal(vm.runInContext(`(${fillCode.toString()})("", true)`, context).ok, true);
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
  const result = vm.runInContext(`(${fillCode.toString()})("", true)`, context);
  assert.equal(result.ok, false);
  assert.equal(result.contextRoots[0], form);
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
  vm.runInContext(`var detect = (${fillCode.toString()}); var field = detect("", true);`, context);
  assert.equal(context.field.ok, false);
  input.rect = { top: 100, bottom: 130, left: 0, right: 100 };
  vm.runInContext('field = detect("", true, field.candidates);', context);
  assert.equal(context.field.ok, true);
  assert.equal(queries, 1);
  input.isConnected = false;
  vm.runInContext('field = detect("", true, field.candidates);', context);
  assert.equal(context.field.ok, false);
  input.isConnected = true;
  input.autocomplete = "";
  vm.runInContext('field = detect("", true);', context);
  assert.equal(context.field.ok, false);
  assert.equal(queries, 2);
});
