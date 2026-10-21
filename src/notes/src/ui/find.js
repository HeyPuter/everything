import { h, debounce, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { normalize, foldWithOffsets } from '../data/store.js';

/**
 * Find on page (Mod+F). Matches are painted with the CSS Custom Highlight
 * API so the note's DOM is never modified.
 */
export class FindBar {
  constructor(app) {
    this.app = app;
    this.ranges = [];
    this.index = -1;
    this.input = h('input.input', { type: 'search', placeholder: 'Find on page', 'aria-label': 'Find on page', autocomplete: 'off', spellcheck: 'false' });
    this.count = h('span.find-count', { role: 'status', 'aria-live': 'polite' });
    const prev = h('button.icon-btn', { type: 'button', 'aria-label': 'Previous match', 'data-tip': 'Previous match', 'data-tip-key': 'Shift+Enter', onclick: () => this.step(-1) }, icon('chevUp', 16));
    const next = h('button.icon-btn', { type: 'button', 'aria-label': 'Next match', 'data-tip': 'Next match', 'data-tip-key': 'Enter', onclick: () => this.step(1) }, icon('chevDown', 16));
    const close = h('button.icon-btn', { type: 'button', 'aria-label': 'Close find', onclick: () => this.close() }, icon('x', 16));
    this.el = h('div.find-bar', { role: 'search', 'aria-label': 'Find on page', hidden: true }, icon('search', 16), this.input, this.count, prev, next, close);
    app.canvasCol.append(this.el);
    this.input.addEventListener('input', debounce(() => this.run(), 120));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  open(query) {
    this.el.hidden = false;
    if (typeof query === 'string') this.input.value = query;
    else {
      const sel = window.getSelection()?.toString();
      if (sel && sel.length < 80 && !sel.includes('\n')) this.input.value = sel;
    }
    this.input.focus();
    this.input.select();
    this.run();
  }

  close() {
    this.el.hidden = true;
    this.clear();
    this.app.editor.restoreRange() || this.app.editor.scroller.focus();
  }

  clear() {
    this.ranges = [];
    this.index = -1;
    if (globalThis.CSS?.highlights) {
      CSS.highlights.delete('nt-find');
      CSS.highlights.delete('nt-find-current');
    }
  }

  pageChanged() {
    if (!this.el.hidden) this.run();
  }

  run() {
    this.clear();
    const q = normalize(this.input.value.trim());
    if (!q) {
      this.count.textContent = '';
      return;
    }
    const ed = this.app.editor;
    const roots = [ed.titleEl, ...ed.outlinesEl.querySelectorAll('.outline-body')];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const { flat: hay, from, to } = foldWithOffsets(n.nodeValue);
        let i = hay.indexOf(q);
        while (i >= 0) {
          const r = document.createRange();
          r.setStart(n, from(i));
          r.setEnd(n, to(i + q.length));
          this.ranges.push(r);
          i = hay.indexOf(q, i + q.length);
        }
      }
    }
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('nt-find', new Highlight(...this.ranges));
    this.index = this.ranges.length ? 0 : -1;
    this.show();
  }

  step(dir) {
    if (!this.ranges.length) return;
    this.index = (this.index + dir + this.ranges.length) % this.ranges.length;
    this.show();
  }

  show() {
    const n = this.ranges.length;
    this.count.textContent = n ? `${this.index + 1} of ${n}` : 'No matches';
    if (!n) {
      announce('No matches');
      return;
    }
    const r = this.ranges[this.index];
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('nt-find-current', new Highlight(r));
    // Scroll to the match itself; a wide block would pull the page sideways.
    const scroller = this.app.editor.scroller;
    const box = r.getBoundingClientRect?.();
    const view = scroller.getBoundingClientRect();
    if (box && (box.width || box.height)) {
      if (box.top < view.top + 60 || box.bottom > view.bottom - 20) scroller.scrollTop += box.top - view.top - view.height / 2;
      if (box.left < view.left || box.right > view.right) scroller.scrollLeft += box.left - view.left - 40;
    } else r.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}
