/**
 * Slices: the Slice and Slice Selection tools, Object > Slice commands,
 * View > Show Slices / Lock Slices, the slice overlay, File > Save Selected
 * Slices and File > Export > Save for Web (loaded on first use).
 */
import './styles.css';
import { h } from '../../lib/dom.js';
import { registerIcons } from '../../ui/icons.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { overlayHooks } from '../../render/overlay.js';
import {
  SLICE_TYPES,
  TARGETS,
  findSlice,
  slicesOf,
  sliceRect,
  addSlice,
  updateSlice,
  removeSlices,
  promote,
  makeObjectSlices,
  slicesFromSelection,
  slicesFromGuides,
  duplicateSlices,
  combineSlices,
  divideSlices,
  objectSliceIds,
  clipsToArtboard,
  defaultSliceName,
} from './model.js';
import { SliceTool, SliceSelectTool, drawSliceOverlay, tableOf, selectedSlices, selectedStored, setSliceSelection, deleteSelectedSlices } from './tools.js';

const P = (d, extra = {}) => ['path', { d, ...extra }];

registerIcons({
  'tool-slice': [P('M4 20 14.5 9.5'), P('M13 8l4-4 3 3-4 4z'), P('M3 4h5M3 4v5', { 'stroke-dasharray': '2 2' }), P('M21 15v5h-5', { 'stroke-dasharray': '2 2' })],
  'tool-slice-select': [['rect', { x: '3', y: '3', width: '13', height: '13', 'stroke-dasharray': '2 2' }], P('M11 11l9 3.5-4 1.5-1.5 4z', { 'stroke-linejoin': 'round', fill: 'currentColor' })],
});

const loadWeb = () => import('./save-for-web.js'); // loaded on first use

/**
 * Slices a command acts on: the selected slices (stored, or auto slices
 * made into user slices when `promoteAuto`), else the object slices of the
 * selected objects.
 */
function targetSlices(editor, { promoteAuto = false } = {}) {
  const doc = editor.doc;
  const out = [];
  for (const id of selectedSlices(editor)) {
    if (findSlice(doc, id)) out.push(id);
    else if (promoteAuto) {
      const row = tableOf(editor).find((r) => r.id === id);
      if (row) out.push(promote(doc, row));
    }
  }
  if (!out.length && editor.selection.size) out.push(...objectSliceIds(doc, editor.topSelection()));
  return out;
}

const hasTargets = (a) => Boolean(a.editor) && (selectedSlices(a.editor).size > 0 || objectSliceIds(a.editor.doc, a.editor.topSelection()).length > 0);

