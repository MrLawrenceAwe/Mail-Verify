import { MAIL_TYPES } from "../shared/mail-types.js";
import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";
import { handleCodeField } from "../shared/code-fields.js";
import { isFreshMessage } from "../shared/mail-timing.js";
import { createPopupView } from "./popup-view.js";
import { copyPasswordResetLink } from "../shared/reset-link-copy.js";
import { createPollingLifecycle } from "../shared/polling-lifecycle.js";

const POLL_INTERVAL_MS = 8_000;
const MIN_POLL_PAUSE_MS = 2_000;

export function createPopupController({
  document,
  chrome,
  client,
  clock = Date,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  clipboard = globalThis.navigator?.clipboard,
}) {
  const { sendOneOffRequest, sendSessionRequest, closeSession } = client;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout, intervalMs: POLL_INTERVAL_MS });
  let targetTab;
  let mailType = "codes";
  let checking = false,
    usingResult = false,
    removingAccount = false,
    addingAccount = false;
  const view = createPopupView(document, {
    onRemoveAccount: removeAccount,
    onFillCode: fillSelectedCode,
    onUseLink: useSelectedLink,
    onSelectMailType: selectMailType,
    onAddAccount: addAccount,
  });
  function applyConnectedAccounts(accountEmails) {
    abortCheck();
    view.renderAccounts(accountEmails);
    view.clearResults();
    if (!accountEmails.length) {
      polling.reset();
      view.setStatus("No email accounts connected.");
      return;
    }
    startPolling();
  }
  function startPolling() {
    polling.renewDeadline();
    checkInbox();
  }
  function abortCheck() {
    polling.cancelScheduledCheck();
    polling.invalidateResponses();
    checking = false;
    closeSession();
  }
  async function useSelectedResult(action, { reusable = false } = {}) {
    if (usingResult || removingAccount || addingAccount) return;
    usingResult = true;
    abortCheck();
    view.setAccountAndCheckButtonsDisabled(true);
    view.setResultButtonsDisabled(true);
    try {
      await action();
      polling.reset();
    } catch (error) {
      view.setStatus(error.message, true);
      view.setResultButtonsDisabled(false);
    } finally {
      usingResult = false;
      if (reusable) view.setResultButtonsDisabled(false);
      view.setAccountAndCheckButtonsDisabled(addingAccount);
      if (polling.deadline) scheduleCheck();
      else closeSession();
    }
  }
  async function fillSelectedCode(item, button) {
    await useSelectedResult(async () => {
      if (!isFreshMessage(item.receivedAt, clock.now()))
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
      view.setStatus("Code filled. The website may continue automatically.");
      view.markCodeFilled(button);
    });
  }
  async function useSelectedLink(item, button) {
    await useSelectedResult(async () => {
      if (!isFreshMessage(item.receivedAt, clock.now()))
        throw new Error("This link is too old. Request a new email.");
      if (!isSupportedEmailLinkUrl(item.url))
        throw new Error("This link is not supported.");
      if (mailType === "passwordResetLinks") {
        await copyPasswordResetLink(clipboard, item.url,
          "Clipboard unavailable. Close and reopen this popup, then try again.");
        view.markLinkCopied(button);
        view.setStatus(MAIL_TYPES.passwordResetLinks.copySuccessStatus);
        return;
      }
      await chrome.tabs.create({ url: item.url });
      view.markLinkOpened(button);
      view.setStatus("Confirmation link opened in a new tab.");
    }, { reusable: mailType === "passwordResetLinks" });
  }
  function scheduleCheck(delay = POLL_INTERVAL_MS) {
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (!usingResult && !removingAccount)
      polling.schedule(checkInbox, delay);
    else polling.cancelScheduledCheck();
  }
  function finishPolling() {
    polling.cancelScheduledCheck();
    closeSession();
    if (!usingResult && !removingAccount)
      view.setStatus(`Automatic checking finished. Check again for newer ${MAIL_TYPES[mailType].resultLabel}.`);
  }
  async function checkInbox() {
    if (usingResult || removingAccount) return;
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (checking) abortCheck();
    polling.cancelScheduledCheck();
    checking = true;
    const requestGeneration = polling.generation;
    const startedAt = clock.now();
    let failed = false;
    view.setStatus("Checking your connected inboxes…");
    try {
      const response = await sendSessionRequest(mailType);
      const results = response[mailType];
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        if (mailType !== "codes") view.renderLinks(results, mailType);
        else view.renderCodes(results, targetTab);
        view.setStatus(
          response.warnings?.length
            ? `Some accounts could not be checked: ${response.warnings.join("; ")}`
            : results.length ? MAIL_TYPES[mailType].foundStatus : MAIL_TYPES[mailType].emptyStatus,
        );
      }
    } catch (error) {
      failed = true;
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        view.clearResults();
        view.setStatus(error.message, true);
      }
    } finally {
      if (polling.isCurrent(requestGeneration)) {
        checking = false;
        view.setAccountAndCheckButtonsDisabled(usingResult || removingAccount || addingAccount);
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
  function selectMailType(nextMailType) {
    if (usingResult || removingAccount || addingAccount) return;
    abortCheck();
    if (mailType !== nextMailType) view.clearResults();
    mailType = nextMailType;
    // Unchanged results retain their buttons, including the disabled state
    // left by a successful fill. A manual check starts a new selection.
    view.setResultButtonsDisabled(mailType === "codes" && !targetTab);
    view.setMailType(mailType);
    startPolling();
  }
  async function addAccount() {
    if (addingAccount || removingAccount) return;
    addingAccount = true;
    view.setAddAccountDisabled(true);
    view.setAccountAndCheckButtonsDisabled(true);
    view.setStatus("Checking your Yahoo connection…");
    const { email, password } = view.readCredentialsAndClearPassword();
    try {
      const result = await sendOneOffRequest({
        action: "saveAccount",
        email,
        password,
      });
      view.clearAccountEmail();
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      view.setStatus(error.message, true);
    } finally {
      addingAccount = false;
      view.setAddAccountDisabled(false);
      view.setAccountAndCheckButtonsDisabled(usingResult || removingAccount);
    }
  }
  async function removeAccount(email) {
    if (addingAccount || removingAccount) return;
    polling.reset();
    removingAccount = true;
    abortCheck();
    view.setAccountAndCheckButtonsDisabled(true);
    try {
      const result = await sendOneOffRequest({ action: "removeAccount", email });
      removingAccount = false;
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      view.setStatus(error.message, true);
      polling.renewDeadline();
    } finally {
      removingAccount = false;
      view.setAccountAndCheckButtonsDisabled(false);
      if (polling.deadline && !checking) scheduleCheck();
    }
  }
  async function initialize() {
    view.setMailType(mailType);
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.url?.startsWith("https://")) targetTab = tab;
    view.setDestination(targetTab
      ? new URL(targetTab.url).hostname
      : "an HTTPS sign-in page");
    try {
      const result = await sendSessionRequest("status");
      if (result.accountEmails?.length) applyConnectedAccounts(result.accountEmails);
      else {
        view.showAccountSetup();
        view.setStatus("Connect once. No webmail tab needed.");
      }
    } catch (error) {
      view.setStatus(error.message, true);
      view.showCompanionSetup();
    }
  }

  return { initialize };
}
