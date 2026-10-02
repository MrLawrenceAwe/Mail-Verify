import test from "node:test";
import assert from "node:assert/strict";
import { getPageCoordinator } from "../extension/inline/page-coordinator.js";

test("page interfaces share one observer, navigation listener and code-field cache", () => {
  const events = new Map();
  const document = {
    documentElement: {},
    addEventListener(name, callback) { events.set(name, callback); },
  };
  const window = {
    addEventListener(name, callback) { events.set(name, callback); },
    navigation: { addEventListener(name, callback) { events.set(name, callback); } },
  };
  let observers = 0, discoveries = 0, observed;
  const browser = { document, window, MutationObserver: class {
    constructor(callback) { observers++; observed = callback; }
    observe() {}
  } };
  const detect = ({ candidateCache }) => {
    if (!candidateCache) discoveries++;
    return { ok: true, candidateCache: { inputs: [] } };
  };
  const picker = getPageCoordinator(browser, detect);
  const card = getPageCoordinator(browser);
  assert.equal(picker, card);
  picker.detectCodeField();
  card.detectCodeField();
  assert.equal(discoveries, 1);
  card.invalidateCandidates();
  picker.detectCodeField();
  assert.equal(discoveries, 2);

  let pickerChanges = 0, cardChanges = 0;
  picker.onMutation(() => pickerChanges++);
  card.onMutation(() => cardChanges++);
  observed([{ type: "childList" }]);
  assert.deepEqual([pickerChanges, cardChanges], [1, 1]);
  picker.onPageChange(() => pickerChanges++);
  card.onPageChange(() => cardChanges++);
  events.get("popstate")();
  assert.deepEqual([pickerChanges, cardChanges], [2, 2]);
  assert.equal(observers, 1);
});


test("mutation containment is cached, invalidated by structure, and skipped while hidden", () => {
  let observe, queries = 0, mutations = 0;
  const document = {documentElement: {}, hidden: false, addEventListener() {}};
  const browser = {document, window: {addEventListener() {}}, MutationObserver: class {
    constructor(callback) { observe = callback; }
    observe() {}
  }};
  const page = getPageCoordinator(browser, () => ({ok: false, candidateCache: {inputs: []}}));
  const target = {querySelector() { queries++; return null; }};
  page.onMutation(() => {
    mutations++;
    page.hasMutationDescendant(target, "input");
  });
  for (let i = 0; i < 1000; i++) observe([{type: "attributes", target, attributeName: "class"}]);
  assert.equal(queries, 1);
  observe([{type: "childList", target}]);
  assert.equal(queries, 2);
  observe([{type: "attributes", target, attributeName: "role"}]);
  assert.equal(queries, 3);
  page.detectCodeField();
  document.hidden = true;
  observe([{type: "childList", target}]);
  assert.equal(mutations, 1002);
  assert.equal(queries, 3);
  assert.equal(page.candidateCache, undefined);
  document.hidden = false;
  observe([{type: "attributes", target}]);
  assert.equal(queries, 4);
});
