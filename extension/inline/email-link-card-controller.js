import {
  selectSuggestedEmailLinks,
  isEligibleEmailLink,
  isEmailLinkRequestControl,
  mutationAffectsEmailLinkCard,
} from "./email-link-card-policy.js";
import { detectEmailLinkStep } from "./email-link-step.js";
import {
  MAIL_PRESENTATION,
  formatAccountCheckWarnings,
} from "../shared/mail-presentation.js";
import { createEmailLinkCardView } from "./email-link-card-view.js";
import {
  REQUEST_CONTROL_SELECTOR,
  belongsToVerificationStep,
} from "./request-controls.js";
import {
  MAX_MESSAGE_AGE_MS,
  nextSecondCutoff,
  DEFAULT_SCAN_INTERVAL_MS,
} from "../shared/mail-timing.js";
import { requestInlineCheck } from "./inline-client.js";
import { getPageCoordinator } from "./page-coordinator.js";
import { createInlinePollingLifecycle } from "../shared/polling-lifecycle.js";
import { mountSuggestion, suggestionMountRoot } from "./suggestion-mount.js";

export function startEmailLinkCard({
  environment = globalThis,
  detectStep = detectEmailLinkStep,
  page = getPageCoordinator(environment),
  hasCodeField = () => page.detectCodeField().ok,
  createView = createEmailLinkCardView,
} = {}) {
  const {
    document,
    location,
    chrome,
    setTimeout,
    clearTimeout,
    Date: clock = Date,
  } = environment;
  const polling = createInlinePollingLifecycle({
    clock,
    setTimeout,
    clearTimeout,
    intervalMs: DEFAULT_SCAN_INTERVAL_MS,
  });
  const { checks, scanSchedule } = polling;
  let view, discoveryTimer;
  let lastURL = location.href,
    dismissed = false,
    minReceivedAtMs;
  let activeStep = null;
  let currentLinks = [];
  let checkIssueMessage = "";
  function isCurrentStep() {
    const step = detectStep(document);
    return (
      activeStep !== null &&
      step?.key === activeStep.key &&
      step?.mailType === activeStep.mailType
    );
  }
  function unmountCard() {
    polling.invalidateChecks();
    view?.host.remove();
    view = undefined;
  }
  function dismissCard() {
    dismissed = true;
    unmountCard();
  }
  async function checkForLinks() {
    polling.cancelScheduledCheck();
    if (!view || document.hidden || checks.busy) return;
    if (lastURL !== location.href || hasCodeField() || !isCurrentStep()) {
      syncLinkCard();
      return;
    }
    if (polling.hasExpired()) {
      view.setStatus(
        `${checkIssueMessage ? `${checkIssueMessage} ` : ""}Checking finished. Click ↻ to check again.`,
      );
      return;
    }
    const { mailType } = activeStep;
    const requestGeneration = polling.generation;
    const checkToken = checks.start();
    try {
      const { collectOnly } = scanSchedule.beginCheck();
      const response = await requestInlineCheck(
        chrome.runtime,
        mailType,
        collectOnly,
      );
      if (!polling.isCurrent(requestGeneration) || !view || document.hidden)
        return;
      if (lastURL !== location.href || hasCodeField() || !isCurrentStep()) {
        syncLinkCard();
        return;
      }
      if (!response?.ok)
        throw new Error(response?.error || "Could not check your inboxes.");
      scanSchedule.recordResponse(response.scanPending);
      currentLinks = selectSuggestedEmailLinks(
        response[mailType] || [],
        minReceivedAtMs,
        clock.now(),
      );
      view.renderLinks(currentLinks);
      checkIssueMessage = response.warnings?.length
        ? formatAccountCheckWarnings(response.warnings)
        : "";
      view.setStatus(
        checkIssueMessage
          ? checkIssueMessage
          : currentLinks.length
            ? MAIL_PRESENTATION[mailType].foundStatus
            : MAIL_PRESENTATION[mailType].waitingStatus,
      );
    } catch (error) {
      if (polling.isCurrent(requestGeneration) && view) {
        checkIssueMessage = error.message;
        scanSchedule.clearPending();
        currentLinks = [];
        view.renderLinks(currentLinks);
        view.setStatus(error.message);
      }
    } finally {
      const outcome = checks.finish(checkToken);
      if (outcome === "stale") return;
      if (outcome === "retry" && view && !document.hidden) checkForLinks();
      else if (polling.isCurrent(requestGeneration) && view && !document.hidden)
        polling.schedule(checkForLinks, scanSchedule.pollDelayMs);
    }
  }
  function syncLinkCard() {
    if (lastURL !== location.href) {
      unmountCard();
      lastURL = location.href;
      dismissed = false;
      activeStep = null;
      minReceivedAtMs = undefined;
    }
    if (document.hidden) {
      unmountCard();
      return;
    }
    const nextStep = hasCodeField() ? null : detectStep(document);
    if (nextStep === null) {
      unmountCard();
      dismissed = false;
      activeStep = null;
      minReceivedAtMs = undefined;
      polling.endPollingWindow();
      return;
    }
    if (
      activeStep &&
      (nextStep.key !== activeStep.key ||
        nextStep.mailType !== activeStep.mailType)
    ) {
      unmountCard();
      dismissed = false;
      activeStep = null;
      // A changed panel can represent a different signup. IMAP arrival times
      // have one-second precision, so start with the next second to exclude
      // links delivered just before this step appeared.
      minReceivedAtMs = Math.max(
        minReceivedAtMs ?? -Infinity,
        nextSecondCutoff(clock.now()),
      );
      polling.endPollingWindow();
    }
    if (dismissed) return;
    if (!activeStep) {
      checkIssueMessage = "";
      activeStep = nextStep;
      minReceivedAtMs ??= clock.now() - MAX_MESSAGE_AGE_MS;
      polling.renewDeadline();
    }
    if (view) {
      if (view.host.parentNode !== suggestionMountRoot(document))
        mountSuggestion(document, view.host);
      return;
    }
    currentLinks = [];
    const { mailType } = activeStep;
    view = createView(document, {
      onClose: dismissCard,
      onRetry: () => polling.restart(checkForLinks),
      mailType,
      acceptLinkSelection(item) {
        if (
          document.hidden ||
          lastURL !== location.href ||
          hasCodeField() ||
          !isCurrentStep() ||
          !currentLinks.some(
            (current) =>
              current.accountEmail === item.accountEmail &&
              current.uid === item.uid &&
              current.url === item.url,
          ) ||
          !isEligibleEmailLink(item, minReceivedAtMs, clock.now())
        ) {
          view?.setStatus(
            "This link is no longer current. Request a new email or check again.",
          );
          return false;
        }
        dismissCard();
        return true;
      },
    });
    mountSuggestion(document, view.host);
    view.setStatus(MAIL_PRESENTATION[mailType].waitingStatus);
    checkForLinks();
  }
  function scheduleDiscovery() {
    if (discoveryTimer) return;
    discoveryTimer = setTimeout(() => {
      discoveryTimer = undefined;
      syncLinkCard();
    }, 250);
  }
  page.onMutation((records) => {
    if (
      mutationAffectsEmailLinkCard(
        records,
        view?.host,
        document,
        activeStep !== null,
      )
    )
      scheduleDiscovery();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && view) dismissCard();
  });
  document.addEventListener(
    "click",
    (event) => {
      const control = event.target.closest?.(REQUEST_CONTROL_SELECTOR);
      if (
        !activeStep ||
        !isEmailLinkRequestControl(control) ||
        !belongsToVerificationStep(control, activeStep.panel)
      )
        return;
      minReceivedAtMs = nextSecondCutoff(clock.now());
      checkIssueMessage = "";
      dismissed = false;
      unmountCard();
      polling.renewDeadline();
      syncLinkCard();
    },
    true,
  );
  page.onPageChange(scheduleDiscovery);
  syncLinkCard();
}
