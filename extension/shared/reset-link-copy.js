export async function copyPasswordResetLink(clipboard, url, unavailableMessage) {
  if (!clipboard?.writeText) throw new Error(unavailableMessage);
  try {
    await clipboard.writeText(url);
  } catch (error) {
    throw new Error(`Could not copy password reset link. ${error.message || "Clipboard access failed."} Try copying again.`);
  }
}
