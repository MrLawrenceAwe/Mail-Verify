export const MAIL_PRESENTATION = {
  codes: {
    resultLabel: "codes",
    foundStatus: "Choose the code for this website. Checking for newer codes…",
    popupEmptyStatus:
      "No recent code yet. Request one on the website; keep this popup open.",
  },
  confirmationLinks: {
    resultLabel: "confirmation links",
    actionLabel: "Open confirmation link ↗",
    foundStatus: "Choose a confirmation link to open.",
    popupEmptyStatus:
      "No recent confirmation link yet. Request one and keep this popup open.",
    waitingStatus: "Waiting for your confirmation email…",
    guidance:
      "Check the sender and link domain. Links may redirect. Opening a link in a new tab may confirm your account.",
  },
  passwordResetLinks: {
    resultLabel: "password reset links",
    actionLabel: "Copy password reset link",
    copyAgainLabel: "Copy again",
    copySuccessStatus: "Password reset link copied to clipboard.",
    foundStatus: "Choose a password reset email to copy its link.",
    popupEmptyStatus:
      "No recent password reset link yet. Request one and keep this popup open.",
    waitingStatus: "Waiting for your password reset email…",
    guidance:
      "Check the sender and link domain before copying. Links may redirect.",
  },
};

export function formatAccountCheckWarnings(warnings) {
  return `Some accounts could not be checked: ${warnings.join("; ")}`;
}

export function formatSenderLabel(sender) {
  return sender?.trim() || "Unknown sender";
}
