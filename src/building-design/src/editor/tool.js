/**
 * Base class for interactive tools. A tool receives pointer events from the
 * viewport (with model coordinates), draws feedback on the overlay, shows
 * its options in the options bar and a prompt in the status bar.
 */
import { snapPoint } from './snap.js';
import { drawSnapMarker, strokeModel } from '../views/overlay.js';
import { parseLength, formatLength } from '../core/units.js';
import { h } from '../ui/dom.js';

export class Tool {
  constructor(app, opts = {}) {
    this.app = app;
    this.opts = opts;
    this.snapRes = null;
    this.hoverPoint = null;
  }

  /** Label shown in the contextual tab and options bar. */
  get title() {
    return 'Modify';
  }

  get prompt() {
    return '';
  }

  /** View kinds the tool works in. */
  get viewKinds() {
    return ['plan', 'ceilingPlan'];
  }

  get doc() {
    return this.app.doc;
  }

  get vc() {
    return this.app.vc;
  }

  start() {}

  stop() {
    this.closeInput();
  }

  /** Escape: step back; returns true when the tool should exit. */
  cancel() {
    return true;
  }

  viewChanged() {}

  down() {}
  move() {}
  up() {}
  dblclick() {}
  leave() {
    this.snapRes = null;
    this.app.requestRender();
  }
  key() {
    return false;
  }

  /** Options bar content (array of nodes) or null. */
  options() {
    return null;
  }

  drawOverlay(ctx, vc, vp) {
    this.drawSnap(ctx, vc, vp);
  }

  /** Snap a pointer event's model point. */
  snap(ev, from = null, opts = {}) {
    if (!ev?.p || !this.vc?.is2D) {
      this.snapRes = null;
      return ev?.p ?? null;
    }
    if (ev.shift && opts.allowFree !== false && !from) {
      this.snapRes = null;
      return ev.p;
    }
    const s = this.app.settings.snaps;
    const r = snapPoint({ vc: this.vc, from, exclude: opts.exclude, settings: { ...s, enabled: s.enabled !== false && !ev.alt, angles: !ev.shift && s.angles !== false }, units: this.doc.units }, ev.p);
    this.snapRes = r;
    return r.point;
  }

  drawSnap(ctx, vc, vp) {
    const r = this.snapRes;
    if (!r || !vc.modelToScreen) return;
    for (const [a, b] of r.guides || []) strokeModel(ctx, [a, b], (p) => vc.modelToScreen(p), vp.theme.snap, 1, [4, 4]);
    if (r.kind && r.kind !== 'tracking' && r.kind !== 'alignment') drawSnapMarker(ctx, vc.modelToScreen(r.point), r.kind, vp.theme.snap, this.app.settings.snapLabels === false ? '' : r.label);
  }

  // Inline numeric input (typed lengths while drawing) ---------------------------------

  openInput(x, y, { value = '', label = 'Length', onSubmit, onCancel, multiline = false } = {}) {
    this.closeInput();
    const wrap = this.app.shell.canvasWrap;
    const input = multiline ? h('textarea.input', { 'aria-label': label, rows: 3 }) : h('input.input', { type: 'text', value, 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
    if (multiline) input.value = value;
    const box = h('div.canvas-input', { role: 'dialog', 'aria-label': label }, input);
    box.style.left = `${Math.min(x + 14, wrap.clientWidth - 260)}px`;
    box.style.top = `${Math.min(y + 14, wrap.clientHeight - 90)}px`;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeInput();
        onCancel?.();
        this.app.viewport.overlay.focus();
      } else if (e.key === 'Enter' && (!multiline || !e.shiftKey)) {
        e.preventDefault();
        const v = input.value;
        const ok = onSubmit?.(v);
        if (ok !== false) {
          this.closeInput();
          this.app.viewport.overlay.focus();
        } else input.setAttribute('aria-invalid', 'true');
      }
    });
    wrap.append(box);
    this.inputBox = box;
    // Focus now so keys typed right after the click land in the field.
    input.focus();
    if (!multiline) input.select();
    return input;
  }

  closeInput() {
    this.inputBox?.remove();
    this.inputBox = null;
  }

  parseLen(v) {
    return parseLength(v, this.doc.units);
  }

  fmt(mm) {
    return formatLength(mm, this.doc.units);
  }
}

/** A typed key that starts numeric entry (digits, minus, dot, feet/inch marks). */
export function isNumericStart(e) {
  return !e.ctrlKey && !e.metaKey && !e.altKey && /^[0-9.\-]$/.test(e.key);
}
