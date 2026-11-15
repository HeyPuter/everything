// Selection tools built on the segmentation engine: Quick Selection (graph-cut
// brush with live growth), Object Selection (subject segmentation inside a
// drawn region) and Magnetic Lasso (intelligent scissors).
import type { Editor } from '../../editor';
import type { Tool } from '../../app/registry';
import { svg } from '../../app/icons';
import { brushFor, cursor } from '../paint';
import { ants, bindCheck, bindSize, checkbox, sizeField, sizeKeys } from './ui';
import { bindSelectionOptions, commitSelectionMask, finishShape, movableOutline, optionsFor, selectionOp } from '../selection';
import { LiveWire, rasterizePolygon, expand } from '../../imaging/segment';
import { mask8, type Mask8, type RGBA8 } from '../../imaging/types';
import { channel, heavy, buffersOf } from './client';
import { anchorSpacing, edgeStrength, expandRect, outlinePath, pasteMask, pathLength, type Pt } from './logic';
import { mergedImage, selectionMask, sourceImage, sourceKey, cropSafe } from './source';

// ----- Quick Selection -----
type QuickMode = 'new' | 'add' | 'subtract';
const QS = 'quick-selection';
let qs: { key: string; generation: number; ready: Promise<void> } | undefined;
/** Build (or reuse) the Quick Selection graph for the current source in the worker. */
function ensureSelector(e: Editor): Promise<string> {
  const sampleAll = !!e.settings.quickSampleAll;
  const key = sourceKey(e, sampleAll);
  const live = channel('live');
  if (!qs || qs.key !== key || qs.generation !== live.generation) {
    const entry: { key: string; generation: number; ready: Promise<void> } = { key, generation: live.generation, ready: Promise.resolve() };
    entry.ready = (async () => {
      e.message('Analyzing the image…');
      const img = await sourceImage(e, sampleAll);
      const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
      const init = live.call('qs-init', { key, img: copy }, { transfer: buffersOf(copy) });
      entry.generation = live.generation;
      await init;
      if (e.el('#status').textContent === 'Analyzing the image…') e.message('Ready');
    })();
    qs = entry;
    entry.ready.catch(() => {
      if (qs === entry) qs = undefined;
    });
  }
  return qs.ready.then(() => key);
}
type QuickStrokeState = { points: Pt[]; positive: boolean; ready: boolean; inflight?: Promise<void>; dirty: boolean; mask?: Mask8; path: string; done?: boolean; error?: boolean };
let qstroke: QuickStrokeState | undefined;

