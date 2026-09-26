import { handleCodeField } from "./fill-code.js";
import { MAX_CODE_AGE_MS, POLL_WINDOW_MS } from "./code-policy.js";
import { createPopupView } from "./popup-view.js";

const POLL_INTERVAL_MS = 8_000;
const MIN_POLL_PAUSE_MS = 2_000;

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
  let pollTimer, pollDeadline = 0, checkGeneration = 0;
  const {
    setStatus, setAccountAndCheckDisabled, renderAccounts, clearCodes, renderCodes,
  } = createPopupView(document, {
    onRemoveAccount: (email) => removeAccount(email),
    onFillCode: (item, button) => fillSelectedCode(item, button),
  });
  function updateAccounts(nextAccounts) {
    abortCheck();
    accounts = nextAccounts;
    renderAccounts(accounts);
    clearCodes();
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
    setAccountAndCheckDisabled(true);
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
        func: handleCodeField,
        args: [{ action: "fill", code: item.code }],
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
      setAccountAndCheckDisabled(false);
      scheduleCheck();
    }
  }
  function scheduleCheck(delay = POLL_INTERVAL_MS) {
    clearTimeout(pollTimer);
    if (!filling && !removingAccount && clock.now() < pollDeadline)
      pollTimer = setTimeout(checkForCodes, delay);
    else if (clock.now() >= pollDeadline) closeSession();
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
    setStatus("Checking your connected Yahoo inboxes…");
    try {
      const response = await sendSessionRequest("codes");
      const codes = response.codes;
      if (!filling && requestGeneration === checkGeneration) {
        renderCodes(codes, targetTab);
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
        setAccountAndCheckDisabled(filling || removingAccount);
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
      updateAccounts(result.accounts);
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
    setAccountAndCheckDisabled(true);
    try {
      const result = await sendCompanionRequest({ action: "disconnect", email });
      updateAccounts(result.accounts);
    } catch (error) {
      setStatus(error.message, true);
      pollDeadline = clock.now() + POLL_WINDOW_MS;
    } finally {
      removingAccount = false;
      setAccountAndCheckDisabled(false);
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
      if (result.accounts?.length) updateAccounts(result.accounts);
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
