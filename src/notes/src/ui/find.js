import { h, debounce, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { normalize, foldWithOffsets } from '../data/store.js';
import { BLOCK_SELECTOR } from '../editor/selection.js';

/**
 * The text of each paragraph (or cell, list item, heading) under root as one
 * folded string with the text nodes it came from, so a match can run across
 * formatting: "quarterly" is found in "<b>quar</b>terly".
 */
function paragraphs(root) {
  const byBlock = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  let parent = null;
  let p = null;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue) continue;
    // Text nodes side by side share their paragraph: look it up once.
    if (n.parentNode !== parent) {
      parent = n.parentNode;
      const block = parent.closest(BLOCK_SELECTOR);
      const key = block && root.contains(block) ? block : root;
      if (!byBlock.has(key)) byBlock.set(key, { flat: '', parts: [] });
      p = byBlock.get(key);
    }
    const fold = foldWithOffsets(n.nodeValue);
    // A non-breaking space is a space to whoever types the search.
    const flat = fold.flat.replace(/\u00a0/g, ' ');
    p.parts.push({ node: n, start: p.flat.length, end: p.flat.length + flat.length, fold });
    p.flat += flat;
  }
  return [...byBlock.values()];
}

/** Ranges of every occurrence of the terms in the paragraphs, in reading order. */
function matchesIn(paras, terms) {
  const ranges = [];
  for (const { flat, parts } of paras) {
    const hits = [];
    for (const term of terms) {
      for (let i = flat.indexOf(term); i >= 0; i = flat.indexOf(term, i + term.length)) hits.push([i, i + term.length]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (const [from, to] of hits) {
      const first = parts.find((p) => from < p.end);
      let last = first;
      for (const p of parts) if (to > p.start) last = p;
      const r = document.createRange();
      r.setStart(first.node, first.fold.from(from - first.start));
      r.setEnd(last.node, last.fold.to(to - last.start));
      ranges.push(r);
    }
  }
  return ranges;
}

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
    const runSoon = debounce(() => this.run(), 120);
    this.input.addEventListener('input', () => {
      // Typed text is searched for as it is typed.
      this.words = false;
      runSoon();
    });
    this.input.addEventListener('keydown', (e) => {
      // Keys pressed while an input method is composing belong to it.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        // Right after typing, go to the first match of the new text
        // rather than stepping through the previous text's matches.
        if (runSoon.pending()) {
          runSoon.cancel();
          this.run();
        } else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        runSoon.cancel();
        e.preventDefault();
        this.close();
      }
    });
  }

  /**
   * query: the text to look for, or { text, words: true } from Search, which
   * finds pages holding every word of its query in any order: when the
   * query is nowhere on the page as a phrase, its words are shown instead.
   */
  open(query) {
    this.el.hidden = false;
    this.words = Boolean(query?.words);
    if (query?.text !== undefined) query = query.text;
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

  /**
   * The page's text changed under the open bar (typing, undo, a version
   * restored, an update from another device): match again, staying at the
   * same match number and without scrolling the page away from the edit.
   */
  refresh() {
    if (this.el.hidden) return;
    const at = this.index;
    this.run({ quiet: true });
    if (!this.ranges.length) return;
    this.index = Math.min(Math.max(at, 0), this.ranges.length - 1);
    this.show({ quiet: true });
  }

  run({ quiet = false } = {}) {
    this.clear();
    const q = normalize(this.input.value.trim()).replace(/\u00a0/g, ' ');
    if (!q) {
      this.count.textContent = '';
      return;
    }
    const ed = this.app.editor;
    const paras = [ed.titleEl, ...ed.outlinesEl.querySelectorAll('.outline-body')].flatMap(paragraphs);
    this.ranges = matchesIn(paras, [q]);
    if (!this.ranges.length && this.words) this.ranges = matchesIn(paras, [...new Set(q.split(/\s+/).filter(Boolean))]);
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('nt-find', new Highlight(...this.ranges));
    this.index = this.ranges.length ? 0 : -1;
    this.show({ quiet });
  }

  step(dir) {
    if (!this.ranges.length) return;
    this.index = (this.index + dir + this.ranges.length) % this.ranges.length;
    this.show();
  }

  show({ quiet = false } = {}) {
    const n = this.ranges.length;
    const count = n ? `${this.index + 1} of ${n}` : 'No matches';
    if (this.count.textContent !== count) this.count.textContent = count;
    if (!n) {
      if (!quiet) announce('No matches');
      return;
    }
    const r = this.ranges[this.index];
    if (globalThis.CSS?.highlights && globalThis.Highlight) CSS.highlights.set('nt-find-current', new Highlight(r));
    if (quiet) return;
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
