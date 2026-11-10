/**
 * In-place text entry. A small editor floats next to the insertion point
 * while the canvas shows a live preview of the real drafting text.
 */
import { h } from './dom.js';

export class TextEditor {
  constructor(app) {
    this.app = app;
    this.current = null;
  }

  /**
   * opts: { anchor: {x, y} world, multiline, initial, onChange(value), onDone(value | null) }
   * Returns a handle with close().
   */
  open(opts) {
    this.current?.close(true);
    const app = this.app;
    const field = opts.multiline
      ? h('textarea.input.te-field', { rows: 4, 'aria-label': 'Text', spellcheck: 'true' })
      : h('input.input.te-field', { type: 'text', 'aria-label': 'Text', spellcheck: 'true', autocomplete: 'off' });
    field.value = opts.initial ?? '';
    const ok = h('button.btn.sm.primary', { type: 'button' }, 'Done');
    const cancel = h('button.btn.sm.ghost', { type: 'button' }, 'Cancel');
    const hint = h('span.te-hint', opts.multiline ? 'Ctrl+Enter to finish' : 'Enter to finish');
    const el = h('div.text-editor', { role: 'dialog', 'aria-label': opts.multiline ? 'Multiline text' : 'Text' }, field, h('div.te-bar', hint, cancel, ok));
    app.shell.canvasWrap.append(el);

    const place = () => {
      const s = app.camera.toScreen(opts.anchor.x, opts.anchor.y);
      const wrap = app.shell.canvasWrap.getBoundingClientRect();
      const w = el.offsetWidth,
        ht = el.offsetHeight;
      let x = s.x + 12,
        y = s.y + 12;
      if (x + w > wrap.width - 8) x = s.x - w - 12;
      if (y + ht > wrap.height - 8) y = s.y - ht - 12;
      // Keep it on screen when the insertion point is near or past an edge.
      x = Math.max(8, Math.min(x, wrap.width - w - 8));
      y = Math.max(8, Math.min(y, wrap.height - ht - 8));
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    };
    place();
    // The canvas gets shorter when an on-screen keyboard opens (and when the
    // window is resized): the editor moves with it instead of ending up below
    // the edge with the keyboard over it.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    resized?.observe(app.shell.canvasWrap);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      el.remove();
      resized?.disconnect();
      window.removeEventListener('pointerdown', outside, true);
      this.current = null;
      app.focusCanvas();
      opts.onDone(value);
    };
    const outside = (e) => {
      if (el.contains(e.target)) return;
      // Clicking the canvas finishes the text, like pressing Enter.
      if (e.target === app.shell.overlay) {
        e.stopPropagation();
        e.preventDefault();
        finish(field.value);
      }
    };
    field.addEventListener('input', () => opts.onChange?.(field.value));
    // Escape works from anywhere in the editor, including its buttons.
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      // Enter and Escape while an IME is composing belong to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    field.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && (!opts.multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(field.value);
      }
    });
    ok.addEventListener('click', () => finish(field.value));
    cancel.addEventListener('click', () => finish(null));
    setTimeout(() => window.addEventListener('pointerdown', outside, true));
    requestAnimationFrame(() => {
      field.focus();
      if (opts.initial) field.select?.();
    });
    if (opts.initial) opts.onChange?.(opts.initial);
    const handle = {
      /** Accept the text as typed (the Done button). */
      finish: () => finish(field.value),
      close: (silent) => {
        if (done) return;
        done = true;
        el.remove();
        resized?.disconnect();
        window.removeEventListener('pointerdown', outside, true);
        this.current = null;
        if (!silent) app.focusCanvas();
      },
    };
    this.current = handle;
    return handle;
  }
}
