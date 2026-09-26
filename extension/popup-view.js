export function createPopupView(document, { onRemoveAccount, onFillCode }) {
  const $ = (id) => document.getElementById(id);
  let renderedCodesKey;

  function setStatus(text, error = false) {
    $("status").textContent = text;
    $("status").classList.toggle("error", error);
  }

  function setAccountAndCheckDisabled(disabled) {
    $("checkCodes").disabled = disabled;
    for (const button of $("accounts").querySelectorAll("button")) button.disabled = disabled;
  }

  function renderAccounts(accounts) {
    $("setup").hidden = accounts.length > 0;
    $("companionSetup").hidden = true;
    $("codeResults").hidden = accounts.length === 0;
    $("accounts").replaceChildren();
    for (const email of accounts) {
      const row = document.createElement("div");
      row.className = "account";
      const label = document.createElement("span");
      label.textContent = email;
      const remove = document.createElement("button");
      remove.className = "quiet";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${email}`);
      remove.addEventListener("click", () => onRemoveAccount(email));
      row.append(label, remove);
      $("accounts").append(row);
    }
  }

  function clearCodes() {
    $("codes").replaceChildren();
    renderedCodesKey = undefined;
  }

  function renderCodes(codes, targetTab) {
    const key = JSON.stringify(codes);
    if (key === renderedCodesKey) return;
    renderedCodesKey = key;
    $("codes").replaceChildren();
    for (const item of codes) {
      const card = document.createElement("article");
      card.className = "card";
      for (const [tag, className, value] of [
        ["div", "code", item.code],
        ["p", "source", item.accountEmail],
        ["p", "sender", item.sender],
        ["p", "subject", item.subject],
      ]) {
        const element = document.createElement(tag);
        element.className = className;
        element.textContent = value;
        card.append(element);
      }
      const button = document.createElement("button");
      button.textContent = targetTab
        ? `Fill on ${new URL(targetTab.url).hostname}`
        : "Open an HTTPS sign-in page to fill";
      button.disabled = !targetTab;
      button.addEventListener("click", () => onFillCode(item, button));
      card.append(button);
      $("codes").append(card);
    }
  }

  return { setStatus, setAccountAndCheckDisabled, renderAccounts, clearCodes, renderCodes };
}
