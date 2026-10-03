import { POLL_WINDOW_MS } from "./mail-timing.js";

export function createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs }) {
  let timer, deadline = 0, generation = 0;
  return {
    get deadline() { return deadline; },
    get generation() { return generation; },
    renewDeadline() { deadline = clock.now() + POLL_WINDOW_MS; },
    stopScheduledPolling() { this.cancelScheduledCheck(); deadline = 0; },
    cancelScheduledCheck() { clearTimeout(timer); timer = undefined; },
    invalidateResponses() { generation++; },
    isCurrent(value) { return value === generation; },
    hasExpired() { return clock.now() >= deadline; },
    schedule(callback, delay = intervalMs) {
      this.cancelScheduledCheck();
      timer = setTimeout(callback, delay);
    },
  };
}

function createCheckGate() {
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

export function createInlinePollingLifecycle(options) {
  const polling = createPollingLifecycle(options);
  const checks = createCheckGate();
  return Object.assign(polling, {
    checks,
    invalidateChecks() {
      polling.invalidateResponses();
      checks.invalidate();
      polling.cancelScheduledCheck();
    },
    renewAndQueueRetry() {
      polling.renewDeadline();
      if (!checks.requestRetry()) return false;
      polling.invalidateResponses();
      return true;
    },
  });
}
