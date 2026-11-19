// Edit → AI Recompose…: pick an object (the selection, a cut-out layer, the
// main subject or one clicked in the preview), then move, scale, rotate,
// flip or remove it on a live preview. Its old place is filled at once with
// the offline Context Fill; an optional generative pass through Puter blends
// the seams, shadow and lighting, with variations to choose from. The result
// is added as new layers (the fill or blend patch, and the moved object) in
// one undo step, so the original stays untouched underneath.
import type { Editor } from '../../editor';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage, readRGBA } from '../../model/tiles';
import { canvasRect } from '../../model/selection';
import { aiFill } from '../../imaging/ai/puter-ai';
import { boundingBox } from '../../imaging/segment/mask-ops';
import { mask8, type IRect, type Mask8, type RGBA8 } from '../../imaging/types';
import type { DetectedObject } from '../../imaging/segment/objects';
import { DocView, bindRanges, field, openWorkspace, options, range } from '../retouch/workspace';
import { runJob } from '../assist/client';
import { recordGeneration } from '../generations/record';
import {
  IDENTITY,
  cutObject,
  footprint,
  isIdentity,
  normAngle,
  objectMatrix,
  overObject,
  recomposePrompt,
  seamMask,
  vacatedGrow,
  vacatedMask,
  type CutObject,
  type ObjectTransform,
} from './math';
import {
  Generator,
  OBJECT_MODE_LABEL,
  VariationPicker,
  addLayers,
  canRun,
  canvasOf,
  cropMask,
  cropRGBA,
  fillHole,
  notice,
  objectMask,
  objectModes,
  pixelLayer,
  replaceable,
  settle,
  shortName,
  sourceFor,
  type ObjectMode,
  type Source,
} from './shared';
import './genai.css';

const remembered = { note: '', count: 2 };
// A blended variation: a patch (alpha = where it applies) made for one arrangement.
type Blend = {
  patch: RGBA8;
  box: IRect;
  t: ObjectTransform;
  removed: boolean;
  note: string;
  canvas: OffscreenCanvas;
};

