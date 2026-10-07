import vm from "node:vm";
import { handleVerificationFields } from "../extension/shared/code-fields.js";

const contextStyle = node => node.fakeComputedStyle || { display: "block", visibility: "visible", opacity: "1" };

export class FakeInput {
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

// Chrome serializes the entry point. Evaluate it without module dependencies.
export function createVerificationFieldHarness(overrides = {}) {
  const context = vm.createContext({
    getComputedStyle: contextStyle,
    HTMLInputElement: FakeInput,
    innerHeight: 800,
    innerWidth: 1200,
    Event: class { constructor(type) { this.type = type; } },
    ...overrides,
  });
  context.handle = vm.runInContext(`(${handleVerificationFields.toString()})`, context);
  return context;
}
