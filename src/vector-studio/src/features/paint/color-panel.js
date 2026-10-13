/**
 * Color panel (F6): edits the focused paint (fill or stroke) of the
 * selection, or the current style when nothing is selected. Grayscale,
 * RGB, HSB, CMYK and Web Safe RGB sliders with ramps and numeric fields, a
 * hex field, a spectrum bar to click-pick, None / White / Black chips, an
 * out-of-web-color warning, Recent Colors, and Swap / Default fill and
 * stroke. The panel menu switches color modes, hides the options (leaving
 * the spectrum), inverts or complements the color and makes a swatch of it.
 * When the focused paint is a gradient, the panel edits the gradient stop
 * selected in the Gradient panel.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { applyStyle, swapFillStroke, defaultFillStroke } from '../../ops/paint-ops.js';
import { isHex, normalizeHex, invert, complement, webSafe, cmykEngine, hexToRgb, rgbToHex } from '../../lib/color.js';
import { MODES, MODE_IDS, spectrumColor, isWebSafe } from './color-modes.js';
import { colorSliders, miniFillStroke, focusedPaint, displayColor, setFocusedColor, gestureKey, paintState } from './ui-common.js';
import { isGradient } from '../../model/gradients.js';
import { recentColorsRow } from './recent-colors.js';
import { findSwatch, tinted } from './swatch-model.js';
import { createSwatchFromFocused } from './swatches-panel.js';

export class ColorPanel extends Panel {
  static id = 'color';
  static title = 'Color';
  static icon = 'palette';
  static placement = 'strip';
  static shortcut = 'F6';

  build() {
    const app = this.app;
    this.mode = app.prefs.get('colorPanelMode') || 'rgb';
    this.coalesce = gestureKey('color');
    this.fs = miniFillStroke(app);
    this.sliders = colorSliders({
      mode: this.mode,
      label: 'Color',
      onStart: () => (this.coalesce = gestureKey('color')),
      onInput: (hex) => this.apply(hex),
    });
    this.modeSel = h(
      'select.select.cp-mode',
      { 'aria-label': 'Color mode', onchange: () => this.setMode(this.modeSel.value) },
      MODE_IDS.map((m) => h('option', { value: m, selected: m === this.mode }, MODES[m].label)),
    );
    this.hex = h('input.cp-hexfield', { type: 'text', spellcheck: false, autocomplete: 'off', maxlength: 7, 'aria-label': 'Hexadecimal color' });
    this.hex.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commitHex();
        this.hex.select();
      }
    });
    this.hex.addEventListener('blur', () => this.commitHex());
    this.webWarn = iconButton('web-warning', 'Out of Web Color Warning: click to use the closest web color', () => {
      const ed = app.editor;
      if (!ed) return;
      this.coalesce = gestureKey('color');
      this.apply(webSafe(this.current));
    }, { className: 'small cp-web-warn' });
    this.gamutWarn = iconButton('gamut-warning', 'Out of Gamut Warning: this color cannot print in the document’s CMYK profile; click to use the closest printable color', () => {
      const near = app.editor && cmykEngine.gamut(hexToRgb(this.current));
      if (!near) return;
      this.coalesce = gestureKey('color');
      this.apply(rgbToHex(near));
    }, { className: 'small cp-web-warn cp-gamut-warn' });
    this.recent = recentColorsRow(app);
    this.swapBtn = iconButton('swap-fill-stroke', 'Swap Fill and Stroke', () => app.editor && swapFillStroke(app.editor), { className: 'small cp-mini-btn', size: 12 });
    this.defaultBtn = iconButton('default-fill-stroke', 'Default Fill and Stroke', () => app.editor && defaultFillStroke(app.editor), { className: 'small cp-mini-btn', size: 12 });

    // Spectrum bar.
    this.spectrum = h('canvas.cp-spectrum', { width: 200, height: 40, role: 'img', 'aria-label': 'Color spectrum. Click or drag to pick a color.' });
    const pick = (e) => {
      const r = this.spectrum.getBoundingClientRect();
      const hex = spectrumColor((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      this.apply(hex);
    };
    this.spectrum.addEventListener('pointerdown', (e) => {
      if (!app.editor) return;
      this.coalesce = gestureKey('color');
      this.spectrum.setPointerCapture(e.pointerId);
      pick(e);
      const move = (ev) => pick(ev);
      const up = () => {
        this.spectrum.removeEventListener('pointermove', move);
        this.spectrum.removeEventListener('pointerup', up);
      };
      this.spectrum.addEventListener('pointermove', move);
      this.spectrum.addEventListener('pointerup', up);
    });
    const chip = (label, cls, onclick) => h(`button.cp-chip.${cls}`, { type: 'button', 'aria-label': label, 'data-tip': label, onclick });
    this.chips = h(
      'div.cp-chips',
      chip('None', 'none', () => {
        const ed = app.editor;
        if (!ed) return;
        applyStyle(ed, { [ed.focusPaint]: null }, 'None');
      }),
      chip('White', 'white', () => this.applySolid('#ffffff')),
      chip('Black', 'black', () => this.applySolid('#000000')),
    );
    this.stopNote = h('p.cp-note', { hidden: true });
    // Tint of a global swatch: shown when the focused paint is linked to one.
    this.tintRange = h('input#cp-tint.cs-range', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Tint' });
    this.tintField = h('input.cs-field', { type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: false, 'aria-label': 'Tint value' });
    this.tintRange.addEventListener('pointerdown', () => (this.coalesce = gestureKey('tint')));
    this.tintRange.addEventListener('keydown', (e) => {
      this.coalesce = gestureKey('tint');
      e.stopPropagation();
    });
    this.tintRange.addEventListener('input', () => this.setTint(Number(this.tintRange.value)));
    const commitTint = () => {
      const v = Number(String(this.tintField.value).replace('%', '').trim());
      if (!Number.isFinite(v)) return this.update();
      this.coalesce = gestureKey('tint');
      this.setTint(Math.max(0, Math.min(100, v)));
    };
    this.tintField.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTint();
      }
    });
    this.tintField.addEventListener('change', commitTint);
    this.tintSwatchName = h('span.cp-tint-name');
    this.tintRow = h('div.cp-tint', { hidden: true }, h('div.cp-tint-head', h('span.cp-tint-label', 'Global swatch'), this.tintSwatchName), h('div.cs-row', h('label.cs-label', { for: 'cp-tint' }, 'T'), this.tintRange, this.tintField, h('span.cs-unit', { 'aria-hidden': 'true' }, '%')));
    this.el.append(
      this.recent.el,
      h('div.cp-top', h('div.cp-fs', this.fs.el, h('div.cp-fs-btns', this.defaultBtn, this.swapBtn)), h('div.cp-right.cp-options', h('div.cp-modebar', this.modeSel), this.sliders.el)),
      h('div.cp-hexrow.cp-options', h('label.cp-hexlabel', '#'), this.hex, this.gamutWarn, this.webWarn),
      this.tintRow,
      this.stopNote,
      h('div.cp-specrow', this.chips, this.spectrum),
    );
    this.setOptionsShown(app.prefs.get('colorPanelOptions') !== false);
    this.drawSpectrum();
    this.offStop = paintState.on('stop', () => this.visible && this.update());
  }

  drawSpectrum() {
    const c = this.spectrum;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const hgt = c.height;
    const img = ctx.createImageData(w, hgt);
    if (!img?.data) return;
    for (let y = 0; y < hgt; y++) {
      for (let x = 0; x < w; x++) {
        const hex = spectrumColor(x / (w - 1), y / (hgt - 1));
        const n = parseInt(hex.slice(1), 16);
        const i = (y * w + x) * 4;
        img.data[i] = (n >> 16) & 255;
        img.data[i + 1] = (n >> 8) & 255;
        img.data[i + 2] = n & 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  setMode(m) {
    this.mode = m;
    this.app.prefs.set('colorPanelMode', m);
    this.modeSel.value = m;
    this.sliders.setMode(m);
    this.update();
  }

  setOptionsShown(on) {
    this.optionsShown = on;
    this.app.prefs.set('colorPanelOptions', on);
    this.el.classList.toggle('options-hidden', !on);
  }

  menu() {
    const ed = this.app.editor;
    const paint = ed ? focusedPaint(ed).paint : null;
    // Invert and Complement need a color to work from (not None or a mixed selection).
    const hasColor = Boolean(ed) && paint !== 'mixed' && Boolean(paint);
    return [
      { label: this.optionsShown ? 'Hide Options' : 'Show Options', run: () => this.setOptionsShown(!this.optionsShown) },
      '-',
      ...MODE_IDS.map((m) => ({ label: MODES[m].label, checked: this.mode === m, run: () => this.setMode(m) })),
      '-',
      { label: 'Invert', enabled: hasColor, run: () => this.startAndApply(invert(this.current)) },
      { label: 'Complement', enabled: hasColor, run: () => this.startAndApply(complement(this.current)) },
      '-',
      { label: 'Create New Swatch...', enabled: Boolean(ed) && paint !== 'mixed', run: () => createSwatchFromFocused(this.app) },
    ];
  }

  /** The global swatch the focused solid paint is linked to, or null. */
  linkedSwatch() {
    const ed = this.app.editor;
    if (!ed) return null;
    const { paint } = focusedPaint(ed);
    if (!paint || paint === 'mixed' || paint.type !== 'solid' || !paint.swatchId) return null;
    const sw = findSwatch(ed.doc, paint.swatchId);
    return sw?.global && sw.paint?.type === 'solid' ? sw : null;
  }

  /** Set the tint (0..100 %) of the linked global swatch's color, keeping the link. */
  setTint(pct) {
    const ed = this.app.editor;
    const sw = this.linkedSwatch();
    if (!ed || !sw) return;
    const key = ed.focusPaint;
    const t = pct / 100;
    const paint = { type: 'solid', color: tinted(sw.paint.color, t), swatchId: sw.id };
    if (t < 1) paint.tint = t;
    applyStyle(ed, { [key]: paint }, 'Tint', this.coalesce);
  }

  startAndApply(hex) {
    this.coalesce = gestureKey('color');
    this.apply(hex);
  }

  applySolid(hex) {
    const ed = this.app.editor;
    if (!ed) return;
    const p = focusedPaint(ed).paint;
    setFocusedColor(ed, hex, null, { forceSolid: !(isGradient(p) || p?.type === 'freeform') });
  }

  apply(hex) {
    const ed = this.app.editor;
    if (!ed) return;
    this.current = hex;
    setFocusedColor(ed, hex, this.coalesce);
  }

  commitHex() {
    const v = this.hex.value.trim();
    const s = v.startsWith('#') ? v : `#${v}`;
    if (!isHex(s)) {
      this.hex.value = (this.current || '#000000').slice(1).toUpperCase();
      return;
    }
    const hex = normalizeHex(s);
    if (hex === this.current) return;
    this.coalesce = gestureKey('color');
    this.apply(hex);
    this.sliders.setColor(hex);
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    this.recent.refresh();
    if (!ed) return;
    this.fs.refresh();
    const { key, paint } = focusedPaint(ed);
    const color = displayColor(ed, key, paint);
    this.current = color;
    const none = !paint;
    const mixed = paint === 'mixed';
    this.sliders.setColor(color);
    this.el.classList.toggle('is-none', none);
    if (document.activeElement !== this.hex) this.hex.value = mixed ? '' : color.slice(1).toUpperCase();
    this.hex.placeholder = mixed ? 'Mixed' : '';
    this.webWarn.hidden = isWebSafe(color) || mixed;
    // CMYK work: warn about colors the document's CMYK profile cannot print.
    const cmykWork = this.mode === 'cmyk' || ed.doc.root.colorMode === 'CMYK';
    this.gamutWarn.hidden = !cmykWork || none || mixed || !cmykEngine.gamut(hexToRgb(color));
    const linked = this.linkedSwatch();
    this.tintRow.hidden = !linked;
    if (linked) {
      const pct = Math.round((paint.tint ?? 1) * 100);
      this.tintSwatchName.textContent = linked.name;
      if (document.activeElement !== this.tintRange) this.tintRange.value = String(pct);
      if (document.activeElement !== this.tintField) this.tintField.value = String(pct);
      this.tintRange.style.setProperty('--ramp', `linear-gradient(to right, #ffffff, ${linked.paint.color})`);
    }
    const grad = paint && paint !== 'mixed' && isGradient(paint);
    const ff = paint && paint !== 'mixed' && paint.type === 'freeform' && paint.points?.length;
    this.stopNote.hidden = !grad && !ff;
    if (grad) this.stopNote.textContent = `Editing gradient stop ${Math.min(paintState.stop, paint.stops.length - 1) + 1} of ${paint.stops.length}`;
    else if (ff) this.stopNote.textContent = `Editing color point ${Math.min(paintState.stop, paint.points.length - 1) + 1} of ${paint.points.length}`;
  }
}
