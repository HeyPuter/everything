// Libraries: named collections of colors, gradients, patterns, text and
// layer styles, brushes and graphics, shared by every document and synced
// through Puter when signed in. Registration only; the panel, storage and
// capture code load on first use.
import type { Editor } from '../../editor';
import { registerCommand, registerPanel, type Command } from '../../app/registry';
import { lazy, lazyPanel } from '../../app/lazy';
import { formDialog } from '../../ui/dialog';
import { askChoice } from '../preferences/warnings';
import { linkReaders } from '../embedded/link-state';
import { ADD_SOURCES, canAdd } from './context';
import { hasLibraryLinks, ITEM_MIME, libState, loadViewState, saveViewState } from './state';
import { TYPE_SINGULAR } from './model';

const panel = lazy(() => import('./panel'));
const service = lazy(() => import('./service'));
const apply = lazy(() => import('./apply'));
const lib = () => service.loaded?.libraries();
const shownLibrary = () => lib()?.library(libState.libraryId);
const currentItem = () => lib()?.item(libState.itemId)?.item;

async function loaded() {
  const l = (await service()).libraries();
  await l.load();
  return l;
}
function refreshPanel(e: Editor) {
  panel.loaded?.bump();
  e.dock.update();
}
/** The library new items go to: the one shown, else the first, else a new one. */
async function targetLibrary(e: Editor) {
  const l = await loaded();
  const id = l.library(libState.libraryId)?.id ?? l.index.libraries[0]?.id;
  if (id) return id;
  const created = await l.createLibrary('My Library');
  libState.libraryId = created.id;
  saveViewState();
  refreshPanel(e);
  return created.id;
}
const showPanel = (e: Editor) => {
  if (!e.dock.isVisible('libraries')) e.dock.show('libraries');
};