export async function recomposeDialog(e: Editor) {
  e.transform.apply();
  if (!canRun(e, 'AI Recompose')) return;
  const { width: W, height: H } = e.doc;
  const modes = objectModes(e);
  const layer = pixelLayer(e);
  let mode: ObjectMode = modes[0];
  let useLayer = !!layer;
  const ws = openWorkspace(
    'AI Recompose',
    'ga-workspace ga-recompose',
    `<div class="rw-body">
  <div class="rw-stage single"><div class="rw-view ga-view"><p class="ga-hint" id="ga-hint" aria-live="polite"></p></div></div>
  <aside class="rw-side ga-side">
    <h4>Object</h4>
    ${field(
      'Object',
      options(
        'ga-mode',
        mode,
        modes.map((m) => [m, OBJECT_MODE_LABEL[m]]),
      ),
    )}
    <div id="ga-source-row">${field(
      'Work on',
      options(
        'ga-source',
        useLayer ? 'layer' : 'all',
        layer
          ? [
              ['layer', `The layer “${layer.name}”`],
              ['all', 'All visible layers'],
            ]
          : [['all', 'All visible layers']],
      ),
    )}</div>
    <p class="ga-note" id="ga-object-note"></p>
    <h4>Arrange</h4>
    <p class="ga-note">Drag the object in the preview, or focus the preview and use the arrow keys (Shift for 10 px), + and − to scale, [ and ] to rotate.</p>
    ${field('Scale (%)', range('ga-scale', 10, 400, 100))}
    ${field('Angle (°)', range('ga-rotate', -180, 180, 0))}
    <div class="ga-buttons"><button type="button" id="ga-flip-h" aria-pressed="false">Flip Horizontal</button><button type="button" id="ga-flip-v" aria-pressed="false">Flip Vertical</button></div>
    <label class="rw-check"><input type="checkbox" id="ga-remove"> Remove the object (fill its place only)</label>
    <button type="button" id="ga-reset">Reset Arrangement</button>
    <h4>Blend</h4>
    ${notice('The area around the object and its old place (reduced to at most 1024 pixels on the longer side) and your note are sent to Puter’s AI service to blend the seams, shadow and lighting.')}
    ${field('Note (optional)', `<textarea id="ga-note" rows="2" placeholder="e.g. “soft evening light”"></textarea>`)}
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
  </aside>
</div>
<footer class="rw-footer"><span class="ga-foot">The original stays untouched; the result is added as new layers.</span><span class="rw-spacer"></span><button id="ga-cancel" type="button">Cancel</button><button id="ga-apply" type="button" class="primary" disabled>Add Layers</button></footer>`,
  );
  const q = ws.q;
  const host = q('.ga-view');
  const view = new DocView(host, W, H);
  view.canvas.tabIndex = 0;
  // Arrow keys move the object, so screen readers pass keys through.
  view.canvas.setAttribute('role', 'application');
  view.canvas.setAttribute('aria-roledescription', 'arrangement preview');
  view.canvas.setAttribute('aria-label', 'Preview. Drag or use the arrow keys to move the object.');
  const hint = q('#ga-hint'),
    objNote = q('#ga-object-note'),
    apply = q<HTMLButtonElement>('#ga-apply'),
    noteBox = q<HTMLTextAreaElement>('#ga-note');
  noteBox.value = remembered.note;
  const sourceRow = q('#ga-source-row');

  // ----- State -----
  let src: Source | undefined;
  let obj: CutObject | undefined;
  let vacated: Mask8 | undefined;
  let filled: RGBA8 | undefined;
  let t: ObjectTransform = { ...IDENTITY };
  let removed = false;
  let blends: Blend[] = [];
  let shown = 0; // 0: instant fill; k: blends[k - 1]
  let prep: AbortController | undefined;
  const found: { list?: DetectedObject[] } = {};
  // Preview-scale pictures.
  let basePreview: OffscreenCanvas | undefined;
  let objCanvas: OffscreenCanvas | undefined;

  const gen = new Generator(
    q<HTMLButtonElement>('#ga-generate'),
    q('#ai-status'),
    { idle: 'Generate', again: 'Regenerate' },
    (on) => {
      noteBox.disabled = on;
    },
  );
  const picker = new VariationPicker(
    q('.ga-results'),
    (k) => {
      shown = k;
      if (k > 0) {
        const b = blends[k - 1];
        // A blend belongs to its arrangement: choosing it restores that.
        t = { ...b.t };
        removed = b.removed;
        syncControls();
      }
      draw();
    },
    'Generated blends appear here.',
  );

  const scaled = (img: RGBA8) => {
    const c = new OffscreenCanvas(view.canvas.width, view.canvas.height);
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(canvasOf(img), 0, 0, c.width, c.height);
    return c;
  };
  const drawScene = (g: CanvasRenderingContext2D, k: number, which: number) => {
    const w = g.canvas.width,
      h = g.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    if (basePreview) g.drawImage(basePreview, 0, 0, w, h);
    const b = which > 0 ? blends[which - 1] : undefined;
    if (b) g.drawImage(b.canvas, b.box.x * k, b.box.y * k, b.box.width * k, b.box.height * k);
    const arr = b ? b.t : t,
      gone = b ? b.removed : removed;
    if (obj && objCanvas && !gone) {
      const m = objectMatrix(obj.rect, arr);
      g.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * m[4], k * m[5]);
      g.imageSmoothingQuality = 'high';
      g.drawImage(objCanvas, obj.rect.x, obj.rect.y, obj.rect.width, obj.rect.height);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
  };
  const draw = () => {
    const g = view.ctx;
    drawScene(g, view.scale, shown);
    // Outline of the object's new place.
    if (obj && !removed) {
      const m = objectMatrix(obj.rect, t),
        k = view.scale;
      g.setTransform(k * m[0], k * m[1], k * m[2], k * m[3], k * m[4], k * m[5]);
      g.lineWidth = 1 / (k * t.scale);
      g.setLineDash([4 / (k * t.scale), 3 / (k * t.scale)]);
      g.strokeStyle = '#ffffff';
      g.strokeRect(obj.rect.x, obj.rect.y, obj.rect.width, obj.rect.height);
      g.lineDashOffset = 4 / (k * t.scale);
      g.strokeStyle = '#000000';
      g.strokeRect(obj.rect.x, obj.rect.y, obj.rect.width, obj.rect.height);
      g.setLineDash([]);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
  };
  const refreshPicker = () => {
    const items = [
      {
        label: 'Instant fill (offline)',
        width: W,
        height: H,
        draw: (g: CanvasRenderingContext2D) => drawScene(g, g.canvas.width / W, 0),
      },
      ...blends.map((_, i) => ({
        label: `Blend ${i + 1}`,
        width: W,
        height: H,
        draw: (g: CanvasRenderingContext2D) => drawScene(g, g.canvas.width / W, i + 1),
      })),
    ];
    picker.show(items, shown);
  };
  const syncControls = () => {
    const set = (id: string, v: number) => {
      q<HTMLInputElement>(`#${id}`).value = String(v);
      q<HTMLInputElement>(`input[data-for="${id}"]`).value = String(v);
    };
    set('ga-scale', Math.round(t.scale * 100));
    set('ga-rotate', Math.round(normAngle(t.rotate)));
    q('#ga-flip-h').setAttribute('aria-pressed', String(t.flipH));
    q('#ga-flip-v').setAttribute('aria-pressed', String(t.flipV));
    q<HTMLInputElement>('#ga-remove').checked = removed;
    updateApply();
  };
  // The arrangement changed: the instant fill shows it (blends keep theirs).
  const arranged = () => {
    if (shown > 0) {
      shown = 0;
      picker.choose(0);
    }
    syncControls();
    draw();
  };
  const updateApply = () => {
    apply.disabled = !obj || !filled || (shown === 0 && isIdentity(t) && !removed);
  };

  const setHint = (text: string) => {
    hint.textContent = text;
    hint.hidden = !text;
  };
  /** Choose the picture and the object for the current mode. */
  const prepare = async (at?: [number, number]) => {
    prep?.abort();
    gen.stop(false);
    const ac = (prep = new AbortController());
    obj = vacated = filled = undefined;
    objCanvas = undefined;
    blends = [];
    shown = 0;
    t = { ...IDENTITY };
    removed = false;
    syncControls();
    sourceRow.hidden = !layer || mode === 'layer';
    try {
      if (!src || at === undefined) {
        gen.say('Reading the image…', 'busy');
        src = await sourceFor(e, mode, useLayer);
        found.list = undefined;
        basePreview = scaled(src.base);
      }
      if (ac.signal.aborted) return;
      draw();
      if (mode === 'click' && !at) {
        gen.say('');
        setHint('Click the object to move.');
        objNote.textContent =
          'Click an object in the preview to pick it. Click again with Alt to pick another.';
        picker.clear('Pick an object first.');
        return;
      }
      setHint('');
      gen.say(
        mode === 'click'
          ? 'Finding objects…'
          : mode === 'subject'
            ? 'Finding the subject…'
            : 'Reading the object…',
        'busy',
      );
      const m = await objectMask(e, mode, src, ac.signal, at, found);
      if (ac.signal.aborted) return;
      if (typeof m === 'string') {
        gen.say(m, 'error');
        if (mode === 'click') setHint('Click the object to move.');
        return;
      }
      const cut = cutObject(
        mode === 'layer' && src.layer?.pixels
          ? readRGBA(e.assets.tiles, src.layer.pixels, canvasRect(e.doc))
          : src.base,
        m,
        16,
      );
      if (!cut) {
        gen.say('The object is empty. Choose another.', 'error');
        return;
      }
      obj = cut;
      objCanvas = canvasOf(cut.img);
      objNote.textContent = `${cut.rect.width} × ${cut.rect.height} px object${mode === 'layer' ? '; the layer itself is hidden when you add the result.' : '.'}`;
      // A cut-out layer leaves nothing to fill; otherwise fill its old place.
      vacated = mode === 'layer' ? mask8(W, H) : vacatedMask(m, vacatedGrow(cut.rect));
      const box = boundingBox(vacated);
      draw();
      if (box) {
        gen.say('Filling the object’s place…', 'busy');
        filled = await fillHole(src.base, vacated, box, ac.signal, (f) =>
          gen.say(`Filling the object’s place… ${Math.round(f * 100)}%`, 'busy'),
        );
        if (ac.signal.aborted) return;
        basePreview = scaled(filled);
      } else filled = src.base;
      gen.say(
        'Move, scale, rotate, flip or remove the object, then add the result or generate a blend.',
      );
      refreshPicker();
      updateApply();
      draw();
    } catch (error) {
      if (ac.signal.aborted) return;
      gen.say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (prep === ac) prep = undefined;
    }
  };

  // ----- Controls -----
  q<HTMLSelectElement>('#ga-mode').addEventListener('change', (ev) => {
    mode = (ev.target as HTMLSelectElement).value as ObjectMode;
    src = undefined;
    void prepare();
  });
  q<HTMLSelectElement>('#ga-source').addEventListener('change', (ev) => {
    useLayer = (ev.target as HTMLSelectElement).value === 'layer';
    src = undefined;
    void prepare();
  });
  bindRanges(ws.dialog, (id, v) => {
    if (id === 'ga-scale') t = { ...t, scale: Math.max(0.1, v / 100) };
    else if (id === 'ga-rotate') t = { ...t, rotate: v };
    arranged();
  });
  q('#ga-flip-h').addEventListener('click', () => {
    t = { ...t, flipH: !t.flipH };
    arranged();
  });
  q('#ga-flip-v').addEventListener('click', () => {
    t = { ...t, flipV: !t.flipV };
    arranged();
  });
  q<HTMLInputElement>('#ga-remove').addEventListener('change', (ev) => {
    removed = (ev.target as HTMLInputElement).checked;
    arranged();
  });
  q('#ga-reset').addEventListener('click', () => {
    t = { ...IDENTITY };
    removed = false;
    arranged();
  });
  q<HTMLSelectElement>('#ga-count').addEventListener(
    'change',
    (ev) => (remembered.count = Number((ev.target as HTMLSelectElement).value) || 1),
  );
  noteBox.addEventListener('input', () => (remembered.note = noteBox.value));

  // ----- Preview: pick, drag, keys -----
  let drag: { x: number; y: number; dx: number; dy: number; id: number } | undefined;
  view.canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const [x, y] = view.point(ev);
    if (mode === 'click' && (!obj || ev.altKey)) {
      if (!src || prep) return;
      void prepare([x, y]);
      return;
    }
    if (!obj || removed) return;
    view.canvas.setPointerCapture(ev.pointerId);
    drag = { x, y, dx: t.dx, dy: t.dy, id: ev.pointerId };
  });
  view.canvas.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const [x, y] = view.point(ev);
    t = { ...t, dx: Math.round(drag.dx + x - drag.x), dy: Math.round(drag.dy + y - drag.y) };
    if (shown > 0) {
      shown = 0;
      picker.choose(0);
    }
    updateApply();
    draw();
  });
  const endDrag = () => {
    drag = undefined;
  };
  view.canvas.addEventListener('pointerup', endDrag);
  view.canvas.addEventListener('pointercancel', endDrag);
  view.canvas.addEventListener('keydown', (ev) => {
    if (!obj) return;
    const step = ev.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[ev.key]) t = { ...t, dx: t.dx + moves[ev.key][0], dy: t.dy + moves[ev.key][1] };
    else if (ev.key === '+' || ev.key === '=')
      t = { ...t, scale: Math.min(4, Math.round(t.scale * 100 + 5) / 100) };
    else if (ev.key === '-' || ev.key === '_')
      t = { ...t, scale: Math.max(0.1, Math.round(t.scale * 100 - 5) / 100) };
    else if (ev.key === '[' || ev.key === ']')
      t = { ...t, rotate: normAngle(t.rotate + (ev.key === ']' ? 5 : -5)) };
    else if (ev.key === 'Delete' || ev.key === 'Backspace') removed = !removed;
    else return;
    ev.preventDefault();
    arranged();
  });
  const onResize = () => {
    view.fit();
    if (filled ?? src?.base) basePreview = scaled(filled ?? src!.base);
    draw();
  };
  window.addEventListener('resize', onResize);

  // ----- Generate a blend -----
  q('#ga-generate').addEventListener('click', () => {
    if (!gen.running && (!obj || !filled || !vacated))
      return gen.say(obj ? 'Wait for the fill to finish.' : 'Pick an object first.', 'error');
    if (!gen.running && isIdentity(t) && !removed)
      return gen.say('Move, scale, rotate, flip or remove the object first.', 'error');
    const arr = { ...t },
      gone = removed,
      count = remembered.count,
      note = noteBox.value.trim();
    void gen.toggle(
      async (signal, say) => {
        say('Preparing the blend…');
        const placed = gone
          ? null
          : await runJob<CutObject | null>({ signal, progress: () => {} }, 'transform-object', {
              obj: copyObj(obj!),
              t: arr,
              width: W,
              height: H,
            });
        const seam = seamMask(
          vacated!,
          footprint(placed, W, H),
          Math.max(6, Math.round(Math.max(obj!.rect.width, obj!.rect.height) * 0.04)),
        );
        const box = boundingBox(seam);
        if (!box) throw new Error('Nothing to blend.');
        const composite = placed ? overObject(filled!, placed) : filled!;
        const margin = Math.max(64, Math.round(Math.max(box.width, box.height) * 0.5));
        const R = clampRect(
          {
            x: box.x - margin,
            y: box.y - margin,
            width: box.width + 2 * margin,
            height: box.height + 2 * margin,
          },
          W,
          H,
        );
        const crop = cropRGBA(composite, R),
          cm = cropMask(seam, R);
        say(
          `Generating ${count === 1 ? 'one blend' : `${count} blends`}… this can take a little while.`,
        );
        const prompt = recomposePrompt({ removed: gone, extra: note });
        const results = await settle(count, () =>
          aiFill(crop, cm, prompt, { signal, blend: 'normal' }),
        );
        const inner = { x: box.x - R.x, y: box.y - R.y, width: box.width, height: box.height };
        const where = cropMask(seam, box);
        const patches = results.map((r) => {
          const p = cropRGBA(r, inner);
          for (let i = 0; i < where.data.length; i++)
            p.data[i * 4 + 3] = Math.round((p.data[i * 4 + 3] * where.data[i]) / 255);
          return p;
        });
        return { patches, box, arr, gone, count, note };
      },
      (r) => {
        void recordGeneration(
          e,
          {
            kind: 'recompose',
            prompt: r.note,
            settings: { dialog: 'recompose', count: r.count, removed: r.gone },
            placement: { ...r.box },
          },
          r.patches,
        );
        blends = [
          ...blends,
          ...r.patches.map((patch) => ({
            patch,
            box: r.box,
            t: r.arr,
            removed: r.gone,
            note: r.note,
            canvas: canvasOf(patch),
          })),
        ].slice(-8);
        shown = blends.length;
        refreshPicker();
        gen.say(
          r.patches.length < r.count
            ? `${r.patches.length} of ${r.count} blends arrived; the others failed.`
            : 'Pick a blend, or keep arranging (the instant fill follows your changes).',
        );
        updateApply();
      },
    );
  });

  // ----- Close -----
  let result: { blend?: Blend; t: ObjectTransform; removed: boolean } | undefined;
  q('#ga-cancel').addEventListener('click', () => ws.close());
  apply.addEventListener('click', () => {
    if (apply.disabled) return;
    const b = shown > 0 ? blends[shown - 1] : undefined;
    result = { blend: b, t: b ? b.t : { ...t }, removed: b ? b.removed : removed };
    ws.close();
  });
  ws.dialog.addEventListener('close', () => {
    prep?.abort();
    gen.stop(false);
  });
  void prepare();
  await ws.closed;
  window.removeEventListener('resize', onResize);
  prep?.abort();
  gen.stop(false);
  if (!result || !obj || !src || !filled || !vacated) return;
  await addResult(e, { src, obj, filled, vacated, mode, ...result });
}

