// Match ordinary and masked addresses; each caller classifies its own instructions.
export function recipientKeyFromText(text, matchesInstruction) {
  const recipients = new Set();
  const addresses = text.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~•…-]{1,128}@[a-z0-9_*•…-]{1,63}(?:\.[a-z0-9_*•…-]{1,63}){1,8}/gi);
  for (const match of addresses) {
    const instruction = text.slice(Math.max(0, match.index - 180), match.index);
    if (matchesInstruction(instruction)) recipients.add(match[0].toLowerCase());
  }
  return JSON.stringify([...recipients].sort());
}
