// Edit → Generate Image… and Edit → Edit with Prompt…: text-to-image and
// image-to-image through Puter's AI service. Nothing is sent until Generate is
// pressed in the dialog; every variation is its own request. The chosen
// result is added as a new layer (masked to the selection when there is one)
// above the current layer, and the prompt is kept with the layer.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { findLayer, type GeneratedInfo, type Layer } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { applySelection, canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import { emptyGrid, gridDocBounds, gridFromImage, readMask, readRGBA, writeRect } from '../../model/tiles';
import { EDIT_MAX_SIDE, editImage, generateImages, requestSize, toAIError } from '../../imaging/ai/puter-ai';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { ensureSignedIn } from '../retouch/ai';
import { mergedImage } from '../retouch/source';
import { drawImage, field, openWorkspace, options } from '../retouch/workspace';
import { runJob } from './client';
import { recordGeneration } from '../generations/record';
import { ASPECTS, STYLES, aspectSize, qualityFor, styledPrompt, type FitMode } from './place';
import './assist.css';

type Mode = 'generate' | 'edit';
// Models that accept text and, for editing, a reference image.
const MODELS: Record<Mode, [string, string][]> = {
  generate: [['', 'Automatic'], ['gpt-image-2', 'GPT Image 2'], ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image'], ['@cf/black-forest-labs/flux-1-schnell', 'FLUX.1 Schnell (fast)']],
  edit: [['', 'Automatic'], ['gpt-image-2', 'GPT Image 2'], ['gemini-3.1-flash-image', 'Gemini 3.1 Flash Image']],
};
// Settings remembered for the session.
const remembered = { prompt: '', instruction: '', style: 'none', aspect: 'target', model: '', quality: 'standard', count: 2, fit: 'fill' as FitMode };

type Target = { rect: IRect; mask: Mask8 | null; label: string };
/** The selection's bounds (and its shape when not rectangular), else the canvas. */
function generateTarget(e: Editor): Target {
  const grid = selectionGrid(e.doc, e.assets.tiles), b = selectionBounds(e.doc, grid);
  if (grid && b) {
    const m = readMask(e.assets.tiles, grid, b);
    return { rect: b, mask: m.data.every((v) => v === 255) ? null : m, label: 'selection' };
  }
  return { rect: canvasRect(e.doc), mask: null, label: 'canvas' };
}

/** Settings to open a dialog with (Generation History's Reuse Settings, the Assistant). */
export type GeneratePrefill = { prompt?: string; style?: string; aspect?: string; model?: string; quality?: string; count?: number; fit?: FitMode; via?: 'assistant' };
/** The prefill passed as a command argument `{ prefill }`, if any. */
export function prefillOf(arg: unknown): GeneratePrefill | undefined {
  const p = arg && typeof arg === 'object' ? (arg as { prefill?: unknown }).prefill : undefined;
  return p && typeof p === 'object' ? (p as GeneratePrefill) : undefined;
}
function applyPrefill(mode: Mode, p: GeneratePrefill | undefined) {
  if (!p) return;
  if (typeof p.prompt === 'string') {
    if (mode === 'generate') remembered.prompt = p.prompt;
    else remembered.instruction = p.prompt;
  }
  if (typeof p.style === 'string' && STYLES.some((x) => x.id === p.style)) remembered.style = p.style;
  if (typeof p.aspect === 'string' && ASPECTS.some((x) => x.id === p.aspect)) remembered.aspect = p.aspect;
  if (typeof p.model === 'string' && MODELS[mode].some(([v]) => v === p.model)) remembered.model = p.model;
  if (typeof p.quality === 'string' && ['draft', 'standard', 'high'].includes(p.quality)) remembered.quality = p.quality;
  if (typeof p.count === 'number' && p.count >= 1 && p.count <= 4) remembered.count = Math.round(p.count);
  if (p.fit === 'fill' || p.fit === 'fit') remembered.fit = p.fit;
}

type Session = {
  e: Editor;
  mode: Mode;
  target: Target;
  // Opened by the Assistant: results are recorded as the Assistant's.
  via?: 'assistant';
  // Edit with Prompt: the pixels sent (the target area of the source).
  source?: RGBA8;
  sourceLabel?: string;
};

/** Open the dialog; resolves when it closes. */
async function studio(s: Session) {
  const { mode, target } = s;
  const gen = mode === 'generate';
  const { width: tw, height: th } = target.rect;
  const sentNote = gen
    ? 'Your prompt is sent to Puter’s AI service. No pixels from your document are sent.'
    : `${s.sourceLabel} (${tw} × ${th} px${Math.max(tw, th) > EDIT_MAX_SIDE ? `, reduced to ${EDIT_MAX_SIDE} px on the longer side` : ''}) and your instruction are sent to Puter’s AI service.`;
  const sizeNote = gen
    ? `Results are about ${(() => {
        const r = requestSize(tw, th);
        return `${r.w} × ${r.h}`;
      })()} px or smaller and are scaled to the ${target.label} (${tw} × ${th} px).`
    : Math.max(tw, th) > EDIT_MAX_SIDE
      ? `The edited result is enlarged back to ${tw} × ${th} px, so it is softer than the original.`
      : `The edited result is placed at ${tw} × ${th} px.`;
  const ws = openWorkspace(
    gen ? 'Generate Image' : 'Edit with Prompt',
    'ai-workspace assist-studio',
    `<form class="as-body" novalidate>
  <div class="as-form">
    <div class="ai-notice" role="note"><strong>Before you generate</strong><p>${escapeXML(sentNote)} This requires a Puter account (you may be asked to sign in), and each variation is a separate request that can use credits from your Puter balance. Nothing is sent until you press Generate.</p></div>
    ${field(gen ? 'Prompt' : 'Instruction', `<textarea id="as-prompt" rows="3" placeholder="${gen ? 'Describe the image, e.g. “a red kite over green hills”' : 'Describe the change, e.g. “turn the sky into a sunset”'}"></textarea>`)}
    ${gen ? `<div class="as-row">${field('Style', options('as-style', remembered.style, STYLES.map((x) => [x.id, x.label])))}${field('Aspect', options('as-aspect', remembered.aspect, ASPECTS.map((a) => [a.id, a.label])))}</div>` : ''}
    <div class="as-row">${field('Model', options('as-model', MODELS[mode].some(([v]) => v === remembered.model) ? remembered.model : '', MODELS[mode]))}${field('Quality', options('as-quality', remembered.quality, [['draft', 'Draft'], ['standard', 'Standard'], ['high', 'High']]))}</div>
    <div class="as-row">${field('Variations', options('as-count', String(remembered.count), [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]))}${gen ? field('Placement', options('as-fit', remembered.fit, [['fill', `Fill the ${target.label}`], ['fit', `Fit inside the ${target.label}`]])) : '<span></span>'}</div>
    <p class="as-note">${escapeXML(sizeNote)}</p>
  </div>
  <div class="as-results" role="radiogroup" aria-label="Variations"><p class="as-empty">Variations appear here. Pick one to add it as a new layer.</p></div>
  <p class="ai-status" id="ai-status" role="status" aria-live="polite"></p>
</form>
<footer class="rw-footer"><span class="rw-spacer"></span><button id="as-cancel" type="button">Cancel</button><button id="as-generate" type="button">Generate</button><button id="as-add" type="button" class="primary" disabled>Add Layer</button></footer>`,
  );
  const q = ws.q;
  const prompt = q<HTMLTextAreaElement>('#as-prompt');
  prompt.value = gen ? remembered.prompt : remembered.instruction;
  const status = q('#ai-status'), results = q('.as-results');
  const go = q<HTMLButtonElement>('#as-generate'), add = q<HTMLButtonElement>('#as-add');
  let ctrl: AbortController | undefined;
  let images: RGBA8[] = [];
  let chosen = -1;
  let used: { prompt: string; model: string; style?: string } | undefined;
  const read = () => {
    remembered.model = q<HTMLSelectElement>('#as-model').value;
    remembered.quality = q<HTMLSelectElement>('#as-quality').value;
    remembered.count = Number(q<HTMLSelectElement>('#as-count').value) || 1;
    if (gen) {
      remembered.prompt = prompt.value;
      remembered.style = q<HTMLSelectElement>('#as-style').value;
      remembered.aspect = q<HTMLSelectElement>('#as-aspect').value;
      remembered.fit = q<HTMLSelectElement>('#as-fit').value as FitMode;
    } else remembered.instruction = prompt.value;
  };
  const choose = (k: number) => {
    chosen = k;
    results.querySelectorAll<HTMLElement>('[role=radio]').forEach((b, i) => b.setAttribute('aria-checked', String(i === k)));
    add.disabled = k < 0;
  };
  const showResults = () => {
    results.innerHTML = '';
    images.forEach((img, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `Variation ${k + 1}`);
      const c = document.createElement('canvas'), s = Math.min(1, 220 / Math.max(img.width, img.height));
      c.width = Math.max(1, Math.round(img.width * s));
      c.height = Math.max(1, Math.round(img.height * s));
      drawImage(c.getContext('2d')!, img);
      b.append(c);
      b.addEventListener('click', () => choose(k));
      b.addEventListener('dblclick', () => {
        choose(k);
        add.click();
      });
      results.append(b);
    });
    choose(images.length ? 0 : -1);
  };
  const busy = (on: boolean) => {
    go.textContent = on ? 'Stop' : images.length ? 'Regenerate' : 'Generate';
    prompt.disabled = on;
  };
  const say = (text: string, kind: '' | 'busy' | 'error' = '') => {
    status.className = kind ? `ai-status ${kind}` : 'ai-status';
    status.textContent = text;
  };
  q('form').addEventListener('submit', (ev) => ev.preventDefault());
  q('#as-cancel').addEventListener('click', () => {
    ctrl?.abort();
    ws.close();
  });
  ws.dialog.addEventListener('close', () => ctrl?.abort());
  go.addEventListener('click', async () => {
    // Requests already sent cannot be recalled; Stop frees the dialog and
    // ignores whatever arrives later.
    if (ctrl) {
      ctrl.abort();
      ctrl = undefined;
      busy(false);
      say('Stopped. Results that arrive later are ignored.');
      return;
    }
    read();
    const text = prompt.value.trim();
    if (!text) {
      say(gen ? 'Enter a prompt first.' : 'Describe the change first.', 'error');
      prompt.focus();
      return;
    }
    const ac = (ctrl = new AbortController());
    busy(true);
    say('Connecting to Puter…', 'busy');
    try {
      await ensureSignedIn();
      if (ac.signal.aborted) return;
      const n = remembered.count;
      say(`Generating ${n === 1 ? 'one variation' : `${n} variations`}… this can take a little while.`, 'busy');
      const model = remembered.model, quality = qualityFor(model, remembered.quality);
      let out: RGBA8[];
      if (gen) {
        const size = aspectSize(remembered.aspect, tw, th);
        out = await generateImages(styledPrompt(text, remembered.style), { ...size, model: model || undefined, quality, count: n, signal: ac.signal });
        used = { prompt: text, model, style: remembered.style !== 'none' ? remembered.style : undefined };
      } else {
        out = await editImage(s.source!, text, { model: model || undefined, quality, count: n, signal: ac.signal });
        used = { prompt: text, model };
      }
      if (ac.signal.aborted) return;
      const settings = gen
        ? { style: remembered.style, aspect: remembered.aspect, model, quality: remembered.quality, count: n, fit: remembered.fit }
        : { model, quality: remembered.quality, count: n };
      void recordGeneration(s.e, { kind: s.via === 'assistant' ? 'assistant' : mode, prompt: text, settings: { ...settings, dialog: mode }, model: model || undefined, placement: { ...target.rect } }, out);
      images = out;
      showResults();
      say(out.length < n ? `${out.length} of ${n} variations arrived; the others failed.` : '');
    } catch (error) {
      if (ac.signal.aborted) return;
      const err = toAIError(error);
      say(err.message + (err.retryable ? ' You can try again.' : ''), 'error');
    } finally {
      if (ctrl === ac) {
        ctrl = undefined;
        busy(false);
      }
    }
  });
  let placed: { image: RGBA8; info: GeneratedInfo; fit: FitMode } | undefined;
  add.addEventListener('click', () => {
    if (chosen < 0 || !used) return;
    placed = { image: images[chosen], info: { kind: mode, prompt: used.prompt, model: used.model || undefined, style: used.style }, fit: remembered.fit };
    ws.close();
  });
  prompt.focus();
  await ws.closed;
  read();
  return placed;
}

