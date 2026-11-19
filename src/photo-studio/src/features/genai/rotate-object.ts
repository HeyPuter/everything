// Edit → Rotate Object…: turn a flat object in depth. The object (the
// selection, a cut-out layer, the main subject or one clicked in the
// preview) is isolated on a plain backdrop and sent to Puter with the turn
// and tilt set on a turntable; each variation's backdrop is removed with the
// app's background removal, and the turned object is placed as a new layer
// standing where the original stood. The original can be replaced: a
// cut-out layer is hidden, otherwise its place is filled with Context Fill.
import type { Editor } from '../../editor';
import { newPixelLayer } from '../../model/pixel-layer';
import { canvasRect } from '../../model/selection';
import { gridFromImage, readRGBA } from '../../model/tiles';
import { EDIT_MAX_SIDE, instructedEdits } from '../../imaging/ai/puter-ai';
import { boundingBox } from '../../imaging/segment/mask-ops';
import type { DetectedObject } from '../../imaging/segment/objects';
import type { IRect, Mask8, RGBA8 } from '../../imaging/types';
import { DocView, bindRanges, field, openWorkspace, options, range } from '../retouch/workspace';
import { buffersOf, channel, withProgress } from '../retouch/client';
import { runJob } from '../assist/client';
import { mergedImage } from '../retouch/source';
import { recordGeneration } from '../generations/record';
import {
  alignToOriginal,
  cutObject,
  normAngle,
  onBackdrop,
  rotatePrompt,
  turnLabel,
  vacatedGrow,
  vacatedMask,
  type CutObject,
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
  replaceable,
  shortName,
  sourceFor,
  type ObjectMode,
  type Source,
  previewBitmap,
} from './shared';
import './genai.css';

const remembered = { yaw: 45, tilt: 0, note: '', count: 2, replace: true };
type Turned = {
  img: RGBA8;
  rect: IRect;
  yaw: number;
  tilt: number;
  note: string;
  canvas: OffscreenCanvas;
};

/** The turntable: a top-down dial whose marker shows where the object's
 * front faces (bottom = toward the viewer). Keyboard: arrows ±5° (Shift
 * ±15°), Home resets. */
function turntable(host: HTMLElement, value: number, onChange: (v: number) => void) {
  host.innerHTML = `<svg viewBox="-60 -60 120 120" class="ga-dial" role="slider" tabindex="0" aria-label="Turn" aria-valuemin="-180" aria-valuemax="180">
  <ellipse class="ga-dial-plate" cx="0" cy="0" rx="52" ry="52"/>
  <line class="ga-dial-axis" x1="0" y1="-52" x2="0" y2="52"/>
  <path class="ga-dial-view" d="M -8 58 L 0 50 L 8 58"/>
  <g class="ga-dial-marker"><line x1="0" y1="0" x2="0" y2="44"/><circle cx="0" cy="44" r="7"/></g>
</svg>`;
  const svgEl = host.querySelector<SVGSVGElement>('svg')!,
    marker = host.querySelector<SVGGElement>('.ga-dial-marker')!;
  const set = (v: number, fire = true) => {
    value = Math.round(normAngle(v));
    marker.setAttribute('transform', `rotate(${-value})`);
    svgEl.setAttribute('aria-valuenow', String(value));
    svgEl.setAttribute(
      'aria-valuetext',
      value === 0
        ? 'Facing the viewer'
        : `${Math.abs(value)} degrees to the ${value > 0 ? 'right' : 'left'}`,
    );
    if (fire) onChange(value);
  };
  const fromPointer = (ev: PointerEvent) => {
    const r = svgEl.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2),
      dy = ev.clientY - (r.top + r.height / 2);
    let a = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (ev.shiftKey) a = Math.round(a / 15) * 15;
    set(a);
  };
  svgEl.addEventListener('pointerdown', (ev) => {
    svgEl.setPointerCapture(ev.pointerId);
    svgEl.focus();
    fromPointer(ev);
  });
  svgEl.addEventListener('pointermove', (ev) => {
    if (svgEl.hasPointerCapture(ev.pointerId)) fromPointer(ev);
  });
  svgEl.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 15 : 5;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') set(value + step);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') set(value - step);
    else if (ev.key === 'Home') set(0);
    else return;
    ev.preventDefault();
  });
  set(value, false);
  return { set };
}

