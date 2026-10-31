import { startUpload } from '../../../lib/files/index.js';

const PARALLEL = 2;
const queues = new Map();

/**
 * Upload queue per trip, outside the view so uploads keep going while another tab is open. Entries are
 * `{task, queued, running}`; listeners get `(entry, event)` with event `change|done|removed`.
 */
export function uploadQueue(space) {
  const key = `${space.ref.w}/${space.ref.s}`;
  if (queues.has(key) && queues.get(key).space === space) return queues.get(key);
  const entries = [];
  const listeners = new Set();
  const emit = (entry, event) => { for (const listener of [...listeners]) listener(entry, event); };

  function remove(entry) {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    emit(entry, 'removed');
  }

  function pump() {
    let running = entries.filter((entry) => entry.running).length;
    for (const entry of entries) {
      if (running >= PARALLEL) break;
      if (!entry.queued || entry.running) continue;
      entry.queued = false; entry.running = true; running += 1;
      entry.task.run().then((result) => {
        entry.result = result;
        emit(entry, 'done');
        setTimeout(() => remove(entry), 1500);
      }, () => {}).finally(() => { entry.running = false; emit(entry, 'change'); pump(); });
    }
  }

  const queue = {
    space,
    get entries() { return [...entries]; },
    add(files) {
      for (const file of files) {
        const entry = { queued: true, running: false, result: null };
        entry.task = startUpload(space, file, { onChange: () => emit(entry, 'change') });
        entries.push(entry);
        emit(entry, 'change');
      }
      pump();
    },
    retry(entry) { if (!entry.running) { entry.queued = true; emit(entry, 'change'); pump(); } },
    cancel(entry) { entry.queued = false; entry.task.cancel(); emit(entry, 'change'); },
    remove,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  queues.set(key, queue);
  return queue;
}
