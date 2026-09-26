const HOST_NAME = "local.yahoo_code_fill";
const COMPANION_UNAVAILABLE =
  "Mac companion unavailable. Run the companion installer, then reopen this popup.";

function requireSuccessfulResponse(response) {
  if (!response?.ok)
    throw new Error(response?.error || "Unexpected companion response.");
  return response;
}

export function createCompanionClient(runtime) {
  let nativePort, pendingRequest;
  async function sendOneOffRequest(request) {
    let response;
    try {
      response = await runtime.sendNativeMessage(HOST_NAME, request);
    } catch {
      throw new Error(COMPANION_UNAVAILABLE);
    }
    return requireSuccessfulResponse(response);
  }
  function closeSession() {
    const port = nativePort;
    nativePort = undefined;
    if (port) port.disconnect();
    if (pendingRequest) {
      pendingRequest.reject(new Error("Check interrupted."));
      pendingRequest = undefined;
    }
  }
  function sendSessionRequest(action) {
    if (pendingRequest)
      throw new Error("A companion request is already in progress.");
    if (!nativePort) {
      try {
        nativePort = runtime.connectNative(HOST_NAME);
      } catch {
        throw new Error(COMPANION_UNAVAILABLE);
      }
      const port = nativePort;
      port.onMessage.addListener((response) => {
        if (nativePort !== port) return;
        const pending = pendingRequest;
        pendingRequest = undefined;
        if (!pending) return;
        try {
          pending.resolve(requireSuccessfulResponse(response));
        } catch (error) {
          pending.reject(error);
        }
      });
      port.onDisconnect.addListener(() => {
        if (nativePort !== port) return;
        nativePort = undefined;
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
        nativePort.postMessage({ action });
      } catch {
        closeSession();
      }
    });
  }
  return { sendOneOffRequest, sendSessionRequest, closeSession };
}
