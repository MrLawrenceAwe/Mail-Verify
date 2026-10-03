import { createMutationInspection } from "./mutation-inspection.js";
import { getRequestControlLabel } from "../shared/request-controls.js";
import { isFreshMessage } from "../shared/mail-timing.js";

export function calculatePickerPosition(rect, width, height, viewportWidth, viewportHeight) {
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const below = rect.bottom + 4;
  const top = below + height <= viewportHeight - 8
    ? below
    : Math.max(8, rect.top - height - 4);
  return { left, top };
}

export function selectSuggestedCodes(codes, minReceivedAtMs, now = Date.now(), excludedMessageKeys = new Set()) {
  const senders = new Set();
  return codes
    .filter((item) => !excludedMessageKeys.has(messageKey(item)) && isFreshMessage(item.receivedAt, now, minReceivedAtMs))
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .filter((item) => {
      const senderKey = item.sender.trim()
        ? `sender:${item.accountEmail.toLowerCase()}:${item.sender.toLowerCase()}`
        : `message:${messageKey(item)}`;
      if (senders.has(senderKey)) return false;
      senders.add(senderKey);
      return true;
    });
}

export function messageKey(item) {
  return `${item.accountEmail.toLowerCase()}:${item.uid}`;
}

export function mutationAffectsPicker(records, host, contextRoots = [], stepRoots = [], stepParent, labelRoots = []) {
  const { consumeNodeBudget, textNeedsRescan, subtreeNeedsRescan, shouldInspectRecord } = createMutationInspection(
    (value) => /code|email|verif|sign.?in|\bsent\b|\bcheck\b/i.test(value),
  );
  return records.some((record) => {
    const target = record.target;
    if (!shouldInspectRecord(record, host)) return false;
    if (labelRoots.some((root) => root === target || root.contains?.(target))) return true;
    if (record.type === "childList" && target === stepParent) return true;
    if (stepRoots.some((root) => root.contains?.(target)) &&
        (record.type === "characterData" || record.type === "childList")) return true;
    const inContext = contextRoots.some((root) => root.contains?.(target));
    if (record.type === "attributes")
      return record.attributeName === "id" || target?.matches?.("input, label") || subtreeNeedsRescan(target, "input");
    if (record.type === "characterData") {
      if (inContext && (!consumeNodeBudget() ||
          textNeedsRescan(target.textContent || "") || textNeedsRescan(record.oldValue || ""))) return true;
      return !!target?.parentElement?.closest?.("label");
    }
    if (target?.closest?.("label")) return true;
    for (const nodes of [record.addedNodes, record.removedNodes])
      for (const node of nodes)
        if (subtreeNeedsRescan(node, "input, label, form, main", inContext)) return true;
    return false;
  });
}

export function isCodeRequestControl(control) {
  const label = getRequestControlLabel(control);
  if (/\b(?:coupon|promo|discount|referral)\b/i.test(label)) return false;
  return /^(?:re-?send|send|request|get|email)\b/i.test(label) &&
    (/\b(?:code|otp|passcode)\b/i.test(label) || /^(?:re-?send(?: again| e-?mail)?|send again)$/i.test(label));
}