/** Slice Options dialog for one slice. */
export async function sliceOptionsDialog(app, editor, id) {
  const doc = editor.doc;
  const s = findSlice(doc, id);
  if (!s) return null;
  const number = tableOf(editor).find((r) => r.id === id)?.number || 1;
  const node = s.kind === 'object' ? doc.get(s.node) : null;
  const isText = node?.type === 'text';
  const field = (label, input) => h('div.form-row', h('label', { for: input.id }, label), input);
  const type = h('select#so-type', SLICE_TYPES.filter((t) => t.value !== 'html' || isText).map((t) => h('option', { value: t.value, selected: (s.type || 'image') === t.value }, t.label)));
  const name = h('input#so-name', { type: 'text', value: s.name || defaultSliceName(doc, number), spellcheck: false, autocomplete: 'off' });
  const url = h('input#so-url', { type: 'url', value: s.url || '', placeholder: 'https://', spellcheck: false, autocomplete: 'off' });
  const target = h('input#so-target', { type: 'text', value: s.target || '', list: 'so-targets', spellcheck: false, autocomplete: 'off' });
  const targets = h('datalist#so-targets', TARGETS.filter(Boolean).map((t) => h('option', { value: t })));
  const message = h('input#so-message', { type: 'text', value: s.message || '', autocomplete: 'off' });
  const alt = h('input#so-alt', { type: 'text', value: s.alt || '', autocomplete: 'off' });
  const html = h('textarea#so-html', { rows: 3 }, s.html || '');
  const halign = h('select#so-halign', ['left', 'center', 'right'].map((v) => h('option', { value: v, selected: (s.align || 'left') === v }, v[0].toUpperCase() + v.slice(1))));
  const valign = h('select#so-valign', ['top', 'middle', 'bottom'].map((v) => h('option', { value: v, selected: (s.valign || 'top') === v }, v[0].toUpperCase() + v.slice(1))));
  const bgKind = h('select#so-bg', [['none', 'None'], ['#ffffff', 'White'], ['#000000', 'Black'], ['other', 'Other']].map(([v, l]) => h('option', { value: v }, l)));
  const bgColor = h('input', { type: 'color', 'aria-label': 'Background color', value: s.bg || '#ffffff' });
  bgKind.value = !s.bg ? 'none' : s.bg === '#ffffff' || s.bg === '#000000' ? s.bg : 'other';
  const imageRows = h('div.so-group', field('Name', name), field('URL', url), field('Target', target), targets, field('Message', message), field('Alt', alt));
  const htmlRows = h('div.so-group', field('Text displayed in cell', html), h('div.so-pair', field('Horizontal', halign), field('Vertical', valign)));
  const sync = () => {
    imageRows.hidden = type.value !== 'image';
    htmlRows.hidden = type.value !== 'noImage';
    bgColor.hidden = bgKind.value !== 'other';
  };
  type.addEventListener('change', sync);
  bgKind.addEventListener('change', sync);
  sync();
  const info = h('p.form-description', `${s.kind === 'object' ? 'Object slice' : 'User slice'} ${String(number).padStart(2, '0')}`);
  const body = h('div.form.slice-options', info, field('Slice Type', type), imageRows, htmlRows, h('div.form-row', h('label', { for: 'so-bg' }, 'Background'), h('div.so-bg', bgKind, bgColor)));
  const res = await openDialog({
    title: 'Slice Options',
    body,
    className: 'slice-options-dialog',
    initialFocus: () => name,
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'OK',
        primary: true,
        value: () => ({
          type: type.value,
          name: name.value.trim(),
          url: url.value.trim(),
          target: target.value.trim(),
          message: message.value,
          alt: alt.value,
          html: html.value,
          align: halign.value,
          valign: valign.value,
          bg: bgKind.value === 'none' ? null : bgKind.value === 'other' ? bgColor.value : bgKind.value,
        }),
      },
    ],
  });
  if (!res) return null;
  doc.transact('Slice Options', () => updateSlice(doc, id, res));
  return res;
}

