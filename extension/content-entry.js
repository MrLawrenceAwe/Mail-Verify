if (window === window.top) {
  Promise.all([
    import(chrome.runtime.getURL("inline/page-coordinator.js")),
    import(chrome.runtime.getURL("inline/code-picker-controller.js")),
    import(chrome.runtime.getURL("inline/email-link-card-controller.js")),
  ])
    .then(
      ([
        { getPageCoordinator },
        { startCodePicker },
        { startEmailLinkCard },
      ]) => {
        const page = getPageCoordinator(globalThis);
        startCodePicker({ page });
        startEmailLinkCard({ page });
      },
    )
    .catch(() => {});
}