function quickUpdate(e: Editor) {
  const s = qstroke;
  if (!s || !s.ready) return;
  if (s.inflight) {
    s.dirty = true;
    return;
  }
  s.dirty = false;
  const pts = s.points.slice();
  s.inflight = channel('live')
    .call<Mask8>('qs-update', { key: qs!.key, strokes: [{ points: pts, positive: s.positive }], brushSize: brushFor(QS).size })
    .then((m) => {
      s.mask = m;
      s.path = outlinePath(m);
      e.overlay();
    })
    .catch((error) => {
      s.error = true;
      e.message(error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      s.inflight = undefined;
      if (s.dirty && !s.error) quickUpdate(e);
    });
}
const quickSelectionTool: Tool = {
  id: QS,
  label: 'Quick Selection Tool',
  key: 'W',
  icon: 'quick-select',
  group: 'select',
  cursor: () => 'none',
  options: (e) => {
    const mode = (e.settings.quickMode as QuickMode) ?? 'new';
    const modes: [QuickMode, string, string][] = [
      ['new', 'New selection', 'square'],
      ['add', 'Add to selection (Shift)', 'plus'],
      ['subtract', 'Subtract from selection (Alt)', 'minus'],
    ];
    return `<div class="segmented" role="group" aria-label="Quick Selection mode">${modes.map(([id, label, icon]) => `<button data-quick-mode="${id}" aria-pressed="${mode === id}" title="${label}" aria-label="${label}">${svg(icon, 14)}</button>`).join('')}</div>${sizeField(QS)}${checkbox('qs-all', 'Sample All Layers', !!e.settings.quickSampleAll)}<button data-command="select.mask-refine" ${e.doc.selection ? '' : 'disabled'}>Select and Mask…</button>`;
  },
  bindOptions: ({ e, el }) => {
    el.querySelectorAll<HTMLButtonElement>('[data-quick-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        e.settings.quickMode = b.dataset.quickMode;
        e.options();
      }),
    );
    bindSize(el, QS);
    bindCheck(e, el, 'qs-all', 'quickSampleAll');
  },
  // Analyze the image as soon as the tool is chosen so the first stroke is quick.
  activate: (e) => {
    if (e.hasDocument) ensureSelector(e).catch(() => {});
  },
  deactivate: (e) => {
    e.screenOverlayContent = '';
    e.screenOverlay();
  },
  hover: (e, p) => cursor(e, QS, p),
  keyDown: (e, ev) => sizeKeys(e, QS, ev),
  pointerDown: async (e, p) => {
    const mode = (e.settings.quickMode as QuickMode) ?? 'new';
    const positive = !(p.alt || (mode === 'subtract' && !p.shift));
    const keep = !positive || p.shift || mode === 'add';
    const s: QuickStrokeState = { points: [[p.x, p.y]], positive, ready: false, dirty: false, path: '' };
    qstroke = s;
    const live = channel('live');
    let key: string;
    try {
      key = await ensureSelector(e);
      const existing = keep ? (selectionMask(e) ?? undefined) : undefined;
      await live.call('qs-begin', { key, existing }, { transfer: existing ? buffersOf(existing) : [] });
    } catch (error) {
      qs = undefined;
      if (qstroke === s) qstroke = undefined;
      throw error;
    }
    if (qstroke !== s) return;
    s.ready = true;
    quickUpdate(e);
    if (s.done) await finishQuick(e, s);
  },
  pointerMove: (e, p) => {
    cursor(e, QS, p);
    const s = qstroke;
    if (!s) return;
    for (const q of p.coalesced ?? [p]) s.points.push([q.x, q.y]);
    quickUpdate(e);
  },
  pointerUp: async (e) => {
    const s = qstroke;
    if (!s) return;
    s.done = true;
    if (s.ready) await finishQuick(e, s);
  },
  overlay: (e) => (qstroke?.path ? ants(qstroke.path, e.zoom) : ''),
};
async function finishQuick(e: Editor, s: QuickStrokeState) {
  while (s.inflight) await s.inflight;
  if (s.dirty && !s.error) {
    quickUpdate(e);
    while (s.inflight) await s.inflight;
  }
  if (qstroke === s) qstroke = undefined;
  if (s.mask) {
    commitSelectionMask(e, s.mask, 'replace', 'Quick Selection');
    // The next stroke adds to the selection, so it can be built up stroke by stroke.
    if ((e.settings.quickMode ?? 'new') === 'new') {
      e.settings.quickMode = 'add';
      e.options();
    }
  } else e.overlay();
}

