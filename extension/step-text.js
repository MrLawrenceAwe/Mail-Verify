export function normalizeStepText(text) {
  return text
    .replace(/\b\d{1,2}:\d{2}\b/g, "#")
    .replace(/\b(?:re-?send|send again|retry|try again|expires?|wait)\s+(?:in\s+|after\s+)?\d{1,3}(?:\s*(?:seconds?|minutes?|secs?|mins?|s|m))?\b/gi, "# timer")
    .replace(/\b\d+\s*(?:seconds?|minutes?|secs?|mins?|s|m)\b/gi, "# time")
    .replace(/\s+/g, " ").trim();
}
