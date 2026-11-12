// The color picker dialog: a saturation/brightness field with a component
// strip (any of H, S, B, L, a, b, R, G, B), numeric HSB/RGB/Lab/CMYK/hex
// entry, a printable-color (CMYK gamut) warning with one-click correction,
// web-safe snapping, Add to Swatches and sampling from the canvas while the
// dialog is open. Values are document RGB, the space painting tools use.
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import {
  builtinProfile,
  cachedTransform,
  colorInfo,
  decodeLab,
  encodeLab,
  hsbToRgb,
  parseHex,
  toHex,
  type Profile,
} from '../../color/color-management';
import { docCmykRef, docProfile, ensureProfile, profileReady } from './profiles';
import { AXES, fromRgb, positions, renderField, renderStrip, stateAt, webSafe, type Axis, type LabConverter, type PickerState, type RGB } from './picker-model';
import { compositeRGBA } from '../pixels';

const AXIS_LABEL: Record<Axis, string> = { h: 'H', s: 'S', v: 'B', r: 'R', g: 'G', b: 'B', L: 'L', A: 'a', B: 'b' };
const AXIS_TITLE: Record<Axis, string> = {
  h: 'Hue (degrees)', s: 'Saturation (%)', v: 'Brightness (%)', r: 'Red', g: 'Green', b: 'Blue', L: 'Lightness', A: 'a (green–red)', B: 'b (blue–yellow)',
};
const AXIS_RANGE: Record<Axis, [number, number]> = { h: [0, 359], s: [0, 100], v: [0, 100], r: [0, 255], g: [0, 255], b: [0, 255], L: [0, 100], A: [-128, 127], B: [-128, 127] };
const FIELD = 256;

let lastAxis: Axis = 'h';
let onlyWeb = false;
try {
  const a = localStorage.getItem('photo-studio-picker-axis') as Axis | null;
  if (a && AXES.includes(a)) lastAxis = a;
} catch {
  /* Optional. */
}

export function labConverter(doc: Profile): LabConverter {
  const lab = builtinProfile('lab-d50');
  const toRgbT = cachedTransform(lab, doc, 'relative');
  const toLabT = cachedTransform(doc, lab, 'relative');
  return {
    toRgb(values, count, out) {
      const enc = new Float32Array(count * 3);
      const tmp = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        encodeLab([values[i * 3], values[i * 3 + 1], values[i * 3 + 2]], 'v4', tmp);
        enc[i * 3] = tmp[0];
        enc[i * 3 + 1] = tmp[1];
        enc[i * 3 + 2] = tmp[2];
      }
      toRgbT.apply(enc, out, count);
    },
    toLab(rgb) {
      const v = decodeLab(toLabT.one([rgb[0] / 255, rgb[1] / 255, rgb[2] / 255]), 'v4');
      return [v[0], v[1], v[2]];
    },
  };
}

const warnIcon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="#f5c400" stroke="#222" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 9v6M12 17.6v.4" stroke="#222" stroke-width="2" stroke-linecap="round"/></svg>`;
const cubeIcon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7l9-4.5Z" fill="#9ad" stroke="#223" stroke-width="1.2" stroke-linejoin="round"/><path d="M3 7l9 4.5L21 7M12 11.5v10" fill="none" stroke="#223" stroke-width="1.2"/></svg>`;

/**
 * Open the color picker. Resolves with the chosen color (#rrggbb, document
 * RGB) or null when cancelled. Safe to call while another dialog is open.
 */
