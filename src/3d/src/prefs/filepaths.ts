// Preferences ▸ File Paths: default paths for new files and the browser storage that stands
// in for folders on disk (recent files, startup file, auto saves, installed assets).
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, onAppReady, operators } from '../app/app';
import { prefs } from '../app/prefs';
import { panel } from '../ui/widgets';
import { recentFiles, clearRecent, hasStartupFile, clearStartupFile, listSnapshots, onSessionChange } from '../io/session';
import { registerPrefSection } from './editor';
import { pText, note, infoRow } from './ui';
import { scriptDirectoriesPanel } from './pathlists';

const FACTORY_OUTPUT = '//render/';

// File ▸ New: a factory scene takes the preferred render output path
onAppReady(() => {
  const op = operators.get('wm.read_homefile');
  if (!op?.exec) return;
  const prev = op.exec;
  op.exec = (ctx, p) => {
    const r = prev(ctx, p);
    const rd = app.doc.scene.render;
    if (rd && rd.filepath === FACTORY_OUTPUT && prefs.render_output_directory && prefs.render_output_directory !== FACTORY_OUTPUT) rd.filepath = prefs.render_output_directory;
    return r;
  };
});

let usage: { used: number; quota: number; persisted: boolean; snapshots: number } | null = null;
let pending = false;
const MB = (n: number) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

async function refresh(redraw: () => void) {
  if (pending) return;
  pending = true;
  try {
    const est = (await navigator.storage?.estimate?.()) ?? {};
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    const snaps = await listSnapshots().catch(() => []);
    usage = { used: est.usage ?? 0, quota: est.quota ?? 0, persisted, snapshots: snaps.length };
  } catch {
    usage = { used: 0, quota: 0, persisted: false, snapshots: 0 };
  }
  pending = false;
  redraw();
}

function storagePanel(redraw: () => void): Child {
  if (!usage) void refresh(redraw);
  const u = usage;
  return [
    infoRow('Used', u ? `${MB(u.used)}${u.quota ? ` of ${MB(u.quota)}` : ''}` : '…'),
    infoRow('Persistent', u ? (u.persisted ? 'Yes: the browser keeps this data when space runs low' : 'No: the browser may clear it when space runs low') : '…'),
    infoRow('Recent Files', `${recentFiles().length} kept`),
    infoRow('Startup File', hasStartupFile() ? 'Saved (File ▸ Defaults)' : 'Factory settings'),
    infoRow('Auto Saves', u ? `${u.snapshots}` : '…'),
    h(
      'div',
      { class: 'prefs-btn-row left' },
      h('button', { class: 'btn', disabled: !!u?.persisted || !navigator.storage?.persist, 'data-tip': 'Keep Data\nAsk the browser not to clear this storage when space runs low', onclick: () => void navigator.storage?.persist?.().then(() => refresh(redraw)) }, icon('locked'), 'Keep Data'),
      h('button', { class: 'btn', disabled: !recentFiles().length, 'data-tip': 'Clear Recent Files\nForget the recent files list and its stored copies', onclick: () => void clearRecent().then(() => refresh(redraw)) }, 'Clear Recent Files'),
      h('button', { class: 'btn', disabled: !hasStartupFile(), 'data-tip': 'Delete Startup File\nNew files start from the factory settings again', onclick: () => void clearStartupFile().then(() => refresh(redraw)) }, 'Delete Startup File'),
      h('button', { class: 'btn icon-btn', 'data-tip': 'Refresh', 'aria-label': 'Refresh storage information', onclick: () => void refresh(redraw) }, icon('file_refresh')),
    ),
  ];
}

let unsub: (() => void) | null = null;
/** redraw of the editor that drew the section last */
let lastRedraw: () => void = () => {};

registerPrefSection({
  id: 'FILE_PATHS',
  label: 'File Paths',
  group: 3,
  draw: (c) => {
    lastRedraw = c.redraw;
    unsub ??= onSessionChange(() => void refresh(() => lastRedraw())) as unknown as () => void;
    return [
      panel('pf-fp-data', 'Data', () => [pText('render_output_directory', 'Render Output', FACTORY_OUTPUT), note('Output path of the scene in new files (File ▸ New with factory settings). "//" is relative to the project.')]),
      scriptDirectoriesPanel(),
      panel('pf-fp-storage', 'Browser Storage', () => storagePanel(c.redraw)),
    ];
  },
});
