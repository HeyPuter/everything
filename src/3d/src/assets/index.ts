// Asset system entry: icons, the Asset Browser editor and keymap, File Browser operators in
// asset mode, menus in other editors, and the "Assets" workspace template.
import { app, onAppReady, operators, registerOperators, type OpContext, type Operator } from '../app/app';
import { addKeys } from '../app/keymap';
import { registerIcons } from '../ui/icons';
import { registerWorkspaceTemplate, A, H, V, dock } from '../ui/screen';
import { openMenu } from '../ui/menu';
import './ops';
import './poselib';
import './browser';
import './menus';
import './poseui';
import { browserOf } from './state';
import { idAssetHooks } from '../scripting/api';
import { markAsset, clearAsset } from './ops';
import { renderPreview } from './preview';
import { blockOf, isAssetTable } from './types';
import { loadLibraryIndex, userLibraries, ensureLibrary } from './library';

registerIcons({
  asset_browser: '<rect class="s" x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke-width="1.3"/><path class="f" d="M9.2 2.5h3.6v6.2L11 7.4 9.2 8.7z"/><path class="s" d="M4.5 11h4" stroke-width="1.3" stroke-linecap="round"/>',
  asset_library: '<path class="f" d="M2 3h3v10H2zM6 4.5h2.6V13H6z"/><path class="f" d="M9.6 5.2l2.5-.8 2.6 8.1-2.5.8z"/>',
  asset_essentials: '<path class="f" d="M8 1.8l1.8 3.9 4.2.5-3.1 2.8.8 4.2L8 11.1l-3.7 2.1.8-4.2L2 6.2l4.2-.5z"/>',
  asset_catalog: '<path class="s" d="M2 4.2h4l1.5 1.5H14V13H2z" fill="none" stroke-width="1.3" stroke-linejoin="round"/>',
  asset_catalog_all: '<path class="s" d="M3.5 6h3.5l1.3 1.3H14V13H3.5z" fill="none" stroke-width="1.2" stroke-linejoin="round"/><path class="s" d="M1.8 10.5V3.5h3.5l1.3 1.3h5.6" fill="none" stroke-width="1.2" stroke-linejoin="round"/>',
  asset_catalog_none: '<path class="s" d="M2 4.2h4l1.5 1.5H14V13H2z" fill="none" stroke-width="1.2" stroke-dasharray="1.8 1.4"/>',
  asset_tag: '<path class="s" d="M2.5 2.5h5.2l6 6-5.2 5.2-6-6z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><circle class="f" cx="5.4" cy="5.4" r="1.1"/>',
  asset_mark: '<path class="f" d="M4 1.5h8v13l-4-3.2-4 3.2z"/><path d="M8 4.2l.9 1.9 2 .2-1.5 1.4.4 2L8 8.7l-1.8 1 .4-2L5.1 6.3l2-.2z" fill="#1d1d1d"/>',
});

// ---------------------------------------------------------------------------
// the File Browser's operators also work in the Asset Browser

type Handler = { poll?: (ctx: OpContext, p: Record<string, unknown>) => boolean; exec: (ctx: OpContext, p: Record<string, unknown>) => ReturnType<NonNullable<Operator['exec']>> };

const inAssets: Record<string, Handler> = {
  'file.select_all': { exec: (ctx, p) => void browserOf(ctx)!.selectAll(p.action as 'SELECT') },
  'file.select_walk': { exec: (ctx, p) => void browserOf(ctx)!.walk(p.direction as 'UP', !!p.extend, !!p.fill) },
  'file.select_box': { exec: (ctx) => void (browserOf(ctx)!.boxPending = true) },
  'file.view_selected': { poll: (ctx) => !!browserOf(ctx)!.selected.size, exec: (ctx) => void browserOf(ctx)!.viewSelected() },
  'file.start_filter': { exec: (ctx) => void browserOf(ctx)!.startFilter() },
  'file.sidebar_toggle': { exec: (ctx) => void browserOf(ctx)!.toggleSidebar() },
  'file.execute': { poll: (ctx) => !!browserOf(ctx)!.activeAsset(), exec: () => void app.run('asset.activate') },
  'file.rename': { poll: (ctx) => !!browserOf(ctx)!.activeAsset(), exec: (ctx) => void browserOf(ctx)!.startRename() },
  'file.context_menu': {
    exec: (ctx) => {
      const b = browserOf(ctx) as unknown as { contextMenu(): import('../ui/menu').MenuItem[] };
      openMenu(b.contextMenu(), { x: app.pointer.x, y: app.pointer.y }, { title: 'Assets' });
    },
  },
};

onAppReady(() => {
  for (const [id, mine] of Object.entries(inAssets)) {
    const prev = operators.get(id);
    if (!prev) continue;
    operators.set(id, {
      ...prev,
      poll: (ctx) => (browserOf(ctx) ? (mine.poll ? mine.poll(ctx, {}) : true) : prev.poll ? prev.poll(ctx) : true),
      exec: (ctx, p) => (browserOf(ctx) ? mine.exec(ctx, p) : prev.exec?.(ctx, p)),
      invoke: prev.invoke ? (ctx, p) => (browserOf(ctx) ? mine.exec(ctx, p) : prev.invoke!(ctx, p)) : undefined,
    });
  }
  // load the user libraries after startup so menus (node Add menus, the brush shelf) can list their assets
  setTimeout(() => void loadLibraryIndex().then(() => Promise.all(userLibraries().map((l) => ensureLibrary(l.id)))), 800);
});

// scripts: ID.asset_mark() / asset_clear() / asset_generate_preview()
idAssetHooks.mark = (table, id) => {
  if (!isAssetTable(table)) throw new Error(`${table} cannot be assets`);
  markAsset(app.doc, table, id);
};
idAssetHooks.clear = (table, id) => {
  if (isAssetTable(table)) clearAsset(app.doc, table, id, false);
};
idAssetHooks.preview = (table, id) => {
  const m = isAssetTable(table) ? blockOf(app.doc, table, id)?.asset_data : undefined;
  if (!m) return;
  const url = renderPreview(app.doc, table as never, id);
  if (url) m.preview = url;
};

registerOperators([
  {
    idname: 'asset.details_toggle',
    label: 'Toggle Asset Details',
    description: 'Show or hide the asset details sidebar (metadata, preview and tags)',
    undo: false,
    poll: (ctx) => !!browserOf(ctx),
    exec: (ctx) => void browserOf(ctx)!.toggleDetails(),
  },
]);

addKeys('Asset Browser', [
  { key: 'R', op: 'asset.library_refresh' },
  { key: 'N', op: 'asset.details_toggle' },
  { key: 'Z', ctrl: true, op: 'asset.catalog_undo' },
  { key: 'Z', ctrl: true, shift: true, op: 'asset.catalog_redo' },
  { key: 'W', op: 'file.context_menu' },
]);

registerWorkspaceTemplate('General', () => ({
  name: 'Assets',
  layout: H(0.822, V(0.6, A('VIEW_3D'), A('ASSETS', { library: 'ESSENTIALS' })), dock()),
}));
