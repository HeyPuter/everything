/** Stop waiting for shared work without canceling it for its other consumers. */
export async function abortable(task, signal) {
  const canceled = () => new DOMException('Operation canceled', 'AbortError');
  if (signal?.aborted) throw canceled();
  if (!signal) return task();
  return new Promise((resolve, reject) => {
    const settle = (finish, value) => {
      signal.removeEventListener('abort', cancel);
      finish(value);
    };
    const cancel = () => settle(reject, canceled());
    signal.addEventListener('abort', cancel, { once: true });
    try {
      // Keep both handlers attached after cancellation: a late failure is still
      // handled, and a late file must never resume the canceled caller.
      Promise.resolve(task()).then((value) => settle(resolve, value), (err) => settle(reject, err));
    } catch (err) {
      settle(reject, err);
    }
  });
}
