import { isSupportedConfirmationUrl } from "./confirmation-url.js";
import { handleCodeField } from "./code-fields.js";
import { MAX_MESSAGE_AGE_MS } from "./mail-timing.js";
import { createPopupView } from "./popup-view.js";
import { createPollingLifecycle } from "./polling-lifecycle.js";

const POLL_INTERVAL_MS = 8_000;
const MIN_POLL_PAUSE_MS = 2_000;

export function createPopupController({
  document,
  chrome,
  client,
  clock = Date,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const $ = (id) => document.getElementById(id);
  const { sendOneOffRequest, sendSessionRequest, closeSession } = client;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: POLL_INTERVAL_MS });
  let targetTab;
  let mode = "codes";
  let checking = false,
    usingResult = false,
    removingAccount = false,
    addingAccount = false;
  const {
    setStatus, setRemoveAndCheckDisabled, setResultButtonsDisabled,
    markCodeFilled, markLinkOpened, renderAccounts, clearResults, renderCodes, renderLinks,
    showAccountSetup, showCompanionSetup, setExtensionId, setMode, setDestination,
    setAddAccountDisabled, readCredentialsAndClearPassword, clearAccountEmail,
  } = createPopupView(document, {
    onRemoveAccount: (email) => removeAccount(email),
    onFillCode: (item, button) => fillSelectedCode(item, button),
    onOpenLink: (item, button) => openSelectedLink(item, button),
  });
  function applyConnectedAccounts(accountEmails) {
    abortCheck();
    renderAccounts(accountEmails);
    clearResults();
    if (!accountEmails.length) {
      polling.reset();
      setStatus("No email accounts connected.");
      return;
    }
    startPolling();
  }
  function startPolling() {
    polling.restart();
    checkInbox();
  }
  function abortCheck() {
    polling.clear();
    polling.invalidate();
    checking = false;
    closeSession();
  }
  async function useSelectedResult(action) {
    if (usingResult || removingAccount || addingAccount) return;
    usingResult = true;
    abortCheck();
    setRemoveAndCheckDisabled(true);
    setResultButtonsDisabled(true);
    try {
      await action();
      polling.reset();
    } catch (error) {
      setStatus(error.message, true);
      setResultButtonsDisabled(false);
    } finally {
      usingResult = false;
      setRemoveAndCheckDisabled(addingAccount);
      if (polling.deadline) scheduleCheck();
      else closeSession();
    }
  }
  async function fillSelectedCode(item, button) {
    await useSelectedResult(async () => {
      if (clock.now() - item.receivedAt > MAX_MESSAGE_AGE_MS)
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
      setStatus("Code filled. The website may continue automatically.");
      markCodeFilled(button);
    });
  }
  async function openSelectedLink(item, button) {
    await useSelectedResult(async () => {
      if (!Number.isFinite(item.receivedAt) || clock.now() - item.receivedAt > MAX_MESSAGE_AGE_MS || item.receivedAt > clock.now())
        throw new Error("This link is too old. Request a new confirmation email.");
      if (!isSupportedConfirmationUrl(item.url))
        throw new Error("This confirmation link is not supported.");
      await chrome.tabs.create({ url: item.url });
      markLinkOpened(button);
      setStatus("Confirmation link opened in a new tab.");
    });
  }
  function scheduleCheck(delay = POLL_INTERVAL_MS) {
    if (polling.expired()) {
      finishPolling();
      return;
    }
    if (!usingResult && !removingAccount)
      polling.schedule(checkInbox, delay);
    else polling.clear();
  }
  function finishPolling() {
    polling.clear();
    closeSession();
    if (!usingResult && !removingAccount)
      setStatus(`Automatic checking finished. Check again for newer ${mode}.`);
  }
  async function checkInbox() {
    if (usingResult || removingAccount) return;
    if (polling.expired()) {
      finishPolling();
      return;
    }
    if (checking) abortCheck();
    polling.clear();
    checking = true;
    const requestGeneration = polling.generation;
    const startedAt = clock.now();
    let failed = false;
    setStatus("Checking your connected inboxes…");
    try {
      const response = await sendSessionRequest(mode);
      const results = response[mode];
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        if (mode === "links") renderLinks(results);
        else renderCodes(results, targetTab);
        setStatus(
          response.warnings?.length ? `Some accounts could not be checked: ${response.warnings.join("; ")}` : results.length
            ? mode === "links" ? "Check the sender and destination, then open your confirmation link." : "Choose the code for this website. Checking for newer codes…"
            : mode === "links" ? "No recent confirmation link yet. Request one and keep this popup open." : "No recent code yet. Request one on the website; keep this popup open.",
        );
      }
    } catch (error) {
      failed = true;
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        clearResults();
        setStatus(error.message, true);
      }
    } finally {
      if (polling.isCurrent(requestGeneration)) {
        checking = false;
        setRemoveAndCheckDisabled(usingResult || removingAccount || addingAccount);
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
    if (usingResult || removingAccount || addingAccount) return;
    abortCheck();
    if (mode !== nextMode) clearResults();
    mode = nextMode;
    setMode(mode);
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
      setRemoveAndCheckDisabled(usingResult || removingAccount);
    }
  });
  $("addAccount").addEventListener("click", () => {
    showAccountSetup();
  });
  async function removeAccount(email) {
    if (addingAccount || removingAccount) return;
    polling.reset();
    removingAccount = true;
    abortCheck();
    setRemoveAndCheckDisabled(true);
    try {
      const result = await sendOneOffRequest({ action: "removeAccount", email });
      removingAccount = false;
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      setStatus(error.message, true);
      polling.restart();
    } finally {
      removingAccount = false;
      setRemoveAndCheckDisabled(false);
      if (polling.deadline && !checking) scheduleCheck();
    }
  }
  async function initialize() {
    setExtensionId(chrome.runtime.id);
    setMode(mode);
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
