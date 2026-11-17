/**
 * Files handed over by the Puter desktop: the ones the app was launched with
 * (a double-click, "Open with") and those dragged onto its window from the
 * desktop or a folder window. They are read from the drive and passed on as
 * Files; main.js decides where they go (a new project, the open one, or a
 * project file opened as a project).
 * https://docs.puter.com/UI/onLaunchedWithItems/
 */
import { toast } from './dialog.js';
import { guessKind } from '../media/media-types.js';

/** Project files exported from Home (see storage/bundle.js). */
export const isBundleName = (name) => /\.zip$/i.test(name || '');

const isDir = (it) => Boolean(it.is_dir || it.isDir || it.isDirectory || it.fsentry_is_dir);
const baseName = (path) => String(path || '').replace(/\/+$/, '').split('/').pop() || '';
const listOf = (names) => (names.length === 1 ? names[0] : `${names.length} files`);

/**
 * Read drive entries into Files. Folders and files that are neither media nor
 * a project file are left out, and unreadable ones are skipped; each is said
 * in a message. Resolves to the Files read (possibly none).
 */
export async function readDriveItems(puter, given) {
  const all = (Array.isArray(given) ? given : [given]).filter((it) => it && typeof it === 'object');
  const entries = all.filter((it) => !isDir(it) && ((typeof it.path === 'string' && it.path) || typeof it.read === 'function'));
  if (!entries.length) {
    if (all.some(isDir)) toast('Folders cannot be opened. Open the files inside instead.', { kind: 'info' });
    return [];
  }
  const named = entries.map((it) => ({ it, name: it.name || baseName(it.path) || 'file' }));
  const usable = named.filter(({ it, name }) => isBundleName(name) || guessKind({ name, type: typeof it.type === 'string' ? it.type : '' }));
  const unsupported = named.filter((n) => !usable.includes(n)).map((n) => n.name);
  if (unsupported.length) {
    const many = unsupported.length > 1;
    toast(`${listOf(unsupported)} ${many ? "aren't" : "isn't"} video, audio, a picture or a Video Studio project file, so ${many ? 'they were' : 'it was'} not opened.`, { kind: 'error' });
  }
  const files = [];
  const failed = [];
  for (const { it, name } of usable) {
    try {
      const blob = typeof it.read === 'function' ? await it.read() : await puter.fs.read(it.path);
      // The drive often hands over no media type: the name's extension tells the kind then.
      const type = /^(video|audio|image)\//.test(blob?.type || '') ? blob.type : typeof it.type === 'string' && /^(video|audio|image)\//.test(it.type) ? it.type : '';
      files.push(new File([blob], name, { type }));
    } catch (err) {
      console.error(err);
      failed.push(name);
    }
  }
  if (failed.length) toast(`Couldn't read ${listOf(failed)} from Puter.`, { kind: 'error' });
  return files;
}

/**
 * Register with the Puter desktop; call once, when the library is ready.
 * onFiles(files, { dropped }) gets each hand-over in turn: launch items with
 * dropped false, files dragged onto the window with dropped true.
 */
export function installLaunchOpen(puter, onFiles) {
  if (!puter) return;
  // One hand-over at a time, in the order they came.
  let chain = Promise.resolve();
  const take = (items, dropped) => {
    chain = chain
      .then(async () => {
        const files = await readDriveItems(puter, items);
        if (files.length) await onFiles(files, { dropped });
      })
      .catch((err) => {
        console.error(err);
        toast(err?.message || "Couldn't open the files from Puter.", { kind: 'error' });
      });
    return chain;
  };
  try {
    // The SDK answers at once when the app was started with files (in a desktop window or a browser tab).
    puter.ui?.onLaunchedWithItems?.((items) => take(items, false));
  } catch {
    /* An SDK without launch items. */
  }
  // Files dragged in from the Puter desktop do not arrive as a browser drop:
  // the SDK dispatches a drop of its own with the drive's entries in its detail.
  window.addEventListener('drop', (e) => {
    const items = e.detail?.items;
    if (e.dataTransfer || !Array.isArray(items)) return;
    e.preventDefault();
    take(items, true);
  });
}
