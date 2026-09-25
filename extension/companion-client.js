const HOST_NAME = "local.yahoo_code_fill";
const COMPANION_UNAVAILABLE =
  "Mac companion unavailable. Run the companion installer, then reopen this popup.";

export function createCompanionClient(runtime) {
  let mailPort, pendingRequest;
  async function sendCompanionRequest(request) {
    let response;
    try {
      response = await runtime.sendNativeMessage(HOST_NAME, request);
    } catch {
      throw new Error(COMPANION_UNAVAILABLE);
    }
    if (!response?.ok)
      throw new Error(response?.error || "Unexpected companion response.");
    return response;
  }
  function closeSession() {
    const port = mailPort;
    mailPort = undefined;
    if (port) port.disconnect();
    if (pendingRequest) {
      pendingRequest.reject(new Error("Check interrupted."));
      pendingRequest = undefined;
    }
  }
  function sendSessionRequest(action) {
    if (!mailPort) {
      try {
        mailPort = runtime.connectNative(HOST_NAME);
      } catch {
        throw new Error(COMPANION_UNAVAILABLE);
      }
      const port = mailPort;
      port.onMessage.addListener((response) => {
        if (mailPort !== port) return;
        const pending = pendingRequest;
        pendingRequest = undefined;
        if (!pending) return;
        if (response?.ok) pending.resolve(response);
        else
          pending.reject(
            new Error(response?.error || "Unexpected companion response."),
          );
      });
      port.onDisconnect.addListener(() => {
        if (mailPort !== port) return;
        mailPort = undefined;
        if (pendingRequest) {
          const message =
            pendingRequest.action === "status"
              ? COMPANION_UNAVAILABLE
              : "Mac companion disconnected. Try checking again.";
          pendingRequest.reject(new Error(message));
          pendingRequest = undefined;
        }
      });
    }
    return new Promise((resolve, reject) => {
      pendingRequest = { action, resolve, reject };
      try {
        mailPort.postMessage({ action });
      } catch {
        closeSession();
      }
    });
  }
  return { sendCompanionRequest, sendSessionRequest, closeSession };
}
