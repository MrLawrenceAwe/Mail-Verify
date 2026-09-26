import { createCompanionClient } from "./companion-client.js";

export function registerInlineRequests(chrome, timers = globalThis) {
  // Reuse the authenticated mailbox while a visible code field is polling.
  const client = createCompanionClient(chrome.runtime);
  let pendingCodeRequest, idleTimer;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== "yahoo-inline-codes") return;
    (async () => {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
          !sender.url?.startsWith("https://") || !sender.tab?.id)
        throw new Error("Code checks are available on HTTPS pages only.");
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id !== sender.tab.id) throw new Error("Return to this tab to check for a code.");
      if (!pendingCodeRequest) {
        timers.clearTimeout(idleTimer);
        pendingCodeRequest = client.sendSessionRequest("codes").finally(() => {
          pendingCodeRequest = undefined;
          idleTimer = timers.setTimeout(() => client.closeSession(), 15_000);
        });
      }
      const { codes, warnings = [] } = await pendingCodeRequest;
      return { ok: true, codes, warnings };
    })().then(respond, (error) => respond({ ok: false, error: error.message }));
    return true;
  });
}

if (globalThis.chrome?.runtime?.onMessage) registerInlineRequests(chrome);
