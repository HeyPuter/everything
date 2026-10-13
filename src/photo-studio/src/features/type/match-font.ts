// Type → Match Font…: box text in the image, compare it with the fonts this
// browser can draw (bundled, detected system fonts and, when permitted, local
// fonts) and apply a match to the selected text layer. Measuring and ranking
// live in imaging/text/match-font.ts; this module draws candidates with canvas
// text and hosts the dialog. "Ask AI" sends the boxed pixels to Puter only
// when pressed.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { selectionBounds, selectionGrid } from '../../model/selection';
import { findLayer } from '../../model/document';
import type { IRect, RGBA8 } from '../../imaging/types';
import { applyCharStyle, plainText, textLength } from '../../imaging/text/model';
import { ensureFont, fontFamilies, localFontAccessSupported, type FontFamilyInfo } from '../../imaging/text/fonts';
import { analyzeText, rankFonts, rerank, variantsOf, type FontCandidate, type FontMatch, type FontRenderer, type TextSample } from '../../imaging/text/match-font';
import { matchFontWithAI, toAIError } from '../../imaging/ai/puter-ai';
import { compositeRGBA } from '../pixels';
import { ensureSignedIn } from '../retouch/ai';
import { DocView, drawImage, openWorkspace } from '../retouch/workspace';
import { commit, editLayers, selectedTextLayers, session } from './session';
import './match-font.css';

const SHOWN = 8;
const REFINE_FAMILIES = 4;
const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black' };
export function styleName(f: FontCandidate) {
  const w = WEIGHT_NAMES[f.weight] ?? String(f.weight);
  return f.italic ? (f.weight === 400 ? 'Italic' : `${w} Italic`) : w;
}
const cssFont = (f: FontCandidate, px: number) => `${f.italic ? 'italic ' : ''}${f.weight} ${px}px "${f.family.replace(/["\\]/g, '\\$&')}"`;

// Remembered while the page is open.
const remembered = { text: '', local: false };

let scratch: OffscreenCanvasRenderingContext2D | undefined;
/** Candidates drawn with canvas text, dark on white. */
export const canvasRenderer: FontRenderer = (text, f, px) => {
  scratch ??= new OffscreenCanvas(8, 8).getContext('2d', { willReadFrequently: true })!;
  const g = scratch;
  const lines = text.split('\n');
  g.font = cssFont(f, px);
  const width = Math.max(1, ...lines.map((l) => g.measureText(l).width));
  const lineH = Math.ceil(px * 1.4);
  const W = Math.ceil(width + px), H = lineH * lines.length + px;
  g.canvas.width = W;
  g.canvas.height = H;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#000';
  g.font = cssFont(f, px);
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, px / 2, px / 2 + px + i * lineH));
  const d = g.getImageData(0, 0, W, H);
  return { width: W, height: H, data: d.data };
};

function crop(img: RGBA8, r: IRect): RGBA8 {
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) out.set(img.data.subarray(((y + r.y) * img.width + r.x) * 4, ((y + r.y) * img.width + r.x + r.width) * 4), y * r.width * 4);
  return { width: r.width, height: r.height, data: out };
}
const pause = () => new Promise<void>((r) => setTimeout(r, 0));
const nearest = (list: number[], w: number) => (list.length ? list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a)) : w);

/** Rank the available fonts against a sample: every family at its regular
 * weight, then weights and italics of the closest families. */
