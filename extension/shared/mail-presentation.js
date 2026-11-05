export const MAIL_PRESENTATION = {
  codes: {
    resultLabel: "codes",
    actionLabel: "Fill code",
    foundStatus: "Choose the code from the email you requested.",
    popupEmptyStatus:
      "No recent code yet. Request one on the website; keep this popup open.",
  },
  confirmationLinks: {
    resultLabel: "confirmation or sign-in links",
    actionLabel: "Open confirmation or sign-in link ↗",
    openedStatus: "Link opened in a new tab.",
    foundStatus: "Choose a confirmation or sign-in link.",
    popupEmptyStatus:
      "No recent confirmation or sign-in link. Request one and keep this popup open.",
    waitingStatus: "Waiting for your confirmation or sign-in email…",
    guidance:
      "Check the sender and link domain. Links may redirect. Opening a link may confirm your account or sign you in.",
  },
  passwordResetLinks: {
    resultLabel: "password reset links",
    actionLabel: "Open reset link ↗",
    openedStatus: "Password reset link opened in a new tab.",
    foundStatus: "Choose a password reset link to open.",
    popupEmptyStatus:
      "No recent password reset link yet. Request one and keep this popup open.",
    waitingStatus: "Waiting for your password reset email…",
    guidance:
      "Check the sender and link domain. Links may redirect.",
  },
};

export function formatAccountCheckWarnings(warnings) {
  return `Some accounts could not be checked: ${warnings.join("; ")}`;
}

export function formatSenderLabel(sender) {
  return sender?.trim() || "Unknown sender";
}

export function formatReceivedAt(receivedAt) {
  return `Received: ${new Date(receivedAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })}`;
}
