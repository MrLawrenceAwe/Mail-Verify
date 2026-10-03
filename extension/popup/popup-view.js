import { MAIL_PRESENTATION } from "../shared/mail-presentation.js";
import { appendEmailLinkDetails } from "../shared/email-link-details.js";

export function createPopupView(document, { onRemoveAccount, onFillCode, onUseLink, onCheckMail, onAddAccount }) {
  const getElement = (id) => document.getElementById(id);
  const checkButtonMailTypes = [
    ["checkCodes", "codes"],
    ["checkConfirmationLinks", "confirmationLinks"],
    ["checkPasswordResetLinks", "passwordResetLinks"],
  ];
  let renderedResultsKey;

  function setStatus(text, error = false) {
    getElement("status").textContent = text;
    getElement("status").classList.toggle("error", error);
  }

  function showAccountSetup() {
    getElement("accountSetup").hidden = false;
    getElement("email").focus();
  }

  function showCompanionSetup() {
    getElement("companionSetup").hidden = false;
  }

  function setMailType(mailType) {
    getElement("codeContext").hidden = mailType !== "codes";
    getElement("linkGuidance").hidden = mailType === "codes";
    getElement("linkGuidance").textContent = MAIL_PRESENTATION[mailType].guidance || "";
  }

  function setDestination(text) {
    getElement("destination").textContent = text;
  }

  function setAccountSubmitDisabled(disabled) {
    getElement("addAccountSubmit").disabled = disabled;
  }

  function readCredentialsAndClearPassword() {
    const email = getElement("email").value;
    const password = getElement("password").value;
    getElement("password").value = "";
    return { email, password };
  }

  function clearAccountEmail() {
    getElement("email").value = "";
  }

  function setCheckAndRemoveButtonsDisabled(disabled) {
    for (const [id] of checkButtonMailTypes) getElement(id).disabled = disabled;
    for (const button of getElement("accounts").querySelectorAll("button")) button.disabled = disabled;
  }

  function setResultButtonsDisabled(disabled) {
    for (const button of getElement("results").querySelectorAll("button")) button.disabled = disabled;
  }

  function markCodeFilled(button) {
    button.textContent = "Filled";
  }

  function markLinkOpened(button) {
    button.textContent = "Opened";
  }

  function markLinkCopied(button) {
    button.textContent = MAIL_PRESENTATION.passwordResetLinks.copyAgainLabel;
  }

  function renderAccounts(accounts) {
    getElement("accountSetup").hidden = accounts.length > 0;
    getElement("companionSetup").hidden = true;
    getElement("connectedAccountPanel").hidden = accounts.length === 0;
    getElement("accounts").replaceChildren();
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
      getElement("accounts").append(row);
    }
  }

  function clearResults() {
    getElement("results").replaceChildren();
    renderedResultsKey = undefined;
  }

  function renderCodes(codes, targetTab) {
    const key = JSON.stringify(codes);
    if (key === renderedResultsKey) return;
    renderedResultsKey = key;
    getElement("results").replaceChildren();
    for (const item of codes) {
      const card = document.createElement("article");
      card.className = "card";
      for (const [tag, className, value] of [
        ["div", "code", item.code],
        ["p", "account-email", item.accountEmail],
        ["p", "result-detail", item.sender],
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
        : "Open an HTTPS page with a verification-code field";
      button.disabled = !targetTab;
      button.addEventListener("click", () => onFillCode(item, button));
      card.append(button);
      getElement("results").append(card);
    }
  }

  function renderLinks(links, mailType) {
    const key = mailType + ":" + JSON.stringify(links);
    if (key === renderedResultsKey) return;
    renderedResultsKey = key;
    getElement("results").replaceChildren();
    for (const item of links) {
      const card = document.createElement("article");
      card.className = "card";
      appendEmailLinkDetails(document, card, item, "result-detail");
      const button = document.createElement("button");
      button.textContent = MAIL_PRESENTATION[mailType].actionLabel;
      button.addEventListener("click", () => onUseLink(item, button));
      card.append(button);
      getElement("results").append(card);
    }
  }

  for (const [id, mailType] of checkButtonMailTypes) getElement(id).addEventListener("click", () => onCheckMail(mailType));
  getElement("addAccountForm").addEventListener("submit", (event) => {
    event.preventDefault();
    return onAddAccount();
  });
  getElement("addAccount").addEventListener("click", showAccountSetup);

  return { setStatus, showAccountSetup, showCompanionSetup,
    setMailType, setDestination, setAccountSubmitDisabled, readCredentialsAndClearPassword,
    clearAccountEmail, setCheckAndRemoveButtonsDisabled, setResultButtonsDisabled,
    markCodeFilled, markLinkOpened, markLinkCopied, renderAccounts, clearResults, renderCodes, renderLinks };
}
