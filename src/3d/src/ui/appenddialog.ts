// File ▸ Append…: pick a project (.p3d) or .blend file, choose data-blocks by type, append them.
import { h, type Child } from './h';
import { icon } from './icons';
import { app, registerOperators } from '../app/app';
import type { DocumentData, ID } from '../data/types';
import { decodeDocument, isNativeFile, pickFile } from '../io/native';
import { appendDatablocks, dataTables, type Pick } from '../io/appenddata';
import { activeCollection } from '../ops/object';
import { openDialog, closeDialog } from '../scripting/dialog';

const LABELS: Record<string, [string, string]> = {
  objects: ['Objects', 'object'],
  collections: ['Collections', 'collection'],
  materials: ['Materials', 'material'],
  meshes: ['Meshes', 'mesh_data'],
  curves: ['Curves', 'curve_data'],
  lights: ['Lights', 'light_data'],
  cameras: ['Cameras', 'camera_data'],
  armatures: ['Armatures', 'armature_data'],
  lattices: ['Lattices', 'outliner_ob_lattice'],
  worlds: ['Worlds', 'world'],
  images: ['Images', 'image'],
  actions: ['Actions', 'action'],
  node_groups: ['Node Groups', 'node_tree'],
  texts: ['Texts', 'text'],
  brushes: ['Brushes', 'brush'],
  particles: ['Particle Settings', 'particles'],
};
const labelOf = (t: string) => LABELS[t]?.[0] ?? t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

interface State {
  file: string;
  src: DocumentData;
  table: string;
  picks: Map<ID, string>;
  filter: string;
}

function tablesWithItems(st: State) {
  const master = st.src.scene.collection;
  return dataTables(st.src)
    .map((t) => [t, Object.values((st.src as unknown as Record<string, Record<ID, { id: ID; name: string }>>)[t]).filter((x) => x.id !== master)] as const)
    .filter(([, list]) => list.length)
    .sort((a, b) => (a[0] === 'objects' ? -1 : b[0] === 'objects' ? 1 : labelOf(a[0]).localeCompare(labelOf(b[0]))));
}

function body(st: State, redraw: () => void): Child {
  const tables = tablesWithItems(st);
  const items = (tables.find(([t]) => t === st.table)?.[1] ?? []).filter((x) => !st.filter || x.name.toLowerCase().includes(st.filter.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const count = st.picks.size;
  return h(
    'div',
    { class: 'append-dlg' },
    h('div', { class: 'append-file' }, icon('file_3d'), st.file),
    h(
      'div',
      { class: 'append-cols' },
      h(
        'div',
        { class: 'append-types', role: 'listbox', 'aria-label': 'Data types' },
        tables.map(([t, list]) => {
          const n = list.filter((x) => st.picks.has(x.id)).length;
          return h('button', { key: t, class: { 'append-type': true, on: t === st.table }, onclick: () => ((st.table = t), redraw()) }, icon(LABELS[t]?.[1] ?? 'file'), h('span', { class: 'grow' }, labelOf(t)), h('span', { class: 'append-count' }, n ? `${n}/${list.length}` : String(list.length)));
        }),
      ),
      h(
        'div',
        { class: 'append-items' },
        h('label', { class: 'text-field append-filter' }, icon('search'), h('input', { value: st.filter, placeholder: 'Filter', spellcheck: 'false', 'aria-label': 'Filter', oninput: (e: Event) => ((st.filter = (e.target as HTMLInputElement).value), redraw()) })),
        h(
          'div',
          { class: 'append-list', role: 'listbox', 'aria-multiselectable': 'true' },
          items.map((x) =>
            h(
              'label',
              { key: x.id, class: { 'append-item': true, on: st.picks.has(x.id) } },
              h('input', {
                type: 'checkbox',
                checked: st.picks.has(x.id),
                onchange: (e: Event) => {
                  if ((e.target as HTMLInputElement).checked) st.picks.set(x.id, st.table);
                  else st.picks.delete(x.id);
                  redraw();
                },
              }),
              h('span', null, x.name),
            ),
          ),
        ),
        h(
          'div',
          { class: 'append-sel' },
          h('button', { class: 'btn', onclick: () => (items.forEach((x) => st.picks.set(x.id, st.table)), redraw()) }, 'Select All'),
          h('button', { class: 'btn', onclick: () => (items.forEach((x) => st.picks.delete(x.id)), redraw()) }, 'Select None'),
        ),
      ),
    ),
    h(
      'div',
      { class: 'append-foot' },
      h('span', { class: 'grow' }, 'Referenced data (meshes, materials, images…) comes along.'),
      h('button', { class: 'btn', onclick: () => closeDialog('append') }, 'Cancel'),
      h('button', { class: 'btn primary', disabled: !count, onclick: () => doAppend(st) }, count ? `Append ${count}` : 'Append'),
    ),
  );
}

function doAppend(st: State) {
  const picks: Pick[] = [...st.picks].map(([id, table]) => ({ id, table }));
  const res = appendDatablocks(app.doc, st.src, picks, activeCollection(app.doc));
  closeDialog('append');
  const obs = [...res.linkedObjects, ...res.linkedCollections.flatMap((c) => app.doc.collections[c]?.objects ?? [])];
  if (obs.length) {
    for (const o of Object.values(app.doc.objects)) o.select = false;
    for (const id of obs) if (app.doc.objects[id]) app.doc.objects[id].select = true;
    app.doc.scene.active_object = obs[0];
  }
  const n = Object.values(res.added).reduce((a, l) => a + l.length, 0);
  app.pushUndo('Append');
  app.changed('doc', 'select');
  app.report('INFO', `Appended ${picks.length} data-block${picks.length === 1 ? '' : 's'} (${n} with their dependencies) from "${st.file}"`);
}

/** Open the append dialog for a decoded document. */
export function showAppendDialog(file: string, src: DocumentData) {
  const st: State = { file, src, table: 'objects', picks: new Map(), filter: '' };
  const tables = tablesWithItems(st);
  if (!tables.length) {
    app.report('WARNING', `"${file}" contains nothing to append`);
    return;
  }
  if (!tables.some(([t]) => t === 'objects')) st.table = tables[0][0];
  const dlg = openDialog({ id: 'append', title: 'Append', width: 600, height: 460, className: 'append-dialog', body: () => body(st, () => dlg.redraw()) });
}

async function decode(file: File): Promise<DocumentData> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isNativeFile(bytes)) return decodeDocument(bytes).doc;
  if (file.name.toLowerCase().endsWith('.blend')) {
    const { readBlend } = await import('../io/blend/convert');
    return (await readBlend(bytes)).doc;
  }
  throw new Error('Not a project file');
}

registerOperators([
  {
    idname: 'wm.append',
    label: 'Append',
    description: 'Copy objects, collections, materials and other data from another project file into this one',
    undo: false,
    poll: (ctx) => ctx.doc.mode === 'OBJECT',
    invoke: () => {
      void pickFile('.p3d,.blend').then(async (file) => {
        if (!file) return;
        try {
          showAppendDialog(file.name, await decode(file));
        } catch (e) {
          app.report('ERROR', `Cannot read "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      return 'CANCELLED';
    },
  },
]);
