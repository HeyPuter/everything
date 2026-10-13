// The Generation History panel: AI results kept in this browser, filtered by
// kind and searched by prompt. Each can be placed as a new layer, opened as a
// document, have its prompt copied, open its dialog again with the same
// settings, or be deleted.
import type { Editor } from '../../editor';
import { findCommand } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import type { GeneratedInfo } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { relativeTime } from '../../persistence/versions';
import { filterGenerations, GENERATION_KINDS, GENERATION_LABELS, type GenerationEntry, type GenerationKind } from '../../persistence/generations';
import type { RGBA8 } from '../../imaging/types';
import { warnOnce } from '../preferences/warnings';
import { generationStore, generationsChanged, onGenerationsChange } from './record';

let entries: GenerationEntry[] | undefined;
let urls = new Map<string, string>();
let revision = 0;
const view = { kind: 'all' as GenerationKind | 'all', query: '' };
onGenerationsChange(() => {
  entries = undefined;
  revision++;
});

async function load() {
  if (!entries) {
    const list = await generationStore().list().catch(() => [] as GenerationEntry[]);
    const next = new Map<string, string>();
    for (const x of list) next.set(x.id, urls.get(x.id) ?? (x.thumb ? URL.createObjectURL(x.thumb) : ''));
    for (const [id, u] of urls) if (!next.has(id) && u) URL.revokeObjectURL(u);
    urls = next;
    entries = list;
  }
  return entries;
}

async function decode(blob: Blob): Promise<RGBA8> {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: d.width, height: d.height, data: d.data };
}
async function imageOf(x: GenerationEntry) {
  const blob = await generationStore().image(x.id);
  if (!blob) throw new Error('This result is no longer stored in this browser.');
  return blob;
}
const shortPrompt = (x: GenerationEntry) => {
  const p = x.prompt.replace(/\s+/g, ' ').trim() || GENERATION_LABELS[x.kind];
  return p.length > 40 ? `${p.slice(0, 39)}…` : p;
};
const layerKind = (k: GenerationKind): GeneratedInfo['kind'] => (k === 'assistant' ? 'generate' : k);

/** Place a stored result as a new pixel layer: where it was made when it came
 * from this document, otherwise centered (and scaled down to fit). */
