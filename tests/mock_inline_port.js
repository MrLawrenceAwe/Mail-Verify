export function inlineRuntime(check) {
  return {
    connect({ name }) {
      let onMessage, onDisconnect, disconnected = false;
      return {
        onMessage: { addListener(fn) { onMessage = fn; } },
        onDisconnect: { addListener(fn) { onDisconnect = fn; } },
        postMessage({ mailType }) {
          if (name !== "mail-verify-inline") throw new Error("Unexpected port name.");
          Promise.resolve(check(mailType))
            .then((response) => { if (!disconnected) onMessage(response); },
              () => { if (!disconnected) onDisconnect(); });
        },
        disconnect() { disconnected = true; },
      };
    },
  };
}
