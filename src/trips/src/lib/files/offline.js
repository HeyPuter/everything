// Downloads for offline copies (`setFileDownloader`). They read like any other file: straight from the owner's
// shared folder in direct file mode, otherwise through the trip worker.
import { fileBlob } from './index.js';
import { loadFeatures } from '../sync/features.js';
import { filesEntry } from '../store/personal.js';

const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;

/**
 * `(ref, file, {signal}) → Blob` for `setFileDownloader`. Uses the session's open trip when the ref matches; other
 * kept trips get a stand-in space whose `fileAccess` answers from the direct-files flag, this account's own worker and
 * the `files` block `open` stored in `me:spaces`.
 */
export function offlineDownloader({ session, puter, features = loadFeatures }) {
  let flags = null;
  async function access(ref) {
    flags ??= Promise.resolve().then(() => features()).catch(() => ({}));
    if (!(await flags)?.directFiles) return { mode: 'proxied' };
    const own = await Promise.resolve(session.ownWorker?.()).catch(() => null);
    if (own && own === ref.w) return { mode: 'direct', owner: true, account: session.account.uuid };
    const entries = await Promise.resolve(session.personal?.spaces?.list()).catch(() => null);
    return filesEntry(entries?.find((entry) => sameRef(entry.ref, ref))?.files) ?? { mode: 'proxied' };
  }
  return (ref, file, { signal } = {}) => {
    const open = session.trip?.space;
    const target = open && sameRef(open.ref, ref) ? open
      : { ref, get: (type, id) => (type === 'file' && id === file.id ? file : null), fileAccess: () => access(ref) };
    return fileBlob(target, file.id, { download: true, signal, api: session.api, puter });
  };
}
