export const CODE_PICKER_SCAN_INTERVAL_MS = 2_000;
export const DEFAULT_SCAN_INTERVAL_MS = 8_000;
export const POLL_WINDOW_MS = 120_000;
export const PENDING_SCAN_POLL_MS = 1_000;
export const MAX_MESSAGE_AGE_MS = 600_000;
const STEP_ALLOWANCE_MS = 5_000;

export function stepStartCutoff(now) {
  return now - STEP_ALLOWANCE_MS;
}

// Exclude the current IMAP arrival second when a resend or changed link step starts.
export function nextSecondCutoff(now) {
  return Math.floor(now / 1000) * 1000 + 1000;
}

export function isFreshMessage(
  receivedAt,
  now,
  minReceivedAt = now - MAX_MESSAGE_AGE_MS,
) {
  return (
    Number.isFinite(receivedAt) &&
    receivedAt >= minReceivedAt &&
    receivedAt <= now &&
    now - receivedAt <= MAX_MESSAGE_AGE_MS
  );
}
