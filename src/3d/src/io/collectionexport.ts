// Collection exporters: a collection keeps a list of export setups (format, file path and the
// format's options). Properties ▸ Collection ▸ Exporters edits them; Export / Export All write the
// collection's objects with them, and File ▸ Export All Collections runs every exporter of the
// scene. Settings use the scripting names of the format operators' properties.
import { app, registerOperators, type OpContext } from '../app/app';
import type { CollectionData, DocumentData } from '../data/types';
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { panel, panelHeaderExtras, button, opButton, textField } from '../ui/widgets';
import { bool, enumProp, num, splitRow } from '../ui/props';
import { openMenu, type MenuItem } from '../ui/menu';
import { collectionExtraPanels } from '../editors/properties/tabs';
import { uiList } from '../editors/properties/uilist';
import { propertiesCollection } from '../object/relations';
import { collectionObjectIds, exportToPath, formatDefs, propsToOptions } from './formats/formatops';
import type { FormatOption } from './formats/ui';

export interface CollectionExporter {
  /** display name of the format ("Wavefront OBJ") */
  name: string;
  /** format id (io/formats) */
  format: string;
  /** '' = //<collection name>.<ext> */
  filepath: string;
  /** operator properties by scripting name */
  export_properties: Record<string, unknown>;
  is_open: boolean;
}

declare module '../data/types' {
  interface CollectionData {
    exporters?: CollectionExporter[];
    active_exporter_index?: number;
  }
}

/** Formats that can be added as exporters, with their file handler names and display names. */
export const EXPORTER_FORMATS: { format: string; handler: string; name: string; ext: string }[] = [
  { format: 'abc', handler: 'IO_FH_alembic', name: 'Alembic', ext: '.abc' },
  { format: 'usd', handler: 'IO_FH_usd', name: 'Universal Scene Description', ext: '.usdz' },
  { format: 'obj', handler: 'IO_FH_obj', name: 'Wavefront OBJ', ext: '.obj' },
  { format: 'ply', handler: 'IO_FH_ply', name: 'Stanford PLY', ext: '.ply' },
  { format: 'stl', handler: 'IO_FH_stl', name: 'STL', ext: '.stl' },
  { format: 'fbx', handler: 'IO_FH_fbx', name: 'FBX', ext: '.fbx' },
  { format: 'gltf', handler: 'IO_FH_gltf2', name: 'glTF 2.0', ext: '.glb' },
];

export function exporterFormat(name: string) {
  const n = String(name ?? '');
  return EXPORTER_FORMATS.find((f) => f.handler === n || f.format === n || f.name === n) ?? null;
}

/** File extension a format writes with the given settings. */
function extensionOf(ex: CollectionExporter): string {
  const f = exporterFormat(ex.format);
  if (ex.format === 'gltf') return ex.export_properties.export_format === 'GLTF_EMBEDDED' || ex.export_properties.export_format === 'GLTF_SEPARATE' ? '.gltf' : '.glb';
  if (ex.format === 'usd') return ex.export_properties.format === 'USDA' ? '.usda' : '.usdz';
  return f?.ext ?? '';
}

export const exporterPath = (c: CollectionData, ex: CollectionExporter) => ex.filepath || `//${c.name}${extensionOf(ex)}`;

export function addExporter(c: CollectionData, name: string): CollectionExporter | null {
  const f = exporterFormat(name);
  const def = f ? formatDefs.get(f.format) : undefined;
  if (!f || !def?.exportData) return null;
  const props: Record<string, unknown> = {};
  for (const o of def.exportOptions ?? []) if (!o.dynamicDefault) props[o.bpy ?? o.id] = o.default;
  const ex: CollectionExporter = { name: f.name, format: f.format, filepath: '', export_properties: props, is_open: true };
  (c.exporters ??= []).push(ex);
  c.active_exporter_index = c.exporters.length - 1;
  return ex;
}

