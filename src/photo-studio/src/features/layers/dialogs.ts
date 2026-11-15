// New Layer, New Group and Duplicate Layer dialogs, and layer color labels.
import type { Editor } from '../../editor';
import { registerCommand } from '../../app/registry';
import {
  allLayers,
  blendGroupStarts,
  blendLabel,
  blends,
  containerOf,
  findLayer,
  layer,
  MAX_LAYERS,
  type Layer,
  type PhotoDocument,
} from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { rgba8 } from '../../imaging/types';
import { nextLayerName } from '../pixels';
import { insertAboveSelection } from './insert';
import { releaseBackground } from '../../model/housekeeping';
import { recordsSettings, settingsDialog } from '../action-settings';
import { formDialog, type Field } from '../../ui/dialog';
import { duplicateSelected } from '../../ui/actions';

/** Color labels for organizing layers (shown behind the visibility column). */
export const layerColors = [
  ['red', 'Red'],
  ['orange', 'Orange'],
  ['yellow', 'Yellow'],
  ['green', 'Green'],
  ['blue', 'Blue'],
  ['violet', 'Violet'],
  ['gray', 'Gray'],
] as const;
export type LayerColor = (typeof layerColors)[number][0];
export const isLayerColor = (v: unknown): v is LayerColor => layerColors.some(([k]) => k === v);
const colorOptions: [string, string][] = [
  ['none', 'None'],
  ...layerColors.map(([k, l]) => [k, l] as [string, string]),
];

/** The color a layer with this blend mode can be filled with and look
 * unchanged (a neutral layer to paint dodge/burn or lighting into). */
export function neutralColor(blend: Layer['blend']): [number, number, number] | undefined {
  if (
    ['overlay', 'soft light', 'hard light', 'vivid light', 'linear light', 'pin light'].includes(
      blend,
    )
  )
    return [128, 128, 128];
  if (['multiply', 'darken', 'color burn', 'linear burn', 'divide'].includes(blend))
    return [255, 255, 255];
  if (
    [
      'screen',
      'lighten',
      'color dodge',
      'linear dodge',
      'difference',
      'exclusion',
      'subtract',
    ].includes(blend)
  )
    return [0, 0, 0];
  return undefined;
}

const blendOptions = (group = false): [string, string][] =>
  (group ? (['pass through', ...blends] as Layer['blend'][]) : blends).map((b) => [
    b,
    blendLabel(b),
  ]);
const clampOpacity = (v: string | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 1;
};
const parseBlend = (v: string | undefined, group = false): Layer['blend'] =>
  (group ? ['pass through', ...blends] : blends).includes(v as Layer['blend'])
    ? (v as Layer['blend'])
    : group
      ? 'pass through'
      : 'normal';

/** Group separators in the dialog's blend list, as in the panel. */
function separateBlends(dialog: HTMLElement) {
  const select = dialog.querySelector<HTMLSelectElement>('select[name="mode"]');
  if (!select) return;
  for (const o of [...select.options]) {
    if (!blendGroupStarts.includes(o.value as Layer['blend'])) continue;
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '──────────';
    o.before(sep);
  }
}

/** Layer → New → Layer…: name, color label, clipping, mode, opacity and an
 * optional neutral fill for the chosen mode. */
async function newLayerDialog(e: Editor, arg: unknown) {
  const below = e.layer;
  const fields: Field[] = [
    { name: 'name', label: 'Name', value: nextLayerName(e.doc) },
    { name: 'color', label: 'Color', value: 'none', type: 'select', options: colorOptions },
    {
      name: 'clip',
      label: 'Clip to the layer below (clipping mask)',
      value: 'no',
      type: 'checkbox',
    },
    { name: 'mode', label: 'Mode', value: 'normal', type: 'select', options: blendOptions() },
    {
      name: 'opacity',
      label: 'Opacity (%)',
      value: 100,
      type: 'number',
      min: 0,
      max: 100,
      step: 1,
    },
    {
      name: 'neutral',
      label: 'Fill with the neutral color for this mode',
      value: 'no',
      type: 'checkbox',
    },
  ];
  const pending = settingsDialog(e, 'layer.new', arg, 'New Layer', fields, 'OK');
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (dialog?.open) {
    separateBlends(dialog);
    const mode = dialog.querySelector<HTMLSelectElement>('select[name="mode"]');
    const neutral = dialog.querySelector<HTMLInputElement>('input[type=checkbox][name="neutral"]');
    const clip = dialog.querySelector<HTMLInputElement>('input[type=checkbox][name="clip"]');
    if (clip && !below) clip.disabled = true;
    const sync = () => {
      if (!mode || !neutral) return;
      const c = neutralColor(mode.value as Layer['blend']);
      neutral.disabled = !c;
      if (!c) neutral.checked = false;
      const label = neutral.closest('label');
      if (label?.firstChild?.nodeType === Node.TEXT_NODE)
        label.firstChild.textContent = c
          ? `Fill with ${c[0] === 128 ? '50% gray' : c[0] ? 'white' : 'black'} (neutral for ${blendLabel(mode.value as Layer['blend'])})`
          : 'Fill with neutral color (not available for this mode)';
    };
    mode?.addEventListener('change', sync);
    sync();
  }
  const v = await pending;
  if (!v) return;
  const l = newPixelLayer(v.name?.trim() || nextLayerName(e.doc), e.doc);
  l.blend = parseBlend(v.mode);
  l.opacity = clampOpacity(v.opacity);
  if (isLayerColor(v.color)) l.colorLabel = v.color;
  const neutral = v.neutral === 'yes' ? neutralColor(l.blend) : undefined;
  if (neutral) {
    l.pixels = gridFromImage(e.assets.tiles, rgba8(e.doc.width, e.doc.height, [...neutral, 255]));
    l.transform = { x: 0, y: 0, width: e.doc.width, height: e.doc.height, rotation: 0 };
  }
  if (v.clip === 'yes' && below && !below.background) l.clipped = true;
  else if (v.clip === 'yes' && below?.background)
    e.message('The Background layer cannot be the base of a clipping mask.');
  insertAboveSelection(e, l, 'New Layer');
}

