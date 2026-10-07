// Let pending promise callbacks complete without running the timer queue.
export const waitForAsyncCallbacks = () =>
  new Promise((resolve) => setImmediate(resolve));
