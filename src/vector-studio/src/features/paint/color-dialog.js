/**
 * Color Picker dialog (double-click the fill or stroke in the Tools panel):
 * a large color field and a channel strip for the chosen H, S, B, R, G or B
 * channel, HSB / RGB / CMYK / hex fields, new versus original preview,
 * Only Web Colors, and a Color Swatches view. Resolves to '#rrggbb' or null.
 */
import { h } from '../../lib/dom.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, cmykEngine, isHex, normalizeHex, webSafe, clamp } from '../../lib/color.js';
import { paintSwatch } from '../../ui/widgets.js';

const SIZE = 256;
const HSB_KEYS = ['h', 's', 'v'];

/** Color at field (x, y) in [0,1] and strip value t in [0,1] (0 = top) for a channel. */
export function fieldColor(channel, x, y, t) {
  const X = clamp(x, 0, 1);
  const Y = clamp(y, 0, 1);
  const T = clamp(t, 0, 1);
  switch (channel) {
    case 'h':
      return hsbToRgb({ h: (1 - T) * 360, s: X * 100, v: (1 - Y) * 100 });
    case 's':
      return hsbToRgb({ h: X * 360, s: (1 - T) * 100, v: (1 - Y) * 100 });
    case 'v':
      return hsbToRgb({ h: X * 360, s: (1 - Y) * 100, v: (1 - T) * 100 });
    case 'r':
      return { r: (1 - T) * 255, g: (1 - Y) * 255, b: X * 255 };
    case 'g':
      return { r: (1 - Y) * 255, g: (1 - T) * 255, b: X * 255 };
    case 'b':
    default:
      return { r: X * 255, g: (1 - Y) * 255, b: (1 - T) * 255 };
  }
}

/** Field position and strip value for a color. */
export function fieldPosition(channel, rgb, hsb) {
  switch (channel) {
    case 'h':
      return { x: hsb.s / 100, y: 1 - hsb.v / 100, t: 1 - hsb.h / 360 };
    case 's':
      return { x: hsb.h / 360, y: 1 - hsb.v / 100, t: 1 - hsb.s / 100 };
    case 'v':
      return { x: hsb.h / 360, y: 1 - hsb.s / 100, t: 1 - hsb.v / 100 };
    case 'r':
      return { x: rgb.b / 255, y: 1 - rgb.g / 255, t: 1 - rgb.r / 255 };
    case 'g':
      return { x: rgb.b / 255, y: 1 - rgb.r / 255, t: 1 - rgb.g / 255 };
    default:
      return { x: rgb.r / 255, y: 1 - rgb.g / 255, t: 1 - rgb.b / 255 };
  }
}