/** Layer → New → Group…: name, color label, mode and opacity. */
async function newGroupDialog(e: Editor, arg: unknown) {
  const name = `Group ${allLayers(e.doc.layers).filter((l) => l.kind === 'group').length + 1}`;
  const pending = settingsDialog(
    e,
    'layer.new-group',
    arg,
    'New Group',
    [
      { name: 'name', label: 'Name', value: name },
      { name: 'color', label: 'Color', value: 'none', type: 'select', options: colorOptions },
      {
        name: 'mode',
        label: 'Mode',
        value: 'pass through',
        type: 'select',
        options: blendOptions(true),
      },
      {
        name: 'opacity',
        label: 'Opacity (%)',
        value: 100,
        type: 'number',
        min: 0,
        max: 100,
        step: 1,
      },
    ],
    'OK',
  );
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (dialog?.open) separateBlends(dialog);
  const v = await pending;
  if (!v) return;
  const g = newGroup(e, v.name?.trim() || name);
  g.blend = parseBlend(v.mode, true);
  g.opacity = clampOpacity(v.opacity);
  if (isLayerColor(v.color)) g.colorLabel = v.color;
  insertAboveSelection(e, g, 'New Group');
}
function newGroup(e: Editor, name: string) {
  const g = layer('group', name, e.doc.width, e.doc.height);
  g.blend = 'pass through';
  return g;
}

/** New IDs for copies placed in another document (or the same one twice). */
function freshIds(layers: Layer[]) {
  for (const item of allLayers(layers)) {
    item.id = crypto.randomUUID();
    delete item.psdId;
  }
}

/** Layer → Duplicate Layer…: name the copy and choose where it goes — this
 * document, another open document, or a new document holding only the copy. */
