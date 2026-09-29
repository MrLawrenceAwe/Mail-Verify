export function inlineRuntime(check) {
  return {
    connect({ name }) {
      let onMessage, onDisconnect, disconnected = false;
      return {
        onMessage: { addListener(fn) { onMessage = fn; } },
        onDisconnect: { addListener(fn) { onDisconnect = fn; } },
        postMessage({ kind }) {
          if (name !== "mail-verify-inline") throw new Error("Unexpected port name.");
          Promise.resolve(check(kind))
            .then((response) => { if (!disconnected) onMessage(response); },
              () => { if (!disconnected) onDisconnect(); });
        },
        disconnect() { disconnected = true; },
      };
    },
  };
}