export async function rotateObjectDialog(e: Editor) {
  e.transform.apply();
  if (!canRun(e, 'Rotate Object')) return;
  const { width: W, height: H } = e.doc;
  const modes = objectModes(e);
  let mode: ObjectMode = modes[0];
  const ws = openWorkspace(
    'Rotate Object',
    'ga-workspace ga-rotate',
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
    <p class="ga-note" id="ga-object-note"></p>
    <h4>Turn</h4>
    <div class="ga-turn"><div id="ga-dial"></div><div class="ga-turn-fields">${field('Turn (°)', `<input type="number" id="ga-yaw" min="-180" max="180" step="1" value="${remembered.yaw}">`)}<p class="ga-note">Drag the marker: it shows where the front of the object faces (bottom = toward you).</p></div></div>
    ${field('Tilt (°)', range('ga-tilt', -60, 60, remembered.tilt), 'Positive shows more of the top, negative more of the underside.')}
    ${notice('The object on a plain backdrop (reduced to at most 1024 pixels on the longer side), the angles and your note are sent to Puter’s AI service.')}
    ${field('Note (optional)', `<textarea id="ga-note" rows="2" placeholder="e.g. “the back has a zipper”"></textarea>`)}
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
    <label class="rw-check"><input type="checkbox" id="ga-replace" ${remembered.replace ? 'checked' : ''}> Replace the original (hide it or fill behind it)</label>
  </aside>
</div>
<footer class="rw-footer"><span class="ga-foot">The turned object is added as a new layer where the original stands.</span><span class="rw-spacer"></span><button id="ga-cancel" type="button">Cancel</button><button id="ga-apply" type="button" class="primary" disabled>Add Layer</button></footer>`,
  );
  const q = ws.q;
  const view = new DocView(q('.ga-view'), W, H);
  view.canvas.setAttribute('aria-label', 'Preview of the turned object in place');
  const hint = q('#ga-hint'),
    objNote = q('#ga-object-note'),
    apply = q<HTMLButtonElement>('#ga-apply'),
    noteBox = q<HTMLTextAreaElement>('#ga-note'),
    yawBox = q<HTMLInputElement>('#ga-yaw');
  noteBox.value = remembered.note;
  const dial = turntable(q('#ga-dial'), remembered.yaw, (v) => {
    remembered.yaw = v;
    yawBox.value = String(v);
  });
  yawBox.addEventListener('change', () => {
    const v = Math.round(normAngle(Number(yawBox.value) || 0));
    yawBox.value = String(v);
    remembered.yaw = v;
    dial.set(v, false);
  });
  bindRanges(ws.dialog, (id, v) => {
    if (id === 'ga-tilt') remembered.tilt = v;
  });

  let src: Source | undefined;
  let obj: CutObject | undefined;
  let objMask: Mask8 | undefined;
  // The visible picture, and a copy scaled to the view for drawing.
  let visible: RGBA8 | undefined;
  let baseCanvas: OffscreenCanvas | undefined;
  const rescale = async () => {
    if (!visible) return;
    baseCanvas = await previewBitmap(visible, view.canvas.width, view.canvas.height);
    draw();
  };
  let turned: Turned[] = [];
  let shown = -1;
  let prep: AbortController | undefined;
  const found: { list?: DetectedObject[] } = {};
  const replace = () => q<HTMLInputElement>('#ga-replace').checked;

  const drawScene = (g: CanvasRenderingContext2D, which: number) => {
    const w = g.canvas.width,
      h = g.canvas.height,
      k = w / W;
    g.clearRect(0, 0, w, h);
    if (baseCanvas) g.drawImage(baseCanvas, 0, 0, w, h);
    const tr = turned[which];
    if (!tr) return;
    // Preview of replacing: the original's box dimmed (the fill is made on apply).
    if (replace() && obj && mode !== 'layer') {
      g.fillStyle = '#80808099';
      g.fillRect(obj.rect.x * k, obj.rect.y * k, obj.rect.width * k, obj.rect.height * k);
    }
    g.imageSmoothingQuality = 'high';
    g.drawImage(tr.canvas, tr.rect.x * k, tr.rect.y * k, tr.rect.width * k, tr.rect.height * k);
  };
  const draw = () => drawScene(view.ctx, shown);
  const gen = new Generator(
    q<HTMLButtonElement>('#ga-generate'),
    q('#ai-status'),
    { idle: 'Generate', again: 'Generate More' },
    (on) => (noteBox.disabled = on),
  );
  const picker = new VariationPicker(
    q('.ga-results'),
    (k) => {
      shown = k;
      apply.disabled = false;
      draw();
    },
    'Turned variations appear here.',
  );
  const setHint = (t: string) => {
    hint.textContent = t;
    hint.hidden = !t;
  };
  const prepare = async (at?: [number, number]) => {
    prep?.abort();
    gen.stop(false);
    const ac = (prep = new AbortController());
    obj = objMask = undefined;
    turned = [];
    shown = -1;
    apply.disabled = true;
    picker.clear();
    try {
      if (!src || at === undefined) {
        gen.say('Reading the image…', 'busy');
        src = await sourceFor(e, mode, true);
        found.list = undefined;
        // The visible picture: with a cut-out layer, its background plus the layer.
        visible = mode === 'layer' ? await mergedImage(e) : src.base;
        await rescale();
      }
      if (ac.signal.aborted) return;
      draw();
      if (mode === 'click' && !at) {
        gen.say('');
        setHint('Click the object to turn.');
        objNote.textContent = 'Click an object in the preview to pick it.';
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
        if (mode === 'click') setHint('Click the object to turn.');
        return;
      }
      const pixels =
        mode === 'layer' && src.layer?.pixels
          ? readRGBA(e.assets.tiles, src.layer.pixels, canvasRect(e.doc))
          : src.base;
      const cut = cutObject(pixels, m, 16);
      if (!cut || cut.rect.width < 8 || cut.rect.height < 8) {
        gen.say('The object is too small. Choose a larger one.', 'error');
        return;
      }
      obj = cut;
      objMask = m;
      objNote.textContent = `${cut.rect.width} × ${cut.rect.height} px object${Math.max(cut.rect.width, cut.rect.height) > EDIT_MAX_SIDE ? ' (results come back smaller and are enlarged to fit)' : ''}.`;
      gen.say('Set the turn and tilt, then generate.');
      draw();
    } catch (error) {
      if (ac.signal.aborted) return;
      gen.say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      if (prep === ac) prep = undefined;
    }
  };
  q<HTMLSelectElement>('#ga-mode').addEventListener('change', (ev) => {
    mode = (ev.target as HTMLSelectElement).value as ObjectMode;
    src = undefined;
    void prepare();
  });
  view.canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || mode !== 'click' || !src || prep) return;
    void prepare(view.point(ev));
  });
  q<HTMLInputElement>('#ga-replace').addEventListener('change', () => {
    remembered.replace = replace();
    draw();
  });
  q<HTMLSelectElement>('#ga-count').addEventListener(
    'change',
    (ev) => (remembered.count = Number((ev.target as HTMLSelectElement).value) || 1),
  );
  noteBox.addEventListener('input', () => (remembered.note = noteBox.value));
  const onResize = () => {
    view.fit();
    void rescale();
  };
  window.addEventListener('resize', onResize);

  q('#ga-generate').addEventListener('click', () => {
    if (!gen.running && !obj) return gen.say('Pick an object first.', 'error');
    const yaw = remembered.yaw,
      tilt = remembered.tilt,
      count = remembered.count,
      note = noteBox.value.trim();
    if (!gen.running && !yaw && !tilt) return gen.say('Set a turn or a tilt first.', 'error');
    const o = obj!;
    void gen.toggle(
      async (signal, say) => {
        say(
          `Generating ${count === 1 ? 'one variation' : `${count} variations`}… this can take a little while.`,
        );
        const out = await instructedEdits(onBackdrop(o), rotatePrompt(yaw, tilt, note), {
          count,
          signal,
          native: true,
        });
        say('Removing the backdrop…');
        const list: Turned[] = [];
        for (const img of out) {
          if (signal.aborted) break;
          // The app's background removal finds the object on the plain backdrop.
          const copy = {
            width: img.width,
            height: img.height,
            data: new Uint8ClampedArray(img.data),
          };
          const m = await channel('heavy').call<Mask8>(
            'subject',
            { img: copy },
            { transfer: buffersOf(copy), signal },
          );
          const cutOut = cutObject(img, m, 8);
          if (!cutOut) continue;
          const rect = alignToOriginal(o.rect, cutOut.rect, tilt);
          const fitted = await runJob<RGBA8>({ signal, progress: () => {} }, 'resize', {
            img: cutOut.img,
            width: rect.width,
            height: rect.height,
          });
          list.push({ img: fitted, rect, yaw, tilt, note, canvas: canvasOf(fitted) });
        }
        if (!list.length)
          throw new Error(
            'The object could not be separated from the backdrop in any result. Try again or change the angles.',
          );
        return { list, count, arrived: out.length };
      },
      (r) => {
        void recordGeneration(
          e,
          {
            kind: 'rotate',
            prompt: r.list[0].note,
            settings: {
              dialog: 'rotate',
              yaw: r.list[0].yaw,
              tilt: r.list[0].tilt,
              count: r.count,
            },
            placement: { ...r.list[0].rect },
          },
          r.list.map((t) => t.img),
        );
        turned = [...turned, ...r.list].slice(-8);
        picker.show(
          turned.map((t, i) => ({
            label: `${turnLabel(t.yaw, t.tilt)} (${i + 1})`,
            width: t.img.width,
            height: t.img.height,
            draw: (g) => g.drawImage(t.canvas, 0, 0, g.canvas.width, g.canvas.height),
          })),
          turned.length - r.list.length,
        );
        gen.say(
          r.list.length < r.count
            ? `${r.list.length} of ${r.count} variations could be used.`
            : 'Pick a variation, then add the layer.',
        );
      },
    );
  });

  let chosen: Turned | undefined;
  q('#ga-cancel').addEventListener('click', () => ws.close());
  apply.addEventListener('click', () => {
    if (shown < 0) return;
    chosen = turned[shown];
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
  if (!chosen || !obj || !objMask || !src) return;
  await addTurned(e, { src, obj, objMask, mode, chosen, replace: remembered.replace });
}

async function addTurned(
  e: Editor,
  r: {
    src: Source;
    obj: CutObject;
    objMask: Mask8;
    mode: ObjectMode;
    chosen: Turned;
    replace: boolean;
  },
) {
  const tiles = e.assets.tiles;
  const base = r.src.layer?.name ?? 'Object';
  const turnedLayer = newPixelLayer(
    shortName(turnLabel(r.chosen.yaw, r.chosen.tilt), base),
    e.doc,
    gridFromImage(tiles, r.chosen.img, r.chosen.rect.x, r.chosen.rect.y),
  );
  turnedLayer.generated = {
    kind: 'rotate',
    prompt: [turnLabel(r.chosen.yaw, r.chosen.tilt), r.chosen.note]
      .filter(Boolean)
      .join('. ')
      .slice(0, 4000),
  };
  const layers = [turnedLayer];
  let hide: string | undefined;
  if (r.replace && r.mode === 'layer')
    hide = replaceable(e, r.src.layer) ? r.src.layer!.id : undefined;
  else if (r.replace) {
    const hole = vacatedMask(r.objMask, vacatedGrow(r.obj.rect));
    const box = boundingBox(hole);
    if (box) {
      const filled = await withProgress(e, 'Filling behind the object', (job) =>
        fillHole(r.src.base, hole, box, job.signal, job.progress),
      );
      if (!filled) return;
      const p = cropRGBA(filled, box),
        m = cropMask(hole, box);
      for (let i = 0; i < m.data.length; i++)
        p.data[i * 4 + 3] = Math.min(p.data[i * 4 + 3], m.data[i]);
      layers.unshift(
        newPixelLayer(shortName('Fill behind', base), e.doc, gridFromImage(tiles, p, box.x, box.y)),
      );
    }
  }
  addLayers(e, 'Rotate Object', layers, r.src.layer?.id ?? e.selected, hide);
  e.message(
    `The turned object was added as a new layer${layers.length > 1 ? ' over a fill of its old place' : hide ? ' and the original layer was hidden' : ''}.`,
  );
}