/** Run one exporter of a collection; returns the written path or null (reported). */
export function runExporter(doc: DocumentData, c: CollectionData, ex: CollectionExporter): string | null {
  const ids = collectionObjectIds(doc, c.id);
  if (!ids?.size) {
    app.report('WARNING', `Collection "${c.name}" has no objects to export`);
    return null;
  }
  try {
    const path = exportToPath(ex.format, exporterPath(c, ex), ex.export_properties, ids);
    if (!path) app.report('ERROR', `${ex.name} cannot export`);
    return path;
  } catch (e) {
    app.report('ERROR', `Exporting "${c.name}" (${ex.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const ctxCollection = (_ctx: OpContext): CollectionData | undefined => propertiesCollection();

function exportAll(doc: DocumentData, cols: CollectionData[]): number {
  let n = 0;
  for (const c of cols) for (const ex of c.exporters ?? []) if (runExporter(doc, c, ex)) n++;
  return n;
}

registerOperators([
  {
    idname: 'collection.exporter_add',
    label: 'Add Exporter',
    description: 'Add an export setup for this collection',
    props: [{ id: 'name', label: 'Format', type: 'string', default: '' }],
    poll: (ctx) => !!ctxCollection(ctx),
    invoke: (ctx, p) => {
      if (p.name) return operatorsExec('collection.exporter_add', p);
      const c = ctxCollection(ctx);
      if (!c) return 'CANCELLED';
      openMenu(
        EXPORTER_FORMATS.filter((f) => formatDefs.get(f.format)?.exportData).map((f) => ({ label: f.name, op: 'collection.exporter_add', props: { name: f.handler } })),
        { x: ctx.event?.x ?? app.pointer.x, y: ctx.event?.y ?? app.pointer.y },
      );
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const c = ctxCollection(ctx);
      if (!c || !addExporter(c, String(p.name))) {
        app.report('ERROR', `Unknown exporter "${p.name}"`);
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'collection.exporter_remove',
    label: 'Remove Exporter',
    description: 'Remove an export setup from this collection',
    props: [{ id: 'index', label: 'Index', type: 'int', default: -1 }],
    poll: (ctx) => !!ctxCollection(ctx)?.exporters?.length,
    exec: (ctx, p) => {
      const c = ctxCollection(ctx)!;
      const list = c.exporters!;
      const i = Number(p.index) >= 0 ? Number(p.index) : (c.active_exporter_index ?? 0);
      if (i < 0 || i >= list.length) return 'CANCELLED';
      list.splice(i, 1);
      c.active_exporter_index = Math.max(0, Math.min(i, list.length - 1));
    },
  },
  {
    idname: 'collection.exporter_move',
    label: 'Move Exporter',
    description: 'Move the active exporter up or down the list',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: (ctx) => (ctxCollection(ctx)?.exporters?.length ?? 0) > 1,
    exec: (ctx, p) => {
      const c = ctxCollection(ctx)!;
      const list = c.exporters!;
      const i = c.active_exporter_index ?? 0;
      const j = p.direction === 'DOWN' ? i + 1 : i - 1;
      if (j < 0 || j >= list.length) return 'CANCELLED';
      [list[i], list[j]] = [list[j], list[i]];
      c.active_exporter_index = j;
    },
  },
  {
    idname: 'collection.exporter_export',
    label: 'Export',
    description: "Export the collection's objects with this exporter",
    props: [{ id: 'index', label: 'Index', type: 'int', default: -1 }],
    poll: (ctx) => !!ctxCollection(ctx)?.exporters?.length,
    undo: false,
    exec: (ctx, p) => {
      const c = ctxCollection(ctx)!;
      const i = Number(p.index) >= 0 ? Number(p.index) : (c.active_exporter_index ?? 0);
      const ex = c.exporters![i];
      if (!ex) return 'CANCELLED';
      const path = runExporter(ctx.doc, c, ex);
      if (!path) return 'CANCELLED';
      app.report('INFO', `Exported "${c.name}" to ${path}`);
    },
  },
  {
    idname: 'collection.export_all',
    label: 'Export All',
    description: 'Run every exporter of this collection',
    poll: (ctx) => !!ctxCollection(ctx)?.exporters?.length,
    undo: false,
    exec: (ctx) => {
      const n = exportAll(ctx.doc, [ctxCollection(ctx)!]);
      app.report('INFO', `Wrote ${n} file${n === 1 ? '' : 's'}`);
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'wm.collection_export_all',
    label: 'Export All Collections',
    description: 'Run the exporters of every collection in the scene',
    poll: (ctx) => Object.values(ctx.doc.collections).some((c) => c.exporters?.length),
    undo: false,
    exec: (ctx) => {
      const cols = Object.values(ctx.doc.collections).filter((c) => c.exporters?.length);
      const n = exportAll(ctx.doc, cols);
      app.report('INFO', `Wrote ${n} file${n === 1 ? '' : 's'} from ${cols.length} collection${cols.length === 1 ? '' : 's'}`);
      if (!n) return 'CANCELLED';
    },
  },
]);

function operatorsExec(id: string, p: Record<string, unknown>) {
  return app.run(id, p, { invoke: false });
}

// ---------------------------------------------------------------------------
// Properties ▸ Collection ▸ Exporters

function optionRow(ex: CollectionExporter, o: FormatOption, key: string): Child {
  const owner = ex.export_properties;
  const k = o.bpy ?? o.id;
  if (!(k in owner)) owner[k] = o.dynamicDefault ? o.dynamicDefault() : o.default;
  const opts = { tip: o.description, undo: 'Change Exporter Setting' };
  if (o.type === 'bool') return bool(owner, k, o.label, opts);
  if (o.type === 'enum') return enumProp(owner, k, o.label, o.items ?? [], opts);
  if (o.type === 'float' || o.type === 'int') return num(owner, k, o.label, { ...opts, min: o.min, max: o.max, step: o.step, int: o.type === 'int' });
  return splitRow(o.label, textField(`${key}.${k}`, String(owner[k] ?? ''), (v) => ((owner[k] = v), app.pushUndo('Change Exporter Setting'), app.changed('doc'))));
}

/** The exporter's settings as option values (for visibility conditions). */
function optionValues(ex: CollectionExporter): Record<string, unknown> {
  const def = formatDefs.get(ex.format);
  try {
    return propsToOptions(def?.exportOptions ?? [], ex.export_properties);
  } catch {
    return {};
  }
}

function exporterBody(c: CollectionData, ex: CollectionExporter, i: number): Child {
  const def = formatDefs.get(ex.format);
  const key = `colex-${c.id}-${i}`;
  const values = optionValues(ex);
  // export button at the right of the exporter's header
  panelHeaderExtras[key] = () => button(`${key}.export`, icon('export'), () => app.run('collection.exporter_export', { index: i }, { invoke: false }), { tip: `Export the collection with ${ex.name}`, className: 'icon-btn' });
  return panel(
    key,
    ex.name,
    () => [
      splitRow(
        'File Path',
        textField(`${key}.path`, ex.filepath, (v) => ((ex.filepath = v), app.pushUndo('Set Export Path'), app.changed('doc')), { placeholder: exporterPath(c, { ...ex, filepath: '' }) }),
      ),
      ...(def?.exportOptions ?? []).filter((o) => !o.showIf || o.showIf(values)).map((o) => optionRow(ex, { ...o, showIf: undefined }, key)),
    ],
    { sub: true },
  );
}

collectionExtraPanels.push((c) =>
  panel(
    'col-exporters',
    'Exporters',
    () => {
      const list = c.exporters ?? [];
      const active = Math.min(c.active_exporter_index ?? 0, list.length - 1);
      const addMenu = (e: MouseEvent): void => {
        const items: MenuItem[] = EXPORTER_FORMATS.filter((f) => formatDefs.get(f.format)?.exportData).map((f) => ({ label: f.name, op: 'collection.exporter_add', props: { name: f.handler } }));
        openMenu(items, e.currentTarget as HTMLElement);
      };
      return [
        uiList(
          `colex-${c.id}`,
          list.map((ex, i) => ({ key: `${i}`, label: ex.name, icon: 'export' })),
          active,
          (i) => {
            c.active_exporter_index = i;
            app.changed('ui');
          },
          {
            add: ((e?: MouseEvent) => (e?.currentTarget ? addMenu(e) : app.run('collection.exporter_add', {}, { invoke: true }))) as () => void,
            remove: list.length ? () => app.run('collection.exporter_remove', { index: active }, { invoke: false }) : undefined,
            up: list.length > 1 ? () => app.run('collection.exporter_move', { direction: 'UP' }, { invoke: false }) : undefined,
            down: list.length > 1 ? () => app.run('collection.exporter_move', { direction: 'DOWN' }, { invoke: false }) : undefined,
          },
        ),
        h('div', { class: 'btn-row' }, opButton('collection.export_all', 'Export All', {}, { icon: 'export' })),
        list[active] ? exporterBody(c, list[active], active) : null,
      ];
    },
    { closed: true },
  ),
);
