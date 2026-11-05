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
  let activeCheck;
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
    view.renderAccounts(accountEmails);
    view.clearResults();
    selectionCompleted = false;
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
    activeCheck = undefined;
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
    if (activeCheck) resetMailCheckSession();
    polling.cancelScheduledCheck();
    const check = {};
    activeCheck = check;
    const startedAt = clock.now();
    let failed = false;
    view.setStatus("Checking your connected inboxes…");
    try {
      const collectOnly = scanSchedule.shouldCollectOnly();
      const response = await sendSessionRequest(mailType, collectOnly);
      if (!userActionInProgress && activeCheck === check) {
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
                ? "Verification codes found."
                : MAIL_PRESENTATION[mailType].foundStatus
              : scanSchedule.pending
                ? "Checking your connected inboxes…"
                : MAIL_PRESENTATION[mailType].popupEmptyStatus,
        );
      }
    } catch (error) {
      failed = true;
      if (!userActionInProgress && activeCheck === check) {
        scanSchedule.clearPending();
        view.clearResults();
        checkIssue = { message: error.message, error: true };
        view.setStatus(error.message, true);
      }
    } finally {
      if (activeCheck === check) {
        activeCheck = undefined;
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
    view.setStatus("Checking your Yahoo connection…");
    const { email, password } = view.readCredentialsAndClearPassword();
    await updateAccount({ action: "saveAccount", email, password });
  }
  async function removeAccount(email) {
    if (userActionInProgress) return;
    await updateAccount({ action: "removeAccount", email });
  }
  async function updateAccount(request) {
    setUserActionInProgress(true);
    resetMailCheckSession();
    const saving = request.action === "saveAccount";
    let result;
    try {
      result = await sendOneOffRequest(request);
    } catch (error) {
      view.setStatus(error.message, true);
    } finally {
      setUserActionInProgress(false);
    }
    if (result) {
      if (saving) view.clearAccountEmail();
      applyConnectedAccounts(result.accountEmails);
    } else {
      if (!saving) polling.renewDeadline();
      if (polling.hasExpired()) polling.endPollingWindow();
      else scheduleCheck();
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
      const result = await sendOneOffRequest({ action: "status" });
      if (result.accountEmails?.length)
        applyConnectedAccounts(result.accountEmails);
      else {
        view.showAccountSetup();
        view.setStatus("Connect once. No webmail tab needed.");
      }
    } catch (error) {
      if (error instanceof CompanionUnavailableError) {
        view.setStatus("Mac companion unavailable.", true);
        view.showCompanionSetup();
      } else {
        view.setStatus(error.message, true);
      }
    }
  }

  return { initialize };
}
