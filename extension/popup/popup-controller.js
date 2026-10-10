import { createScanSchedule } from "../shared/scan-schedule.js";
import {
  MAIL_PRESENTATION,
  formatAccountCheckWarnings,
} from "../shared/mail-presentation.js";
import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";
import { detectOrFillCodeFields } from "../shared/code-fields.js";
import {
  isFreshMessage,
  DEFAULT_SCAN_INTERVAL_MS,
} from "../shared/mail-timing.js";
import { createPopupView } from "./popup-view.js";
import { copyPasswordResetLink } from "../shared/reset-link-copy.js";
import { createPollingLifecycle } from "../shared/polling-lifecycle.js";
import { CompanionUnavailableError } from "../shared/companion-client.js";

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
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout });
  let targetTab;
  let mailType = "codes";
  let checking = false,
    usingResult = false,
    removingAccount = false,
    savingAccount = false;
  const scanSchedule = createScanSchedule({
    clock,
    intervalMs: DEFAULT_SCAN_INTERVAL_MS,
  });
  const view = createPopupView(document, {
    onRemoveAccount: removeAccount,
    onFillCode: fillSelectedCode,
    onUseLink: useSelectedLink,
    onCheckMail: startMailCheck,
    onSaveAccount: saveAccount,
  });
  function applyConnectedAccounts(accountEmails) {
    resetMailCheckSession();
    view.renderAccounts(accountEmails);
    view.clearResults();
    if (!accountEmails.length) {
      polling.endPollingWindow();
      view.setStatus("No email accounts connected.");
      return;
    }
    startPolling();
  }
  function startPolling() {
    polling.renewDeadline();
    checkInbox();
  }
  function resetMailCheckSession() {
    scanSchedule.clearPending();
    polling.cancelScheduledCheck();
    polling.invalidateResponses();
    checking = false;
    closeSession();
  }
  async function useSelectedResult(action, { reusable = false } = {}) {
    if (usingResult || removingAccount || savingAccount) return;
    usingResult = true;
    resetMailCheckSession();
    view.setAccountAndCheckControlsDisabled(true);
    view.setResultButtonsDisabled(true);
    try {
      await action();
      polling.endPollingWindow();
    } catch (error) {
      view.setStatus(error.message, true);
      view.setResultButtonsDisabled(false);
    } finally {
      usingResult = false;
      if (reusable) view.setResultButtonsDisabled(false);
      view.setAccountAndCheckControlsDisabled(savingAccount);
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
        func: detectOrFillCodeFields,
        args: [{ action: "fill", code: item.code }],
      });
      if (!result?.ok)
        throw new Error(result?.error || "Could not fill this page.");
      view.setStatus("Code filled. The website may continue automatically.");
      view.markCodeFilled(button);
    });
  }
  async function useSelectedLink(item, button) {
    await useSelectedResult(
      async () => {
        if (!isFreshMessage(item.receivedAt, clock.now()))
          throw new Error("This link is too old. Request a new email.");
        if (!isSupportedEmailLinkUrl(item.url))
          throw new Error("This link is not supported.");
        if (mailType === "passwordResetLinks") {
          await copyPasswordResetLink(
            clipboard,
            item.url,
            "Clipboard unavailable. Close and reopen this popup, then try again.",
          );
          view.markLinkCopied(button);
          view.setStatus(
            MAIL_PRESENTATION.passwordResetLinks.copySuccessStatus,
          );
          return;
        }
        await chrome.tabs.create({ url: item.url });
        view.markLinkOpened(button);
        view.setStatus("Confirmation link opened in a new tab.");
      },
      { reusable: mailType === "passwordResetLinks" },
    );
  }
  function scheduleCheck(delay = DEFAULT_SCAN_INTERVAL_MS) {
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (!usingResult && !removingAccount) polling.schedule(checkInbox, delay);
    else polling.cancelScheduledCheck();
  }
  function finishPolling() {
    polling.cancelScheduledCheck();
    closeSession();
    if (!usingResult && !removingAccount)
      view.setStatus(
        `Automatic checking finished. Check again for newer ${MAIL_PRESENTATION[mailType].resultLabel}.`,
      );
  }
  async function checkInbox() {
    if (usingResult || removingAccount) return;
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (checking) resetMailCheckSession();
    polling.cancelScheduledCheck();
    checking = true;
    const requestGeneration = polling.generation;
    const startedAt = clock.now();
    let failed = false;
    view.setStatus("Checking your connected inboxes…");
    try {
      const { collectOnly } = scanSchedule.beginCheck();
      const response = await sendSessionRequest(mailType, collectOnly);
      const results = response[mailType];
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        scanSchedule.recordResponse(response.scanPending);
        if (mailType !== "codes") view.renderLinks(results, mailType);
        else view.renderCodes(results, targetTab);
        view.setStatus(
          response.warnings?.length
            ? formatAccountCheckWarnings(response.warnings)
            : results.length
              ? MAIL_PRESENTATION[mailType].foundStatus
              : scanSchedule.pending
                ? "Checking your connected inboxes…"
                : MAIL_PRESENTATION[mailType].popupEmptyStatus,
        );
      }
    } catch (error) {
      failed = true;
      if (!usingResult && polling.isCurrent(requestGeneration)) {
        scanSchedule.clearPending();
        view.clearResults();
        view.setStatus(error.message, true);
      }
    } finally {
      if (polling.isCurrent(requestGeneration)) {
        checking = false;
        view.setAccountAndCheckControlsDisabled(
          usingResult || removingAccount || savingAccount,
        );
        scheduleCheck(
          failed
            ? DEFAULT_SCAN_INTERVAL_MS
            : scanSchedule.pending
              ? scanSchedule.pollDelayMs
              : Math.max(
                  MIN_POLL_PAUSE_MS,
                  DEFAULT_SCAN_INTERVAL_MS - (clock.now() - startedAt),
                ),
        );
      }
    }
  }
  function startMailCheck(nextMailType) {
    if (usingResult || removingAccount || savingAccount) return;
    resetMailCheckSession();
    if (mailType !== nextMailType) view.clearResults();
    mailType = nextMailType;
    // Unchanged results retain their buttons, including the disabled state
    // left by a successful fill. A manual check starts a new selection.
    view.setResultButtonsDisabled(mailType === "codes" && !targetTab);
    view.setMailType(mailType);
    startPolling();
  }
  async function saveAccount() {
    if (savingAccount || removingAccount) return;
    savingAccount = true;
    view.setAccountSaveDisabled(true);
    view.setAccountAndCheckControlsDisabled(true);
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
      savingAccount = false;
      view.setAccountSaveDisabled(false);
      view.setAccountAndCheckControlsDisabled(usingResult || removingAccount);
    }
  }
  async function removeAccount(email) {
    if (savingAccount || removingAccount) return;
    polling.endPollingWindow();
    removingAccount = true;
    resetMailCheckSession();
    view.setAccountAndCheckControlsDisabled(true);
    try {
      const result = await sendOneOffRequest({
        action: "removeAccount",
        email,
      });
      removingAccount = false;
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      view.setStatus(error.message, true);
      polling.renewDeadline();
    } finally {
      removingAccount = false;
      view.setAccountAndCheckControlsDisabled(false);
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
    view.setCodeTargetPage(targetTab);
    try {
      const result = await sendSessionRequest("status");
      if (result.accountEmails?.length)
        applyConnectedAccounts(result.accountEmails);
      else {
        view.showAccountSetup();
        view.setStatus("Connect once. No webmail tab needed.");
      }
    } catch (error) {
      view.setStatus(error.message, true);
      if (error instanceof CompanionUnavailableError) view.showCompanionSetup();
    }
  }

  return { initialize };
}
