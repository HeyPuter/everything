// Asset operators that act on one data-block or on the Asset Browser's active asset: Mark / Clear
// as Single Asset (data-block selector menus), Assign Action, Show in Library, catalog undo
// snapshots, library listing reload, and asset shelf popovers outside paint modes.
import { app, registerOperators, type OpContext } from '../app/app';
import type { ID } from '../data/types';
import { h } from '../ui/h';
import { openPopover } from '../ui/menu';
import { browserOf } from './state';
import { clearAsset, markAsset } from './ops';
import { assetRef, catalogUndoPush, libraryInfo, LOCAL, refreshLibrary, userLibraries } from './library';
import { assetTableOfId, blockOf, decodeTargets, type AssetTable } from './types';
import { poseLibraryContent } from './poseui';
import { openBrushPicker } from '../paint/assetshelf';

/** The one data-block a single-asset operator acts on: explicit target, else the active object. */
function singleTarget(ctx: OpContext, p: Record<string, unknown>): { table: AssetTable; id: ID } | null {
  if (p.targets) {
    const t = decodeTargets(String(p.targets))[0];
    return t && blockOf(ctx.doc, t.table, t.id) ? t : null;
  }
  if (p.id) {
    const id = String(p.id);
    const table = assetTableOfId(ctx.doc, id);
    if (table) return { table, id };
  }
  const act = ctx.doc.scene.active_object;
  return act && ctx.doc.objects[act] ? { table: 'objects', id: act } : null;
}

const singleProps = [
  { id: 'targets', label: 'Targets', type: 'string' as const, default: '', hidden: true },
  { id: 'id', label: 'Data-Block', type: 'string' as const, default: '', hidden: true },
];

registerOperators([
  {
    idname: 'asset.mark_single',
    label: 'Mark as Single Asset',
    description: 'Make this one data-block an asset (shown in the Asset Browser, with a generated preview)',
    props: singleProps,
    poll: (ctx) => !browserOf(ctx),
    exec: (ctx, p) => {
      const t = singleTarget(ctx, p);
      if (!t) return 'CANCELLED';
      if (!markAsset(ctx.doc, t.table, t.id)) {
        app.report('WARNING', `"${blockOf(ctx.doc, t.table, t.id)?.name}" is an asset already`);
        return 'CANCELLED';
      }
      app.report('INFO', `Marked "${blockOf(ctx.doc, t.table, t.id)!.name}" as an asset`);
    },
  },
  {
    idname: 'asset.clear_single',
    label: 'Clear Single Asset',
    description: 'Turn this one asset back into an ordinary data-block',
    props: [{ id: 'set_fake_user', label: 'Set Fake User', type: 'bool', default: false }, ...singleProps],
    exec: (ctx, p) => {
      const t = singleTarget(ctx, p);
      if (!t || !clearAsset(ctx.doc, t.table, t.id, !!p.set_fake_user)) return 'CANCELLED';
    },
  },
  {
    idname: 'asset.assign_action',
    label: 'Assign Action',
    description: 'Use the active action asset as the animation of the selected objects (or apply it as a pose to the selected bones)',
    poll: (ctx) => {
      const e = browserOf(ctx)?.activeAsset();
      return !!e && e.table === 'actions';
    },
    exec: (ctx) => {
      const e = browserOf(ctx)!.activeAsset()!;
      return app.run('anim.action_asset_assign', { asset: assetRef(e) }, { invoke: false });
    },
  },
  {
    idname: 'asset.library_reload_listing',
    label: 'Reload Library Listing',
    description: 'Read the asset listing of the shown library (or of every user library) again',
    undo: false,
    exec: (ctx) => {
      const b = browserOf(ctx);
      const libs = !b || b.library === 'ALL' ? userLibraries().map((l) => l.id) : [b.library];
      void Promise.all(libs.map((l) => refreshLibrary(l))).then(() => {
        b?.draw();
        app.changed('ui');
      });
    },
  },
  {
    idname: 'asset.browse_containing_blend_file',
    label: 'Show in Library',
    description: "Show the active asset in its own library's view (for assets listed under All Libraries)",
    undo: false,
    poll: (ctx) => !!browserOf(ctx)?.activeAsset(),
    exec: (ctx) => {
      const b = browserOf(ctx)!;
      const e = b.activeAsset()!;
      const ref = assetRef(e);
      if (b.library !== e.library) b.setLibrary(e.library);
      b.selected.clear();
      b.selected.add(ref);
      b.active = ref;
      b.draw();
      requestAnimationFrame(() => b.viewSelected());
      app.report('INFO', `"${e.block.name}" is in ${libraryInfo(e.library)?.name ?? 'its library'}`);
    },
  },
  {
    idname: 'asset.catalog_undo_push',
    label: 'Store Catalog Undo Snapshot',
    description: "Remember the catalogs of the shown library so the next edit can be undone with the browser's catalog undo",
    undo: false,
    poll: (ctx) => {
      const b = browserOf(ctx);
      return !!b && !!libraryInfo(b.library)?.editable;
    },
    exec: (ctx) => {
      const b = browserOf(ctx)!;
      if (b.library === LOCAL) return; // the current file's catalogs use the regular undo history
      catalogUndoPush(b.library);
    },
  },
  {
    idname: 'wm.call_asset_shelf_popover',
    label: 'Call Asset Shelf Popover',
    description: 'Open an asset shelf as a popover at the mouse (pose library, or the brushes of the paint mode)',
    props: [{ id: 'name', label: 'Shelf', type: 'string', default: '' }],
    undo: false,
    exec: (_ctx, p) => {
      const name = String(p.name ?? '');
      const at = { x: app.pointer.x, y: app.pointer.y };
      if (/pose/i.test(name)) {
        openPopover(at, () => h('div', { class: 'shelf-popover pose-shelf' }, poseLibraryContent()), { width: 360, className: 'asset-shelf-popover' });
        return;
      }
      if (/brush/i.test(name)) {
        openBrushPicker(at);
        return;
      }
      app.report('ERROR', `Unknown asset shelf "${name}"`);
      return 'CANCELLED';
    },
  },
]);
