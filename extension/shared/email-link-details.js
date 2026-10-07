export function appendEmailLinkDetails(document, card, item, className = "") {
  const details = [
    `Inbox: ${item.accountEmail}`,
    `From: ${item.sender?.trim() || "Unknown sender"}`,
    item.subject?.trim(),
    `Initial destination: ${new URL(item.url).hostname}`,
  ];
  for (const text of details.filter(Boolean)) {
    const line = document.createElement("p");
    line.textContent = text;
    if (className) line.className = className;
    card.append(line);
  }
}
