export const POLL_WINDOW_MS = 120_000;
export const MAX_MESSAGE_AGE_MS = 600_000;

export function isFreshMessage(receivedAt, now, minReceivedAt = now - MAX_MESSAGE_AGE_MS) {
  return Number.isFinite(receivedAt) && receivedAt >= minReceivedAt &&
    receivedAt <= now && now - receivedAt <= MAX_MESSAGE_AGE_MS;
}