async function duplicateDialog(e: Editor) {
  const roots = e.selectedLayers;
  if (!roots.length) return;
  const one = roots.length === 1;
  const others = e.sessions.filter((s) => s !== e.session && s.hasDocument);
  const options: [string, string][] = [
    ['', `${e.doc.name} (this document)`],
    ...others.map((s) => [s.id, s.doc.name] as [string, string]),
    ['new', 'New document'],
  ];
  const fields: Field[] = [
    ...(one
      ? [{ name: 'as', label: `Duplicate “${roots[0].name}” as`, value: `${roots[0].name} copy` }]
      : []),
    { name: 'dest', label: 'Destination', value: '', type: 'select', options },
    { name: 'docName', label: 'New document name', value: one ? `${roots[0].name}` : 'Layers' },
  ];
  const pending = formDialog(
    one ? 'Duplicate Layer' : 'Duplicate Layers',
    fields,
    'OK',
    one ? '' : `${roots.length} layers will be duplicated.`,
  );
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (dialog?.open) {
    const dest = dialog.querySelector<HTMLSelectElement>('select[name="dest"]');
    const docName = dialog.querySelector<HTMLInputElement>('input[name="docName"]');
    const sync = () => {
      if (!dest || !docName) return;
      docName.disabled = dest.value !== 'new';
    };
    dest?.addEventListener('change', sync);
    sync();
  }
  const v = await pending;
  if (!v) return;
  const dest = v.dest ?? '';
  if (!dest) {
    duplicateSelected(e, one ? v.as?.trim() : undefined);
    // Actions replay a copy within the document as the plain duplicate step.
    e.recorder?.('layer.duplicate', undefined);
    return;
  }
  e.transform.apply();
  await e.session.waitForEdits();
  const ids = new Set(roots.map((l) => l.id));
  // Keep only the chosen layers (and the groups' contents), then carry them
  // through the project format so their pixels and assets come along.
  const keep = (layers: Layer[]): Layer[] =>
    layers.flatMap((l) => (ids.has(l.id) ? [l] : keep(l.children)));
  const source: PhotoDocument = { ...e.doc, layers: keep(e.doc.layers) };
  const { serialize, deserialize } = await import('../../model/serialization');
  const blob = await serialize(source, e.assets);
  if (dest === 'new') {
    const loaded = await deserialize(blob);
    const doc = Object.assign(loaded.document, {
      id: crypto.randomUUID(),
      name: v.docName?.trim() || 'Untitled',
    });
    for (const l of allLayers(doc.layers)) if (l.background) releaseBackground(l);
    if (one && v.as?.trim() && doc.layers[0]) doc.layers[0].name = v.as.trim();
    const s = e.newSession(doc);
    s.assets = loaded.assets;
    s.history.reset(doc);
    s.hasDocument = true;
    e.session = s;
    e.selectLayers(doc.layers.map((l) => l.id));
    e.fit();
    e.update();
    return;
  }
  const target = e.sessions.find((s) => s.id === dest);
  if (!target) return;
  if (allLayers(target.doc.layers).length + allLayers(roots).length > MAX_LAYERS) {
    e.message(`A document can contain up to ${MAX_LAYERS} layers.`);
    return;
  }
  const loaded = await deserialize(blob, target.assets);
  const copies = loaded.document.layers;
  freshIds(copies);
  for (const l of allLayers(copies)) if (l.background) releaseBackground(l);
  if (one && v.as?.trim() && copies[0]) copies[0].name = v.as.trim();
  e.session = target;
  const anchorId = e.selected;
  e.command(one ? 'Duplicate Layer' : 'Duplicate Layers', (d) => {
    // Patterns, embedded objects and text styles the copies refer to by ID.
    for (const p of loaded.document.patterns ?? [])
      if (!d.patterns?.some((x) => x.id === p.id)) d.patterns = [...(d.patterns ?? []), p];
    for (const [id, c] of Object.entries(loaded.document.embeds ?? {}))
      if (!d.embeds?.[id]) d.embeds = { ...(d.embeds ?? {}), [id]: c };
    for (const kind of ['character', 'paragraph'] as const)
      for (const s of loaded.document.textStyles?.[kind] ?? []) {
        d.textStyles ??= { character: [], paragraph: [] };
        const list = d.textStyles[kind] as { id: string }[];
        if (!list.some((x) => x.id === s.id)) list.push(s);
      }
    const anchor = anchorId ? findLayer(d.layers, anchorId) : undefined;
    const list = anchor ? containerOf(d.layers, anchor.id)! : d.layers;
    const at = anchor ? list.indexOf(anchor) + 1 : list.length;
    list.splice(at, 0, ...copies);
  });
  e.selectLayers(copies.map((l) => l.id));
  e.update();
  e.message(`Duplicated into ${target.doc.name}`);
}

/** Set the color label of every selected layer. */
function setColorLabel(e: Editor, color: LayerColor | undefined) {
  const ids = [...e.selectedIds];
  if (!ids.length) return;
  e.command('Layer Color', (d) => {
    for (const id of ids) {
      const l = findLayer(d.layers, id);
      if (!l) continue;
      if (color) l.colorLabel = color;
      else delete l.colorLabel;
    }
  });
}

export function installLayerDialogs(_e: Editor) {
  const hasDoc = (e: Editor) => e.hasDocument;
  const hasLayer = (e: Editor) => !!e.layer;
  recordsSettings('layer.new-group');
  registerCommand(
    {
      id: 'layer.new',
      label: 'Layer…',
      shortcut: 'Mod+Shift+N',
      enabled: hasDoc,
      run: (e, arg) => newLayerDialog(e, arg),
    },
    {
      id: 'layer.new-group',
      label: 'Group…',
      enabled: hasDoc,
      run: (e, arg) => newGroupDialog(e, arg),
    },
    {
      id: 'layer.new-group-quick',
      label: 'New Group',
      hidden: true,
      enabled: hasDoc,
      run: (e) =>
        insertAboveSelection(
          e,
          newGroup(
            e,
            `Group ${allLayers(e.doc.layers).filter((l) => l.kind === 'group').length + 1}`,
          ),
          'New Group',
        ),
    },
    {
      id: 'layer.duplicate-dialog',
      label: 'Duplicate Layer…',
      enabled: hasLayer,
      recordable: false,
      run: (e) => duplicateDialog(e),
    },
    {
      id: 'layer.color-none',
      label: 'No Color',
      enabled: hasLayer,
      checked: (e) => !!e.layer && !e.layer.colorLabel,
      run: (e) => setColorLabel(e, undefined),
    },
    ...layerColors.map(([k, label]) => ({
      id: `layer.color-${k}`,
      label,
      enabled: hasLayer,
      checked: (e: Editor) => e.layer?.colorLabel === k,
      run: (e: Editor) => setColorLabel(e, k),
    })),
  );
}
/** Color label commands for menus (Layer Properties submenu, row context menu). */
export const colorLabelItems = [
  'layer.color-none',
  ...layerColors.map(([k]) => `layer.color-${k}`),
];
