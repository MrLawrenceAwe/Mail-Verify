if (window === window.top) {
  Promise.all([
    import(chrome.runtime.getURL("page-coordinator.js")),
    import(chrome.runtime.getURL("inline-picker.js")),
    import(chrome.runtime.getURL("confirmation-card.js")),
  ]).then(([{ getPageCoordinator }, { startInlinePicker }, { startConfirmationCard }]) => {
    const page = getPageCoordinator(globalThis);
    startInlinePicker({ page });
    startConfirmationCard({ page });
  }).catch(() => {});
}
