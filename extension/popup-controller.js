import { handleCodeField } from "./code-fields.js";
import { MAX_CODE_AGE_MS, POLL_WINDOW_MS } from "./code-timing.js";
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
  const { sendOneOffRequest, sendSessionRequest, closeSession } = client;
  let targetTab;
  let mode = "codes";
  let checking = false,
    filling = false,
    removingAccount = false,
    addingAccount = false;
  let pollTimer, pollDeadline = 0, checkGeneration = 0;
  const {
    setStatus, setRemoveAndCheckDisabled, setCodeButtonsDisabled,
    markCodeFilled, renderAccounts, clearCodes, renderCodes, renderLinks,
    showAccountSetup, showCompanionSetup, setExtensionId, setDestination,
    setAddAccountDisabled, readCredentialsAndClearPassword, clearAccountEmail,
  } = createPopupView(document, {
    onRemoveAccount: (email) => removeAccount(email),
    onFillCode: (item, button) => fillSelectedCode(item, button),
    onOpenLink: (item, button) => openSelectedLink(item, button),
  });
  function applyConnectedAccounts(accountEmails) {
    abortCheck();
    renderAccounts(accountEmails);
    clearCodes();
    if (!accountEmails.length) {
      pollDeadline = 0;
      setStatus("No email accounts connected.");
      return;
    }
    startPolling();
  }
  function startPolling() {
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
    setRemoveAndCheckDisabled(true);
    setCodeButtonsDisabled(true);
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
          "The page changed. Reopen Mail Verify on the intended page.",
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
      markCodeFilled(button);
    } catch (error) {
      setStatus(error.message, true);
      setCodeButtonsDisabled(false);
    } finally {
      filling = false;
      setRemoveAndCheckDisabled(addingAccount);
      if (pollDeadline) scheduleCheck();
      else closeSession();
    }
  }
  async function openSelectedLink(item, button) {
    if (filling || removingAccount || addingAccount) return;
    filling = true;
    abortCheck();
    setRemoveAndCheckDisabled(true);
    setCodeButtonsDisabled(true);
    try {
      if (!Number.isFinite(item.receivedAt) || clock.now() - item.receivedAt > MAX_CODE_AGE_MS || item.receivedAt > clock.now())
        throw new Error("This link is too old. Request a new confirmation email.");
      const url = new URL(item.url);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port || /[\s\\]/.test(item.url))
        throw new Error("This confirmation link is not supported.");
      await chrome.tabs.create({ url: item.url });
      pollDeadline = 0;
      button.textContent = "Opened";
      setStatus("Confirmation link opened in a new tab.");
    } catch (error) {
      setStatus(error.message, true);
      setCodeButtonsDisabled(false);
    } finally {
      filling = false;
      setRemoveAndCheckDisabled(addingAccount);
      if (pollDeadline) scheduleCheck();
      else closeSession();
    }
  }
  function scheduleCheck(delay = POLL_INTERVAL_MS) {
    if (clock.now() >= pollDeadline) {
      finishPolling();
      return;
    }
    clearTimeout(pollTimer);
    if (!filling && !removingAccount)
      pollTimer = setTimeout(checkForCodes, delay);
  }
  function finishPolling() {
    clearTimeout(pollTimer);
    closeSession();
    if (!filling && !removingAccount)
      setStatus(`Automatic checking finished. Check again for newer ${mode}.`);
  }
  async function checkForCodes() {
    if (filling || removingAccount) return;
    if (clock.now() >= pollDeadline) {
      finishPolling();
      return;
    }
    if (checking) abortCheck();
    clearTimeout(pollTimer);
    checking = true;
    const requestGeneration = ++checkGeneration;
    const startedAt = clock.now();
    let failed = false;
    setStatus("Checking your connected inboxes…");
    try {
      const response = await sendSessionRequest(mode);
      const codes = response[mode];
      if (!filling && requestGeneration === checkGeneration) {
        if (mode === "links") renderLinks(codes);
        else renderCodes(codes, targetTab);
        setStatus(
          response.warnings?.length ? `Some accounts could not be checked: ${response.warnings.join("; ")}` : codes.length
            ? mode === "links" ? "Check the sender and destination, then open your confirmation link." : "Choose the code for this website. Checking for newer codes…"
            : mode === "links" ? "No recent confirmation link yet. Request one and keep this popup open." : "No recent code yet. Request one on the website; keep this popup open.",
        );
      }
    } catch (error) {
      failed = true;
      if (!filling && requestGeneration === checkGeneration) {
        clearCodes();
        setStatus(error.message, true);
      }
    } finally {
      if (requestGeneration === checkGeneration) {
        checking = false;
        setRemoveAndCheckDisabled(filling || removingAccount || addingAccount);
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
  function selectMode(nextMode) {
    if (filling || removingAccount || addingAccount) return;
    abortCheck();
    if (mode !== nextMode) clearCodes();
    mode = nextMode;
    startPolling();
  }
  $("checkCodes").addEventListener("click", () => selectMode("codes"));
  $("checkLinks").addEventListener("click", () => selectMode("links"));
  $("addAccountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (addingAccount || removingAccount) return;
    addingAccount = true;
    setAddAccountDisabled(true);
    setRemoveAndCheckDisabled(true);
    setStatus("Checking your Yahoo connection…");
    const { email, password } = readCredentialsAndClearPassword();
    try {
      const result = await sendOneOffRequest({
        action: "saveAccount",
        email,
        password,
      });
      clearAccountEmail();
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      addingAccount = false;
      setAddAccountDisabled(false);
      setRemoveAndCheckDisabled(filling || removingAccount);
    }
  });
  $("addAccount").addEventListener("click", () => {
    showAccountSetup();
  });
  async function removeAccount(email) {
    if (addingAccount || removingAccount) return;
    pollDeadline = 0;
    removingAccount = true;
    abortCheck();
    setRemoveAndCheckDisabled(true);
    try {
      const result = await sendOneOffRequest({ action: "removeAccount", email });
      removingAccount = false;
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      setStatus(error.message, true);
      pollDeadline = clock.now() + POLL_WINDOW_MS;
    } finally {
      removingAccount = false;
      setRemoveAndCheckDisabled(false);
      if (pollDeadline && !checking) scheduleCheck();
    }
  }
  async function initialize() {
    setExtensionId(chrome.runtime.id);
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.url?.startsWith("https://")) targetTab = tab;
    setDestination(targetTab
      ? new URL(targetTab.url).hostname
      : "an HTTPS sign-in page");
    try {
      const result = await sendSessionRequest("status");
      if (result.accountEmails?.length) applyConnectedAccounts(result.accountEmails);
      else {
        showAccountSetup();
        setStatus("Connect once. No webmail tab needed.");
      }
    } catch (error) {
      setStatus(error.message, true);
      showCompanionSetup();
    }
  }

  return { initialize };
}
