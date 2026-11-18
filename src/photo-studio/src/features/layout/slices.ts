// Slices: View → Show/Lock/Clear Slices, Snap To → Slices, layer-based
// slices, slice options, promotion, division and Export for Web.
import type { Editor } from '../../editor';
import { contributeMenu, registerCommand, registerOverlay } from '../../app/registry';
import { snapProviders } from '../../model/transform';
import { MAX_SLICE_NAME, MAX_SLICES, sliceRect, type Slice, type SliceFormat } from '../../model/slices';
import { formDialog } from '../../ui/dialog';
import { escapeXML } from '../../model/assets';
import { modal, fieldValue } from '../files/ui';
import { addSlice, installSliceTools, newSliceId, selectedSlices, showSlices, sliceState, slicesLocked, slicesOverlay } from './slice-tools';
import { lazy, lazyRun } from '../../app/lazy';

const webExport = lazy(() => import('./export-web'));

const formatLabels: [SliceFormat | '', string][] = [['', 'Export default'], ['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['gif', 'GIF']];

async function sliceOptions(e: Editor) {
  const s = selectedSlices(e)[0];
  if (!s) return;
  const quality = s.quality ?? (s.format === 'gif' ? 256 : 80);
  const result = await modal({
    title: 'Slice Options',
    submit: 'OK',
    className: 'slice-options-dialog',
    body: `<label class="dialog-field">Name<input name="name" type="text" maxlength="256" value="${escapeXML(s.name ?? '')}" placeholder="Numbered automatically"></label>
      <label class="dialog-field">Format<select name="format">${formatLabels.map(([v, l]) => `<option value="${v}" ${(s.format ?? '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="dialog-field" data-q>Quality<input name="quality" type="number" min="1" max="100" step="1" value="${Math.min(100, quality)}"></label>
      <label class="dialog-field" data-c>Colors<input name="colors" type="number" min="2" max="256" step="1" value="${s.format === 'gif' ? quality : 256}"></label>
      <p class="muted slice-options-note">${s.layerId ? 'This slice follows the bounds of its layer.' : `${sliceRect(e.doc, s)?.width ?? 0} × ${sliceRect(e.doc, s)?.height ?? 0} px at ${s.rect.x}, ${s.rect.y}`}</p>`,
    bind: (dialog) => {
      const f = dialog.querySelector<HTMLSelectElement>('[name=format]')!;
      const sync = () => {
        dialog.querySelector<HTMLElement>('[data-q]')!.hidden = !['jpeg', 'webp'].includes(f.value);
        dialog.querySelector<HTMLElement>('[data-c]')!.hidden = f.value !== 'gif';
      };
      f.addEventListener('change', sync);
      sync();
    },
  });
  if (!result) return;
  const name = fieldValue(result.form, 'name').trim();
  const format = fieldValue(result.form, 'format') as SliceFormat | '';
  const q = format === 'gif' ? Number(fieldValue(result.form, 'colors')) : Number(fieldValue(result.form, 'quality'));
  result.close();
  e.command('Slice Options', (d) => {
    d.slices = (d.slices ?? []).map((x) => {
      if (x.id !== s.id) return x;
      const next: Slice = { ...x };
      if (name) next.name = name;
      else delete next.name;
      if (format) next.format = format;
      else delete next.format;
      if (format && format !== 'png' && Number.isFinite(q)) next.quality = Math.max(format === 'gif' ? 2 : 1, Math.min(format === 'gif' ? 256 : 100, Math.round(q)));
      else delete next.quality;
      return next;
    });
  });
}

function promote(e: Editor) {
  if (slicesLocked(e)) return;
  if (sliceState.auto) {
    const rect = sliceState.auto;
    sliceState.auto = undefined;
    addSlice(e, rect, 'Promote Slice');
    return;
  }
  const layered = selectedSlices(e).filter((s) => s.layerId);
  if (!layered.length) return;
  const rects = new Map(layered.map((s) => [s.id, sliceRect(e.doc, s)]));
  e.command('Promote Slice', (d) => {
    d.slices = (d.slices ?? []).flatMap((s) => {
      if (!rects.has(s.id)) return [s];
      const r = rects.get(s.id);
      if (!r) return [];
      const next: Slice = { ...s, rect: r };
      delete next.layerId;
      return [next];
    });
  });
  e.options();
}

function deleteSelected(e: Editor) {
  if (slicesLocked(e)) return;
  const ids = new Set(sliceState.selected);
  if (!ids.size) return;
  e.command(ids.size > 1 ? 'Delete Slices' : 'Delete Slice', (d) => {
    d.slices = (d.slices ?? []).filter((s) => !ids.has(s.id));
    if (!d.slices.length) delete d.slices;
  });
  sliceState.selected = new Set();
  e.options();
}

async function divide(e: Editor) {
  if (slicesLocked(e)) return;
  const s = selectedSlices(e)[0];
  const r = s && !s.layerId ? sliceRect(e.doc, s) : undefined;
  if (!s || !r) return;
  // The parts replace the slice; the document keeps at most MAX_SLICES.
  const room = MAX_SLICES - (e.doc.slices?.length ?? 0) + 1;
  if (room < 2) {
    e.message(`This document already has ${MAX_SLICES} slices, the most it can hold.`);
    return;
  }
  const v = await formDialog('Divide Slice', [
    { name: 'cols', label: 'Columns', value: 2, type: 'number', min: 1, max: Math.min(64, r.width, room), step: 1 },
    { name: 'rows', label: 'Rows', value: 1, type: 'number', min: 1, max: Math.min(64, r.height, room), step: 1 },
  ], 'Divide', `Split the ${r.width} × ${r.height} px slice into equal parts.\n\nColumns × rows can be at most ${room} (a document holds up to ${MAX_SLICES} slices).`);
  if (!v) return;
  const cols = Math.max(1, Math.min(64, r.width, Math.round(Number(v.cols)) || 1)),
    rows = Math.max(1, Math.min(64, r.height, Math.round(Number(v.rows)) || 1));
  if (cols * rows < 2) return;
  if (cols * rows > room) {
    e.message(`${cols} × ${rows} would make ${cols * rows} slices; at most ${room} fit (a document holds up to ${MAX_SLICES}).`);
    return;
  }
  const parts: Slice[] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x0 = r.x + Math.round((r.width * i) / cols),
        x1 = r.x + Math.round((r.width * (i + 1)) / cols);
      const y0 = r.y + Math.round((r.height * j) / rows),
        y1 = r.y + Math.round((r.height * (j + 1)) / rows);
      const { id: _id, name, ...rest } = s;
      // Numbered names stay within the name limit.
      const suffix = `_${parts.length + 1}`;
      parts.push({ ...rest, id: newSliceId(), ...(name ? { name: name.slice(0, MAX_SLICE_NAME - suffix.length) + suffix } : {}), rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    }
  e.command('Divide Slice', (d) => {
    const list = d.slices ?? [];
    const i = list.findIndex((x) => x.id === s.id);
    d.slices = [...list.slice(0, i), ...parts, ...list.slice(i + 1)];
  });
  sliceState.selected = new Set(parts.map((p) => p.id));
  e.options();
}

/** User slices for every cell of the guide grid. */
export function guideCells(width: number, height: number, guides: { orientation: 'horizontal' | 'vertical'; position: number }[]) {
  const cut = (o: 'horizontal' | 'vertical', max: number) =>
    [...new Set([0, max, ...guides.filter((g) => g.orientation === o).map((g) => Math.round(g.position)).filter((p) => p > 0 && p < max)])].sort((a, b) => a - b);
  const xs = cut('vertical', width),
    ys = cut('horizontal', height);
  const cells = [];
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < xs.length - 1; i++) cells.push({ x: xs[i], y: ys[j], width: xs[i + 1] - xs[i], height: ys[j + 1] - ys[j] });
  return cells;
}
async function fromGuides(e: Editor) {
  if (slicesLocked(e)) return;
  const guides = e.doc.guides ?? [];
  if (!guides.length) {
    e.message('Add guides first; each cell between them becomes a slice.');
    return;
  }
  const users = (e.doc.slices ?? []).filter((s) => !s.layerId);
  if (users.length && !(await formDialog('Slices From Guides', [], 'Replace', `This replaces the ${users.length} existing user slice${users.length > 1 ? 's' : ''}.`))) return;
  const cells = guideCells(e.doc.width, e.doc.height, guides);
  const kept = (e.doc.slices ?? []).filter((s) => s.layerId).length;
  if (kept + cells.length > MAX_SLICES) {
    e.message(`The guides make ${cells.length} cells; a document holds up to ${MAX_SLICES} slices. Remove some guides first.`);
    return;
  }
  const fresh = cells.map((rect) => ({ id: newSliceId(), rect }));
  e.command('Slices From Guides', (d) => {
    d.slices = [...(d.slices ?? []).filter((s) => s.layerId), ...fresh];
  });
  sliceState.selected = new Set();
  sliceState.auto = undefined;
  showSlices(e);
  e.options();
}

export function installSlices(e: Editor) {
  installSliceTools(e);
  registerOverlay('slices', slicesOverlay);
  snapProviders.push((doc) => {
    if (!e.preferences.showSlices || e.preferences.snapSlices === false || !doc.slices?.length) return { x: [], y: [] };
    const x: number[] = [],
      y: number[] = [];
    for (const s of doc.slices) {
      const r = sliceRect(doc, s);
      if (r) {
        x.push(r.x, r.x + r.width);
        y.push(r.y, r.y + r.height);
      }
    }
    return { x, y };
  });
  const toggle = (key: 'showSlices' | 'lockSlices') => (ed: Editor) => {
    ed.preferences[key] = !ed.preferences[key];
    ed.savePreferences();
    ed.options();
    ed.overlay();
  };
  registerCommand(
    { id: 'view.show-slices', label: 'Slices', checked: (ed) => !!ed.preferences.showSlices, run: toggle('showSlices'), recordable: false, description: 'Show user, layer-based and automatic slices' },
    { id: 'view.lock-slices', label: 'Lock Slices', checked: (ed) => !!ed.preferences.lockSlices, run: toggle('lockSlices'), recordable: false },
    {
      id: 'view.snap-slices',
      label: 'Slices',
      checked: (ed) => ed.preferences.snapSlices !== false,
      run: (ed) => {
        ed.preferences.snapSlices = ed.preferences.snapSlices === false;
        ed.savePreferences();
      },
      recordable: false,
      description: 'Snap layers and slices to slice edges',
    },
    {
      id: 'view.clear-slices',
      label: 'Clear Slices',
      enabled: (ed) => ed.hasDocument && !!ed.doc.slices?.length,
      run: (ed) => {
        if (slicesLocked(ed)) return;
        ed.command('Clear Slices', (d) => delete d.slices);
        sliceState.selected = new Set();
        sliceState.auto = undefined;
        ed.options();
      },
    },
    {
      id: 'layer.new-layer-slice',
      label: 'New Layer Based Slice',
      enabled: (ed) => ed.hasDocument && ed.selectedIds.size === 1 && !!ed.layer && ed.layer.kind !== 'adjustment',
      run: (ed) => {
        if (slicesLocked(ed)) return;
        const l = ed.layer!;
        const id = newSliceId();
        const s: Slice = { id, layerId: l.id, rect: { x: 0, y: 0, width: 0, height: 0 } };
        if (!sliceRect(ed.doc, s)) {
          ed.message('The layer has no visible area on the canvas.');
          return;
        }
        const list = ed.doc.slices ?? [];
        if (list.length >= MAX_SLICES && !list.some((x) => x.layerId === l.id)) {
          ed.message(`This document already has ${MAX_SLICES} slices, the most it can hold.`);
          return;
        }
        ed.command('New Layer Based Slice', (d) => {
          d.slices = [...(d.slices ?? []).filter((x) => x.layerId !== l.id), s];
        });
        sliceState.selected = new Set([id]);
        showSlices(ed);
        ed.overlay();
      },
      description: 'A slice that follows the bounds of the selected layer',
    },
    { id: 'slices.options', label: 'Slice Options…', enabled: (ed) => selectedSlices(ed).length === 1, run: sliceOptions },
    { id: 'slices.promote', label: 'Promote Slice', enabled: (ed) => !!sliceState.auto || selectedSlices(ed).some((s) => s.layerId), run: promote },
    { id: 'slices.delete', label: 'Delete Slice', enabled: (ed) => selectedSlices(ed).length > 0, run: deleteSelected },
    { id: 'slices.divide', label: 'Divide Slice…', enabled: (ed) => selectedSlices(ed).length === 1 && !selectedSlices(ed)[0].layerId, run: divide },
    { id: 'slices.from-guides', label: 'Slices From Guides', enabled: (ed) => ed.hasDocument && !!ed.doc.guides?.length, run: fromGuides, description: 'Create a user slice for each cell between the guides' },
    { id: 'file.export-web', label: 'Export for Web…', shortcut: 'Mod+Alt+Shift+S', enabled: (ed) => ed.hasDocument, ...lazyRun(webExport, (m, e) => m.exportForWeb(e)), recordable: false, description: 'Optimized images per slice with side-by-side previews, as a ZIP with an optional HTML table' },
  );
  contributeMenu('view.snap-to', ['view.snap-slices'], 'view.snap-layers');
  contributeMenu('file.export', ['file.export-web'], 'file.export-as');
}
