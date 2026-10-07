import { findActiveModal } from "../shared/active-modal.js";

// Modal dialogs make the rest of the document inert, regardless of z-index.
export function suggestionMountRoot(document) {
  return findActiveModal(document) || document.documentElement;
}

export function mountSuggestion(document, host) {
  const root = suggestionMountRoot(document);
  // A popover inside the modal stays interactive, but escapes transformed or
  // clipping dialog ancestors so fixed positioning still uses the viewport.
  if (host.hasAttribute("popover")) {
    host.hidePopover();
    host.removeAttribute("popover");
  }
  root.append(host);
  if (root !== document.documentElement) {
    const { left, right, top, bottom } = host.style;
    Object.assign(host.style, {
      inset: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      left,
      right,
      top,
      bottom,
    });
    host.setAttribute("popover", "manual");
    host.showPopover();
  }
}