// ----- Object Selection -----
let objectDrag: { start: Pt; points: Pt[]; last: Pt } | undefined;
const objectSelectionTool: Tool = {
  id: 'object-selection',
  label: 'Object Selection Tool',
  key: 'W',
  icon: 'object-select',
  group: 'select',
  cursor: () => 'crosshair',
  options: (e) =>
    optionsFor(
      e,
      `<label>Mode <select id="object-mode"><option value="rect">Rectangle</option><option value="lasso" ${e.settings.objectMode === 'lasso' ? 'selected' : ''}>Lasso</option></select></label>${checkbox('object-all', 'Sample All Layers', e.settings.objectSampleAll !== false)}`,
    ),
  bindOptions: ({ e, el }) => {
    bindSelectionOptions(e, el);
    el.querySelector<HTMLSelectElement>('#object-mode')?.addEventListener('change', (ev) => (e.settings.objectMode = (ev.target as HTMLSelectElement).value));
    bindCheck(e, el, 'object-all', 'objectSampleAll');
  },
  pointerDown: (_e, p) => {
    objectDrag = { start: [p.x, p.y], points: [[p.x, p.y]], last: [p.x, p.y] };
  },
  pointerMove: (e, p) => {
    if (!objectDrag) return;
    objectDrag.last = [p.x, p.y];
    for (const q of p.coalesced ?? [p]) objectDrag.points.push([q.x, q.y]);
    e.overlay();
  },
  pointerUp: async (e, p) => {
    const d = objectDrag;
    objectDrag = undefined;
    e.overlay();
    if (!d) return;
    const lasso = e.settings.objectMode === 'lasso';
    const pts: Pt[] = lasso ? d.points : [d.start, [p.x, d.start[1]], [p.x, p.y], [d.start[0], p.y]];
    const xs = pts.map((q) => q[0]),
      ys = pts.map((q) => q[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    if (box.width < 4 || box.height < 4) {
      e.message(lasso ? 'Draw a loop around an object.' : 'Drag a rectangle around an object.');
      return;
    }
    await e.run(async () => {
      const W = e.doc.width,
        H = e.doc.height;
      // A margin of background around the region lets the segmentation see what
      // the object stands out from (it expects background at the borders).
      const pad = Math.max(8, Math.round(Math.max(box.width, box.height) * 0.08));
      const R = expandRect(box, pad, W, H);
      if (!R) return;
      const local = await heavy<Mask8>(e, 'Selecting object', 'subject', async () => ({ img: cropSafe(await sourceImage(e, e.settings.objectSampleAll !== false), R) }));
      if (!local) return;
      // Keep the result near the drawn region.
      const region = expand(rasterizePolygon(pts.map(([x, y]) => [x - R.x, y - R.y] as Pt), R.width, R.height, true), pad * 0.5);
      let any = 0;
      for (let i = 0; i < local.data.length; i++) {
        local.data[i] = Math.round((local.data[i] * region.data[i]) / 255);
        any |= local.data[i];
      }
      if (!any) {
        e.message('No distinct object found in that region. Try a tighter region or the Quick Selection tool.');
        return;
      }
      finishShape(e, selectionOp(e, p), pasteMask(mask8(W, H), local, R.x, R.y), 'Object Selection');
    });
  },
  overlay: (e) => {
    const d = objectDrag;
    if (!d) return '';
    if (e.settings.objectMode === 'lasso') return ants(d.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(''), e.zoom);
    const [x0, y0] = d.start,
      [x1, y1] = d.last;
    return ants(`M${x0} ${y0}H${x1}V${y1}H${x0}Z`, e.zoom);
  },
};

// ----- Magnetic Lasso -----
type Magnetic = { anchors: Pt[]; fixed: Pt[]; live: Pt[]; op: ReturnType<typeof selectionOp>; wire?: LiveWire; img?: RGBA8; sinceAnchor: number };
let magnetic: Magnetic | undefined;
let wireCache: { key: string; wire: LiveWire; img: RGBA8 } | undefined;
const mset = (e: Editor) => ({
  width: Number(e.settings.magneticWidth ?? 10),
  contrast: Number(e.settings.magneticContrast ?? 10),
  frequency: Number(e.settings.magneticFrequency ?? 57),
});
/** Where the live wire should end: the strongest edge within Width of the
 * pointer when that edge is at least as strong as the Contrast setting. */
function magneticTarget(e: Editor, m: Magnetic, x: number, y: number): Pt {
  const { width, contrast } = mset(e);
  const s = m.wire!.snap(x, y, Math.max(1, width));
  return edgeStrength(m.img!, s[0], s[1]) * 100 >= contrast ? s : [Math.round(x), Math.round(y)];
}
function closeMagnetic(e: Editor) {
  const m = magnetic;
  magnetic = undefined;
  if (!m || !m.wire) return;
  const pts = [...m.fixed];
  if (m.anchors.length > 1) {
    // Close along the image edges back to the start.
    m.wire.setSeed(...m.anchors.at(-1)!);
    pts.push(...m.wire.pathTo(...m.anchors[0]).slice(1));
  }
  e.overlay();
  if (pts.length < 3) return;
  finishShape(e, m.op, rasterizePolygon(pts, e.doc.width, e.doc.height, e.settings.antiAlias !== false), 'Magnetic Lasso');
}
function addAnchor(m: Magnetic, at: Pt) {
  const seg = m.anchors.length ? m.wire!.pathTo(at[0], at[1]) : [at];
  m.fixed.push(...(m.anchors.length ? seg.slice(1) : seg));
  m.anchors.push(at);
  m.wire!.setSeed(at[0], at[1]);
  m.live = [];
  m.sinceAnchor = 0;
}
// Rebuild the fixed path from the anchors (after Backspace).
function rebuild(m: Magnetic) {
  const anchors = m.anchors;
  m.anchors = [];
  m.fixed = [];
  for (const a of anchors) {
    if (m.anchors.length) m.wire!.setSeed(...m.anchors.at(-1)!);
    addAnchor(m, a);
  }
}
let pendingHover: Pt | undefined;
function magneticHover(e: Editor) {
  const at = pendingHover;
  pendingHover = undefined;
  const m = magnetic;
  if (!at || !m?.wire || !m.anchors.length) return;
  const t = magneticTarget(e, m, at[0], at[1]);
  m.live = m.wire.pathTo(t[0], t[1]);
  // Automatic anchors: once the live path is long enough, fix it.
  if (pathLength(m.live) >= anchorSpacing(mset(e).frequency) && m.live.length > 2) {
    const end = m.live[m.live.length - 1];
    m.fixed.push(...m.live.slice(1));
    m.anchors.push(end);
    m.wire.setSeed(end[0], end[1]);
    m.live = [];
  }
  e.overlay();
}
const magneticLassoTool: Tool = {
  id: 'magnetic-lasso',
  label: 'Magnetic Lasso Tool',
  key: 'L',
  icon: 'lasso-magnetic',
  group: 'lasso',
  cursor: () => 'crosshair',
  options: (e) => {
    const s = mset(e);
    return optionsFor(
      e,
      `<label title="Distance from the pointer within which edges are found">Width <input id="mag-width" type="number" min="1" max="256" value="${s.width}"> px</label><label title="Minimum edge contrast to follow">Contrast <input id="mag-contrast" type="number" min="1" max="100" value="${s.contrast}">%</label><label title="How often anchor points are placed automatically">Frequency <input id="mag-frequency" type="number" min="0" max="100" value="${s.frequency}"></label>`,
    );
  },
  bindOptions: ({ e, el }) => {
    bindSelectionOptions(e, el);
    const num = (id: string, key: string, lo: number, hi: number) =>
      el.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (ev) => {
        const v = Number((ev.target as HTMLInputElement).value);
        if (Number.isFinite(v)) e.settings[key] = Math.max(lo, Math.min(hi, v));
      });
    num('mag-width', 'magneticWidth', 1, 256);
    num('mag-contrast', 'magneticContrast', 1, 100);
    num('mag-frequency', 'magneticFrequency', 0, 100);
  },
  deactivate: (e) => {
    magnetic = undefined;
    e.overlay();
  },
  pointerDown: async (e, p) => {
    if (magnetic?.wire) {
      const [sx, sy] = magnetic.anchors[0];
      if (magnetic.anchors.length > 1 && Math.hypot(p.x - sx, p.y - sy) * e.zoom < 9) {
        closeMagnetic(e);
        return;
      }
      addAnchor(magnetic, magneticTarget(e, magnetic, p.x, p.y));
      e.overlay();
      return;
    }
    const m: Magnetic = { anchors: [], fixed: [], live: [], op: selectionOp(e, p), sinceAnchor: 0 };
    magnetic = m;
    const key = sourceKey(e, true);
    if (wireCache?.key !== key) {
      const img = await mergedImage(e);
      wireCache = { key, img, wire: new LiveWire(img) };
    }
    if (magnetic !== m) return;
    m.wire = wireCache.wire;
    m.img = wireCache.img;
    addAnchor(m, magneticTarget(e, m, p.x, p.y));
    e.overlay();
  },
  // Path searches run at most once per frame, for the latest pointer position.
  hover: (e, p) => {
    const first = !pendingHover;
    pendingHover = [p.x, p.y];
    if (first) requestAnimationFrame(() => magneticHover(e));
  },
  // A drag works like moving the pointer with the button released.
  pointerMove: (e, p) => magneticLassoTool.hover!(e, p),
  doubleClick: (e) => closeMagnetic(e),
  keyDown: (e, ev) => {
    const m = magnetic;
    if (!m) return false;
    if (ev.key === 'Enter') closeMagnetic(e);
    else if (ev.key === 'Escape') {
      magnetic = undefined;
      e.overlay();
    } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      m.anchors.pop();
      if (!m.anchors.length) magnetic = undefined;
      else rebuild(m);
      e.overlay();
    } else return false;
    return true;
  },
  overlay: (e) => {
    const m = magnetic;
    if (!m || !m.anchors.length) return '';
    const z = e.zoom,
      all = [...m.fixed, ...m.live.slice(1)];
    const d = all.map((q, i) => `${i ? 'L' : 'M'}${q[0] + 0.5} ${q[1] + 0.5}`).join('');
    const s = 5 / z;
    const marks = m.anchors.map(([x, y], i) => `<rect x="${x + 0.5 - s / 2}" y="${y + 0.5 - s / 2}" width="${s}" height="${s}" class="${i ? 'retouch-anchor' : 'retouch-anchor start'}" stroke-width="${1 / z}"/>`).join('');
    return `${ants(d, z)}<g>${marks}</g>`;
  },
};

export const selectTools = [movableOutline(objectSelectionTool), quickSelectionTool, movableOutline(magneticLassoTool, () => !!magnetic)];
export function resetSelectToolState() {
  qs = undefined;
  wireCache = undefined;
}
