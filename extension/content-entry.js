if (window === window.top) {
  Promise.all([
    import(chrome.runtime.getURL("page-coordinator.js")),
    import(chrome.runtime.getURL("code-picker.js")),
    import(chrome.runtime.getURL("email-link-card.js")),
  ]).then(([{ getPageCoordinator }, { startCodePicker }, { startEmailLinkCard }]) => {
    const page = getPageCoordinator(globalThis);
    startCodePicker({ page });
    startEmailLinkCard({ page });
  }).catch(() => {});
}
