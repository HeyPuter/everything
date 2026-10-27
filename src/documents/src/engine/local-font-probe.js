// Loading an installed face by its local() name, with a deadline. Chrome on macOS can block the
// calling thread inside FontFace.load() for the local() name of an on-demand system font that is not
// downloaded (seen with NanumGothic, NanumMyeongjo and Osaka in headless Chrome): no timer or other
// script runs again, so a document using such a font froze while it opened. While that lookup is
// stuck, lookups of other missing names (Malgun Gothic, any unknown name) block too; installed
// faces still answer at once. Each name is therefore first loaded in a worker. A worker that does
// not answer by the deadline is abandoned and the name counts as not installed under that name; the
// page's thread never asks for it. After one such stall the deadline is short, since installed
// faces answer in a millisecond or two. Only a name a worker found is loaded on the page, which is
// then immediate. Without workers the load is direct, bounded by the deadline in case it never settles.
export const LOCAL_FONT_DEADLINE_MS = 2000;
const STALLED_DEADLINE_MS = 250, START_DEADLINE_MS = 10000, POOL_SIZE = 4, IDLE_MS = 30000;

const answers = new Map(), queue = [], idle = [];
let workers = 0, nextId = 0, workersUnavailable = false, stalled = false;

function startWorker() {
  let worker;
  try { worker = new Worker(new URL('./local-font-probe-worker.js', import.meta.url), { type: 'module' }); }
  catch { workersUnavailable = true; return null; }
  // A worker counts as started when it says so: the probe deadline excludes loading its script.
  worker.started = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), START_DEADLINE_MS);
    worker.onmessage = ({ data }) => { if (data?.ready) { clearTimeout(timer); resolve(true); } };
    // Blocked by policy, or no module workers: the direct path is used instead.
    worker.onerror = event => { event.preventDefault?.(); clearTimeout(timer); resolve(false); };
  });
  return worker;
}
function pump() {
  if (workersUnavailable) { for (const job of queue.splice(0)) job.resolve(null); return; }
  while (queue.length && (idle.length || workers < POOL_SIZE)) {
    let worker = idle.pop();
    if (worker) clearTimeout(worker.idleTimer);
    else { worker = startWorker(); if (!worker) { pump(); return; } workers++; }
    serve(worker, queue.shift());
  }
}
// One probe at a time per worker, so a deadline is attributed to the name that caused it.
async function serve(worker, { source, resolve }) {
  const retire = () => { worker.terminate(); workers--; };
  if (!await worker.started) { workersUnavailable = true; retire(); resolve(null); pump(); return; }
  const id = nextId++;
  const finish = (found, keep) => {
    clearTimeout(timer); worker.onmessage = worker.onerror = null;
    if (keep) {
      // Fonts are probed while documents open; between documents the threads are released.
      idle.push(worker);
      worker.idleTimer = setTimeout(() => { idle.splice(idle.indexOf(worker), 1); retire(); }, IDLE_MS);
    } else retire();
    resolve(found); pump();
  };
  const timer = setTimeout(() => { stalled = true; finish(false, false); }, stalled ? STALLED_DEADLINE_MS : LOCAL_FONT_DEADLINE_MS);
  worker.onmessage = ({ data }) => {
    if (data?.id !== id) return;
    if (data.found === null) workersUnavailable = true;
    finish(data.found, data.found !== null);
  };
  worker.onerror = event => { event.preventDefault?.(); workersUnavailable = true; finish(null, false); };
  worker.postMessage({ id, source });
}
/** Whether a local() source loads, asked in a worker: true, false, or null when no worker can ask. */
function probe(source) {
  if (workersUnavailable || typeof Worker === 'undefined') return Promise.resolve(null);
  if (!answers.has(source)) {
    const answer = new Promise(resolve => { queue.push({ source, resolve }); pump(); });
    answers.set(source, answer);
    // An unanswerable probe is asked again later, by the direct path.
    answer.then(found => { if (found === null) answers.delete(source); });
  }
  return answers.get(source);
}
const deadline = (promise, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), LOCAL_FONT_DEADLINE_MS); })]).finally(() => clearTimeout(timer));
};

/** `new FontFace(family, source, descriptors).load()` for a local() source, bounded as above. */
export async function loadLocalFace(family, source, descriptors) {
  const found = await probe(source);
  if (found === false) throw new Error('The font is not installed.');
  return deadline(new FontFace(family, source, descriptors).load(), 'The installed font did not load in time.');
}
