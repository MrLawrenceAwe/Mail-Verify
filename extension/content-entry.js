if (window === window.top) {
  Promise.all([
    import(chrome.runtime.getURL("page-coordinator.js")),
    import(chrome.runtime.getURL("inline-picker.js")),
    import(chrome.runtime.getURL("email-link-card.js")),
  ]).then(([{ getPageCoordinator }, { startInlinePicker }, { startEmailLinkCard }]) => {
    const page = getPageCoordinator(globalThis);
    startInlinePicker({ page });
    startEmailLinkCard({ page });
  }).catch(() => {});
}
