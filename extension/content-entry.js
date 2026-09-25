if (window === window.top) {
  import(chrome.runtime.getURL("inline.js")).then(({ startInlinePicker }) => {
    startInlinePicker();
  }).catch(() => {});
}
