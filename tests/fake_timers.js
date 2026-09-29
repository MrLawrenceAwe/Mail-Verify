import assert from "node:assert/strict";

export function createFakeTimers() {
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
    clearTimeout(id) { pending.delete(id); },
    pop() { return take([...pending.keys()].at(-1)); },
    shift() { return take(pending.keys().next().value); },
    get length() { return pending.size; },
    values() { return pending.values(); },
    async run(delay) {
      const match = [...pending].find(([, entry]) => entry.delay === delay);
      assert.ok(match, `timer ${delay} exists`);
      await take(match[0])();
    },
  };
}
