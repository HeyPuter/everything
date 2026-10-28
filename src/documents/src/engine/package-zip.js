import { zipPackage } from './package-part-paths.js';

// Saving a long document deflated its parts on the page's thread: an autosave a moment after typing stopped
// held the page for a few hundred milliseconds, so the next keys typed waited. The parts are now zipped in a
// worker, with the same zipPackage. Without workers (or when one fails), they are zipped here as before.
const WORKER_START_MS = 10000;
let worker = null, unavailable = false, nextId = 0;
const pending = new Map();

function fail() {
  unavailable = true;
  worker?.terminate();
  worker = null;
  for (const job of pending.values()) job.fallback();
  pending.clear();
}
function startWorker() {
  if (worker || unavailable) return worker;
  if (typeof Worker !== 'function') { unavailable = true; return null; }
  try { worker = new Worker(new URL('./package-zip-worker.js', import.meta.url), { type: 'module' }); }
  catch { unavailable = true; return null; }
  const started = setTimeout(fail, WORKER_START_MS);
  worker.onmessage = ({ data }) => {
    if (data?.ready) { clearTimeout(started); return; }
    const job = pending.get(data?.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.zipped);
  };
  // Blocked by policy, or no module workers: zip on the page instead.
  worker.onerror = event => { event.preventDefault?.(); clearTimeout(started); fail(); };
  return worker;
}

/** The package's parts as ZIP bytes (zipPackage), made off the page's thread where workers are available. */
export function zipPackageAsync(parts) {
  const zipper = startWorker();
  if (!zipper) return Promise.resolve().then(() => zipPackage(parts));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, fallback: () => { try { resolve(zipPackage(parts)); } catch (error) { reject(error); } } });
    try { zipper.postMessage({ id, parts }); }
    catch { pending.delete(id); try { resolve(zipPackage(parts)); } catch (error) { reject(error); } }
  });
}
