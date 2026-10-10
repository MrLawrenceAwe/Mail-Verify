import test from "node:test";
import assert from "node:assert/strict";
import { createCodePickerHarness } from "./support/code_picker_harness.js";

test("picker repositions using the current viewport after resize", () => {
  const frames = [];
  const anchor = {};
  let mounted;
  const { environment, events } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor,
      rect: { left: 900, right: 1100, top: 100, bottom: 130 },
    }),
    onMount: (node) => {
      mounted = node;
    },
    onFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    check: () => new Promise(() => {}),
  });
  assert.equal(mounted.style.left, "900px");
  environment.innerWidth = 1000;
  environment.innerHeight = 150;
  events.get("resize")();
  frames.shift()();
  assert.equal(mounted.style.left, "752px");
  assert.equal(mounted.style.top, "36px");
});

test("picker avoids page controls and reuses their discovery during scroll", async () => {
  let mounted,
    observer,
    queries = 0;
  const controls = [];
  const { events, timers } = createCodePickerHarness({
    detectOrFillCodeFields: () => ({
      ok: true,
      anchor: {},
      rect: { left: 20, right: 200, top: 100, bottom: 130 },
    }),
    getControls: () => {
      queries++;
      return controls;
    },
    onMount: (node) => {
      mounted = node;
    },
    onObserve: (callback) => {
      observer = callback;
    },
    check: () => new Promise(() => {}),
  });
  assert.equal(mounted.style.top, "134px");
  const control = {
    nodeType: 1,
    isConnected: true,
    matches: () => true,
    getBoundingClientRect: () => ({
      left: 20,
      right: 200,
      top: 134,
      bottom: 170,
      width: 180,
      height: 36,
    }),
  };
  controls.push(control);
  observer([
    { type: "childList", target: {}, addedNodes: [control], removedNodes: [] },
  ]);
  await timers.runWithDelay(150);
  assert.equal(mounted.style.top, "36px");
  const beforeScroll = queries;
  events.get("scroll")();
  assert.equal(queries, beforeScroll);
  assert.equal(mounted.style.top, "36px");
});

test("scroll positioning uses animation frames and cached candidates; mutations rediscover", async () => {
  const frames = [];
  let observer,
    discoveries = 0,
    detections = 0,
    visible = false,
    mounted;
  const anchor = {};
  const cached = { inputs: [], contextRoots: [] };
  const { events, timers, elements } = createCodePickerHarness({
    detectOrFillCodeFields: ({ candidateCache: candidates }) => {
      detections++;
      if (!candidates) discoveries++;
      return {
        ok: visible,
        anchor,
        trackedAnchorOffscreen: !visible && !!candidates,
        candidateCache: cached,
        rect: { top: 100, bottom: 130, left: 20, right: 200 },
      };
    },
    onMount: (node) => {
      mounted = node;
    },
    onRemove: () => {
      mounted = undefined;
    },
    onObserve: (callback) => {
      observer = callback;
    },
    onFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    check: () => new Promise(() => {}),
  });
  assert.equal(discoveries, 1);
  for (let i = 0; i < 20; i++) events.get("scroll")();
  assert.equal(frames.length, 1);
  assert.equal(timers.length, 0);
  frames.shift()();
  assert.equal(discoveries, 1);
  visible = true;
  events.get("scroll")();
  frames.shift()();
  assert.equal(mounted.style.top, "134px");
  assert.equal(discoveries, 1);
  visible = false;
  events.get("scroll")();
  frames.shift()();
  assert.equal(mounted, undefined);
  observer([{ type: "attributes", target: { matches: () => true } }]);
  timers.takeOldest()();
  assert.equal(discoveries, 2);
  visible = true;
  events.get("scroll")();
  frames.shift()();
  elements["#close"].onclick();
  const before = detections;
  events.get("scroll")();
  assert.equal(frames.length, 0);
  assert.equal(detections, before);
});

test("oversized picker mutations coalesce into one deferred discovery", async () => {
  let observer,
    discoveries = 0;
  const contextRoots = [{ contains: () => true }];
  const { timers } = createCodePickerHarness({
    detectOrFillCodeFields: () => {
      discoveries++;
      return { ok: false, candidateCache: { inputs: [], contextRoots } };
    },
    onObserve: (callback) => {
      observer = callback;
    },
    check: () => {
      assert.fail("no field should start a mail check");
    },
  });
  const records = [
    {
      type: "childList",
      target: {},
      removedNodes: [],
      addedNodes: [{ nodeType: 3, textContent: "x".repeat(1_000_000) }],
    },
  ];
  for (let index = 0; index < 20; index++) observer(records);
  assert.equal(discoveries, 1);
  assert.equal(timers.length, 1);
  await timers.runWithDelay(150);
  assert.equal(discoveries, 2);
});
