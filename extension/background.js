import { createCompanionClient } from "./shared/companion-client.js";

export function registerInlineRequests(chrome, timers = globalThis) {
  // Keep a native session per mail type so requests cannot consume another type’s results.
  const sessionsByMailType = Object.fromEntries(
    ["codes", "confirmationLinks", "passwordResetLinks"].map((mailType) => [
      mailType,
      { client: createCompanionClient(chrome.runtime, timers) },
    ]),
  );
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "mail-verify-inline") return;
    const reply = (message) => {
      try {
        port.postMessage(message);
      } catch {
        /* The page may have closed during the scan. */
      }
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
        if (
          sender.id !== chrome.runtime.id ||
          sender.frameId !== 0 ||
          !sender.url?.startsWith("https://") ||
          !sender.tab?.id
        )
          throw new Error("Mail checks are available on HTTPS pages only.");
        const [active] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (active?.id !== sender.tab.id)
          throw new Error("Return to this tab to check your inboxes.");
        const collectOnly = message.collectOnly === true;
        const previous = session.inFlight;
        if (!previous || (previous.collectOnly && !collectOnly)) {
          timers.clearTimeout(session.idleTimer);
          const send = () => session.client.sendSessionRequest(mailType, collectOnly);
          // A full check must still run after an in-flight collection settles.
          const request = previous ? previous.response.then(send, send) : send();
          const next = {
            collectOnly,
            response: request.finally(() => {
              if (session.inFlight !== next) return;
              session.inFlight = undefined;
              session.idleTimer = timers.setTimeout(
                () => session.client.closeSession(),
                15_000,
              );
            }),
          };
          session.inFlight = next;
        }
        const response = await session.inFlight.response;
        reply({
          ok: true,
          [mailType]: response[mailType],
          warnings: response.warnings || [],
          scanPending: response.scanPending,
        });
      } catch (error) {
        reply({ ok: false, error: error.message });
      }
    });
  });
}

if (globalThis.chrome?.runtime?.onConnect) registerInlineRequests(chrome);
