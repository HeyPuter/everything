// Edit → Remove Reflections…: take window and glass reflections out of the
// selection, the layer or the visible image. Single-image classical methods
// cannot tell a reflection from the scene behind the glass reliably, so this
// is a generative edit through Puter with a strong instruction. The chosen
// variation is compared with the original on a split preview; Amount blends
// it with the original (it becomes the new layer's opacity, so it can still
// be changed afterwards), and the result is added as a new layer, optionally
// with a mask to paint parts back.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { newPixelLayer } from '../../model/pixel-layer';
import { canvasRect, selectionBounds, selectionGrid } from '../../model/selection';
import {
  emptyGrid,
  gridDocBounds,
  gridFromImage,
  readMask,
  readRGBA,
  writeRect,
} from '../../model/tiles';
import { EDIT_MAX_SIDE, instructedEdits } from '../../imaging/ai/puter-ai';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { mergedImage } from '../retouch/source';
import { field, openWorkspace, options, range, bindRanges } from '../retouch/workspace';
import { runJob } from '../assist/client';
import { recordGeneration } from '../generations/record';
import { reflectionPrompt } from './math';
import {
  Generator,
  VariationPicker,
  addLayers,
  canRun,
  canvasOf,
  cropRGBA,
  notice,
  pixelLayer,
  previewBitmap,
} from './shared';
import './genai.css';

const remembered = {
  strength: 'standard' as 'standard' | 'strong',
  note: '',
  count: 2,
  amount: 100,
  output: 'layer' as 'layer' | 'masked',
  detail: true,
};

type Target = { rect: IRect; mask: Mask8 | null; full: RGBA8; layerId?: string; label: string };
/** The selection's part of the layer (or visible image), else the layer's
 * bounds, else the canvas. */
async function targetOf(e: Editor): Promise<Target | string> {
  const l = pixelLayer(e);
  const grid = selectionGrid(e.doc, e.assets.tiles),
    selB = selectionBounds(e.doc, grid);
  const layerB = l ? intersect(gridDocBounds(l.pixels!), canvasRect(e.doc)) : null;
  const rect = selB ?? layerB ?? canvasRect(e.doc);
  if (!rect || rect.width < 16 || rect.height < 16)
    return 'Select a larger area (at least 16 × 16 pixels).';
  const mask = grid && selB ? readMask(e.assets.tiles, grid, rect) : null;
  const full = l ? readRGBA(e.assets.tiles, l.pixels!, rect) : cropRGBA(await mergedImage(e), rect);
  if (!full.data.some((v, i) => (i & 3) === 3 && v > 0))
    return 'There is nothing visible to work on here.';
  const label = l
    ? `The ${selB ? 'selected part of the layer' : 'layer'} “${l.name}”`
    : selB
      ? 'The selected part of the visible image'
      : 'The visible image';
  return {
    rect,
    mask: mask && !mask.data.every((v) => v === 255) ? mask : null,
    full,
    layerId: l?.id,
    label,
  };
}