/** Insert `l` above the layer `anchor` (or at the top). */
function insertAbove(e: Editor, l: Layer, anchor: string | undefined, label: string) {
  e.command(label, (d) => {
    const find = (layers: Layer[]): boolean => {
      const i = layers.findIndex((x) => x.id === anchor);
      if (i >= 0) {
        layers.splice(i + 1, 0, l);
        return true;
      }
      return layers.some((x) => find(x.children));
    };
    if (!anchor || !find(d.layers)) d.layers.push(l);
    applySelection(d, null);
  });
  e.selectLayers([l.id]);
  e.update();
}
function shortName(prefix: string, prompt: string) {
  const p = prompt.replace(/\s+/g, ' ').trim();
  return `${prefix}: ${p.length > 40 ? `${p.slice(0, 39)}…` : p}`;
}
function placeLayer(e: Editor, label: string, name: string, image: RGBA8, target: Target, info: GeneratedInfo, anchor: string | undefined) {
  const { rect } = target, tiles = e.assets.tiles;
  const l = newPixelLayer(name, e.doc, gridFromImage(tiles, image, rect.x, rect.y));
  if (target.mask) l.maskGrid = writeRect(tiles, emptyGrid(1), rect.x, rect.y, target.mask);
  l.generated = info;
  insertAbove(e, l, anchor, label);
}

