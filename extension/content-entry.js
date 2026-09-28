if (window === window.top) {
  import(chrome.runtime.getURL("confirmation-card.js")).then(({ startConfirmationCard }) => {
    startConfirmationCard();
  }).catch(() => {});
  import(chrome.runtime.getURL("inline-picker.js")).then(({ startInlinePicker }) => {
    startInlinePicker();
  }).catch(() => {});
}
