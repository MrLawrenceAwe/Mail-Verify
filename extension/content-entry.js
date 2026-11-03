if (window === window.top) {
  import(chrome.runtime.getURL("inline/start-suggestions.js")).catch(() => {});
}
