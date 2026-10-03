import { createMutationInspection } from "./mutation-inspection.js";
import { getRequestControlLabel } from "../shared/step-text.js";
import { isFreshMessage } from "../shared/mail-timing.js";

import { isSupportedEmailLinkUrl } from "../shared/email-link-url.js";

export function selectEmailLinks(items, minReceivedAtMs, now) {
  return items.filter((item) => {
    if (!isFreshMessage(item.receivedAt, now, minReceivedAtMs)) return false;
    return isSupportedEmailLinkUrl(item.url);
  }).sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5);
}

export function isEmailLinkRequestControl(control) {
  const label = getRequestControlLabel(control);
  if (/^(?:re-?send|send again)\b/i.test(label)) return true;
  return /^(?:send|request|get|email)\b/i.test(label) &&
    /\b(?:confirm(?:ation)?|verif(?:y|ication)|activat(?:e|ion)|reset|password)\b/i.test(label) &&
    /\b(?:e-?mail|link)\b/i.test(label);
}

export function mutationAffectsEmailLinkCard(records, host, document, hasActiveStep, hasDescendant = (node, selector) => node?.querySelector?.(selector)) {
  const panels = "main, [role=main], form, [role=dialog]";
  const relevantElements = `${panels}, input`;
  const { relevantText, relevantSubtree, shouldInspectRecord } = createMutationInspection(
    (value) => /check|inbox|e-?mail|confirm|verif|activat|password|reset|\blink\b/i.test(value),
  );
  return records.some((record) => {
    const target = record.target;
    if (!shouldInspectRecord(record, host)) return false;
    const element = target.nodeType === 1 ? target : target.parentElement;
    const inActivePanel = hasActiveStep &&
      (element?.closest?.(panels) || !document.querySelector?.(panels));
    if (record.type === "attributes")
      return !!(target.matches?.(relevantElements) || hasDescendant(target, relevantElements));
    if (record.type === "characterData")
      return !!inActivePanel || relevantText(target.textContent || "") || relevantText(record.oldValue || "");
    if (record.type === "childList") {
      if (inActivePanel) return true;
      for (const nodes of [record.addedNodes, record.removedNodes])
        for (const node of nodes)
          if (relevantSubtree(node, relevantElements, true)) return true;
      return false;
    }
    return false;
  });
}
