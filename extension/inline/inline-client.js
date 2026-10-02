export function requestInlineCheck(runtime, mailType, collectOnly = false) {
  return new Promise((resolve, reject) => {
    const port = runtime.connect({ name: "mail-verify-inline" });
    let settled = false;
    port.onMessage.addListener((response) => {
      if (settled) return;
      settled = true;
      resolve(response);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(new Error("Mail Verify disconnected. Reload the extension and try again."));
    });
    try {
      port.postMessage({ mailType, collectOnly });
    } catch (error) {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(error);
    }
  });
}
