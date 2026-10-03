import { createCompanionClient } from "./shared/companion-client.js";

export function registerInlineRequests(chrome, timers = globalThis) {
  // Keep a native session per mail type so requests cannot consume another type’s results.
  const sessionsByMailType = Object.fromEntries(["codes", "confirmationLinks", "passwordResetLinks"].map(mailType => [mailType, { client: createCompanionClient(chrome.runtime) }]));
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "mail-verify-inline") return;
    const reply = (message) => {
      try { port.postMessage(message); } catch { /* The page may have closed during the scan. */ }
    };
    port.onMessage.addListener(async (message) => {
      const mailType = message?.mailType;
      if (!Object.hasOwn(sessionsByMailType, mailType)) {
        reply({ ok: false, error: "Unknown mail check." });
        return;
      }
      const session = sessionsByMailType[mailType];
      const sender = port.sender || {};
      try {
        if (sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
            !sender.url?.startsWith("https://") || !sender.tab?.id)
          throw new Error("Mail checks are available on HTTPS pages only.");
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (active?.id !== sender.tab.id) throw new Error("Return to this tab to check your inboxes.");
        if (!session.inFlightRequest) {
          timers.clearTimeout(session.idleTimer);
          session.inFlightRequest = session.client.sendSessionRequest(mailType, message.collectOnly === true).finally(() => {
            session.inFlightRequest = undefined;
            session.idleTimer = timers.setTimeout(() => session.client.closeSession(), 15_000);
          });
        }
        const response = await session.inFlightRequest;
        reply({ ok: true, [mailType]: response[mailType], warnings: response.warnings || [], scanPending: response.scanPending });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });
  });
}

if (globalThis.chrome?.runtime?.onConnect) registerInlineRequests(chrome);
