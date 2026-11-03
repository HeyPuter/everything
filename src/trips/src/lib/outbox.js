import { invariant } from '../shared/errors.js';

export function createOutbox({ store, wait = 400, setTimer = setTimeout, clearTimer = clearTimeout, onError = () => {} }) {
  let timer;
  let stopped = false;
  const report = (error) => { if (!stopped) onError(error); };
  const flush = async () => {
    clearTimer(timer);
    if (stopped) return;
    const result = await store.flush();
    if (!stopped && result.error) report(result.error);
    return result;
  };
  return {
    async apply(ops) {
      invariant(!stopped, 'outbox_stopped');
      await store.apply(ops);
      clearTimer(timer);
      if (!stopped) timer = setTimer(() => { void flush().catch(report); }, wait);
    },
    flush,
    stop() { stopped = true; clearTimer(timer); },
  };
}