export async function findMatches(sample: TextSample, families: FontFamilyInfo[], opts: { text?: string; render?: FontRenderer; progress?: (fraction: number) => void; cancelled?: () => boolean } = {}): Promise<FontMatch[]> {
  const render = opts.render ?? canvasRenderer;
  const draw: FontRenderer = async (text, f, px) => {
    await ensureFont(f.family, f.weight, f.italic);
    return render(text, f, px);
  };
  const check = async () => {
    await pause();
    if (opts.cancelled?.()) throw new DOMException('Cancelled', 'AbortError');
  };
  const first = families.map((f) => ({ family: f.family, weight: nearest(f.weights, 400), italic: false }));
  const coarse = await rankFonts(sample, first, draw, { text: opts.text, pause: check, onProgress: (d, n) => opts.progress?.((d / n) * 0.6) });
  const top = coarse.slice(0, REFINE_FAMILIES).map((m) => families.find((f) => f.family === m.family)!);
  const variants = top.flatMap((f) => variantsOf(f.family, f.weights, f.italic)).filter((v) => !first.some((c) => c.family === v.family && c.weight === v.weight && c.italic === v.italic));
  const fine = await rankFonts(sample, variants, draw, { text: opts.text, pause: check, onProgress: (d, n) => opts.progress?.(0.6 + (d / n) * 0.4) });
  return [...coarse, ...fine].sort((a, b) => a.distance - b.distance);
}

/** Set the family, weight and style of a whole text layer as one step. */
export async function applyMatch(e: Editor, layerId: string, f: FontCandidate) {
  await ensureFont(f.family, f.weight, f.italic);
  await editLayers(e, 'Match Font', (d) => ({ ...d, content: applyCharStyle(d.content, 0, textLength(d.content), { family: f.family, weight: f.weight, italic: f.italic }) }), [layerId]);
}