export async function placeGeneration(e: Editor, x: GenerationEntry) {
  if (!e.hasDocument) return openGeneration(e, x);
  let img = await decode(await imageOf(x));
  const doc = e.doc;
  const p = x.placement;
  let at: { x: number; y: number };
  if (p && x.docId === doc.id && p.width && p.height) {
    if (p.width !== img.width || p.height !== img.height) img = await fit(img, p.width, p.height);
    at = { x: p.x, y: p.y };
  } else {
    const s = Math.min(1, doc.width / img.width, doc.height / img.height);
    if (s < 1) img = await fit(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
    at = { x: Math.round((doc.width - img.width) / 2), y: Math.round((doc.height - img.height) / 2) };
  }
  const l = newPixelLayer(`${GENERATION_LABELS[x.kind]}: ${shortPrompt(x)}`, doc, gridFromImage(e.assets.tiles, img, at.x, at.y));
  l.generated = { kind: layerKind(x.kind), prompt: x.prompt, model: x.model, style: typeof x.settings.style === 'string' && x.settings.style !== 'none' ? x.settings.style : undefined };
  const anchor = e.selected;
  e.command('Place Generated Image', (d) => {
    const insert = (layers: typeof d.layers): boolean => {
      const i = layers.findIndex((y) => y.id === anchor);
      if (i >= 0) return (layers.splice(i + 1, 0, l), true);
      return layers.some((y) => insert(y.children));
    };
    if (!anchor || !insert(d.layers)) d.layers.push(l);
  });
  e.selectLayers([l.id]);
  e.update();
  e.message('Placed the generated image as a new layer.');
}
async function fit(img: RGBA8, w: number, h: number): Promise<RGBA8> {
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  const out = new OffscreenCanvas(w, h);
  const g = out.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}
/** Open a stored result as a new document. */
export async function openGeneration(e: Editor, x: GenerationEntry) {
  const { openFile } = await import('../files/open');
  const name = shortPrompt(x).replace(/…$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Generated';
  await openFile(e, await imageOf(x), `${name}.png`);
}
async function copyPrompt(e: Editor, x: GenerationEntry) {
  try {
    await navigator.clipboard.writeText(x.prompt);
    e.message('Prompt copied.');
  } catch {
    e.message('The clipboard is not available here.');
  }
}
// The dialog each kind came from and the command that opens it.
const dialogCommand: Record<string, string> = { generate: 'edit.generate-image', edit: 'edit.edit-with-prompt', fill: 'edit.ai-fill', expand: 'edit.ai-expand', upscale: 'image.upscale' };
/** Open the dialog that made a result, with the same prompt and settings. */
export async function reuseSettings(e: Editor, x: GenerationEntry) {
  const dialog = typeof x.settings.dialog === 'string' ? x.settings.dialog : x.kind;
  const id = dialogCommand[dialog];
  const c = id && findCommand(id);
  if (!c) return e.message('These settings cannot be reused.');
  if (c.enabled && !c.enabled(e))
    return e.message(dialog === 'fill' ? 'Select the area to fill first, then reuse these settings.' : `Open a document first to use ${c.label.replace(/…$/, '')}.`);
  const { variation: _v, dialog: _d, ...rest } = x.settings;
  void _v;
  void _d;
  await e.runCommand(id, { prefill: { ...rest, prompt: x.prompt } });
}
async function remove(e: Editor, x: GenerationEntry) {
  await generationStore().remove(x.id);
  generationsChanged();
  e.dock?.update();
}
export async function clearGenerations(e: Editor) {
  const n = (await load()).length;
  if (!n) return e.message('Generation History is empty.');
  if (!(await warnOnce(e, 'clear-generations', 'Clear Generation History', `Delete all ${n} stored AI result${n === 1 ? '' : 's'} from this browser? This cannot be undone. Layers already placed in documents are not affected.`, 'Delete All'))) return;
  await generationStore().clear();
  generationsChanged();
  e.dock?.update();
  e.message('Generation History cleared.');
}

const sizeText = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
function rowHTML(x: GenerationEntry) {
  const url = urls.get(x.id);
  const name = escapeXML(shortPrompt(x));
  const meta = [GENERATION_LABELS[x.kind], x.model, relativeTime(x.time), `${x.width} × ${x.height}`, x.docName].filter(Boolean).map((t) => escapeXML(String(t))).join(' · ');
  const b = (act: string, icon: string, label: string) => `<button type="button" class="icon-button" data-gen-act="${act}" title="${label}" aria-label="${label}: ${name}">${svg(icon, 14)}</button>`;
  return `<div class="gen-row" role="listitem" data-gen="${x.id}">
<button type="button" class="gen-thumb" data-gen-act="place" title="Place as a new layer" aria-label="Place as a new layer: ${name}">${url ? `<img src="${url}" alt="">` : svg('image', 18)}</button>
<div class="gen-meta"><q title="${escapeXML(x.prompt)}">${escapeXML(x.prompt || GENERATION_LABELS[x.kind])}</q><small title="${escapeXML(new Date(x.time).toLocaleString())} · ${sizeText(x.size)}">${meta}</small>
<div class="gen-actions">${b('place', 'image-plus', 'Place as a new layer')}${b('open', 'file-plus', 'Open as a new document')}${b('copy', 'copy', 'Copy prompt')}${b('reuse', 'repeat', 'Reuse settings')}${b('delete', 'trash-2', 'Delete')}</div></div></div>`;
}

export function mountGenerations(e: Editor, el: HTMLElement) {
  el.classList.add('generations-panel');
  el.innerHTML = `<div class="gen-head"><input type="search" class="gen-search" placeholder="Search prompts" aria-label="Search prompts" spellcheck="false"><select class="gen-kind" aria-label="Show results of"><option value="all">All kinds</option>${GENERATION_KINDS.map((k) => `<option value="${k}">${GENERATION_LABELS[k]}</option>`).join('')}</select></div><div class="gen-body"></div>`;
  const search = el.querySelector<HTMLInputElement>('.gen-search')!;
  const kind = el.querySelector<HTMLSelectElement>('.gen-kind')!;
  search.value = view.query;
  kind.value = view.kind;
  search.addEventListener('input', () => {
    view.query = search.value;
    draw(e, el, true);
  });
  kind.addEventListener('change', () => {
    view.kind = kind.value as GenerationKind | 'all';
    draw(e, el, true);
  });
  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const act = t.closest<HTMLElement>('[data-gen-act]')?.dataset.genAct;
    const id = t.closest<HTMLElement>('[data-gen]')?.dataset.gen;
    const x = entries?.find((y) => y.id === id);
    if (!act || !x) return;
    const run = { place: placeGeneration, open: openGeneration, copy: copyPrompt, reuse: reuseSettings, delete: remove }[act];
    if (!run) return;
    if (act === 'reuse' || act === 'copy') void run(e, x).catch((err: unknown) => e.message(err instanceof Error ? err.message : String(err)));
    else void e.run(() => run(e, x));
  });
}
export function updateGenerations(e: Editor, el: HTMLElement) {
  draw(e, el, false);
}
function draw(e: Editor, el: HTMLElement, force: boolean) {
  const body = el.querySelector<HTMLElement>('.gen-body');
  if (!body) return;
  const key = `${revision}:${view.kind}:${view.query}`;
  if (!force && body.dataset.key === key) return;
  body.dataset.key = key;
  void load().then((list) => {
    if (body.dataset.key !== key) return;
    const shown = filterGenerations(list, view);
    body.innerHTML = !list.length
      ? '<p class="gen-empty">No AI results yet. Images made with Generate Image, Edit with Prompt, AI Fill, AI Expand, the AI layer of Upscale and the Assistant are kept here, in this browser.</p>'
      : shown.length
        ? `<p class="gen-count muted">${shown.length === list.length ? `${list.length} result${list.length === 1 ? '' : 's'}` : `${shown.length} of ${list.length}`}</p><div class="gen-list" role="list">${shown.map(rowHTML).join('')}</div>`
        : '<p class="gen-empty">No results match.</p>';
    void e;
  });
}
