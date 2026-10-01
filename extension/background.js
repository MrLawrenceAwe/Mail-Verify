import { createCompanionClient } from "./companion-client.js";

export function registerInlineRequests(chrome, timers = globalThis) {
  // Keep independent scans so code and link requests cannot consume each other’s results.
  const scans = Object.fromEntries(["codes", "confirmationLinks", "passwordResetLinks"].map(kind => [kind, { client: createCompanionClient(chrome.runtime) }]));
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "mail-verify-inline") return;
    const reply = (message) => {
      try { port.postMessage(message); } catch { /* The page may have closed during the scan. */ }
    };
    port.onMessage.addListener(async (message) => {
      const kind = message?.kind;
      if (!Object.hasOwn(scans, kind)) {
        reply({ ok: false, error: "Unknown mail check." });
        return;
      }
      const scan = scans[kind];
      const sender = port.sender || {};
      try {
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
        reply({ ok: true, [kind]: response[kind], warnings: response.warnings || [] });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });
  });
}

if (globalThis.chrome?.runtime?.onConnect) registerInlineRequests(chrome);
