import { POLL_WINDOW_MS } from "./mail-timing.js";

export function createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs }) {
  let timer, deadline = 0, generation = 0;
  return {
    get deadline() { return deadline; },
    get generation() { return generation; },
    restart() { deadline = clock.now() + POLL_WINDOW_MS; },
    reset() { this.clear(); deadline = 0; },
    clear() { clearTimeout(timer); timer = undefined; },
    invalidate() { generation++; },
    isCurrent(value) { return value === generation; },
    expired() { return clock.now() >= deadline; },
    schedule(callback, delay = intervalMs) {
      this.clear();
      timer = setTimeout(callback, delay);
    },
  };
}

export function createRetryGate() {
  let active, retry = false;
  return {
    get busy() { return !!active; },
    start() {
      if (active) return null;
      active = {};
      return active;
    },
    requestRetry() {
      if (!active) return false;
      retry = true;
      return true;
    },
    invalidate() { active = undefined; retry = false; },
    finish(token) {
      if (active !== token) return null;
      active = undefined;
      const requested = retry;
      retry = false;
      return requested;
    },
  };
}
