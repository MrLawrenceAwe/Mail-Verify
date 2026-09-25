import { fillCode } from "./fill-code.js";

const POLL_INTERVAL_MS = 8_000;
const POLL_WINDOW_MS = 120_000;
const MIN_POLL_PAUSE_MS = 2_000;
const MAX_CODE_AGE_MS = 600_000;

export function createPopup({
  document,
  chrome,
  client,
  clock = Date,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const $ = (id) => document.getElementById(id);
  const { sendCompanionRequest, sendSessionRequest, closeSession } = client;
  let targetTab;
  let accounts = [];
  let checking = false,
    filling = false,
    removingAccount = false;
  let pollTimer,
    pollDeadline = 0,
    checkGeneration = 0,
    renderedCodesKey;
  function setStatus(text, error = false) {
    $("status").textContent = text;
    $("status").classList.toggle("error", error);
  }
  function setActionControlsDisabled(disabled) {
    $("checkCodes").disabled = disabled;
    for (const button of $("accounts").querySelectorAll("button")) button.disabled = disabled;
  }
  function showAccounts(nextAccounts) {
    abortCheck();
    accounts = nextAccounts;
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
      remove.addEventListener("click", () => removeAccount(email));
      row.append(label, remove);
      $("accounts").append(row);
    }
    $("codes").replaceChildren();
    renderedCodesKey = undefined;
    if (!accounts.length) {
      pollDeadline = 0;
      setStatus("No Yahoo accounts connected.");
      return;
    }
    pollDeadline = clock.now() + POLL_WINDOW_MS;
    checkForCodes();
  }
  function abortCheck() {
    clearTimeout(pollTimer);
    checkGeneration++;
    checking = false;
    closeSession();
  }
  async function fillSelectedCode(item, button) {
    if (filling) return;
    filling = true;
    abortCheck();
    setActionControlsDisabled(true);
    const buttons = [...$("codes").querySelectorAll("button")];
    for (const control of buttons) control.disabled = true;
    try {
      if (clock.now() - item.receivedAt > MAX_CODE_AGE_MS)
        throw new Error("This code is too old. Request a new code.");
      const current = await chrome.tabs.get(targetTab.id);
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (active?.id !== targetTab.id || current.url !== targetTab.url)
        throw new Error(
          "The page changed. Reopen Code Fill on the intended page.",
        );
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: fillCode,
        args: [item.code],
      });
      if (!result?.ok)
        throw new Error(result?.error || "Could not fill this page.");
      pollDeadline = 0;
      setStatus("Code filled. The website may continue automatically.");
      button.textContent = "Filled";
    } catch (error) {
      setStatus(error.message, true);
      for (const control of buttons) control.disabled = false;
    } finally {
      filling = false;
      setActionControlsDisabled(false);
      scheduleCheck();
    }
  }
  function scheduleCheck(delay = POLL_INTERVAL_MS) {
    clearTimeout(pollTimer);
    if (!filling && !removingAccount && clock.now() < pollDeadline)
      pollTimer = setTimeout(checkForCodes, delay);
    else if (clock.now() >= pollDeadline) closeSession();
  }
  function renderCodes(codes) {
    const key = JSON.stringify(codes);
    if (key === renderedCodesKey) return;
    renderedCodesKey = key;
    $("codes").replaceChildren();
    for (const item of codes) {
      const card = document.createElement("article");
      card.className = "card";
      for (const [tag, className, text] of [
        ["div", "code", item.code],
        ["p", "source", item.accountEmail || accounts[0]],
        ["p", "sender", item.sender],
        ["p", "subject", item.subject],
      ]) {
        const el = document.createElement(tag);
        el.className = className;
        el.textContent = text;
        card.append(el);
      }
      const button = document.createElement("button");
      button.textContent = targetTab
        ? `Fill on ${new URL(targetTab.url).hostname}`
        : "Open an HTTPS sign-in page to fill";
      button.disabled = !targetTab;
      button.addEventListener("click", () => fillSelectedCode(item, button));
      card.append(button);
      $("codes").append(card);
    }
  }
  async function checkForCodes() {
    if (filling || removingAccount) return;
    if (clock.now() >= pollDeadline) {
      clearTimeout(pollTimer);
      closeSession();
      return;
    }
    if (checking) abortCheck();
    clearTimeout(pollTimer);
    checking = true;
    const requestGeneration = ++checkGeneration;
    const startedAt = clock.now();
    let failed = false;
    setStatus("Checking recent Yahoo emails… This may take up to 25 seconds.");
    try {
      const response = await sendSessionRequest("codes");
      const codes = response.codes;
      if (!filling && requestGeneration === checkGeneration) {
        renderCodes(codes);
        setStatus(
          response.warnings?.length ? `Some accounts could not be checked: ${response.warnings.join("; ")}` : codes.length
            ? "Choose the code for this website. Checking for newer codes…"
            : "No recent code yet. Request one on the website; keep this popup open.",
        );
      }
    } catch (error) {
      failed = true;
      if (!filling && requestGeneration === checkGeneration)
        setStatus(error.message, true);
    } finally {
      if (requestGeneration === checkGeneration) {
        checking = false;
        setActionControlsDisabled(filling || removingAccount);
        scheduleCheck(
          failed
            ? POLL_INTERVAL_MS
            : Math.max(
                MIN_POLL_PAUSE_MS,
                POLL_INTERVAL_MS - (clock.now() - startedAt),
              ),
        );
      }
    }
  }
  $("checkCodes").addEventListener("click", () => {
    pollDeadline = clock.now() + POLL_WINDOW_MS;
    checkForCodes();
  });
  $("connectForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("connect").disabled = true;
    setStatus("Checking your Yahoo connection…");
    const password = $("password").value;
    $("password").value = "";
    try {
      const result = await sendCompanionRequest({
        action: "configure",
        email: $("email").value,
        password,
      });
      $("email").value = "";
      showAccounts(result.accounts);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      $("connect").disabled = false;
    }
  });
  $("addAccount").addEventListener("click", () => {
    $("setup").hidden = false;
    $("email").focus();
  });
  async function removeAccount(email) {
    pollDeadline = 0;
    removingAccount = true;
    abortCheck();
    setActionControlsDisabled(true);
    try {
      const result = await sendCompanionRequest({ action: "disconnect", email });
      showAccounts(result.accounts);
    } catch (error) {
      setStatus(error.message, true);
      pollDeadline = clock.now() + POLL_WINDOW_MS;
    } finally {
      removingAccount = false;
      setActionControlsDisabled(false);
      if (pollDeadline) scheduleCheck();
    }
  }
  async function initialize() {
    $("extensionId").value = chrome.runtime.id;
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.url?.startsWith("https://")) targetTab = tab;
    $("destination").textContent = targetTab
      ? new URL(targetTab.url).hostname
      : "an HTTPS sign-in page";
    try {
      const result = await sendSessionRequest("status");
      if (result.accounts?.length) showAccounts(result.accounts);
      else {
        $("setup").hidden = false;
        setStatus("Connect once. No Yahoo tab needed.");
      }
    } catch (error) {
      setStatus(error.message, true);
      $("companionSetup").hidden = false;
    }
  }

  return { initialize };
}