export function installLibraries(e: Editor) {
  loadViewState();
  registerPanel(
    lazyPanel(
      {
        id: 'libraries',
        title: 'Libraries',
        icon: 'libraries',
        location: 'strip',
        hidden: true,
        menu: () => [{ label: 'Add to Library', id: 'libraries.add', items: ADD_SOURCES.map(([src]) => `libraries.add-${src}`) }, '-', 'libraries.new', 'libraries.rename', 'libraries.duplicate', 'libraries.delete', '-', 'libraries.import', 'libraries.export', '-', 'libraries.sync', '-', 'libraries.view-grid', 'libraries.view-list', 'libraries.group'],
      },
      panel,
    ),
  );
  const cmd = (c: Omit<Command, 'recordable'>) => registerCommand({ recordable: false, ...c });
  // Directly in the Window menu (not under Panels).
  cmd({ id: 'window.panel.libraries', label: 'Libraries', checked: (e) => e.dock.isVisible('libraries'), run: (e) => e.dock.show('libraries', true) });
  cmd({
    id: 'libraries.new',
    label: 'New Library…',
    description: 'Create a library for colors, styles, brushes and graphics you reuse',
    run: async (e) => {
      const l = await loaded();
      const v = await formDialog('New Library', [{ name: 'name', label: 'Name', value: `Library ${l.index.libraries.length + 1}` }], 'Create');
      if (!v?.name.trim()) return;
      const created = await l.createLibrary(v.name.trim());
      libState.libraryId = created.id;
      saveViewState();
      showPanel(e);
      refreshPanel(e);
    },
  });
  cmd({
    id: 'libraries.rename',
    label: 'Rename Library…',
    enabled: () => !!shownLibrary(),
    run: async (e) => {
      const l = shownLibrary();
      if (!l) return;
      const v = await formDialog('Rename Library', [{ name: 'name', label: 'Name', value: l.name }], 'Rename');
      if (v?.name.trim() && v.name.trim() !== l.name) await lib()!.renameLibrary(l.id, v.name);
      refreshPanel(e);
    },
  });
  cmd({
    id: 'libraries.duplicate',
    label: 'Duplicate Library',
    enabled: () => !!shownLibrary(),
    run: async (e) => {
      const copy = await lib()!.duplicateLibrary(libState.libraryId);
      if (copy) libState.libraryId = copy.id;
      saveViewState();
      refreshPanel(e);
    },
  });
  cmd({
    id: 'libraries.delete',
    label: 'Delete Library…',
    enabled: () => !!shownLibrary(),
    run: async (e) => {
      const l = shownLibrary();
      if (!l) return;
      const ok = await askChoice('Delete Library', `Delete “${l.name}” and its ${l.items.length} item${l.items.length === 1 ? '' : 's'}${lib()!.status.state === 'local' ? '' : ' everywhere it syncs'}? Placed graphics stay in their documents.`, [['delete', 'Delete']]);
      if (ok !== 'delete') return;
      await lib()!.deleteLibrary(l.id);
      libState.libraryId = '';
      saveViewState();
      refreshPanel(e);
    },
  });
  cmd({
    id: 'libraries.export',
    label: 'Export Library…',
    description: 'Save the library and its content as one file to share or back up',
    enabled: () => !!shownLibrary(),
    run: async (e) => {
      const l = shownLibrary();
      if (!l) return;
      const { exportLibraryFile, LIBRARY_FILE_EXTENSION } = await import('./model');
      const { download } = await import('../../persistence/puter');
      const text = await exportLibraryFile(l, (h) => lib()!.readAsset(h));
      download(new Blob([text], { type: 'application/json' }), `${l.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Library'}${LIBRARY_FILE_EXTENSION}`);
      e.message(`Exported ${l.name}.`);
    },
  });
  cmd({
    id: 'libraries.import',
    label: 'Import Library…',
    description: 'Add a library from a library file',
    run: async (e) => {
      const { LIBRARY_FILE_EXTENSION, importLibraryFile } = await import('./model');
      const file = await new Promise<File | null>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = `${LIBRARY_FILE_EXTENSION},application/json`;
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
      });
      if (!file) return;
      if (file.size > 256 * 1024 * 1024) throw new Error('The library file is larger than 256 MB.');
      const { sha256Hex } = await import('../../model/provenance');
      const got = await importLibraryFile(await file.text(), sha256Hex);
      const l = await loaded();
      for (const [h, blob] of got.assets) await l.addAsset(blob).then((x) => x === h || console.warn('asset hash mismatch'));
      const { uniqueName } = await import('./model');
      got.library.name = uniqueName(got.library.name, l.index.libraries.map((x) => x.name));
      await l.apply({ op: 'create-library', library: got.library });
      libState.libraryId = got.library.id;
      saveViewState();
      showPanel(e);
      refreshPanel(e);
      e.message(`Imported ${got.library.name} (${got.library.items.length} item${got.library.items.length === 1 ? '' : 's'})${got.skipped ? `; ${got.skipped} damaged item${got.skipped === 1 ? ' was' : 's were'} left out` : ''}.`);
    },
  });
  cmd({
    id: 'libraries.sync',
    label: 'Sync Libraries Now',
    description: 'Send library changes to Puter and take in changes made elsewhere',
    run: async (e) => {
      const l = await loaded();
      // Puter may take a while (or never answer); the editor stays usable.
      void l.sync().then(() => e.message(l.status.message));
    },
  });
  const view = (id: string, label: string, v: 'grid' | 'list') =>
    cmd({
      id,
      label,
      checked: () => libState.view === v,
      run: (e) => {
        libState.view = v;
        saveViewState();
        refreshPanel(e);
      },
    });
  view('libraries.view-grid', 'View as Grid', 'grid');
  view('libraries.view-list', 'View as List', 'list');
  cmd({
    id: 'libraries.group',
    label: 'Group by Type',
    checked: () => libState.grouped,
    run: (e) => {
      libState.grouped = !libState.grouped;
      saveViewState();
      refreshPanel(e);
    },
  });
  // "+" menu: add from the current context.
  for (const [src, label, type] of ADD_SOURCES)
    cmd({
      id: `libraries.add-${src}`,
      label: `Add ${label}`,
      description: `Add the ${label.toLowerCase()} to the library shown in the Libraries panel`,
      enabled: (e) => canAdd(e, src),
      run: async (e) => {
        const id = await targetLibrary(e);
        const item = await (await apply()).addFromContext(e, src, id);
        if (!item) return;
        libState.itemId = item.id;
        libState.itemType = type;
        showPanel(e);
        refreshPanel(e);
        e.message(`Added ${TYPE_SINGULAR[type].toLowerCase()} “${item.name}” to ${lib()?.library(id)?.name ?? 'the library'}.`);
      },
    });
  // Item commands act on the item last clicked in the panel.
  const itemCmd = (id: string, label: string, run: (e: Editor) => Promise<unknown>, when: (t: string) => boolean = () => true, description?: string) =>
    cmd({ id, label, description, enabled: () => !!currentItem() && when(currentItem()!.type), run: (e) => run(e).then(() => refreshPanel(e)) });
  itemCmd('libraries.item-apply', 'Apply', async (e) => (await apply()).applyItem(e, currentItem()!), (t) => t !== 'graphic', 'Use the item: set the color, apply the style, make the brush or pattern current');
  itemCmd('libraries.item-place', 'Place', async (e) => (await apply()).placeGraphic(e, currentItem()!), (t) => t === 'graphic', 'Place the graphic as an embedded object');
  itemCmd('libraries.item-place-linked', 'Place Linked', async (e) => (await apply()).placeGraphic(e, currentItem()!, { linked: true }), (t) => t === 'graphic', 'Place the graphic so it updates when the library item changes');
  itemCmd('libraries.item-redefine', 'Redefine from Current', async (e) => {
    const item = currentItem()!;
    const m = await apply();
    if (!(await m.redefineItem(e, item))) return;
    // Linked placements in this document follow as part of this command.
    const n = e.hasDocument ? await m.updateLibraryLinks(e) : 0;
    if (!n) e.message(`Updated ${item.name}.`);
  }, () => true, 'Replace the item with the current color, style, brush, selected layers or selection');
  itemCmd('libraries.item-rename', 'Rename…', async () => {
    const item = currentItem()!;
    const v = await formDialog(`Rename ${TYPE_SINGULAR[item.type]}`, [{ name: 'name', label: 'Name', value: item.name }], 'Rename');
    if (v?.name.trim() && v.name.trim() !== item.name) await lib()!.renameItem(item.id, v.name);
  });
  itemCmd('libraries.item-duplicate', 'Duplicate', async () => {
    const copy = await lib()!.duplicateItem(libState.itemId);
    if (copy) libState.itemId = copy.id;
  });
  itemCmd('libraries.item-delete', 'Delete…', async () => {
    const item = currentItem()!;
    const ok = await askChoice(`Delete ${TYPE_SINGULAR[item.type]}`, `Delete “${item.name}” from the library? Linked placements keep their current content.`, [['delete', 'Delete']]);
    if (ok === 'delete') await lib()!.deleteItem(item.id);
  });

  bindCanvasDrop(e);
  watchLinkedPlacements(e);
  linkReaders.library = async (c) => (await apply()).readLibraryLink(c);
}