export async function pickColor(e: Editor, initial: string, title = 'Color Picker'): Promise<string | null> {
  const doc = docProfile(e.doc);
  const ref = docCmykRef(e.doc);
  if (!profileReady(ref)) e.message('Preparing the CMYK profile…');
  const cmyk = await ensureProfile(ref);
  const lab = labConverter(doc);
  const fromCmyk = cachedTransform(cmyk, doc, 'relative', { bpc: true });
  let start: RGB;
  try {
    start = parseHex(initial);
  } catch {
    start = [0, 0, 0];
  }
  const current = fromRgb(start, undefined, lab);
  let state: PickerState = current;
  let axis = lastAxis;
  const dialog = document.createElement('dialog');
  dialog.className = 'color-picker-dialog';
  dialog.setAttribute('aria-label', title);
  const num = (id: string, label: string, min: number, max: number, unit = '', ariaLabel = label) =>
    `<label class="cp-num"><span>${label}</span><input data-f="${id}" type="number" min="${min}" max="${max}" step="1" aria-label="${escapeXML(ariaLabel)}"><em>${unit}</em></label>`;
  const radio = (a: Axis, unit = '') =>
    `<label class="cp-num"><input type="radio" name="cp-axis" value="${a}" ${a === axis ? 'checked' : ''} aria-label="Field shows ${AXIS_TITLE[a]}"><span>${AXIS_LABEL[a]}</span><input data-f="${a}" type="number" min="${AXIS_RANGE[a][0]}" max="${AXIS_RANGE[a][1]}" step="1" aria-label="${AXIS_TITLE[a]}"><em>${unit}</em></label>`;
  dialog.innerHTML = `<form method="dialog" class="cp-form">
    <h2>${escapeXML(title)}</h2>
    <div class="cp-body">
      <div class="cp-field-wrap"><canvas class="cp-field" width="${FIELD}" height="${FIELD}" tabindex="0" role="slider" aria-label="Color field"></canvas><span class="cp-ring"></span></div>
      <div class="cp-strip-wrap"><canvas class="cp-strip" width="1" height="${FIELD}" tabindex="0" role="slider" aria-label="Color component"></canvas><span class="cp-arrow"></span></div>
      <div class="cp-side">
        <div class="cp-compare"><span class="muted">new</span><button type="button" class="cp-new" aria-label="New color"></button><button type="button" class="cp-old" aria-label="Current color (click to restore)" title="Restore current color"></button><span class="muted">current</span></div>
        <div class="cp-warnings">
          <button type="button" class="cp-gamut" hidden title="Not printable with the CMYK profile. Click to use the closest printable color.">${warnIcon}<span class="cp-gamut-swatch"></span></button>
          <button type="button" class="cp-web" hidden title="Not a web-safe color. Click to use the closest web-safe color.">${cubeIcon}<span class="cp-web-swatch"></span></button>
        </div>
        <div class="cp-actions">
          <button type="submit" class="primary">OK</button>
          <button type="button" class="cp-cancel">Cancel</button>
          <button type="button" class="cp-add">Add to Swatches</button>
        </div>
      </div>
    </div>
    <div class="cp-values">
      <div class="cp-col">${radio('h', '°')}${radio('s', '%')}${radio('v', '%')}${radio('r')}${radio('g')}${radio('b')}</div>
      <div class="cp-col">${radio('L')}${radio('A')}${radio('B')}${num('c', 'C', 0, 100, '%', 'Cyan (%)')}${num('m', 'M', 0, 100, '%', 'Magenta (%)')}${num('y', 'Y', 0, 100, '%', 'Yellow (%)')}${num('k', 'K', 0, 100, '%', 'Black (%)')}</div>
    </div>
    <div class="cp-footer">
      <label class="cp-hex"># <input data-f="hex" maxlength="7" spellcheck="false" aria-label="Hex color"></label>
      <label class="cp-check"><input type="checkbox" class="cp-only-web" ${onlyWeb ? 'checked' : ''}> Only web colors</label>
    </div>
    <p class="cp-hint muted">Click the image outside this dialog to sample a color. CMYK values use ${escapeXML(cmyk.name)}.</p>
  </form>`;
  (e.root.isConnected ? e.root : document.body).append(dialog);
  const q = <T extends HTMLElement = HTMLElement>(s: string) => dialog.querySelector<T>(s)!;
  const field = q<HTMLCanvasElement>('.cp-field'),
    strip = q<HTMLCanvasElement>('.cp-strip');
  const fieldCtx = field.getContext('2d')!,
    stripCtx = strip.getContext('2d')!;
  let fieldKey = '';

  const info = () => colorInfo(state.rgb, doc, { cmykProfile: cmyk });
  const paint = (skip?: string) => {
    const p = positions(state, axis);
    const key = `${axis}:${p.z.toFixed(4)}:${axis === 'h' ? '' : axis === 's' || axis === 'v' ? `${state.hsb.h}` : ''}`;
    if (key !== fieldKey || ['r', 'g', 'b', 'L', 'A', 'B'].includes(axis)) {
      // Lab fields are rendered at half resolution (a profile conversion per
      // sample) and scaled up by the canvas.
      const lowRes = axis === 'L' || axis === 'A' || axis === 'B';
      const size = lowRes ? FIELD / 2 : FIELD;
      if (field.width !== size) field.width = field.height = size;
      const px = renderField(axis, p.z, size, size, state, lab);
      fieldCtx.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
      fieldKey = key;
    }
    stripCtx.putImageData(new ImageData(renderStrip(axis, FIELD, state, lab) as Uint8ClampedArray<ArrayBuffer>, 1, FIELD), 0, 0);
    const ring = q('.cp-ring'),
      arrow = q('.cp-arrow');
    ring.style.left = `${p.x * 100}%`;
    ring.style.top = `${p.y * 100}%`;
    ring.classList.toggle('light', state.lab[0] < 55);
    arrow.style.top = `${(1 - p.z) * 100}%`;
    field.setAttribute('aria-valuetext', toHex(state.rgb));
    strip.setAttribute('aria-valuetext', `${AXIS_TITLE[axis]} ${Math.round(axisValue(axis))}`);
    const hex = toHex(state.rgb);
    q('.cp-new').style.background = hex;
    q('.cp-old').style.background = toHex(current.rgb);
    const i = info();
    const cmykEditing = skip !== undefined && 'cmyk'.includes(skip) && skip.length === 1;
    const set = (f: string, v: number | string) => {
      // While typing ink values the four CMYK fields keep what was typed: a
      // CMYK -> RGB -> CMYK round trip regenerates black differently.
      if (f === skip || (cmykEditing && f.length === 1 && 'cmyk'.includes(f))) return;
      const input = dialog.querySelector<HTMLInputElement>(`[data-f="${f}"]`)!;
      input.value = String(v);
    };
    set('h', Math.round(state.hsb.h) % 360);
    set('s', Math.round(state.hsb.s));
    set('v', Math.round(state.hsb.b));
    set('r', state.rgb[0]);
    set('g', state.rgb[1]);
    set('b', state.rgb[2]);
    set('L', Math.round(state.lab[0]));
    set('A', Math.round(state.lab[1]));
    set('B', Math.round(state.lab[2]));
    set('c', Math.round(i.cmyk.c));
    set('m', Math.round(i.cmyk.m));
    set('y', Math.round(i.cmyk.y));
    set('k', Math.round(i.cmyk.k));
    set('hex', hex.slice(1));
    const gamut = q<HTMLButtonElement>('.cp-gamut');
    gamut.hidden = !i.outOfGamutForCMYK;
    if (i.outOfGamutForCMYK) q('.cp-gamut-swatch').style.background = toHex(printable(state.rgb));
    const web = q<HTMLButtonElement>('.cp-web');
    web.hidden = i.webSafe.exact;
    q('.cp-web-swatch').style.background = i.webSafe.hex;
  };
  const axisValue = (a: Axis) => (a === 'h' ? state.hsb.h : a === 's' ? state.hsb.s : a === 'v' ? state.hsb.b : a === 'r' ? state.rgb[0] : a === 'g' ? state.rgb[1] : a === 'b' ? state.rgb[2] : a === 'L' ? state.lab[0] : a === 'A' ? state.lab[1] : state.lab[2]);
  const printable = (rgb: RGB): RGB => {
    const n = rgb.map((v) => v / 255);
    // Relative colorimetric with black point compensation, the same round
    // trip the warning tests, so the corrected color is printable by it.
    const c = cachedTransform(doc, cmyk, 'relative', { bpc: true }).one(n);
    return cachedTransform(cmyk, doc, 'relative', { bpc: true }).one(c).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) as RGB;
  };
  const commit = (next: PickerState, skip?: string) => {
    state = onlyWeb ? fromRgb(webSafe(next.rgb), next, lab) : next;
    paint(skip);
  };
  const setRgb = (rgb: RGB, skip?: string) => commit(fromRgb(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as RGB, state, lab), skip);

  // Field and strip dragging.
  const drag = (el: HTMLElement, move: (x: number, y: number) => void) => {
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      el.setPointerCapture(ev.pointerId);
      el.focus();
      const at = (p: PointerEvent) => {
        const r = el.getBoundingClientRect();
        move(Math.max(0, Math.min(1, (p.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (p.clientY - r.top) / r.height)));
      };
      at(ev);
      const mv = (p: PointerEvent) => at(p);
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  };
  drag(field, (x, y) => commit(stateAt(axis, positions(state, axis).z, x, y, state, lab)));
  drag(strip, (_x, y) => {
    const p = positions(state, axis);
    commit(stateAt(axis, Math.min(1 - y, axis === 'h' ? 359.5 / 360 : 1), p.x, p.y, state, lab));
  });
  field.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.1 : 1 / 100;
    const p = positions(state, axis);
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
    if (!d) return;
    ev.preventDefault();
    commit(stateAt(axis, p.z, Math.max(0, Math.min(1, p.x + d[0])), Math.max(0, Math.min(1, p.y + d[1])), state, lab));
  });
  strip.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 0.1 : 1 / 100;
    const d = ev.key === 'ArrowUp' ? step : ev.key === 'ArrowDown' ? -step : 0;
    if (!d) return;
    ev.preventDefault();
    const p = positions(state, axis);
    commit(stateAt(axis, Math.max(0, Math.min(axis === 'h' ? 359.5 / 360 : 1, p.z + d)), p.x, p.y, state, lab));
  });
  dialog.querySelectorAll<HTMLInputElement>('input[name="cp-axis"]').forEach((r) =>
    r.addEventListener('change', () => {
      axis = r.value as Axis;
      lastAxis = axis;
      try {
        localStorage.setItem('photo-studio-picker-axis', axis);
      } catch {
        /* Optional. */
      }
      fieldKey = '';
      paint();
    }),
  );
  // Numeric entry.
  dialog.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    const f = t.dataset.f;
    if (!f) return;
    if (f === 'hex') {
      const v = t.value.trim().replace(/^#/, '');
      if (/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) setRgb(parseHex(v), 'hex');
      return;
    }
    if (t.value === '' || !Number.isFinite(Number(t.value))) return;
    const n = Number(t.value);
    const clampTo = (a: Axis) => Math.max(AXIS_RANGE[a][0], Math.min(AXIS_RANGE[a][1], n));
    if (f === 'h' || f === 's' || f === 'v') {
      const hsb = { ...state.hsb, [f === 'v' ? 'b' : f]: clampTo(f) };
      const rgb = hsbToRgb(hsb.h, hsb.s, hsb.b).map((c) => Math.round(c)) as RGB;
      commit({ hsb, rgb, lab: lab.toLab(rgb) }, f);
    } else if (f === 'r' || f === 'g' || f === 'b') {
      const rgb = [...state.rgb] as RGB;
      rgb['rgb'.indexOf(f)] = clampTo(f);
      setRgb(rgb, f);
    } else if (f === 'L' || f === 'A' || f === 'B') {
      const l = [...state.lab] as [number, number, number];
      l['LAB'.indexOf(f)] = clampTo(f);
      const out = new Float32Array(3);
      lab.toRgb(l, 1, out);
      const rgb = [...out].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)) as RGB;
      commit({ ...fromRgb(rgb, state, lab), lab: l }, f);
    } else if ('cmyk'.includes(f)) {
      const v = ['c', 'm', 'y', 'k'].map((k) => Math.max(0, Math.min(100, Number(dialog.querySelector<HTMLInputElement>(`[data-f="${k}"]`)!.value) || 0)));
      const rgb = fromCmyk.one(v.map((x) => x / 100)).map((x) => Math.max(0, Math.min(1, x)) * 255) as RGB;
      setRgb(rgb, f);
    }
  });
  dialog.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement;
    const f = t.dataset.f;
    // Normalize the fields once editing ends, but keep typed ink values.
    if (f) paint(f.length === 1 && 'cmyk'.includes(f) ? f : undefined);
  });
  q('.cp-only-web').addEventListener('change', (ev) => {
    onlyWeb = (ev.target as HTMLInputElement).checked;
    if (onlyWeb) setRgb(webSafe(state.rgb));
  });
  q('.cp-gamut').addEventListener('click', () => setRgb(printable(state.rgb)));
  q('.cp-web').addEventListener('click', () => setRgb(webSafe(state.rgb)));
  q('.cp-old').addEventListener('click', () => commit(current));
  q('.cp-add').addEventListener('click', async () => {
    const { addSwatch } = await import('../panels');
    addSwatch(e, toHex(state.rgb));
    e.message(`Added ${toHex(state.rgb)} to Swatches`);
  });

  // Sampling: clicks on the backdrop over the canvas pick the document color.
  let snapshot: ReturnType<typeof compositeRGBA> | undefined;
  dialog.addEventListener('pointerdown', async (ev) => {
    if (ev.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) return;
    if (!e.hasDocument || !e.renderer) return;
    const [x, y] = e.docPoint(ev.clientX, ev.clientY).map(Math.floor);
    if (x < 0 || y < 0 || x >= e.doc.width || y >= e.doc.height) return;
    ev.preventDefault();
    snapshot ??= compositeRGBA(e);
    const img = await snapshot;
    const i = (y * img.width + x) * 4;
    if (img.data[i + 3] === 0) {
      e.message('That pixel is transparent.');
      return;
    }
    setRgb([img.data[i], img.data[i + 1], img.data[i + 2]]);
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      dialog.close();
      dialog.remove();
      resolve(v);
    };
    q('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      finish(toHex(state.rgb));
    });
    q('.cp-cancel').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      finish(null);
    });
    dialog.addEventListener('keydown', (ev) => {
      // Enter in a numeric field accepts, as in other dialogs.
      if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input[type=number],input[data-f=hex]')) {
        ev.preventDefault();
        finish(toHex(state.rgb));
      }
    });
    dialog.showModal();
    paint();
    field.focus();
  });
}
