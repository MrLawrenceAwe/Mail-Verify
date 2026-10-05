// DOM order does not describe the native dialog stack. Focus belongs to the
// active modal; its backdrop also wins viewport hit testing when focus is lost.
export function findActiveModal(document) {
  return document.activeElement?.closest?.('dialog:modal') ||
    document.elementFromPoint?.(0, 0)?.closest?.('dialog:modal') ||
    document.querySelector?.('dialog:modal');
}
