import { PENDING_SCAN_POLL_MS } from "./mail-timing.js";

// Collection polls retrieve slow workers without delaying normal inbox scans.
export function createScanSchedule({ clock, intervalMs }) {
  let pending = false;
  let nextScanAt = 0;
  return {
    get pending() { return pending; },
    get pollDelay() { return pending ? PENDING_SCAN_POLL_MS : intervalMs; },
    beginCheck() {
      const now = clock.now();
      const collectOnly = pending && now < nextScanAt;
      if (!collectOnly) nextScanAt = now + intervalMs;
      return collectOnly;
    },
    recordResponse(scanPending) { pending = scanPending === true; },
    clearPending() { pending = false; },
  };
}
