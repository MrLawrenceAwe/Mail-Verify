export function isSupportedConfirmationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username &&
      !url.password && !url.port && !/[\s\\]/.test(value);
  } catch {
    return false;
  }
}
