// Filter → Portrait & Restore…: a workspace that stacks skin smoothing, JPEG
// cleanup, photo restoration, colorizing, color transfer, depth blur, style
// transfer and scene changes in one pass. A filter list (with on/off
// switches) sits on the left, the selected filter's controls on the right and
// a large before/after preview in the middle; previews render progressively
// in a worker. Results go to the current layer, a new layer (optionally
// masked to the affected area), a new document or an editable Live Filter.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { containerOf, findLayer, type Layer } from '../../model/document';
import { newPixelLayer, setLayerPixels } from '../../model/pixel-layer';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { emptyGrid, gridFromImage, readMask, readRGBA, writeRect, type TileGrid } from '../../model/tiles';
import { svg } from '../../app/icons';
import type { Mask8, ParamValues, RGBA8 } from '../../imaging/types';
import { GROUPS, RESTORE_FILTERS, filterDef, isDeterministic, needsPixels, normalizeRestore, replayable, defaultParams, type RestoreEntry, type RestoreFilterId, type RestoreParams } from '../../imaging/restore/defs';
import { RESTORE_ID, RESTORE_LABEL } from '../../imaging/restore/id';
import { transferStats } from '../../imaging/restore/transfer';
import { estimateGrid } from '../../imaging/restore/deblock';
import { labToRgb8 } from '../../imaging/restore/util';
import { paramForm } from '../filters/form';
import { applyDirect } from '../filters/apply';
import { isLiveLayer } from '../filters/state';
import { convertForLiveFilters, renderLive, updateLive } from '../filters/live';
import { recordStep } from '../filters/record';
import { layerRGBA, pixelTarget, rgbHex, type PixelTarget } from '../pixels';
import { loadImage, openDocument, imageLayer } from '../compositing/sources';
import { openWorkspace } from '../retouch/workspace';
import { RestoreClient, isCancel, type RunResult } from './client';
import { CompareView, type CompareMode } from './view';
import { aiInstruction, aiSummary, runAI } from './ai';
import { OUTPUTS, deletePreset, exportPresets, importPresets, loadLast, loadPresets, saveLast, savePreset, storable, type OutputKind } from './settings';
import './restore.css';

export type RestoreDialogOptions = { edit?: { layerId: string; index: number } };

type Source = { image: RGBA8; selection?: Mask8; target?: PixelTarget & { kind: 'pixels' }; layer: Layer; edit?: { layerId: string; index: number } };

/** Pixels the workspace filters: the target layer within the canvas. */
async function prepare(e: Editor, opts: RestoreDialogOptions): Promise<Source | undefined> {
  const rect = canvasRect(e.doc), store = e.assets.tiles;
  if (opts.edit) {
    const l = findLayer(e.doc.layers, opts.edit.layerId);
    if (!isLiveLayer(l) || l.liveFilters[opts.edit.index]?.id !== RESTORE_ID) return;
    // The filter sees the result of the Live Filters below it.
    let grid: TileGrid | undefined = l.liveSource;
    const below = l.liveFilters.slice(0, opts.edit.index);
    if (below.some((f) => f.enabled)) grid = await renderLive(e, l, below, undefined, 'Preparing preview');
    if (!grid) return;
    return { image: readRGBA(store, grid, rect), layer: l, edit: opts.edit };
  }
  e.transform.apply();
  const target = await pixelTarget(e, { create: false, allowMask: false });
  if (!target) return;
  if (target.kind !== 'pixels') {
    e.message('Portrait & Restore works on the pixels of a layer. Select a pixel layer.');
    return;
  }
  const image = readRGBA(store, target.grid, rect);
  if (!image.data.some((v, i) => (i & 3) === 3 && v > 0)) {
    e.message('The layer is empty.');
    return;
  }
  const sel = selectionGrid(e.doc, store);
  const selB = sel ? selectionBounds(e.doc, sel) : null;
  if (sel && !selB) {
    e.message('No pixels are selected.');
    return;
  }
  return { image, selection: sel && selB ? readMask(store, sel, rect) : undefined, target, layer: target.layer };
}

const levelFor = (w: number, h: number, maxSide: number) => {
  let k = 0;
  while (Math.max(w, h) / 2 ** k > maxSide && k < 12) k++;
  return k;
};
const labHex = (lab: number[]) => {
  const o = [0, 0, 0];
  labToRgb8(lab[0], lab[1], lab[2], o);
  return rgbHex(o[0], o[1], o[2]);
};

