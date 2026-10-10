import { createMutationInspection } from "./mutation-inspection.js";
import { EMAIL_LINK_PANEL_SELECTOR } from "./email-link-step.js";
import {
  getRequestControlLabel,
  isPhoneOnlyRequestLabel,
} from "./request-controls.js";
import { isFreshMessage } from "../shared/mail-timing.js";

import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";

export function selectEmailLinks(items, minReceivedAtMs, now) {
  return items
    .filter((item) => {
      if (!isFreshMessage(item.receivedAt, now, minReceivedAtMs)) return false;
      return isSupportedEmailLinkUrl(item.url);
    })
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 5);
}

export function isEmailLinkRequestControl(control) {
  const label = getRequestControlLabel(control);
  if (isPhoneOnlyRequestLabel(label)) return false;
  if (/^(?:re-?send|send again)\b/i.test(label)) return true;
  return (
    /^(?:send|request|get|email)\b/i.test(label) &&
    /\b(?:confirm(?:ation)?|verif(?:y|ication)|activat(?:e|ion)|reset|password)\b/i.test(
      label,
    ) &&
    /\b(?:e-?mail|link)\b/i.test(label)
  );
}

export function mutationAffectsEmailLinkCard(
  records,
  host,
  document,
  hasActiveStep,
) {
  const relevantElements = `${EMAIL_LINK_PANEL_SELECTOR}, input`;
  const { textRequiresRediscovery, subtreeRequiresRediscovery, claimRecord } =
    createMutationInspection((value) =>
      /check|inbox|e-?mail|confirm|verif|activat|password|reset|\blink\b/i.test(
        value,
      ),
    );
  return records.some((record) => {
    const target = record.target;
    if (!claimRecord(record, host)) return false;
    if (record.type === "attributes")
      return subtreeRequiresRediscovery(target, relevantElements, true);
    const element = target.nodeType === 1 ? target : target.parentElement;
    const mutationInCandidatePanel =
      hasActiveStep &&
      Boolean(
        element?.closest?.(EMAIL_LINK_PANEL_SELECTOR) ||
          !document.querySelector?.(EMAIL_LINK_PANEL_SELECTOR),
      );
    if (record.type === "characterData")
      return (
        mutationInCandidatePanel ||
        textRequiresRediscovery(target.textContent || "") ||
        textRequiresRediscovery(record.oldValue || "")
      );
    if (record.type === "childList") {
      if (mutationInCandidatePanel) return true;
      for (const nodes of [record.addedNodes, record.removedNodes])
        for (const node of nodes)
          if (subtreeRequiresRediscovery(node, relevantElements, true))
            return true;
      return false;
    }
    return false;
  });
}
