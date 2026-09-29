export function isSupportedConfirmationUrl(value) {
  if (typeof value !== "string" || value.length > 4096 ||
      !/^https:\/\//i.test(value) || /[\s\x00-\x1f\x7f\\]/.test(value))
    return false;
  try {
    const url = new URL(value);
    const authority = value.slice("https://".length).split(/[/?#]/, 1)[0];
    return url.protocol === "https:" && !!authority && !!url.hostname && !url.username &&
      !url.password && !url.port && !authority.includes("%");
  } catch {
    return false;
  }
}
