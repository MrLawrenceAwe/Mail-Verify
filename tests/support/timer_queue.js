import assert from "node:assert/strict";

// Callbacks run only when explicitly selected; the queue does not advance time.
export function createTimerQueue() {
  const pending = new Map();
  let nextId = 0;
  const take = (id) => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    return entry.fn;
  };
  return {
    setTimeout(fn, delay) {
      const id = ++nextId;
      pending.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    takeOldest() {
      return take(pending.keys().next().value);
    },
    get length() {
      return pending.size;
    },
    values() {
      return pending.values();
    },
    async runNextWithDelay(registeredDelayMs) {
      const match = [...pending].find(
        ([, entry]) => entry.delay === registeredDelayMs,
      );
      assert.ok(match, `timer with registered delay ${registeredDelayMs} exists`);
      await take(match[0])();
    },
  };
}
