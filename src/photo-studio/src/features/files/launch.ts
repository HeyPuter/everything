// Files handed over by the Puter desktop: the ones the app was launched with
// (a double-click, "Open with") and those dragged onto its window from the
// desktop or a folder window. They open where they live, as File → Open from
// Puter does, so a .photo project saves back to its own file.
// https://docs.puter.com/UI/onLaunchedWithItems/
import type { Editor } from '../../editor';
import type { CloudItem } from './cloud';

type DriveItem = Partial<CloudItem> & { is_dir?: boolean; isDirectory?: boolean; fsentry_is_dir?: boolean };
type LaunchUI = { onLaunchedWithItems?: (handler: (items: DriveItem | DriveItem[]) => void) => void };

const isDir = (it: DriveItem) => !!(it.is_dir || it.isDirectory || it.isDir || it.fsentry_is_dir);
const baseName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** Open drive entries once the editor is free; folders are left out. */
export function openDriveItems(e: Editor, given: DriveItem | DriveItem[]) {
  const all = (Array.isArray(given) ? given : [given]).filter((it): it is DriveItem => !!it && typeof it === 'object');
  const items = all.filter((it) => typeof it.path === 'string' && it.path && !isDir(it)).map((it) => ({ ...it, path: it.path!, name: it.name || baseName(it.path!), read: it.read?.bind(it) }) as CloudItem);
  if (!items.length) {
    if (all.some(isDir)) e.message('Folders cannot be opened. Open the files inside instead.');
    return;
  }
  const open = () =>
    e.run(async () => {
      const { openCloudItems } = await import('./save');
      await openCloudItems(e, items);
    });
  if (!e.busy) return void open();
  const names = items.length === 1 ? items[0].name : `${items.length} files`;
  e.message(`${names} ${items.length === 1 ? 'opens' : 'open'} when the current task finishes.`);
  void (async () => {
    while (e.busy) await e.idle;
    await open();
  })();
}

/** Register with the Puter desktop; call once the workspace is ready. */
export function installLaunchOpen(e: Editor) {
  try {
    // The SDK answers at once from the launch address when the app was started with files.
    const ui = (window.puter as unknown as { ui?: LaunchUI } | undefined)?.ui;
    ui?.onLaunchedWithItems?.((items) => openDriveItems(e, items));
  } catch {
    /* Not inside the Puter desktop, or an SDK without launch items. */
  }
  // Files dragged in from the Puter desktop do not arrive as a browser drop:
  // the SDK dispatches a drop of its own with the drive's entries in its detail.
  window.addEventListener('drop', (ev) => {
    const items = (ev as unknown as CustomEvent<{ items?: DriveItem[] } | undefined>).detail?.items;
    if ((ev as DragEvent).dataTransfer || !Array.isArray(items)) return;
    ev.preventDefault();
    openDriveItems(e, items);
  });
}
