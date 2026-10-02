const HOST_NAME = "local.yahoo_code_fill";
const COMPANION_UNAVAILABLE =
  "Mac companion unavailable. Run Install Companion.command, then try again.";

function requireSuccessfulResponse(response) {
  if (!response?.ok)
    throw new Error(response?.error || "Unexpected companion response.");
  return response;
}

function createSession(runtime, timers) {
  let nativePort, pendingRequest;
  function takePending() {
    const pending = pendingRequest;
    pendingRequest = undefined;
    if (pending) timers.clearTimeout(pending.timer);
    return pending;
  }
  function closeSession(error = new Error("Check interrupted.")) {
    const port = nativePort;
    nativePort = undefined;
    if (port) port.disconnect();
    takePending()?.reject(error);
  }
  function sendRequest(request) {
    const { action } = request;
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
        const pending = takePending();
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
          takePending().reject(new Error(message));
        }
      });
    }
    return new Promise((resolve, reject) => {
      pendingRequest = { action, resolve, reject,
        timer: timers.setTimeout(() => closeSession(new Error(
          "Mac companion took too long to respond. Check Keychain access and try again.",
        )), action === "saveAccount" ? 60_000 : 35_000),
      };
      try {
        nativePort.postMessage(request);
      } catch {
        closeSession();
      }
    });
  }
  return { sendRequest, closeSession };
}

export function createCompanionClient(runtime, timers = globalThis) {
  const session = createSession(runtime, timers);
  return {
    sendSessionRequest: (action, collectOnly = false) => session.sendRequest({ action, collectOnly }),
    closeSession: session.closeSession,
    async sendOneOffRequest(request) {
      const oneOff = createSession(runtime, timers);
      try { return await oneOff.sendRequest(request); }
      finally { oneOff.closeSession(); }
    },
  };
}
