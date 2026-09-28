import { createCompanionClient } from "./companion-client.js";

export function registerInlineRequests(chrome, timers = globalThis) {
  // Keep independent scans so code and link requests cannot consume each other’s results.
  const scans = Object.fromEntries(["codes", "links"].map(kind => [kind, { client: createCompanionClient(chrome.runtime) }]));
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const kind = { "mail-verify-inline-codes": "codes", "mail-verify-inline-links": "links" }[message?.type];
    if (!kind) return;
    const scan = scans[kind];
    (async () => {
      if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
          !sender.url?.startsWith("https://") || !sender.tab?.id)
        throw new Error("Mail checks are available on HTTPS pages only.");
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id !== sender.tab.id) throw new Error("Return to this tab to check your inboxes.");
      if (!scan.pending) {
        timers.clearTimeout(scan.idleTimer);
        scan.pending = scan.client.sendSessionRequest(kind).finally(() => {
          scan.pending = undefined;
          scan.idleTimer = timers.setTimeout(() => scan.client.closeSession(), 15_000);
        });
      }
      const response = await scan.pending;
      return { ok: true, [kind]: response[kind], warnings: response.warnings || [] };
    })().then(respond, (error) => respond({ ok: false, error: error.message }));
    return true;
  });
}

if (globalThis.chrome?.runtime?.onMessage) registerInlineRequests(chrome);
