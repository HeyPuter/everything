// Volume operators: Add ▸ Volume ▸ Empty / Import OpenVDB…, grid list editing, and the OpenVDB
// file format entry (File ▸ Import, drag and drop). Files are parsed in a worker with progress in
// the header; Esc stops the import.
import { app, onAppReady, operators, registerOperators, type PropDef } from '../app/app';
import { newObject } from '../data/defaults';
import type { DocumentData, MaterialData, ObjectData } from '../data/types';
import { addNode, connect, ctxOf } from '../nodes/tree';
import { addObjectToScene } from '../ops/object';
import { pickFile } from '../io/native';
import { registerFormat } from '../io/files';
import { newVolume, uniqueVolumeName, volumeOf } from './data';
import type { VolumeGrid } from './types';
import { readVdb } from './vdb/reader';

const transformProps: PropDef[] = [
  { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
  { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
  { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
  { id: 'scale', label: 'Scale', type: 'vec3', default: null, subtype: 'none' },
];

/** Create a Volume object (with data) at the 3D cursor. */
export function addVolumeObject(doc: DocumentData, name: string, grids: VolumeGrid[] = [], props: Record<string, unknown> = {}, filepath = ''): ObjectData {
  doc.volumes ??= {};
  const vo = newVolume(uniqueVolumeName(doc, name));
  vo.grids = grids;
  vo.filepath = filepath;
  doc.volumes[vo.id] = vo;
  const ob = newObject(name, 'VOLUME', vo.id);
  const p = { ...props };
  if (p.location === null || p.location === undefined) p.location = [...doc.scene.cursor.location];
  if (p.rotation === null) delete p.rotation;
  addObjectToScene(doc, ob, p);
  if (Array.isArray(props.scale)) ob.scale = [...(props.scale as [number, number, number])];
  return ob;
}

// ---------------------------------------------------------------------------
// Parsing (worker with a synchronous fallback)

/** Files parsed in this session, so redo (Adjust Last Operation) can rebuild the object. */
const parsed = new Map<string, { grids: VolumeGrid[]; warnings: string[] }>();

let activeWorker: Worker | null = null;

function parseInWorker(bytes: Uint8Array): Promise<{ grids: VolumeGrid[]; warnings: string[] }> {
  if (typeof Worker === 'undefined') return Promise.resolve(readVdb(bytes));
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('./vdbworker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(readVdb(bytes));
      return;
    }
    activeWorker = w;
    w.onmessage = (e: MessageEvent) => {
      const d = e.data as { ok: boolean; grids?: VolumeGrid[]; warnings?: string[]; error?: string };
      w.terminate();
      activeWorker = null;
      if (d.ok) resolve({ grids: d.grids!, warnings: d.warnings ?? [] });
      else reject(new Error(d.error ?? 'The file could not be read.'));
    };
    w.onerror = (e) => {
      w.terminate();
      activeWorker = null;
      reject(new Error(e.message || 'The file could not be read.'));
    };
    w.postMessage(bytes, [bytes.buffer]);
  });
}

/** Read an OpenVDB file into a new Volume object, as a cancellable modal job. */
export async function importVdbFile(file: File, props: Record<string, unknown> = {}): Promise<ObjectData | null> {
  const r = await loadVdb(file);
  if (!r) return null;
  const ob = addVolumeObject(app.doc, file.name.replace(/\.vdb$/i, '') || 'Volume', r.grids, props, file.name);
  app.report('INFO', `Imported ${r.grids.length} grid${r.grids.length === 1 ? '' : 's'} from ${file.name}`);
  app.changed('doc', 'geometry', 'ui');
  return ob;
}

/** Parse an OpenVDB file as a cancellable modal job (null when cancelled or unreadable). */
export async function loadVdb(file: File): Promise<{ grids: VolumeGrid[]; warnings: string[] } | null> {
  const label = 'Import OpenVDB';
  let cancelled = false;
  let dots = 0;
  const timer = setInterval(() => {
    dots = (dots + 1) % 4;
    app.changed('ui');
  }, 400);
  if (!app.modal)
    app.startModal({
      label,
      onKey: (e) => {
        if (e.type === 'keydown' && e.key === 'Escape') {
          cancelled = true;
          activeWorker?.terminate();
          activeWorker = null;
          app.endModal('CANCELLED');
          app.report('INFO', 'Import cancelled');
        }
        return true;
      },
      cancel: () => {},
      header: () => `Reading ${file.name}${'.'.repeat(dots)}`,
      status: () => [['Esc', 'Cancel']],
    });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await parseInWorker(bytes);
    if (cancelled) return null;
    parsed.set(file.name, r);
    if (!r.grids.length) {
      app.report('ERROR', r.warnings[0] ?? `${file.name} contains no grids that can be shown`);
      return null;
    }
    for (const w of r.warnings) app.report('WARNING', w);
    return r;
  } catch (e) {
    if (!cancelled) app.report('ERROR', `${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearInterval(timer);
    if (app.modal && !cancelled) app.endModal('CANCELLED');
    app.changed('ui');
  }
}

const objectMode = () => app.doc.mode === 'OBJECT';

registerOperators([
  {
    idname: 'object.volume_add',
    label: 'Add Volume',
    description: 'Add an empty volume object (fill it with grids from geometry nodes or modifiers)',
    props: transformProps,
    poll: objectMode,
    exec: (ctx, p) => {
      addVolumeObject(ctx.doc, 'Volume', [], p);
    },
  },
  {
    idname: 'object.volume_import',
    label: 'Import OpenVDB',
    description: 'Load an OpenVDB file (.vdb) as a volume object',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true }, ...transformProps],
    poll: objectMode,
    invoke: (_ctx, p) => {
      void pickFile('.vdb').then(async (file) => {
        if (!file) return;
        const ob = await importVdbFile(file, p);
        if (ob) {
          p.filepath = file.name;
          app.pushUndo('Import OpenVDB');
        }
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      // re-run with a file read earlier in the session (Adjust Last Operation, scripts)
      const r = parsed.get(String(p.filepath ?? ''));
      if (!r || !r.grids.length) {
        app.report('ERROR', p.filepath ? `${p.filepath} has not been loaded in this session` : 'No file given');
        return 'CANCELLED';
      }
      addVolumeObject(ctx.doc, String(p.filepath).replace(/\.vdb$/i, '') || 'Volume', r.grids, p, String(p.filepath));
    },
  },
  {
    idname: 'volume.grids_load',
    label: 'Load OpenVDB File',
    description: 'Replace the grids of the active volume with those of an OpenVDB file',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true }],
    poll: () => !!volumeOf(app.doc, app.activeObject),
    invoke: (_ctx, p) => {
      const ob = app.activeObject!;
      void pickFile('.vdb').then(async (file) => {
        if (!file) return;
        const r = await loadVdb(file);
        const vo = volumeOf(app.doc, ob);
        if (!r || !vo) return;
        vo.grids = r.grids;
        vo.filepath = file.name;
        vo.active_grid_index = 0;
        p.filepath = file.name;
        app.pushUndo('Load OpenVDB File');
        app.changed('doc', 'geometry');
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const r = parsed.get(String(p.filepath ?? ''));
      const vo = volumeOf(ctx.doc, app.activeObject);
      if (!r || !vo) return 'CANCELLED';
      vo.grids = r.grids;
      vo.filepath = String(p.filepath);
      vo.active_grid_index = 0;
    },
  },
  {
    idname: 'volume.grid_remove',
    label: 'Remove Grid',
    description: 'Delete the active grid of the volume',
    poll: () => (volumeOf(app.doc, app.activeObject)?.grids.length ?? 0) > 0,
    exec: (ctx) => {
      const vo = volumeOf(ctx.doc, app.activeObject)!;
      const i = Math.min(vo.active_grid_index, vo.grids.length - 1);
      vo.grids = vo.grids.filter((_, k) => k !== i);
      vo.active_grid_index = Math.max(0, Math.min(i, vo.grids.length - 1));
    },
  },
  {
    idname: 'volume.grid_move',
    label: 'Move Grid',
    description: 'Move the active grid up or down the list',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: () => (volumeOf(app.doc, app.activeObject)?.grids.length ?? 0) > 1,
    exec: (ctx, p) => {
      const vo = volumeOf(ctx.doc, app.activeObject)!;
      const i = vo.active_grid_index;
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= vo.grids.length) return 'CANCELLED';
      const g = [...vo.grids];
      [g[i], g[j]] = [g[j], g[i]];
      vo.grids = g;
      vo.active_grid_index = j;
    },
  },
  {
    idname: 'volume.grid_rename',
    label: 'Rename Grid',
    description: 'Change the name shaders and nodes use to read the active grid',
    props: [{ id: 'name', label: 'Name', type: 'string', default: '' }],
    poll: () => (volumeOf(app.doc, app.activeObject)?.grids.length ?? 0) > 0,
    exec: (ctx, p) => {
      const vo = volumeOf(ctx.doc, app.activeObject)!;
      const name = String(p.name ?? '').trim();
      const g = vo.grids[vo.active_grid_index];
      if (!g || !name) return 'CANCELLED';
      vo.grids = vo.grids.map((x) => (x === g ? { ...x, name } : x));
    },
  },
]);

registerFormat({
  id: 'vdb',
  label: 'OpenVDB (.vdb)',
  extensions: ['.vdb'],
  description: 'Volume grids as a volume object',
  import: async (file) => {
    // the file menu pushes the undo step
    await importVdbFile(file);
  },
});

// New materials of volume objects start as a Principled Volume (no surface)
onAppReady(() => {
  const op = operators.get('material.new');
  if (!op?.exec) return;
  const orig = op.exec;
  op.exec = (ctx, p) => {
    const r = orig(ctx, p);
    const ob = app.activeObject;
    const vo = volumeOf(ctx.doc, ob);
    if (r === 'CANCELLED' || !ob || !vo) return r;
    const ma = ctx.doc.materials[vo.materials[ob.active_material_index] ?? ''];
    if (ma) makeVolumeMaterial(ctx.doc, ma);
    return r;
  };
});

/** Turn a material into a plain Principled Volume (the default look of volume objects). */
export function makeVolumeMaterial(doc: DocumentData, ma: MaterialData) {
  const t = ma.tree;
  const out = t.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial');
  if (!out) return;
  const keep = new Set([out.id]);
  t.nodes = t.nodes.filter((n) => keep.has(n.id));
  t.links = [];
  const v = addNode(t, 'ShaderNodeVolumePrincipled', [out.location[0] - 300, out.location[1]]);
  connect(ctxOf(doc, t), v.id, 'Volume', out.id, 'Volume');
  ma.use_nodes = true;
}