export async function generateImageDialog(e: Editor, arg?: unknown) {
  e.transform.apply();
  const target = generateTarget(e);
  const anchor = e.selected;
  const prefill = prefillOf(arg);
  applyPrefill('generate', prefill);
  const out = await studio({ e, mode: 'generate', target, via: prefill?.via });
  if (!out) return;
  const { width, height } = target.rect;
  const image = await runJob<RGBA8>(undefined, 'fit', { img: out.image, width, height, mode: out.fit });
  placeLayer(e, 'Generate Image', shortName('Generated', out.info.prompt), image, target, out.info, anchor);
  e.message('The generated image was added as a new layer.');
}

export async function editWithPromptDialog(e: Editor, arg?: unknown) {
  e.transform.apply();
  const l = e.layer;
  const grid = selectionGrid(e.doc, e.assets.tiles), selB = selectionBounds(e.doc, grid);
  // The layer's own pixels when it is a pixel layer, otherwise what is visible.
  const useLayer = !!l && l.kind === 'pixel' && !!l.pixels && !e.settings.quickMask;
  const layerB = useLayer ? gridDocBounds(l!.pixels!) : null;
  const rect = selB ?? (layerB ? intersect(layerB, canvasRect(e.doc)) : canvasRect(e.doc));
  if (!rect || rect.width < 8 || rect.height < 8) return e.message('Select a larger area (at least 8 × 8 pixels) to edit.');
  const mask = grid && selB ? readMask(e.assets.tiles, grid, rect) : null;
  const target: Target = { rect, mask: mask && !mask.data.every((v) => v === 255) ? mask : null, label: selB ? 'selection' : useLayer ? 'layer' : 'canvas' };
  const full = useLayer ? readRGBA(e.assets.tiles, l!.pixels!, rect) : cropRect(await mergedImage(e), rect);
  if (!full.data.some((v, i) => (i & 3) === 3 && v > 0)) return e.message('There is nothing visible to edit here.');
  const sourceLabel = useLayer ? `The ${selB ? 'selected part of the layer' : 'layer'} “${l!.name}”` : selB ? 'The selected part of the visible image' : 'The visible image';
  const prefill = prefillOf(arg);
  applyPrefill('edit', prefill);
  const out = await studio({ e, mode: 'edit', target, source: full, sourceLabel, via: prefill?.via });
  if (!out) return;
  // Keep the source layer's transparency so an edit does not fill empty areas.
  if (useLayer) for (let i = 3; i < out.image.data.length; i += 4) out.image.data[i] = Math.min(out.image.data[i], full.data[i]);
  placeLayer(e, 'Edit with Prompt', shortName('Edited', out.info.prompt), out.image, target, out.info, findLayer(e.doc.layers, l?.id ?? '') ? l?.id : undefined);
  e.message('The edit was added as a new layer above the original.');
}

function intersect(a: IRect, b: IRect): IRect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), r = Math.min(a.x + a.width, b.x + b.width), bt = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
}
function cropRect(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}
