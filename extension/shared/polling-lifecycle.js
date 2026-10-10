import { POLL_WINDOW_MS } from "./mail-timing.js";
import { createScanSchedule } from "./scan-schedule.js";

export function createPollingLifecycle({ clock, setTimeout, clearTimeout }) {
  let timer,
    deadline = 0,
    generation = 0;
  return {
    get deadline() {
      return deadline;
    },
    get generation() {
      return generation;
    },
    renewDeadline() {
      deadline = clock.now() + POLL_WINDOW_MS;
    },
    // End automatic checking; cancelling a scheduled check alone retains its window.
    endPollingWindow() {
      this.cancelScheduledCheck();
      deadline = 0;
    },
    // Cancel only the next check, leaving the deadline and active response intact.
    cancelScheduledCheck() {
      clearTimeout(timer);
      timer = undefined;
    },
    invalidateResponses() {
      generation++;
    },
    isCurrent(value) {
      return value === generation;
    },
    hasExpired() {
      return clock.now() >= deadline;
    },
    schedule(callback, delay) {
      this.cancelScheduledCheck();
      timer = setTimeout(callback, delay);
    },
  };
}

function createCheckGate() {
  let active,
    retry = false;
  return {
    get busy() {
      return !!active;
    },
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
    invalidate() {
      active = undefined;
      retry = false;
    },
    finish(token) {
      if (active !== token) return "stale";
      active = undefined;
      const outcome = retry ? "retry" : "complete";
      retry = false;
      return outcome;
    },
  };
}

export function createInlinePollingLifecycle({ intervalMs, ...options }) {
  const polling = createPollingLifecycle(options);
  const checks = createCheckGate();
  const scanSchedule = createScanSchedule({ clock: options.clock, intervalMs });
  return Object.assign(polling, {
    checks,
    scanSchedule,
    invalidateChecks() {
      scanSchedule.clearPending();
      polling.invalidateResponses();
      checks.invalidate();
      polling.cancelScheduledCheck();
    },
    restart(check) {
      polling.renewDeadline();
      if (checks.requestRetry()) polling.invalidateResponses();
      else check();
    },
  });
}