/** Divide Slices dialog with a live preview. */
async function divideDialog(app, editor) {
  const doc = editor.doc;
  let tx = null;
  const ids = () => targetSlices(editor, { promoteAuto: true });
  const specs = (v) => ({
    down: v.down ? (v.downMode === 'size' ? { size: v.downSize } : { count: v.downCount }) : { count: 1 },
    across: v.across ? (v.acrossMode === 'size' ? { size: v.acrossSize } : { count: v.acrossCount }) : { count: 1 },
  });
  const rollback = () => {
    if (tx) tx.cancel();
    tx = null;
  };
  const preview = (v) => {
    rollback();
    if (!v.preview) return;
    tx = doc.begin('Divide Slices');
    const { across, down } = specs(v);
    divideSlices(doc, ids(), across, down);
  };
  const res = await app.dialogs.form({
    title: 'Divide Slices',
    fields: [
      { key: 'down', label: 'Divide Horizontally Into rows', type: 'checkbox', value: true },
      { key: 'downMode', label: 'Rows', type: 'radio', value: 'count', options: [{ value: 'count', label: 'Slices down, evenly spaced' }, { value: 'size', label: 'Height per slice' }], disabled: (v) => !v.down },
      { key: 'downCount', label: 'Slices down', type: 'number', value: 2, min: 1, max: 100, disabled: (v) => !v.down || v.downMode !== 'count' },
      { key: 'downSize', label: 'Height per slice', type: 'length', value: 50, min: 1, disabled: (v) => !v.down || v.downMode !== 'size' },
      { key: 'across', label: 'Divide Vertically Into columns', type: 'checkbox', value: true },
      { key: 'acrossMode', label: 'Columns', type: 'radio', value: 'count', options: [{ value: 'count', label: 'Slices across, evenly spaced' }, { value: 'size', label: 'Width per slice' }], disabled: (v) => !v.across },
      { key: 'acrossCount', label: 'Slices across', type: 'number', value: 2, min: 1, max: 100, disabled: (v) => !v.across || v.acrossMode !== 'count' },
      { key: 'acrossSize', label: 'Width per slice', type: 'length', value: 50, min: 1, disabled: (v) => !v.across || v.acrossMode !== 'size' },
      { key: 'preview', label: 'Preview', type: 'checkbox', value: false },
    ],
    onChange: preview,
  });
  rollback();
  if (!res) return;
  const { across, down } = specs(res);
  let out = [];
  doc.transact('Divide Slices', () => {
    out = divideSlices(doc, ids(), across, down);
  });
  setSliceSelection(editor, out);
}

