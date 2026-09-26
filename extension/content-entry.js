if (window === window.top) {
  import(chrome.runtime.getURL("inline-picker.js")).then(({ startInlinePicker }) => {
    startInlinePicker();
  }).catch(() => {});
}