export async function matchFontDialog(e: Editor) {
  if (!e.hasDocument) return;
  if (session) await commit(e);
  const image = await compositeRGBA(e);
  const target = selectedTextLayers(e)[0];
  const targetText = target?.textData ? plainText(target.textData.content).replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  const sel = selectionBounds(e.doc, selectionGrid(e.doc, e.assets.tiles));
  let box: IRect | null = sel && sel.width > 2 && sel.height > 2 ? sel : null;
  const localOption = localFontAccessSupported();
  const ws = openWorkspace(
    'Match Font',
    'match-font',
    `<div class="rw-body">
  <div class="rw-stage single"><div class="rw-view mf-view"></div></div>
  <aside class="rw-side mf-side">
    <p class="mf-hint">Drag a box around one line or a few words of text in the image${sel ? ' (the selection is used to start)' : ''}. Fonts are compared by the shapes of their letters.</p>
    <label class="rw-field"><span>Text in the box (optional)</span><input id="mf-text" type="text" autocomplete="off" spellcheck="false" placeholder="Type what it says for closer matches"></label>
    ${localOption ? `<label class="rw-check"><input id="mf-local" type="checkbox" ${remembered.local ? 'checked' : ''}>Include local fonts</label>` : ''}
    <button id="mf-find" type="button" ${box ? '' : 'disabled'}>Find Matches</button>
    <p class="mf-status" id="mf-status" role="status" aria-live="polite"></p>
    <div class="mf-results" role="radiogroup" aria-label="Matching fonts"></div>
    <div class="ai-notice mf-ai" role="note"><strong>Ask AI</strong><p>Sends the boxed area (at most 1024 px on its longer side) and the names of the listed fonts to Puter’s AI service, which picks the closest. This needs a Puter account and may use credits. Nothing is sent until you press Ask AI.</p></div>
    <button id="mf-ai" type="button" disabled>Ask AI</button>
  </aside>
</div>
<footer class="rw-footer"><span class="mf-target">${target ? `Applies to “${escapeXML(target.name)}”` : 'Select a text layer to apply a match.'}</span><span class="rw-spacer"></span><button id="mf-cancel" type="button">Cancel</button><button id="mf-apply" type="button" class="primary" disabled>Apply</button></footer>`,
  );
  const q = ws.q;
  const status = q('#mf-status'), results = q('.mf-results');
  const find = q<HTMLButtonElement>('#mf-find'), askAI = q<HTMLButtonElement>('#mf-ai'), apply = q<HTMLButtonElement>('#mf-apply');
  const textInput = q<HTMLInputElement>('#mf-text');
  textInput.value = remembered.text;
  const say = (msg: string, error = false) => {
    status.textContent = msg;
    status.classList.toggle('error', error);
  };

  // ----- Image with the box -----
  const view = new DocView(q('.mf-view'), image.width, image.height);
  const base = new OffscreenCanvas(view.canvas.width, view.canvas.height);
  drawImage(base.getContext('2d')!, image);
  view.canvas.setAttribute('aria-label', 'Image: drag a box around the text');
  const redraw = () => {
    const g = view.ctx, s = view.scale;
    g.clearRect(0, 0, view.canvas.width, view.canvas.height);
    g.drawImage(base, 0, 0);
    if (!box) return;
    const x = box.x * s, y = box.y * s, w = box.width * s, h = box.height * s;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.beginPath();
    g.rect(0, 0, view.canvas.width, view.canvas.height);
    g.rect(x, y, w, h);
    g.fill('evenodd');
    g.lineWidth = 2;
    g.strokeStyle = '#fff';
    g.strokeRect(x, y, w, h);
    g.setLineDash([4, 4]);
    g.strokeStyle = '#000';
    g.strokeRect(x, y, w, h);
    g.setLineDash([]);
  };
  redraw();
  let drag: [number, number] | undefined;
  const clampBox = (a: [number, number], b: [number, number]): IRect => {
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]))), y0 = Math.max(0, Math.floor(Math.min(a[1], b[1])));
    const x1 = Math.min(image.width, Math.ceil(Math.max(a[0], b[0]))), y1 = Math.min(image.height, Math.ceil(Math.max(a[1], b[1])));
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  };
  view.canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    drag = view.point(ev);
    view.canvas.setPointerCapture(ev.pointerId);
  });
  view.canvas.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    box = clampBox(drag, view.point(ev));
    redraw();
  });
  const end = (ev: PointerEvent) => {
    if (!drag) return;
    const b = clampBox(drag, view.point(ev));
    drag = undefined;
    box = b.width >= 4 && b.height >= 4 ? b : null;
    redraw();
    find.disabled = !box;
    if (box) void run();
  };
  view.canvas.addEventListener('pointerup', end);
  view.canvas.addEventListener('pointercancel', end);

  // ----- Matching -----
  let job = 0;
  let matches: FontMatch[] = [];
  let aiPicks = new Set<string>();
  let chosen = -1;
  let sampleCrop: RGBA8 | undefined;
  const previewText = () => textInput.value.trim() || targetText || 'Aa Bb Cc 123';
  const choose = (k: number) => {
    chosen = k;
    results.querySelectorAll<HTMLElement>('[role=radio]').forEach((b, i) => {
      b.setAttribute('aria-checked', String(i === k));
      b.tabIndex = i === k || (k < 0 && i === 0) ? 0 : -1;
    });
    apply.disabled = k < 0 || !target;
  };
  const showResults = () => {
    results.innerHTML = '';
    const shown = matches.slice(0, SHOWN);
    const textColor = getComputedStyle(results).color || '#000';
    shown.forEach((m, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mf-match';
      b.setAttribute('role', 'radio');
      b.dataset.family = m.family;
      const pct = Math.round(m.similarity * 100);
      const label = `${m.family} ${styleName(m)}`;
      b.setAttribute('aria-label', `${label}, ${pct}% similar${aiPicks.has(m.family) ? ', suggested by AI' : ''}`);
      b.innerHTML = `<canvas aria-hidden="true"></canvas><span class="mf-name">${escapeXML(m.family)} <small>${escapeXML(styleName(m))}</small></span><span class="mf-score">${aiPicks.has(m.family) ? '<em>AI</em> ' : ''}${pct}%</span>`;
      results.append(b);
      const c = b.querySelector('canvas')!, dpr = devicePixelRatio || 1;
      const cw = Math.max(1, b.clientWidth - 12) || 280, ch = 34;
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
      c.style.width = `${cw}px`;
      c.style.height = `${ch}px`;
      void ensureFont(m.family, m.weight, m.italic).then(() => {
        const g = c.getContext('2d')!;
        g.scale(dpr, dpr);
        g.fillStyle = textColor;
        g.font = cssFont(m, 24);
        g.textBaseline = 'middle';
        g.fillText(previewText(), 2, ch / 2);
      });
      b.addEventListener('click', () => choose(k));
      b.addEventListener('dblclick', () => void doApply());
      b.addEventListener('keydown', (ev) => {
        const step = ev.key === 'ArrowDown' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowUp' || ev.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        ev.preventDefault();
        const next = Math.max(0, Math.min(shown.length - 1, k + step));
        choose(next);
        results.querySelectorAll<HTMLElement>('[role=radio]')[next]?.focus();
      });
    });
    choose(shown.length ? 0 : -1);
    askAI.disabled = !shown.length;
  };
  const run = async () => {
    if (!box) return;
    const id = ++job;
    remembered.text = textInput.value;
    const local = q<HTMLInputElement>('#mf-local');
    remembered.local = !!local?.checked;
    sampleCrop = crop(image, box);
    const sample = analyzeText(sampleCrop);
    if (!sample || !sample.glyphs.length) {
      matches = [];
      showResults();
      say('No text was found in the box. Draw it closer around the letters.', true);
      return;
    }
    find.disabled = true;
    say('Finding fonts…');
    try {
      const families = await fontFamilies({ local: remembered.local, pause });
      if (id !== job || !ws.dialog.isConnected) return;
      const found = await findMatches(sample, families, {
        text: textInput.value,
        progress: (f) => id === job && say(`Comparing fonts… ${Math.round(f * 100)}%`),
        cancelled: () => id !== job || !ws.dialog.isConnected,
      });
      if (id !== job) return;
      matches = found;
      aiPicks = new Set();
      showResults();
      say(`${families.length} font famil${families.length === 1 ? 'y' : 'ies'} compared${sample.skew ? `; text tilted ${Math.round((sample.skew * 1800) / Math.PI) / 10}° was straightened` : ''}.`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      say(`Matching failed: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      if (id === job) find.disabled = !box;
    }
  };
  find.addEventListener('click', () => void run());
  textInput.addEventListener('change', () => {
    if (box && matches.length) void run();
  });
  textInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void run();
    }
  });
  q<HTMLInputElement>('#mf-local')?.addEventListener('change', () => {
    if (box) void run();
  });

  askAI.addEventListener('click', async () => {
    if (!sampleCrop || !matches.length) return;
    const names = [...new Set(matches.map((m) => m.family))].slice(0, 12);
    askAI.disabled = true;
    say('Asking Puter AI…');
    try {
      await ensureSignedIn();
      const order = await matchFontWithAI(sampleCrop, names);
      if (!ws.dialog.isConnected) return;
      if (!order.length) {
        say('The AI did not name any of the listed fonts.');
        return;
      }
      // Keep each family's best variant first, ordered by the AI's preference.
      matches = rerank(matches, order);
      aiPicks = new Set(order);
      showResults();
      say(`AI suggests ${order.slice(0, 3).join(', ')}.`);
    } catch (err) {
      say(toAIError(err).message, true);
    } finally {
      askAI.disabled = !matches.length;
    }
  });

  const doApply = async () => {
    const m = matches[chosen];
    if (!m || !target || !findLayer(e.doc.layers, target.id)) return;
    ws.close();
    await applyMatch(e, target.id, m);
    e.message(`Font set to ${m.family} ${styleName(m)}.`);
  };
  apply.addEventListener('click', () => void doApply());
  q('#mf-cancel').addEventListener('click', () => ws.close());
  void ws.closed.then(() => job++);
  if (box) void run();
  else say('Drag a box around the text to start.');
}