export function openColorPickerDialog(app, { value = '#000000', title = 'Color Picker', swatches = [] } = {}) {
  const original = normalizeHex(value);
  let hsb = rgbToHsb(hexToRgb(original));
  let rgb = hexToRgb(original);
  let channel = app.prefs?.get('colorPickerChannel') || 'h';
  let webOnly = false;

  const field = h('canvas.cpd-field', { width: SIZE, height: SIZE });
  const fieldKnob = h('div.cpd-knob', { role: 'slider', tabindex: '0', 'aria-label': 'Color field', 'aria-valuemin': '0', 'aria-valuemax': '100' });
  const fieldWrap = h('div.cpd-field-wrap', field, fieldKnob);
  const strip = h('canvas.cpd-strip', { width: 20, height: SIZE });
  const stripKnob = h('div.cpd-strip-knob');
  const stripWrap = h('div.cpd-strip-wrap', { role: 'slider', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Channel slider', 'aria-valuemin': '0', 'aria-valuemax': '100' }, strip, stripKnob);
  const newPrev = h('button.cpd-new', { type: 'button', tabindex: '-1', 'aria-hidden': 'true' });
  const oldPrev = h('button.cpd-old', { type: 'button', 'aria-label': 'Restore the original color', 'data-tip': 'Original color: click to restore', onclick: () => setHex(original) });
  oldPrev.style.background = original;

  const mk = (label, key, unit, max) => {
    const id = `cpd-${key}-${Math.random().toString(36).slice(2, 6)}`;
    const input = h('input.cpd-num', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': `${label}` });
    const radio = ['h', 's', 'v', 'r', 'g', 'b'].includes(key)
      ? h('input', { type: 'radio', name: 'cpd-channel', value: key, checked: key === channel, 'aria-label': `Use ${label} for the color slider`, onchange: () => setChannel(key) })
      : null;
    input.addEventListener('change', () => fromFields(key, input.value, max));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = Number(input.value) || 0;
        input.value = String(clamp(v + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, max));
        fromFields(key, input.value, max);
      }
    });
    return { key, input, el: h('div.cpd-fieldrow', radio || h('span.cpd-radio-pad'), h('label', { for: id }, label), input, h('span.cpd-unit', unit)) };
  };
  const fields = [mk('H', 'h', '°', 360), mk('S', 's', '%', 100), mk('B', 'v', '%', 100), mk('R', 'r', '', 255), mk('G', 'g', '', 255), mk('B', 'b', '', 255)];
  const cmykFields = [mk('C', 'c', '%', 100), mk('M', 'm', '%', 100), mk('Y', 'y', '%', 100), mk('K', 'k', '%', 100)];
  const hexInput = h('input.cpd-hex', { type: 'text', maxlength: 7, spellcheck: false, autocomplete: 'off', 'aria-label': 'Hexadecimal color' });
  hexInput.addEventListener('change', () => {
    const s = hexInput.value.startsWith('#') ? hexInput.value : `#${hexInput.value}`;
    if (isHex(s)) setHex(normalizeHex(s));
    else sync();
  });
  const webBox = h('input', { type: 'checkbox', id: 'cpd-web', onchange: () => {
    webOnly = webBox.checked;
    if (webOnly) setHex(webSafe(current()));
    else draw();
  } });

  // Swatches view.
  const swatchGrid = h('div.cpd-swatches', { role: 'listbox', 'aria-label': 'Color swatches', hidden: true });
  for (const s of swatches.filter((s) => s.paint?.type === 'solid')) {
    swatchGrid.append(
      h('button.cpd-swatch', { type: 'button', role: 'option', 'aria-label': s.name || s.paint.color, 'data-tip': s.name || s.paint.color, onclick: () => setHex(s.paint.color) }, paintSwatch(s.paint)),
    );
  }
  const left = h('div.cpd-left', h('div.cpd-models', fieldWrap, stripWrap), swatchGrid);
  const viewBtn = h('button.btn.small.cpd-view', { type: 'button', onclick: () => {
    const showSw = swatchGrid.hidden;
    swatchGrid.hidden = !showSw;
    left.querySelector('.cpd-models').hidden = showSw;
    viewBtn.textContent = showSw ? 'Color Models' : 'Color Swatches';
  } }, 'Color Swatches');

  const right = h(
    'div.cpd-right',
    h('div.cpd-previews', { 'aria-hidden': 'false' }, newPrev, oldPrev),
    h('div.cpd-cols', h('div.cpd-col', fields.map((f) => f.el)), h('div.cpd-col', cmykFields.map((f) => f.el))),
    h('div.cpd-hexrow', h('label', { for: 'cpd-hex' }, '#'), hexInput),
    h('div.check-row', webBox, h('label', { for: 'cpd-web' }, 'Only Web Colors')),
    viewBtn,
  );
  hexInput.id = 'cpd-hex';
  const body = h('div.cpd', left, right);

  const fctx = field.getContext('2d');
  const sctx = strip.getContext('2d');
  const current = () => rgbToHex(rgb);

  const drawField = () => {
    if (!fctx) return;
    const pos = fieldPosition(channel, rgb, hsb);
    const img = fctx.createImageData(SIZE, SIZE);
    const d = img.data;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = fieldColor(channel, x / (SIZE - 1), y / (SIZE - 1), pos.t);
        const i = (y * SIZE + x) * 4;
        d[i] = c.r;
        d[i + 1] = c.g;
        d[i + 2] = c.b;
        d[i + 3] = 255;
      }
    }
    fctx.putImageData(img, 0, 0);
  };
  const drawStrip = () => {
    if (!sctx) return;
    const pos = fieldPosition(channel, rgb, hsb);
    for (let y = 0; y < SIZE; y++) {
      const t = y / (SIZE - 1);
      const c = channel === 'h' ? hsbToRgb({ h: (1 - t) * 360, s: 100, v: 100 }) : fieldColor(channel, pos.x, pos.y, t);
      sctx.fillStyle = rgbToHex(c);
      sctx.fillRect(0, y, 20, 1);
    }
  };
  const draw = () => {
    drawField();
    drawStrip();
    sync();
  };
  const sync = () => {
    const pos = fieldPosition(channel, rgb, hsb);
    fieldKnob.style.left = `${pos.x * 100}%`;
    fieldKnob.style.top = `${pos.y * 100}%`;
    stripKnob.style.top = `${pos.t * 100}%`;
    fieldKnob.setAttribute('aria-valuetext', current().toUpperCase());
    stripWrap.setAttribute('aria-valuenow', String(Math.round((1 - pos.t) * 100)));
    const hex = current();
    newPrev.style.background = hex;
    const vals = { h: hsb.h, s: hsb.s, v: hsb.v, r: rgb.r, g: rgb.g, b: rgb.b };
    const cm = cmykEngine.toCmyk(rgb);
    for (const f of fields) if (document.activeElement !== f.input) f.input.value = String(Math.round(vals[f.key]));
    for (const f of cmykFields) if (document.activeElement !== f.input) f.input.value = String(Math.round(cm[f.key]));
    if (document.activeElement !== hexInput) hexInput.value = hex.slice(1).toUpperCase();
  };
  const setRgb = (c, keepHue = true) => {
    let hex = rgbToHex(c);
    if (webOnly) hex = webSafe(hex);
    rgb = hexToRgb(hex);
    const next = rgbToHsb(rgb);
    if (keepHue && (next.s === 0 || next.v === 0)) next.h = hsb.h;
    if (keepHue && next.v === 0) next.s = hsb.s;
    hsb = next;
  };
  const setHsb = (next) => {
    if (webOnly) {
      setRgb(hsbToRgb(next));
      return;
    }
    hsb = { h: clamp(next.h, 0, 360), s: clamp(next.s, 0, 100), v: clamp(next.v, 0, 100) };
    rgb = hexToRgb(rgbToHex(hsbToRgb(hsb)));
  };
  const setHex = (hex) => {
    setRgb(hexToRgb(hex));
    draw();
  };
  const setChannel = (c) => {
    channel = c;
    app.prefs?.set('colorPickerChannel', c);
    draw();
  };
  const fromFields = (key, text, max) => {
    const v = clamp(Number(String(text).replace(/[%°]/g, '')) || 0, 0, max);
    if (HSB_KEYS.includes(key)) setHsb({ ...hsb, [key]: v });
    else if (['r', 'g', 'b'].includes(key)) setRgb({ ...rgb, [key]: v });
    else {
      const cm = { ...cmykEngine.toCmyk(rgb), [key]: v };
      setRgb(cmykEngine.toRgb(cm));
    }
    draw();
  };
  const fromField = (x, y) => {
    const pos = fieldPosition(channel, rgb, hsb);
    if (HSB_KEYS.includes(channel)) {
      const c = { ...hsb };
      if (channel === 'h') Object.assign(c, { s: x * 100, v: (1 - y) * 100 });
      if (channel === 's') Object.assign(c, { h: x * 360, v: (1 - y) * 100 });
      if (channel === 'v') Object.assign(c, { h: x * 360, s: (1 - y) * 100 });
      setHsb(c);
      drawStrip();
    } else {
      setRgb(fieldColor(channel, x, y, pos.t));
      drawStrip();
    }
    sync();
  };
  const fromStrip = (t) => {
    const T = clamp(t, 0, 1);
    if (channel === 'h') setHsb({ ...hsb, h: (1 - T) * 360 });
    else if (channel === 's') setHsb({ ...hsb, s: (1 - T) * 100 });
    else if (channel === 'v') setHsb({ ...hsb, v: (1 - T) * 100 });
    else setRgb({ ...rgb, [channel]: (1 - T) * 255 });
    drawField();
    sync();
  };
  const drag = (el, fn) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      const at = (ev) => fn(clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
      at(e);
      const move = (ev) => at(ev);
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  };
  drag(fieldWrap, (x, y) => fromField(x, y));
  drag(stripWrap, (_x, y) => fromStrip(y));
  fieldKnob.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const pos = fieldPosition(channel, rgb, hsb);
    let { x, y } = pos;
    if (e.key === 'ArrowLeft') x -= step;
    else if (e.key === 'ArrowRight') x += step;
    else if (e.key === 'ArrowUp') y -= step;
    else if (e.key === 'ArrowDown') y += step;
    else return;
    e.preventDefault();
    fromField(clamp(x, 0, 1), clamp(y, 0, 1));
  });
  stripWrap.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const pos = fieldPosition(channel, rgb, hsb);
    if (e.key === 'ArrowUp') fromStrip(pos.t - step);
    else if (e.key === 'ArrowDown') fromStrip(pos.t + step);
    else return;
    e.preventDefault();
  });

  draw();
  return openDialog({
    title,
    className: 'color-picker-dialog',
    body,
    initialFocus: () => fieldKnob,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', primary: true, value: () => current() },
    ],
  });
}
