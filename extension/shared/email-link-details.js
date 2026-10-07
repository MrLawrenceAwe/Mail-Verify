export function appendEmailLinkDetails(document, card, item, className = "") {
  for (const text of [item.accountEmail, item.sender, item.subject, `Initial destination: ${new URL(item.url).hostname}`]) {
    const line = document.createElement("p");
    line.textContent = text;
    if (className) line.className = className;
    card.append(line);
  }
}
