export async function copyPasswordResetLink(
  clipboard,
  url,
  recoveryMessage,
) {
  if (!clipboard?.writeText)
    throw new Error(`Clipboard unavailable. ${recoveryMessage}`);
  try {
    await clipboard.writeText(url);
  } catch (error) {
    throw new Error(
      `Could not copy password reset link. ${error.message || "Clipboard access failed."} ${recoveryMessage}`,
    );
  }
}