export async function reflectionDialog(e: Editor) {
  e.transform.apply();
  if (!canRun(e, 'Remove Reflections')) return;
  const target = await targetOf(e);
  if (typeof target === 'string') return e.message(target);
  const { rect, full } = target;
  const reduced = Math.max(rect.width, rect.height) > EDIT_MAX_SIDE;
  const sentSize = (() => {
    const s = Math.min(1, EDIT_MAX_SIDE / Math.max(rect.width, rect.height));
    return {
      width: Math.max(1, Math.round(rect.width * s)),
      height: Math.max(1, Math.round(rect.height * s)),
    };
  })();
  const ws = openWorkspace(
    'Remove Reflections',
    'ga-workspace ga-reflection',
    `<div class="rw-body">
  <div class="rw-stage single"><div class="rw-view ga-view ga-compare-view"><canvas class="ga-compare" tabindex="0" role="img" aria-label="Before and after preview"></canvas><span class="ga-tag left">Original</span><span class="ga-tag right">Result</span></div></div>
  <aside class="rw-side ga-side">
    ${notice(`${target.label} (${rect.width} × ${rect.height} px${reduced ? `, reduced to ${EDIT_MAX_SIDE} px on the longer side` : ''}) and your note are sent to Puter’s AI service.`)}
    ${field(
      'Strength',
      options('ga-strength', remembered.strength, [
        ['standard', 'Reflections'],
        ['strong', 'Reflections, glare and haze'],
      ]),
    )}
    ${field('Note (optional)', `<textarea id="ga-note" rows="2" placeholder="e.g. “the reflection of a lamp at the top left”"></textarea>`)}
    <div class="ga-gen-row">${field(
      'Variations',
      options('ga-count', String(remembered.count), [
        ['1', '1'],
        ['2', '2'],
        ['3', '3'],
        ['4', '4'],
      ]),
    )}<button type="button" id="ga-generate">Generate</button></div>
    <div class="ga-results" aria-label="Generated results"></div>
    <p class="ai-status" id="ai-status" role="status" aria-live="polite"></p>
    <h4>Result</h4>
    ${field('Amount (%)', range('ga-amount', 0, 100, remembered.amount), 'Sets the new layer’s opacity, so you can still change it in the Layers panel.')}
    ${field('Compare (%)', range('ga-split', 0, 100, 50), 'Drag the divider in the preview or use this slider.')}
    ${reduced ? `<label class="rw-check"><input type="checkbox" id="ga-detail" ${remembered.detail ? 'checked' : ''}> Restore fine detail from the original</label>` : ''}
    ${field(
      'Output',
      options(
        'ga-output',
        target.mask ? 'masked' : remembered.output,
        target.mask
          ? [['masked', 'New layer masked to the selection']]
          : [
              ['layer', 'New layer'],
              ['masked', 'New layer with a mask (paint to restore parts)'],
            ],
      ),
    )}
  </aside>
</div>
<footer class="rw-footer"><span class="ga-foot">${escapeXML(reduced ? `The result is enlarged back to ${rect.width} × ${rect.height} px.` : `The result is placed at ${rect.width} × ${rect.height} px.`)}</span><span class="rw-spacer"></span><button id="ga-cancel" type="button">Cancel</button><button id="ga-apply" type="button" class="primary" disabled>Add Layer</button></footer>`,
  );
  const q = ws.q;
  const host = q('.ga-view'),
    cv = q<HTMLCanvasElement>('.ga-compare'),
    apply = q<HTMLButtonElement>('#ga-apply'),
    noteBox = q<HTMLTextAreaElement>('#ga-note');
  noteBox.value = remembered.note;
  // Previews are drawn from small copies: the original scaled to the view
  // once, and the results at the size the provider returned them.
  let orig: OffscreenCanvas | undefined;
  let results: RGBA8[] = [];
  let shownCanvas: OffscreenCanvas | undefined;
  let split = 50;
  // Full-size results, made in the worker when a variation is added.
  const finals = new Map<string, Promise<RGBA8>>();
  const fit = () => {
    const r = host.getBoundingClientRect();
    const s = Math.min(1, (r.width - 16) / rect.width, (r.height - 16) / rect.height);
    cv.width = Math.max(1, Math.round(rect.width * s));
    cv.height = Math.max(1, Math.round(rect.height * s));
    void previewBitmap(full, cv.width, cv.height).then((b) => {
      orig = b;
      draw();
    });
  };
  const draw = () => {
    const g = cv.getContext('2d')!,
      w = cv.width,
      h = cv.height;
    g.clearRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    if (orig) g.drawImage(orig, 0, 0, w, h);
    if (shownCanvas) {
      const x = Math.round((split / 100) * w);
      g.save();
      g.beginPath();
      g.rect(x, 0, w - x, h);
      g.clip();
      g.globalAlpha = remembered.amount / 100;
      g.drawImage(shownCanvas, 0, 0, w, h);
      g.restore();
      g.fillStyle = '#ffffff';
      g.fillRect(x - 1, 0, 2, h);
      g.fillStyle = '#00000080';
      g.fillRect(x + 1, 0, 1, h);
    }
  };
  fit();
  draw();
  const onResize = () => {
    fit();
    draw();
  };
  window.addEventListener('resize', onResize);
  /** The chosen result at full size: enlarged, with the original's fine
   * detail when asked, and the layer's transparency kept (worker). */
  const finalImage = (k: number): Promise<RGBA8> => {
    const detail = reduced && (q<HTMLInputElement>('#ga-detail')?.checked ?? false);
    const key = `${k}:${detail}`;
    let p = finals.get(key);
    if (!p) {
      const copy = (i: RGBA8) => ({
        width: i.width,
        height: i.height,
        data: new Uint8ClampedArray(i.data),
      });
      p = runJob<RGBA8>(undefined, 'reflection-final', {
        gen: copy(results[k]),
        orig: copy(full),
        sent: sentSize,
        detail,
        keep: !!target.layerId,
      });
      finals.set(key, p);
    }
    return p;
  };
  const show = (k: number) => {
    shownCanvas = canvasOf(results[k]);
    draw();
  };
  const picker = new VariationPicker(
    q('.ga-results'),
    (k) => void show(k),
    'Variations appear here. Pick one to compare it with the original.',
  );
  const gen = new Generator(
    q<HTMLButtonElement>('#ga-generate'),
    q('#ai-status'),
    { idle: 'Generate', again: 'Regenerate' },
    (on) => (noteBox.disabled = on),
  );
  bindRanges(ws.dialog, (id, v) => {
    if (id === 'ga-amount') remembered.amount = v;
    else if (id === 'ga-split') split = v;
    draw();
  });
  q<HTMLInputElement>('#ga-detail')?.addEventListener(
    'change',
    (ev) => (remembered.detail = (ev.target as HTMLInputElement).checked),
  );
  // Dragging the divider.
  const setSplit = (ev: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    split = Math.round(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * 100);
    q<HTMLInputElement>('#ga-split').value = String(split);
    q<HTMLInputElement>('input[data-for="ga-split"]').value = String(split);
    draw();
  };
  cv.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    cv.setPointerCapture(ev.pointerId);
    setSplit(ev);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (cv.hasPointerCapture(ev.pointerId)) setSplit(ev);
  });
  cv.addEventListener('keydown', (ev) => {
    const d = ev.key === 'ArrowLeft' ? -5 : ev.key === 'ArrowRight' ? 5 : 0;
    if (!d) return;
    ev.preventDefault();
    split = Math.max(0, Math.min(100, split + d));
    q<HTMLInputElement>('#ga-split').value = String(split);
    q<HTMLInputElement>('input[data-for="ga-split"]').value = String(split);
    draw();
  });
  const read = () => {
    remembered.strength = q<HTMLSelectElement>('#ga-strength').value as 'standard' | 'strong';
    remembered.count = Number(q<HTMLSelectElement>('#ga-count').value) || 1;
    remembered.note = noteBox.value;
    if (!target.mask)
      remembered.output = q<HTMLSelectElement>('#ga-output').value as 'layer' | 'masked';
  };
  q('#ga-generate').addEventListener('click', () => {
    read();
    const count = remembered.count,
      note = remembered.note.trim(),
      strength = remembered.strength;
    void gen.toggle(
      async (signal, say) => {
        say(
          `Generating ${count === 1 ? 'one variation' : `${count} variations`}… this can take a little while.`,
        );
        // Results stay at the provider's size until one is added.
        const out = await instructedEdits(full, reflectionPrompt({ strength, extra: note }), {
          count,
          signal,
          native: true,
        });
        return { out, count, note, strength };
      },
      (r) => {
        void recordGeneration(
          e,
          {
            kind: 'reflection',
            prompt: r.note,
            settings: { dialog: 'reflection', strength: r.strength, count: r.count },
            placement: { ...rect },
          },
          r.out,
        );
        results = [...results, ...r.out].slice(-8);
        finals.clear();
        apply.disabled = false;
        picker.show(
          results.map((img, i) => ({
            label: `Variation ${i + 1}`,
            width: img.width,
            height: img.height,
            draw: (g) => g.drawImage(canvasOf(img), 0, 0, g.canvas.width, g.canvas.height),
          })),
          results.length - r.out.length,
        );
        gen.say(
          r.out.length < r.count
            ? `${r.out.length} of ${r.count} variations arrived; the others failed.`
            : 'Compare with the divider, set the amount, then add the layer.',
        );
      },
    );
  });
  let chosen: { image: RGBA8; amount: number; masked: boolean; note: string } | undefined;
  q('#ga-cancel').addEventListener('click', () => ws.close());
  apply.addEventListener('click', async () => {
    if (picker.chosen < 0) return;
    read();
    apply.disabled = true;
    gen.say('Preparing the full-size result…', 'busy');
    const image = await finalImage(picker.chosen);
    chosen = {
      image,
      amount: remembered.amount,
      masked: !!target.mask || remembered.output === 'masked',
      note: remembered.note.trim(),
    };
    ws.close();
  });
  ws.dialog.addEventListener('close', () => gen.stop(false));
  noteBox.focus();
  await ws.closed;
  window.removeEventListener('resize', onResize);
  gen.stop(false);
  read();
  if (!chosen) return;
  const tiles = e.assets.tiles;
  const l = newPixelLayer(
    target.layerId ? `${nameOf(e, target.layerId)} without reflections` : 'Reflections removed',
    e.doc,
    gridFromImage(tiles, chosen.image, rect.x, rect.y),
  );
  l.opacity = Math.max(0, Math.min(1, chosen.amount / 100));
  if (chosen.masked)
    l.maskGrid = writeRect(
      tiles,
      emptyGrid(1),
      rect.x,
      rect.y,
      target.mask ?? {
        width: rect.width,
        height: rect.height,
        data: new Uint8Array(rect.width * rect.height).fill(255),
      },
    );
  l.generated = { kind: 'reflection', prompt: chosen.note.slice(0, 4000) };
  addLayers(e, 'Remove Reflections', [l], target.layerId ?? e.selected);
  e.message(
    `Reflections removed on a new layer${chosen.masked ? ' with a mask' : ''}${chosen.amount < 100 ? ` at ${chosen.amount}% opacity` : ''}.`,
  );
}

function nameOf(e: Editor, id: string) {
  const l = e.layer;
  return l?.id === id ? l.name : 'Layer';
}
function intersect(a: IRect | null, b: IRect): IRect | null {
  if (!a) return null;
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    r = Math.min(a.x + a.width, b.x + b.width),
    bt = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
}