function registerCommands(app) {
  const ed = () => app.editor;
  const hasDoc = (a) => Boolean(a.editor);
  const hasSel = (a) => Boolean(a.editor?.selection.size);
  const showSlices = (editor) => !editor.viewOptions.slices && editor.setViewOption('slices', true);
  app.commands.register([
    {
      id: 'slice.make',
      label: 'Make',
      enabled: hasSel,
      run: () => {
        const e = ed();
        let ids = [];
        e.doc.transact('Make Slice', () => {
          ids = makeObjectSlices(e.doc, e.topSelection());
        });
        if (!ids.length) app.notify('The selected objects already have slices.', { polite: true });
        showSlices(e);
        setSliceSelection(e, ids);
      },
    },
    {
      id: 'slice.release',
      label: 'Release',
      enabled: hasTargets,
      run: () => {
        const e = ed();
        const ids = targetSlices(e);
        e.doc.transact('Release Slice', () => removeSlices(e.doc, ids));
        setSliceSelection(e, []);
      },
    },
    {
      id: 'slice.fromGuides',
      label: 'Create from Guides',
      enabled: (a) => Boolean(a.editor?.doc.root.guides?.length),
      run: async (a) => {
        const e = ed();
        const area = e.artboard();
        if (!area) return;
        const replacing = slicesOf(e.doc).some((s) => s.kind === 'user' && sliceRect(e.doc, s));
        if (replacing && !(await a.dialogs.confirm({ title: 'Create from Guides', message: 'Slices made from the guides replace the user slices on the active artboard.', okLabel: 'Create Slices' }))) return;
        let ids = [];
        e.doc.transact('Create Slices from Guides', () => {
          ids = slicesFromGuides(e.doc, area);
        });
        showSlices(e);
        setSliceSelection(e, ids);
      },
    },
    {
      id: 'slice.fromSelection',
      label: 'Create from Selection',
      enabled: hasSel,
      run: () => {
        const e = ed();
        let ids = [];
        e.doc.transact('Create Slices from Selection', () => {
          ids = slicesFromSelection(e.doc, e.topSelection());
        });
        showSlices(e);
        setSliceSelection(e, ids);
      },
    },
    {
      id: 'slice.duplicate',
      label: 'Duplicate Slice',
      enabled: hasTargets,
      run: () => {
        const e = ed();
        let ids = [];
        e.doc.transact('Duplicate Slice', () => {
          ids = duplicateSlices(e.doc, targetSlices(e, { promoteAuto: true }));
        });
        setSliceSelection(e, ids);
      },
    },
    {
      id: 'slice.combine',
      label: 'Combine Slices',
      enabled: (a) => Boolean(a.editor) && selectedSlices(a.editor).size > 1,
      run: () => {
        const e = ed();
        let id = null;
        e.doc.transact('Combine Slices', () => {
          id = combineSlices(e.doc, targetSlices(e, { promoteAuto: true }));
        });
        setSliceSelection(e, id ? [id] : []);
      },
    },
    { id: 'slice.divide', label: 'Divide Slices...', enabled: hasTargets, run: (a) => divideDialog(a, ed()) },
    {
      id: 'slice.deleteAll',
      label: 'Delete All',
      enabled: (a) => Boolean(a.editor && slicesOf(a.editor.doc).length),
      run: () => {
        const e = ed();
        e.doc.transact('Delete All Slices', () => e.doc.updateRoot({ slices: [] }));
        setSliceSelection(e, []);
      },
    },
    {
      id: 'slice.options',
      label: 'Slice Options...',
      enabled: (a) => Boolean(a.editor) && (selectedSlices(a.editor).size === 1 || objectSliceIds(a.editor.doc, a.editor.topSelection()).length === 1),
      run: async (a) => {
        const e = ed();
        let ids = targetSlices(e);
        if (!ids.length) {
          // An auto slice becomes a user slice when it gets options.
          const tx = e.doc.begin('Slice Options');
          ids = targetSlices(e, { promoteAuto: true });
          tx.commit();
          setSliceSelection(e, ids);
        }
        if (ids.length === 1) await sliceOptionsDialog(a, e, ids[0]);
      },
    },
    {
      id: 'slice.clipToArtboard',
      label: 'Clip to Artboard',
      enabled: hasDoc,
      checked: (a) => Boolean(a.editor && clipsToArtboard(a.editor.doc)),
      run: () => {
        const e = ed();
        e.doc.transact('Clip Slices to Artboard', () => e.doc.updateRoot({ sliceClip: !clipsToArtboard(e.doc) }));
      },
    },
    { id: 'view.slices', label: (a) => (a.editor?.viewOptions.slices ? 'Hide Slices' : 'Show Slices'), enabled: hasDoc, checked: (a) => Boolean(a.editor?.viewOptions.slices), run: () => ed().setViewOption('slices', !ed().viewOptions.slices) },
    { id: 'view.lockSlices', label: 'Lock Slices', enabled: hasDoc, checked: (a) => Boolean(a.editor?.viewOptions.lockSlices), run: () => ed().setViewOption('lockSlices', !ed().viewOptions.lockSlices) },
    { id: 'file.saveForWeb', label: 'Save for Web...', shortcut: 'Alt+Shift+Mod+S', enabled: hasDoc, run: async (a) => (await loadWeb()).saveForWebDialog(a, ed()) },
    {
      id: 'file.saveSlices',
      label: 'Save Selected Slices...',
      enabled: (a) => Boolean(a.editor) && selectedSlices(a.editor).size > 0,
      run: async (a) => (await loadWeb()).saveSelectedSlices(a, ed()),
    },
  ]);
  // Delete removes selected slices while the Slice Selection tool is active.
  const clear = app.commands.get('edit.clear');
  if (clear) {
    app.commands.register({
      ...clear,
      enabled: (a, args) => (a.toolId === 'slice-select' && a.editor && selectedStored(a.editor).length > 0) || (clear.enabled ? clear.enabled(a, args) : true),
      run: (a, args) => (a.toolId === 'slice-select' && a.editor && selectedStored(a.editor).length && !a.editor.viewOptions.lockSlices ? deleteSelectedSlices(a.editor) : clear.run(a, args)),
    });
  }
}

export function install(app) {
  app.registerTool(SliceTool);
  app.registerTool(SliceSelectTool);
  registerCommands(app);
  overlayHooks.add((ctx, editor) => drawSliceOverlay(ctx, editor));
  app.slices = { add: addSlice, table: (editor) => tableOf(editor) };
}
