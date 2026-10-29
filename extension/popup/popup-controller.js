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
import { createPollingLifecycle } from "../shared/polling-lifecycle.js";
import { CompanionUnavailableError } from "../shared/companion-client.js";

const MIN_COMPLETED_SCAN_PAUSE_MS = 2_000;

export function createPopupController({
  document,
  chrome,
  client,
  clock = Date,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const { sendOneOffRequest, sendSessionRequest, closeSession } = client;
  const polling = createPollingLifecycle({ clock, setTimeout, clearTimeout });
  let targetTab;
  let mailType = "codes";
  let mailCheckInProgress = false;
  let userActionInProgress = false;
  let selectionCompleted = false;
  let checkIssue;
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
    selectionCompleted = false;
    setUserActionInProgress(false);
    if (!accountEmails.length) {
      polling.endPollingWindow();
      view.setStatus("No email accounts connected.");
      return;
    }
    startPolling();
  }
  function startPolling() {
    checkIssue = undefined;
    polling.renewDeadline();
    checkInbox();
  }
  function resetMailCheckSession() {
    scanSchedule.clearPending();
    polling.cancelScheduledCheck();
    polling.invalidateResponses();
    mailCheckInProgress = false;
    closeSession();
  }
  function setUserActionInProgress(inProgress) {
    userActionInProgress = inProgress;
    view.setBusy(inProgress);
    view.setResultButtonsDisabled(
      inProgress || selectionCompleted || (mailType === "codes" && !targetTab),
    );
  }
  async function useSelectedResult(action) {
    if (userActionInProgress) return;
    setUserActionInProgress(true);
    resetMailCheckSession();
    try {
      await action();
      selectionCompleted = true;
      polling.endPollingWindow();
    } catch (error) {
      view.setStatus(error.message, true);
    } finally {
      setUserActionInProgress(false);
      if (polling.deadline) scheduleCheck();
      else closeSession();
    }
  }
  async function fillSelectedCode(item, button) {
    await useSelectedResult(async () => {
      if (!isFreshMessage(item.receivedAt, clock.now()))
        throw new Error("This code is no longer current. Request a new code.");
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
          throw new Error("This link is no longer current. Request a new email.");
        if (!isSupportedEmailLinkUrl(item.url))
          throw new Error("This link is not supported.");
        await chrome.tabs.create({ url: item.url });
        view.markLinkOpened(button);
        view.setStatus(MAIL_PRESENTATION[mailType].openedStatus);
      },
    );
  }
  function scheduleCheck(delay = DEFAULT_SCAN_INTERVAL_MS) {
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (!userActionInProgress) polling.schedule(checkInbox, delay);
    else polling.cancelScheduledCheck();
  }
  function finishPolling() {
    polling.endPollingWindow();
    closeSession();
    if (!userActionInProgress)
      view.setStatus(
        `${checkIssue ? `${checkIssue.message} ` : ""}Automatic checking finished. Check again for newer ${MAIL_PRESENTATION[mailType].resultLabel}.`,
        checkIssue?.error === true,
      );
  }
  async function checkInbox() {
    if (userActionInProgress) return;
    if (polling.hasExpired()) {
      finishPolling();
      return;
    }
    if (mailCheckInProgress) resetMailCheckSession();
    polling.cancelScheduledCheck();
    mailCheckInProgress = true;
    const requestGeneration = polling.generation;
    const startedAt = clock.now();
    let failed = false;
    view.setStatus("Checking your connected inboxes…");
    try {
      const { collectOnly } = scanSchedule.beginCheck();
      const response = await sendSessionRequest(mailType, collectOnly);
      if (!userActionInProgress && polling.isCurrent(requestGeneration)) {
        const results = mailType === "codes"
          ? response[mailType]
          : response[mailType].filter((item) => isSupportedEmailLinkUrl(item.url));
        scanSchedule.recordResponse(response.scanPending);
        if (mailType !== "codes") view.renderLinks(results, mailType);
        else view.renderCodes(results, targetTab);
        checkIssue = response.warnings?.length
          ? { message: formatAccountCheckWarnings(response.warnings) }
          : undefined;
        view.setStatus(
          checkIssue
            ? checkIssue.message
            : results.length
              ? mailType === "codes" && !targetTab
                ? "Open an HTTPS page with a verification-code field, then reopen Mail Verify to fill a code."
                : MAIL_PRESENTATION[mailType].foundStatus
              : scanSchedule.pending
                ? "Checking your connected inboxes…"
                : MAIL_PRESENTATION[mailType].popupEmptyStatus,
        );
      }
    } catch (error) {
      failed = true;
      if (!userActionInProgress && polling.isCurrent(requestGeneration)) {
        scanSchedule.clearPending();
        view.clearResults();
        checkIssue = { message: error.message, error: true };
        view.setStatus(error.message, true);
      }
    } finally {
      if (polling.isCurrent(requestGeneration)) {
        mailCheckInProgress = false;
        scheduleCheck(
          failed
            ? DEFAULT_SCAN_INTERVAL_MS
            : scanSchedule.pending
              ? scanSchedule.pollDelayMs
              : Math.max(
                  MIN_COMPLETED_SCAN_PAUSE_MS,
                  DEFAULT_SCAN_INTERVAL_MS - (clock.now() - startedAt),
                ),
        );
      }
    }
  }
  function startMailCheck(nextMailType) {
    if (userActionInProgress) return;
    resetMailCheckSession();
    if (mailType !== nextMailType) view.clearResults();
    mailType = nextMailType;
    // Retain unchanged cards, but restore their actions for a new selection.
    selectionCompleted = false;
    view.resetResultLabels(mailType);
    setUserActionInProgress(false);
    view.setMailType(mailType);
    startPolling();
  }
  async function saveAccount() {
    if (userActionInProgress) return;
    setUserActionInProgress(true);
    resetMailCheckSession();
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
      setUserActionInProgress(false);
      if (polling.deadline && !mailCheckInProgress) {
        if (polling.hasExpired()) polling.endPollingWindow();
        else scheduleCheck();
      }
    }
  }
  async function removeAccount(email) {
    if (userActionInProgress) return;
    polling.endPollingWindow();
    setUserActionInProgress(true);
    resetMailCheckSession();
    try {
      const result = await sendOneOffRequest({
        action: "removeAccount",
        email,
      });
      applyConnectedAccounts(result.accountEmails);
    } catch (error) {
      view.setStatus(error.message, true);
      polling.renewDeadline();
    } finally {
      setUserActionInProgress(false);
      if (polling.deadline && !mailCheckInProgress) scheduleCheck();
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
