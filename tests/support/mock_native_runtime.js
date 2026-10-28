// Each native connection owns its listeners and recorded requests.
export function createMockNativeRuntime(onRequest = () => {}) {
  const ports = [];
  const requests = [];
  return {
    ports,
    requests,
    connectNative(hostName) {
      const messageListeners = new Set();
      const disconnectListeners = new Set();
      const port = {
        hostName,
        messages: [],
        closed: false,
        onMessage: { addListener: (listener) => messageListeners.add(listener) },
        onDisconnect: { addListener: (listener) => disconnectListeners.add(listener) },
        postMessage(request) {
          if (port.closed) throw new Error("Native port is disconnected.");
          port.messages.push(request);
          requests.push(request);
          onRequest(request, port);
        },
        reply(response) {
          if (!port.closed)
            for (const listener of messageListeners) listener(response);
        },
        // Explicitly simulate a callback already queued when a port closed.
        deliverLateReply(response) {
          for (const listener of messageListeners) listener(response);
        },
        disconnect() {
          if (port.closed) return;
          port.closed = true;
          for (const listener of disconnectListeners) listener();
        },
      };
      ports.push(port);
      return port;
    },
  };
}
