import { createOfflineManager } from './manager.js';

export { startPwa, setForcedOffline, isForcedOffline, appOnline, onForcedOffline } from './pwa.js';
export { readCachedFile, storeFile, cacheable } from './files.js';
export { openConflict, conflictListFor, describeConflict, typeLabel, fieldLabel } from './conflicts.js';

const managers = new WeakMap();
let downloader = null;

/** The files module registers how to fetch a trip file as a Blob: `(ref, file, {signal}) => Promise<Blob>`. */
export function setFileDownloader(fn) { downloader = typeof fn === 'function' ? fn : null; }

/** The session's offline manager, created once per session; `start()` runs background downloads until `stop()`. */
export function offlineFor(session, { puter = globalThis.puter, ...options } = {}) {
  if (!session?.db || !session?.personal) throw new TypeError('A session with db and personal is required');
  let manager = managers.get(session);
  if (!manager) {
    manager = createOfflineManager({
      db: session.db, personal: session.personal, api: session.api ?? null, deployer: session.deployer ?? null, services: session.services ?? null,
      account: session.account?.uuid ?? session.db.account, puter,
      resolveDownload: () => downloader, ...options,
    });
    managers.set(session, manager);
  }
  return manager;
}

/** Starts background downloads for a session; returns the stop function. */
export function startOffline(session, options) { return offlineFor(session, options).start(); }