export async function openRestore(e: Editor, opts: RestoreDialogOptions = {}): Promise<boolean> {
  const prepared = await prepare(e, opts);
  if (!prepared) return false;
  const src: Source = prepared;
  const W = src.image.width, H = src.image.height;
  const remembered = loadLast();
  let params: RestoreParams = remembered.params;
  if (src.edit) {
    const l = findLayer(e.doc.layers, src.edit.layerId);
    params = normalizeRestore(isLiveLayer(l) ? l.liveFilters[src.edit.index].params : undefined);
  }
  let selected: RestoreFilterId = src.edit ? (params.filters.find((f) => f.enabled)?.id ?? 'skin') : remembered.selected;
  let output: OutputKind = remembered.output;
  let depthChannel = remembered.depthChannel;
  let showOverlay = false;
  let hintColor = '#c06040';
  const aux = new Map<string, RGBA8>();
  let auxCount = 0;
  const entry = (id: RestoreFilterId) => params.filters.find((f) => f.id === id)!;

  const ws = openWorkspace(
    src.edit ? `${RESTORE_LABEL} (Live Filter)` : RESTORE_LABEL,
    'pr-workspace',
    `<div class="pr-body">
  <nav class="pr-list" aria-label="Filters"></nav>
  <section class="pr-stage" aria-label="Preview">
    <div class="pr-toolbar" role="toolbar" aria-label="Preview">
      <div class="pr-modes" role="radiogroup" aria-label="Compare">
        <button type="button" class="icon-button" data-mode="split" role="radio" aria-label="Split view" title="Split view: drag the divider to compare">${svg('compare-split', 16)}</button>
        <button type="button" class="icon-button" data-mode="side" role="radio" aria-label="Side by side" title="Side by side">${svg('compare-side', 16)}</button>
        <button type="button" class="icon-button" data-mode="after" role="radio" aria-label="Result only" title="Result only">${svg('image', 16)}</button>
      </div>
      <button type="button" class="pr-hold" title="Hold to show the original (or hold the \\ key)">${svg('eye', 14)} Hold to Compare</button>
      <span class="rw-spacer"></span>
      <span class="pr-busy" hidden><progress max="1" value="0" aria-label="Rendering"></progress><span class="pr-busy-text"></span><button type="button" class="pr-stop">Stop</button></span>
      <button type="button" class="icon-button" data-zoom="-1" title="Zoom out" aria-label="Zoom out">${svg('zoom-out', 16)}</button>
      <span class="pr-zoom" aria-live="polite">100%</span>
      <button type="button" class="icon-button" data-zoom="1" title="Zoom in" aria-label="Zoom in">${svg('zoom-in', 16)}</button>
      <button type="button" class="pr-fit" title="Fit in view">Fit</button>
      <button type="button" class="pr-actual" title="Actual pixels">100%</button>
    </div>
    <div class="pr-view"></div>
  </section>
  <aside class="pr-side">
    <div class="pr-controls"></div>
    <section class="pr-output" aria-label="Output"></section>
  </aside>
</div>
<footer class="rw-footer">
  <details class="pr-presets"><summary>Presets</summary><div class="pr-presets-menu"></div></details>
  <button type="button" class="pr-reset-all" title="Turn every filter off and restore default settings">Reset All</button>
  <span class="rw-spacer"></span>
  <span class="pr-status" role="status" aria-live="polite"></span>
  <button type="button" class="pr-cancel">Cancel</button>
  <button type="button" class="primary pr-ok">OK</button>
</footer>`,
  );
  const q = ws.q;
  const list = q('.pr-list'), controls = q('.pr-controls'), outputBox = q('.pr-output');
  const statusEl = q('.pr-status'), busyEl = q('.pr-busy'), busyText = q('.pr-busy-text'), zoomEl = q('.pr-zoom');
  const okBtn = q<HTMLButtonElement>('.pr-ok');
  const view = new CompareView(q('.pr-view'), W, H);
  view.mode = 'split';
  view.onZoom = (z) => {
    zoomEl.textContent = `${Math.round(z * 1000) / 10}%`;
    maybeFull();
    updateBefore();
  };
  zoomEl.textContent = `${Math.round(view.zoom * 1000) / 10}%`;
  const preview = new RestoreClient('preview'), full = new RestoreClient('full');
  preview.load(src.image, src.selection);
  full.load(src.image, src.selection);

  const say = (t: string) => (statusEl.textContent = t);
  const busy = (label: string | null, f = 0) => {
    busyEl.hidden = !label;
    if (label) {
      busyText.textContent = label;
      busyEl.querySelector('progress')!.value = f;
    }
  };

  // ----- Filter list -----
  const renderList = () => {
    list.innerHTML = GROUPS.map((g) => {
      const items = RESTORE_FILTERS.filter((f) => f.group === g)
        .map((f) => {
          const en = entry(f.id).enabled;
          const ai = f.id === 'scene' ? 'AI' : f.id === 'colorize' || f.id === 'style' ? 'AI option' : '';
          return `<div class="pr-item ${f.id === selected ? 'selected' : ''}" data-filter="${f.id}"><input type="checkbox" class="pr-toggle" data-toggle="${f.id}" ${en ? 'checked' : ''} aria-label="Use ${escapeXML(f.label)}"><button type="button" class="pr-name" data-select="${f.id}" aria-pressed="${f.id === selected}">${escapeXML(f.label)}</button>${ai ? `<span class="pr-badge" title="${ai === 'AI' ? 'Uses Puter AI' : 'Has an optional Puter AI mode'}">AI</span>` : ''}</div>`;
        })
        .join('');
      return `<div class="pr-group" role="group" aria-label="${g}"><h3>${g}</h3>${items}</div>`;
    }).join('') + `<p class="pr-order">Filters run from restoration to portrait, color and creative ones.</p>`;
  };
  list.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const id = t.dataset.toggle as RestoreFilterId | undefined;
    if (!id) return;
    entry(id).enabled = t.checked;
    if (id === selected) renderControls();
    changed();
  });
  list.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (!b) return;
    selected = b.dataset.select as RestoreFilterId;
    renderList();
    renderControls();
    changed();
  });

  // ----- Controls of the selected filter -----
  let form: { set: (v: ParamValues) => void } | undefined;
  const visibleKeys = (en: RestoreEntry) => {
    const def = filterDef(en.id)!;
    return def.params
      .map((p) => p.key)
      .filter((k) => {
        if (en.id === 'style' && k === 'brush') return en.params.style !== 'ai';
        if (en.id === 'depth' && k === 'subject') return en.params.source !== 'layer';
        return true;
      });
  };
  const aiNotice = (what: string) =>
    `<div class="ai-notice pr-ai-notice" role="note"><strong>Uses your Puter account</strong><p>${escapeXML(what)} This needs a Puter account (you may be asked to sign in) and can use credits from your Puter balance. Nothing is sent until you press the button.</p></div>`;
  const sendNote = `The layer’s pixels (reduced to at most 1024 pixels on the longer side) and the instruction are sent to Puter’s AI service.`;
  const sourceOptions = (current: string, withNone: string) => {
    const docs = e.sessions.filter((s) => s.hasDocument && s !== e.session);
    const layers: Layer[] = [];
    const walk = (ls: Layer[]) => ls.forEach((l) => (l.kind === 'group' ? walk(l.children) : l.kind !== 'adjustment' && layers.push(l)));
    walk(e.doc.layers);
    return `<option value="">${escapeXML(withNone)}</option>${docs.length ? `<optgroup label="Open documents">${docs.map((s, i) => `<option value="doc:${i}" ${current === `doc:${i}` ? 'selected' : ''}>${escapeXML(s.doc.name)}</option>`).join('')}</optgroup>` : ''}<optgroup label="Layers">${[...layers]
      .reverse()
      .map((l) => `<option value="layer:${l.id}" ${current === `layer:${l.id}` ? 'selected' : ''}>${escapeXML(l.name)}</option>`)
      .join('')}</optgroup>${(e.doc.channels ?? []).length ? `<optgroup label="Channels">${(e.doc.channels ?? []).map((c) => `<option value="channel:${c.id}" ${current === `channel:${c.id}` ? 'selected' : ''}>${escapeXML(c.name)}</option>`).join('')}</optgroup>` : ''}<option value="file">Choose a file…</option>`;
  };
  /** Pixels of a source chosen in a picker (document, layer, channel or file). */
  const pickImage = async (value: string): Promise<{ image: RGBA8; name: string } | undefined> => {
    if (value.startsWith('doc:')) {
      const s = e.sessions.filter((x) => x.hasDocument && x !== e.session)[Number(value.slice(4))];
      if (!s) return;
      return { image: await loadImage(e, { name: s.doc.name, session: s }), name: s.doc.name };
    }
    if (value.startsWith('layer:')) {
      const l = findLayer(e.doc.layers, value.slice(6));
      if (!l) return;
      return { image: await layerRGBA(e, l), name: l.name };
    }
    if (value.startsWith('channel:')) {
      const c = e.doc.channels?.find((x) => x.id === value.slice(8));
      if (!c) return;
      const m = readMask(e.assets.tiles, c.grid, canvasRect(e.doc));
      const data = new Uint8ClampedArray(m.data.length * 4);
      for (let i = 0; i < m.data.length; i++) data.set([m.data[i], m.data[i], m.data[i], 255], i * 4);
      return { image: { width: m.width, height: m.height, data }, name: c.name };
    }
    if (value === 'file') {
      const file = await new Promise<File | undefined>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*,.tif,.tiff,.psd,.bmp,.tga';
        input.onchange = () => resolve(input.files?.[0]);
        input.addEventListener('cancel', () => resolve(undefined));
        input.click();
      });
      if (!file) return;
      return { image: await loadImage(e, { name: file.name, blob: file }), name: file.name };
    }
  };
  const setAux = (en: RestoreEntry, image: RGBA8 | null) => {
    if (en.aux) {
      aux.delete(en.aux);
      preview.setAux(en.aux, null);
      full.setAux(en.aux, null);
    }
    if (!image) {
      delete en.aux;
      return;
    }
    const name = `${en.id}-${++auxCount}`;
    aux.set(name, image);
    preview.setAux(name, image);
    full.setAux(name, image);
    en.aux = name;
  };
  // AI requests per filter, so Cancel and Stop can abandon them.
  const aiRuns = new Map<RestoreFilterId, AbortController>();
  const aiStatus = new Map<RestoreFilterId, string>();
  const styleRefs: { image?: RGBA8; name?: string } = {};

  // Blocking measured once on a central crop aligned to the 8x8 grid.
  let jpegInfo: string | undefined;
  const jpegEstimate = () => {
    if (jpegInfo) return jpegInfo;
    const cw = Math.max(16, Math.min(W, 1024) & ~7), ch = Math.max(16, Math.min(H, 1024) & ~7);
    const x0 = Math.max(0, ((W - cw) >> 1) & ~7), y0 = Math.max(0, ((H - ch) >> 1) & ~7);
    const cwr = Math.min(cw, W - x0), chr = Math.min(ch, H - y0);
    const Y = new Float32Array(cwr * chr), d = src.image.data;
    for (let y = 0; y < chr; y++)
      for (let x = 0; x < cwr; x++) {
        const j = ((y + y0) * W + x + x0) * 4;
        Y[y * cwr + x] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      }
    const g = estimateGrid(Y, cwr, chr);
    jpegInfo = g.blockiness < 1.08 ? 'No visible compression blocks were found.' : `${g.blockiness < 1.3 ? 'Mild' : 'Strong'} compression blocking found${g.px || g.py ? ` (block grid offset by ${g.px}, ${g.py} pixels)` : ''}.`;
    return jpegInfo;
  };
  const extras = (en: RestoreEntry): string => {
    switch (en.id) {
      case 'jpeg':
        return `<p class="pr-note">${escapeXML(jpegEstimate())} Automatic strength follows it. Compare at 100% zoom: block edges are too small to see when zoomed out.</p>`;
      case 'colorize': {
        const n = en.hints?.length ?? 0;
        const ai = en.params.source === 'ai';
        return `<div class="pr-hints"><label class="pr-row"><span>Hint Color</span><input type="color" class="pr-hint-color" value="${hintColor}" aria-label="Hint color"></label>
<p class="pr-note">Click the preview to add a color hint; click a hint to select it, Alt-click to remove it.</p>
<div class="pr-row pr-buttons"><span class="pr-count">${n} hint${n === 1 ? '' : 's'}</span><button type="button" data-act="hint-remove" ${view.selectedHint < 0 ? 'disabled' : ''}>Remove Hint</button><button type="button" data-act="hint-clear" ${n ? '' : 'disabled'}>Clear</button></div></div>
${ai ? `${aiNotice(sendNote)}<div class="pr-row pr-buttons"><button type="button" data-act="ai" class="pr-ai-go">${svg('sparkles', 14)} ${en.aux ? 'Suggest Again' : 'Suggest Colors'}</button></div><p class="pr-ai-status" role="status">${escapeXML(aiStatus.get('colorize') ?? (en.aux ? 'AI colors are applied; hints refine them.' : 'Press Suggest Colors to get AI colors.'))}</p>` : ''}`;
      }
      case 'transfer': {
        const ref = en.reference;
        const sw = ref ? ref.bands.map((b) => `<span class="pr-swatch" style="background:${labHex(b.mean)}"></span>`).join('') : '';
        return `<label class="pr-row pr-col"><span>Reference</span><select class="pr-ref" aria-label="Color reference">${sourceOptions('', ref ? 'Choose another reference…' : 'Choose a reference…')}</select></label>
<p class="pr-note">${ref ? `Look of <strong>${escapeXML(en.referenceName ?? 'Reference')}</strong> <span class="pr-swatches" title="Shadows, midtones and highlights">${sw}</span>` : 'Pick an open document, a layer or a file whose colors to take.'}</p>`;
      }
      case 'depth': {
        const layerMode = en.params.source === 'layer';
        return `${layerMode ? `<label class="pr-row pr-col"><span>Depth Source</span><select class="pr-depth-src" aria-label="Depth source">${sourceOptions('', en.aux ? 'Keep the current depth source' : 'Choose a layer or channel…')}</select></label><p class="pr-note">${en.aux ? 'White is near unless Invert Depth is on.' : 'Choose where the depth map comes from.'}</p>` : ''}
<p class="pr-note">Click the preview to focus on that point.</p>
${src.edit ? '' : `<label class="pr-row pr-check"><input type="checkbox" class="pr-depth-channel" ${depthChannel ? 'checked' : ''}> Save the depth map as a channel</label>`}`;
      }
      case 'style': {
        if (en.params.style !== 'ai') return '';
        return `<label class="pr-row pr-col"><span>Describe the Style</span><textarea class="pr-prompt" rows="3" placeholder="e.g. “a loose oil painting with thick brush strokes”">${escapeXML(en.prompt ?? '')}</textarea></label>
<label class="pr-row pr-col"><span>Style Reference (optional)</span><select class="pr-style-ref" aria-label="Style reference">${sourceOptions('', styleRefs.name ? `Keep “${styleRefs.name}”` : 'No reference image')}</select></label>${styleRefs.name ? `<div class="pr-row pr-buttons"><button type="button" data-act="style-ref-clear">Remove Reference</button></div>` : ''}
${aiNotice(`${sendNote}${styleRefs.name ? ' The reference image is sent too.' : ''}`)}
<div class="pr-row pr-buttons"><button type="button" data-act="ai" class="pr-ai-go">${svg('sparkles', 14)} ${en.aux ? 'Generate Again' : 'Generate Style'}</button></div><p class="pr-ai-status" role="status">${escapeXML(aiStatus.get('style') ?? (en.aux ? 'The AI style is applied; Strength blends it.' : 'Press Generate Style to create it.'))}</p>`;
      }
      case 'scene':
        return `${en.params.preset === 'custom' ? `<label class="pr-row pr-col"><span>Describe the Change</span><textarea class="pr-prompt" rows="3" placeholder="e.g. “a misty morning after rain”">${escapeXML(en.prompt ?? '')}</textarea></label>` : ''}
${aiNotice(sendNote)}
<div class="pr-row pr-buttons"><button type="button" data-act="ai" class="pr-ai-go">${svg('sparkles', 14)} ${en.aux ? 'Generate Again' : 'Generate'}</button></div><p class="pr-ai-status" role="status">${escapeXML(aiStatus.get('scene') ?? (en.aux ? 'The changed scene is applied.' : 'Press Generate to change the scene.'))}</p>`;
      default:
        return '';
    }
  };
  const renderControls = () => {
    const en = entry(selected), def = filterDef(selected)!;
    controls.innerHTML = `<header class="pr-head"><h3>${escapeXML(def.label)}</h3><label class="pr-switch"><input type="checkbox" class="pr-enable" ${en.enabled ? 'checked' : ''}> On</label></header>
<p class="pr-desc">${escapeXML(def.description)}</p>
<div class="pr-form"></div>
<div class="pr-extra">${extras(en)}</div>
${def.overlay ? `<label class="pr-row pr-check"><input type="checkbox" class="pr-overlay" ${showOverlay ? 'checked' : ''}> Show ${escapeXML(def.overlay.toLowerCase())}</label>` : ''}
<div class="pr-row pr-buttons"><button type="button" data-act="reset-filter">Reset ${escapeXML(def.label)}</button></div>`;
    const host = controls.querySelector<HTMLElement>('.pr-form')!;
    form = paramForm(host, def.params, en.params, (v) => {
      const relayout = (en.id === 'style' && 'style' in v && v.style !== en.params.style) || ('source' in v && v.source !== en.params.source) || (en.id === 'scene' && 'preset' in v && v.preset !== en.params.preset);
      en.params = { ...en.params, ...v };
      // Hint Size also resizes the selected hint.
      const hint = en.id === 'colorize' && 'radius' in v ? en.hints?.[view.selectedHint] : undefined;
      if (hint) hint.radius = v.radius as number;
      if (!en.enabled) {
        en.enabled = true;
        renderList();
        controls.querySelector<HTMLInputElement>('.pr-enable')!.checked = true;
      }
      if (relayout) renderControls();
      changed();
    }, { keys: visibleKeys(en) });
    view.hints = selected === 'colorize' ? (en.hints ?? []) : [];
    if (selected !== 'colorize') view.selectedHint = -1;
    view.focus = selected === 'depth' ? focusPoint : undefined;
    view.draw();
  };
  let focusPoint: { x: number; y: number } | undefined;

  controls.addEventListener('change', async (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    const en = entry(selected);
    if (t.classList.contains('pr-enable')) {
      en.enabled = (t as HTMLInputElement).checked;
      renderList();
      changed();
    } else if (t.classList.contains('pr-overlay')) {
      showOverlay = (t as HTMLInputElement).checked;
      changed();
    } else if (t.classList.contains('pr-hint-color')) {
      hintColor = t.value;
      const h = en.hints?.[view.selectedHint];
      if (h) {
        h.color = hintColor;
        changed();
      }
    } else if (t.classList.contains('pr-depth-channel')) depthChannel = (t as HTMLInputElement).checked;
    else if (t.classList.contains('pr-ref') || t.classList.contains('pr-depth-src') || t.classList.contains('pr-style-ref')) {
      const value = t.value;
      if (!value) return;
      try {
        say('Loading…');
        const got = await pickImage(value);
        say('');
        if (!got) {
          (t as HTMLSelectElement).value = '';
          return;
        }
        if (t.classList.contains('pr-ref')) {
          en.reference = transferStats(got.image);
          en.referenceName = got.name;
          en.enabled = true;
        } else if (t.classList.contains('pr-depth-src')) {
          setAux(en, got.image);
          en.enabled = true;
        } else {
          styleRefs.image = got.image;
          styleRefs.name = got.name;
        }
        renderList();
        renderControls();
        changed();
      } catch (error) {
        say(error instanceof Error ? error.message : String(error));
      }
    }
  });
  controls.addEventListener('input', (ev) => {
    const t = ev.target as HTMLTextAreaElement;
    if (t.classList.contains('pr-prompt')) entry(selected).prompt = t.value;
  });
  controls.addEventListener('click', (ev) => {
    const act = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    const en = entry(selected);
    if (act === 'reset-filter') {
      en.params = defaultParams(filterDef(selected)!);
      if (selected === 'colorize') en.hints = [];
      renderControls();
      changed();
    } else if (act === 'hint-remove' && en.hints && view.selectedHint >= 0) {
      en.hints.splice(view.selectedHint, 1);
      view.selectedHint = -1;
      renderControls();
      changed();
    } else if (act === 'hint-clear') {
      en.hints = [];
      view.selectedHint = -1;
      renderControls();
      changed();
    } else if (act === 'style-ref-clear') {
      styleRefs.image = styleRefs.name = undefined;
      renderControls();
    } else if (act === 'ai') void generateAI(en);
  });

  async function generateAI(en: RestoreEntry) {
    const prev = aiRuns.get(en.id);
    if (prev) {
      prev.abort();
      aiRuns.delete(en.id);
      aiStatus.set(en.id, 'Stopped. A result that arrives later is ignored.');
      renderControls();
      return;
    }
    const instruction = aiInstruction(en);
    if (!instruction) {
      aiStatus.set(en.id, 'Describe the change first.');
      renderControls();
      controls.querySelector<HTMLTextAreaElement>('.pr-prompt')?.focus();
      return;
    }
    const ac = new AbortController();
    aiRuns.set(en.id, ac);
    aiStatus.set(en.id, 'Connecting to Puter…');
    renderControls();
    const btn = controls.querySelector<HTMLButtonElement>('.pr-ai-go');
    if (btn) btn.textContent = 'Stop';
    try {
      const image = await runAI(src.image, instruction, { reference: en.id === 'style' ? styleRefs.image : undefined, signal: ac.signal, onStatus: (t) => {
        aiStatus.set(en.id, t);
        const st = selected === en.id ? controls.querySelector('.pr-ai-status') : null;
        if (st) st.textContent = t;
      } });
      if (ac.signal.aborted) return;
      setAux(en, image);
      en.enabled = true;
      aiStatus.set(en.id, en.id === 'colorize' ? 'AI colors are applied; hints refine them.' : en.id === 'style' ? 'The AI style is applied; Strength blends it.' : 'The changed scene is applied.');
      renderList();
      changed();
    } catch (error) {
      if (ac.signal.aborted) return;
      aiStatus.set(en.id, error instanceof Error ? error.message : String(error));
    } finally {
      if (aiRuns.get(en.id) === ac) aiRuns.delete(en.id);
      if (selected === en.id) renderControls();
    }
  }

  // ----- Preview clicks: hints and focus -----
  let depthOverlay: Mask8 | undefined;
  view.onClick = (x, y, ev) => {
    const en = entry(selected);
    if (selected === 'colorize') {
      const r = view.canvas.getBoundingClientRect();
      const hit = view.hintAt(ev.clientX - r.left, ev.clientY - r.top);
      en.hints ??= [];
      if (hit >= 0) {
        if (ev.altKey) {
          en.hints.splice(hit, 1);
          view.selectedHint = -1;
          changed();
        } else {
          view.selectedHint = hit;
          hintColor = en.hints[hit].color;
        }
        renderControls();
        return;
      }
      en.hints.push({ x: x / W, y: y / H, color: hintColor, radius: en.params.radius as number });
      view.selectedHint = en.hints.length - 1;
      en.enabled = true;
      renderList();
      renderControls();
      changed();
    } else if (selected === 'depth') {
      focusPoint = { x: x / W, y: y / H };
      view.focus = focusPoint;
      if (depthOverlay) {
        const px = Math.min(depthOverlay.width - 1, Math.floor((x / W) * depthOverlay.width)), py = Math.min(depthOverlay.height - 1, Math.floor((y / H) * depthOverlay.height));
        en.params = { ...en.params, focal: Math.round((depthOverlay.data[py * depthOverlay.width + px] / 255) * 100) };
        form?.set(en.params);
      }
      en.enabled = true;
      renderList();
      changed();
    }
  };

  // ----- Rendering -----
  const fullSide = Math.max(W, H);
  const coarse = levelFor(W, H, 320);
  const fineLevel = () => levelFor(W, H, Math.max(900, Math.min(1600, view.neededResolution())));
  const befores = new Map<number, RGBA8>();
  let gen = 0;
  let current: { sig: string; level: number; result: RunResult } | undefined;
  let fullDone: { sig: string; result: RunResult } | undefined;
  let fullTimer = 0;
  let fullBefore = false;
  const overlayId = (): RestoreFilterId | undefined => {
    const def = filterDef(selected);
    if (!def?.overlay) return undefined;
    return showOverlay || selected === 'depth' ? selected : undefined;
  };
  const sigOf = () => JSON.stringify(params) + '|' + (overlayId() ?? '');
  const showResult = (r: RunResult) => {
    view.setAfter(r.image);
    const id = overlayId();
    if (id === 'depth') depthOverlay = r.overlay;
    view.setOverlay(showOverlay && r.overlay ? r.overlay : undefined, id === 'depth' ? 'gray' : 'tint');
  };
  const updateBefore = () => {
    // The sharpest original available for the zoom.
    if (view.neededResolution() > fullSide / 2 ** fineLevel() * 1.15 && !fullBefore) {
      fullBefore = true;
      view.setBefore(src.image);
      return;
    }
    if (fullBefore) return;
    const k = [...befores.keys()].sort((a, b) => a - b)[0];
    if (k !== undefined) view.setBefore(befores.get(k));
  };
  function changed() {
    renderOutput();
    void refresh();
  }
  async function refresh() {
    const my = ++gen;
    const sig = sigOf();
    clearTimeout(fullTimer);
    if (fullDone?.sig === sig) {
      showResult(fullDone.result);
      busy(null);
      return;
    }
    const levels = [...new Set([coarse, fineLevel()])].sort((a, b) => b - a);
    for (const k of levels) {
      if (current?.sig === sig && current.level <= k) continue;
      busy('Updating preview…', 0);
      try {
        const r = await preview.run({ params, level: k, overlay: overlayId(), source: !befores.has(k) }, (f) => my === gen && busy('Updating preview…', f));
        if (my !== gen) return;
        if (r.source) {
          befores.set(k, r.source);
          updateBefore();
        }
        current = { sig, level: k, result: r };
        showResult(r);
      } catch (error) {
        if (my !== gen) return;
        busy(null);
        if (!isCancel(error)) say(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (my !== gen) return;
    busy(null);
    say(summary());
    maybeFull();
  }
  // Zoomed in past the preview's resolution: render full size once settled.
  function maybeFull() {
    clearTimeout(fullTimer);
    const sig = sigOf();
    if (fullDone?.sig === sig) return;
    if (view.neededResolution() <= (fullSide / 2 ** fineLevel()) * 1.15 || fineLevel() === 0) return;
    fullTimer = window.setTimeout(async () => {
      const my = gen;
      try {
        busy('Rendering full size…', 0);
        const r = await full.run({ params, level: 0, overlay: overlayId() }, (f) => busy('Rendering full size…', f));
        if (my !== gen) return;
        fullDone = { sig, result: r };
        showResult(r);
      } catch (error) {
        if (!isCancel(error)) say(error instanceof Error ? error.message : String(error));
      } finally {
        if (my === gen) busy(null);
      }
    }, 450);
  }
  const summary = () => {
    const on = params.filters.filter((f) => f.enabled);
    if (!on.length) return 'No filter is on.';
    const waiting = on.filter((f) => needsPixels(f) && !f.aux && f.id !== 'depth').map((f) => filterDef(f.id)!.label);
    if (waiting.length) return `${waiting.join(', ')}: press its AI button to see a result.`;
    return `${on.length} filter${on.length === 1 ? '' : 's'} on.`;
  };

  // ----- Toolbar -----
  const setMode = (m: CompareMode) => {
    view.mode = m;
    q('.pr-modes').querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === m)));
    view.draw();
  };
  setMode('split');
  q('.pr-toolbar').addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const m = t.closest<HTMLElement>('[data-mode]')?.dataset.mode as CompareMode | undefined;
    if (m) return setMode(m);
    const z = t.closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
    if (z) return view.step(Number(z) as 1 | -1);
    if (t.closest('.pr-fit')) return view.fit();
    if (t.closest('.pr-actual')) return view.setZoom(1 / (window.devicePixelRatio || 1));
    if (t.closest('.pr-stop')) {
      preview.terminate();
      full.terminate();
      gen++;
      busy(null);
      say('Stopped.');
    }
  });
  const hold = q<HTMLButtonElement>('.pr-hold');
  const compare = (on: boolean) => {
    view.comparing = on;
    hold.setAttribute('aria-pressed', String(on));
    view.draw();
  };
  hold.addEventListener('pointerdown', () => compare(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(ev, () => compare(false));
  // Keyboard: holding Space or Enter on the button compares too.
  hold.addEventListener('keydown', (ev) => {
    if (ev.key !== ' ' && ev.key !== 'Enter') return;
    ev.preventDefault();
    compare(true);
  });
  hold.addEventListener('keyup', (ev) => {
    if (ev.key === ' ' || ev.key === 'Enter') compare(false);
  });
  ws.dialog.addEventListener('keydown', (ev) => {
    if (ev.key === '\\' && !(ev.target as HTMLElement).matches('input, textarea, select')) compare(true);
  });
  ws.dialog.addEventListener('keyup', (ev) => {
    if (ev.key === '\\') compare(false);
  });

  // ----- Output -----
  const renderOutput = () => {
    if (src.edit) {
      outputBox.innerHTML = `<h3>Output</h3><p class="pr-note">Updates the Live Filter on “${escapeXML(src.layer.name)}”.${isDeterministic(params) ? '' : ' AI results and layer-based depth cannot be kept in a Live Filter and are left out.'}</p>`;
      return;
    }
    const liveOk = isDeterministic(params) && !src.layer.video;
    if (output === 'live' && !liveOk) output = 'new-layer';
    outputBox.innerHTML = `<h3>Output</h3><label class="pr-row pr-col"><span>Send the result to</span><select class="pr-out">${OUTPUTS.map((o) => `<option value="${o.id}" ${o.id === output ? 'selected' : ''} ${o.id === 'live' && !liveOk ? 'disabled' : ''}>${escapeXML(o.label)}</option>`).join('')}</select></label>
<p class="pr-note">${escapeXML(
      output === 'masked-layer'
        ? 'A new layer whose mask covers the area the filters changed.'
        : output === 'live'
          ? 'The filters stay editable on the layer (double-click the Live Filter to change them).'
          : output === 'layer'
            ? 'Changes the pixels of the current layer.'
            : output === 'document'
              ? 'Opens the result as a new document.'
              : 'Adds the result as a new layer above the current one.',
    )}${liveOk ? '' : ' Live Filter output is not available with AI results or layer-based depth.'}${src.selection ? ' Limited to the selection.' : ''}</p>`;
  };
  outputBox.addEventListener('change', (ev) => {
    const t = ev.target as HTMLSelectElement;
    if (t.classList.contains('pr-out')) {
      output = t.value as OutputKind;
      renderOutput();
    }
  });

  // ----- Presets -----
  const presetsMenu = q('.pr-presets-menu');
  const renderPresets = () => {
    const list = loadPresets();
    presetsMenu.innerHTML = `${list.length ? `<ul class="pr-preset-list">${list.map((p, i) => `<li><button type="button" data-preset="${i}" title="Load this preset">${escapeXML(p.name)}</button><button type="button" class="icon-button" data-preset-delete="${i}" aria-label="Delete preset ${escapeXML(p.name)}" title="Delete preset">${svg('trash-2', 13)}</button></li>`).join('')}</ul>` : '<p class="pr-note">No saved presets yet.</p>'}
<div class="pr-row pr-preset-save"><input type="text" class="pr-preset-name" placeholder="Preset name" aria-label="Preset name" maxlength="80"><button type="button" data-preset-act="save">Save</button></div>
<div class="pr-row pr-buttons"><button type="button" data-preset-act="import">Import…</button><button type="button" data-preset-act="export" ${list.length ? '' : 'disabled'}>Export…</button></div>`;
  };
  const presetsBox = q<HTMLDetailsElement>('.pr-presets');
  presetsBox.addEventListener('toggle', () => presetsBox.open && renderPresets());
  // Clicking elsewhere closes the presets menu.
  ws.dialog.addEventListener('pointerdown', (ev) => {
    if (presetsBox.open && !presetsBox.contains(ev.target as Node)) presetsBox.open = false;
  });
  presetsMenu.addEventListener('click', async (ev) => {
    const t = ev.target as HTMLElement;
    const load = t.closest<HTMLElement>('[data-preset]')?.dataset.preset;
    const del = t.closest<HTMLElement>('[data-preset-delete]')?.dataset.presetDelete;
    const act = t.closest<HTMLElement>('[data-preset-act]')?.dataset.presetAct;
    const presets = loadPresets();
    if (load !== undefined) {
      const p = presets[Number(load)];
      if (!p) return;
      // Hints and AI results of this image are kept; settings come from the preset.
      const keep = params;
      params = normalizeRestore(p.params);
      for (const f of params.filters) {
        const old = keep.filters.find((x) => x.id === f.id)!;
        if (old.hints) f.hints = old.hints;
        if (old.aux) f.aux = old.aux;
      }
      (q('.pr-presets') as HTMLDetailsElement).open = false;
      renderList();
      renderControls();
      renderOutput();
      changed();
      say(`Preset “${p.name}” loaded.`);
    } else if (del !== undefined) {
      const p = presets[Number(del)];
      if (p) deletePreset(p.name);
      renderPresets();
    } else if (act === 'save') {
      const input = presetsMenu.querySelector<HTMLInputElement>('.pr-preset-name')!;
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      savePreset(name, params);
      renderPresets();
      say(`Preset “${name}” saved.`);
    } else if (act === 'export') {
      const blob = new Blob([exportPresets(presets)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'portrait-restore-presets.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } else if (act === 'import') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = async () => {
        const f = input.files?.[0];
        if (!f) return;
        try {
          const { added } = importPresets(await f.text());
          renderPresets();
          say(`${added} preset${added === 1 ? '' : 's'} imported.`);
        } catch (error) {
          say(error instanceof Error ? error.message : String(error));
        }
      };
      input.click();
    }
  });
  q('.pr-reset-all').addEventListener('click', () => {
    params = normalizeRestore({ filters: [] });
    for (const name of [...aux.keys()]) {
      preview.setAux(name, null);
      full.setAux(name, null);
    }
    aux.clear();
    renderList();
    renderControls();
    renderOutput();
    changed();
  });

  // ----- Apply -----
  const label = RESTORE_LABEL;
  const layerName = () => {
    const on = params.filters.filter((f) => f.enabled);
    return `${src.layer.name} (${on.length === 1 ? filterDef(on[0].id)!.label : label})`;
  };
  async function finalRender(): Promise<RunResult> {
    const wantDepth = depthChannel && entry('depth').enabled;
    const affected = output === 'masked-layer';
    // The full-size preview can be reused when nothing extra is needed.
    if (fullDone?.sig === sigOf() && !wantDepth && !affected) return fullDone.result;
    gen++;
    clearTimeout(fullTimer);
    preview.terminate();
    busy('Rendering full size…', 0);
    try {
      return await full.run({ params, level: 0, overlay: wantDepth ? 'depth' : undefined, affected }, (f) => busy('Rendering full size…', f));
    } finally {
      busy(null);
    }
  }
  const addDepthChannel = (d: { channels?: { id: string; name: string; grid: TileGrid }[] }, store: typeof e.assets.tiles, m: Mask8) => {
    d.channels = [...(d.channels ?? []), { id: crypto.randomUUID(), name: 'Depth Map', grid: writeRect(store, emptyGrid(1), 0, 0, m) }];
  };
  const generatedInfo = () => {
    const ai = params.filters.find((f) => f.enabled && needsPixels(f) && f.aux && f.id !== 'depth');
    return ai ? { kind: 'edit' as const, prompt: aiSummary(ai) } : undefined;
  };
  async function apply(): Promise<boolean> {
    if (!params.filters.some((f) => f.enabled)) {
      say('Turn on at least one filter.');
      return false;
    }
    const store = e.assets.tiles;
    if (src.edit) {
      const rp = replayable(params);
      await updateLive(e, src.edit.layerId, label, (fs) => fs.map((f, i) => (i === src.edit!.index ? { ...f, params: rp as unknown as ParamValues } : f)));
      return true;
    }
    if (output === 'live') {
      const rp = replayable(params);
      const mark = e.history.mark();
      try {
        if (!isLiveLayer(findLayer(e.doc.layers, src.layer.id))) await convertForLiveFilters(e);
        await applyDirect(e, RESTORE_ID, rp as unknown as ParamValues);
      } finally {
        e.history.squash(mark, label);
        e.update();
      }
      recordStep(e, 'filter.portrait-restore', { params: rp });
      return true;
    }
    const r = await finalRender();
    const depth = depthChannel && entry('depth').enabled ? r.overlay : undefined;
    const id = src.layer.id;
    if (output === 'document') {
      const name = layerName();
      await openDocument(e, name, W, H, (doc, s) => {
        if (depth) addDepthChannel(doc, s.assets.tiles, depth);
        const l = imageLayer(s, doc, name, r.image);
        const g = generatedInfo();
        if (g) l.generated = g;
        return [l];
      });
      return true;
    }
    if (output === 'layer') {
      const grid = writeRect(store, src.target!.grid, 0, 0, r.image);
      e.command(label, (d) => {
        const l = findLayer(d.layers, id);
        if (!l) return;
        setLayerPixels(l, grid, d);
        if (depth) addDepthChannel(d, store, depth);
      });
      if (isDeterministic(params)) recordStep(e, 'filter.portrait-restore', { params: replayable(params) });
      return true;
    }
    const nl = newPixelLayer(layerName(), e.doc, gridFromImage(store, r.image, 0, 0));
    if (output === 'masked-layer' && r.affected) nl.maskGrid = writeRect(store, emptyGrid(1), 0, 0, r.affected);
    const g = generatedInfo();
    if (g) nl.generated = g;
    e.command(label, (d) => {
      const list = containerOf(d.layers, id) ?? d.layers;
      const at = list.findIndex((l) => l.id === id);
      list.splice(at < 0 ? list.length : at + 1, 0, nl);
      if (depth) addDepthChannel(d, store, depth);
    });
    e.selectLayers([nl.id]);
    return true;
  }

  // ----- Start -----
  renderList();
  renderControls();
  renderOutput();

  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (applied: boolean) => {
      if (done) return;
      done = true;
      for (const ac of aiRuns.values()) ac.abort();
      clearTimeout(fullTimer);
      view.dispose();
      preview.dispose();
      full.dispose();
      ws.close();
      e.update();
      resolve(applied);
    };
    void ws.closed.then(() => finish(false));
    q('.pr-cancel').addEventListener('click', () => finish(false));
    okBtn.addEventListener('click', async () => {
      if (okBtn.disabled) return;
      okBtn.disabled = true;
      try {
        if (await apply()) {
          saveLast({ params: storable(params), output, selected, depthChannel });
          finish(true);
          return;
        }
      } catch (error) {
        if (!isCancel(error)) say(error instanceof Error ? error.message : String(error));
        else say('Stopped.');
      }
      okBtn.disabled = false;
    });
    void refresh();
    okBtn.focus();
  });
}