// Dropping an item on the canvas uses it there: graphics are placed at the
// drop point, other items apply as on a click.
function bindCanvasDrop(e: Editor) {
  const viewport = e.root.querySelector<HTMLElement>('#viewport');
  if (!viewport) return;
  viewport.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes(ITEM_MIME) || !e.hasDocument) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });
  viewport.addEventListener('drop', (ev) => {
    const id = ev.dataTransfer?.getData(ITEM_MIME);
    if (!id) return;
    ev.preventDefault();
    const at = e.docPoint(ev.clientX, ev.clientY);
    void e.run(async () => {
      const item = (await loaded()).item(id)?.item;
      if (item) await (await apply()).applyItem(e, item, { at });
    });
  });
}

// Placements linked to library items follow the item: once a document with
// such placements is shown, library changes update them (one history step).
function watchLinkedPlacements(e: Editor) {
  let started = false;
  e.onUpdate((e) => {
    if (started || !hasLibraryLinks(e.doc)) return;
    started = true;
    void Promise.all([loaded(), apply()]).then(([l, m]) => {
      let timer = 0;
      const check = () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (!hasLibraryLinks(e.doc) || !m.staleLibraryLinks(e)) return;
          if (e.busy || e.toolBusy) return check();
          void e.run(async () => void (await m.updateLibraryLinks(e)));
        }, 400);
      };
      l.subscribe(check);
      let shown = e.session;
      e.onUpdate((e) => {
        if (e.session === shown) return;
        shown = e.session;
        check();
      });
      check();
    });
  });
}