async function addResult(
  e: Editor,
  r: {
    src: Source;
    obj: CutObject;
    filled: RGBA8;
    vacated: Mask8;
    mode: ObjectMode;
    blend?: Blend;
    t: ObjectTransform;
    removed: boolean;
  },
) {
  const { width: W, height: H } = e.doc;
  const tiles = e.assets.tiles;
  const layers = [];
  const base = r.src.layer?.name ?? 'Image';
  // The patch over the object's old place: the generated blend or the instant fill.
  if (r.blend) {
    const l = newPixelLayer(
      shortName('AI Recompose blend', base),
      e.doc,
      gridFromImage(tiles, r.blend.patch, r.blend.box.x, r.blend.box.y),
    );
    l.generated = { kind: 'recompose', prompt: r.blend.note.slice(0, 4000) };
    layers.push(l);
  } else {
    const box = boundingBox(r.vacated);
    if (box) {
      const p = cropRGBA(r.filled, box),
        m = cropMask(r.vacated, box);
      for (let i = 0; i < m.data.length; i++)
        p.data[i * 4 + 3] = Math.min(p.data[i * 4 + 3], m.data[i]);
      layers.push(
        newPixelLayer(
          shortName('Recompose fill', base),
          e.doc,
          gridFromImage(tiles, p, box.x, box.y),
        ),
      );
    }
  }
  if (!r.removed) {
    const placed = await runJob<CutObject | null>(undefined, 'transform-object', {
      obj: copyObj(r.obj),
      t: r.t,
      width: W,
      height: H,
    });
    if (placed)
      layers.push(
        newPixelLayer(
          shortName('Recomposed object', base),
          e.doc,
          gridFromImage(tiles, placed.img, placed.rect.x, placed.rect.y),
        ),
      );
    else e.message('The object was moved off the canvas, so only its old place was filled.');
  }
  if (!layers.length) return;
  const hide = r.mode === 'layer' && replaceable(e, r.src.layer) ? r.src.layer!.id : undefined;
  addLayers(e, 'AI Recompose', layers, r.src.layer?.id ?? e.selected, hide);
  e.message(
    `AI Recompose added ${layers.length === 1 ? 'a new layer' : `${layers.length} new layers`}${hide ? ' and hid the original layer' : ''}.`,
  );
}

const copyObj = (o: CutObject): CutObject => ({
  rect: { ...o.rect },
  img: { width: o.img.width, height: o.img.height, data: new Uint8ClampedArray(o.img.data) },
});
function clampRect(r: IRect, W: number, H: number): IRect {
  const x = Math.max(0, r.x),
    y = Math.max(0, r.y);
  return { x, y, width: Math.min(W, r.x + r.width) - x, height: Math.min(H, r.y + r.height) - y };
}
