import { h, debounce, clamp, announce } from '../lib/dom.js';
import { uid } from '../lib/ids.js';
import { sanitizeHtml, safeUrl } from '../lib/sanitize.js';
import { formatPageDate, formatPageTime } from '../lib/dates.js';
import { Emitter } from '../lib/emitter.js';
import { modKey } from '../lib/platform.js';
import { PAGE_COLORS } from '../data/colors.js';
import { History, snapshotOf, applySnapshot } from './history.js';
import { hydrate, serialize, fileSpan } from './embeds.js';
import { ensureBlocks, fixNesting, editableRoot, currentRange, selectRange, placeCaret, isEmptyBody, textOffset, rangeFromOffsets, blockOf } from './selection.js';
import { indent, moveBlock, toggleList, insertHtml, insertNode } from './format.js';
import { moveCell } from './table.js';
import { setDone } from './tag-edit.js';
import { InkTools } from './tools.js';

export const ZOOMS = [0.25, 0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const TOP_OF_CONTENT = 128;

/**
 * The page canvas: a free-form surface with a title header and absolutely
 * positioned note containers ("outlines"), plus an ink layer above them.
 * Events: 'change' (page edited), 'selection' (caret moved, for ribbon
 * state), 'navigate' ({ pageId } from an internal link).
 */
export class PageEditor extends Emitter {
  constructor({ store, host, readOnly = false }) {
    super();
    this.store = store;
    this.host = host;
    this.readOnly = readOnly;
    this.page = null;
    this.zoom = 1;
    this.history = new History();
    this.dirty = new Set();
    this.activeOutline = null;
    this.selectedOutlines = new Set();
    this.lastRange = null;
    this.surface = 'auto';
    this.commitSoon = debounce(() => this.commit(), 350);

    this.scroller = h('div.canvas-scroll', { tabindex: '-1', role: 'region', 'aria-label': 'Page canvas' });
    this.sizer = h('div.page-sizer');
    this.pageEl = h('div.page', { role: 'document' });
    this.header = h('div.page-header');
    this.titleEl = h('div.page-title', { contenteditable: readOnly ? 'false' : 'plaintext-only', role: 'textbox', 'aria-label': 'Page title', 'data-placeholder': '', spellcheck: 'true' });
    this.dateBtn = h('button.page-date', { type: 'button', 'aria-label': 'Page date' });
    this.timeBtn = h('button.page-time', { type: 'button', 'aria-label': 'Page time' });
    this.header.append(this.titleEl, h('div.page-meta', this.dateBtn, this.timeBtn));
    this.outlinesEl = h('div.outlines');
    this.pageEl.append(this.header, this.outlinesEl);
    this.sizer.append(this.pageEl);
    this.scroller.append(this.sizer);
    host.append(this.scroller);

    this.ink = new InkTools(this);
    this.bind();
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.scroller);
  }

  // ------------------------------------------------------------ open/render

  async open(page) {
    this.flush();
    this.page = page;
    this.dirty.clear();
    this.activeOutline = null;
    this.selectedOutlines.clear();
    this.ink.clearSelection();
    this.history.reset(snapshotOf(page));
    await this.render();
    this.scroller.scrollTo(0, 0);
  }

  async render() {
    const page = this.page;
    if (!page) return;
    this.titleEl.textContent = page.title || '';
    this.titleEl.dataset.placeholder = this.readOnly ? '' : '';
    this.updateDate();
    this.applyBackground();
    this.outlinesEl.replaceChildren();
    const jobs = [];
    for (const o of page.outlines) {
      const el = this.buildOutline(o);
      this.outlinesEl.append(el);
      jobs.push(hydrate(el.querySelector('.outline-body'), this.store));
    }
    this.ink.render();
    this.layout();
    await Promise.all(jobs);
    this.layout();
  }

  updateDate() {
    const page = this.page;
    this.dateBtn.textContent = formatPageDate(page.created);
    this.timeBtn.textContent = formatPageTime(page.created);
  }

  buildOutline(o) {
    const body = h('div.outline-body', {
      contenteditable: this.readOnly ? 'false' : 'true',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': 'Note container',
      spellcheck: 'true',
    });
    body.innerHTML = sanitizeHtml(o.html);
    if (!this.readOnly) ensureBlocks(body);
    const el = h('div.outline', { dataset: { id: o.id } },
      h('div.outline-bar', { 'aria-hidden': 'true', title: 'Drag to move this note container' }),
      body,
      h('div.outline-resize', { 'aria-hidden': 'true', title: 'Drag to change the width' }),
    );
    this.place(el, o);
    return el;
  }

  place(el, o) {
    el.style.left = `${o.x}px`;
    el.style.top = `${o.y}px`;
    if (o.w) {
      el.style.width = `${o.w}px`;
      el.classList.remove('auto-width');
    } else {
      el.style.removeProperty('width');
      el.classList.add('auto-width');
    }
  }

  outlineModel(el) {
    return this.page?.outlines.find((o) => o.id === el?.dataset.id) || null;
  }

  outlineEl(id) {
    return this.outlinesEl.querySelector(`.outline[data-id="${CSS.escape(id)}"]`);
  }

  /** Sizes the page surface to its content plus room to keep writing. */
  layout() {
    if (!this.page) return;
    const z = this.zoom;
    const viewW = this.scroller.clientWidth / z;
    const viewH = this.scroller.clientHeight / z;
    let right = 0;
    let bottom = 0;
    for (const el of this.outlinesEl.children) {
      right = Math.max(right, el.offsetLeft + el.offsetWidth);
      bottom = Math.max(bottom, el.offsetTop + el.offsetHeight);
    }
    const inkB = this.ink.extent();
    if (inkB) {
      right = Math.max(right, inkB.x + inkB.w);
      bottom = Math.max(bottom, inkB.y + inkB.h);
    }
    const w = Math.max(viewW, right + 240, 960);
    const hgt = Math.max(viewH, bottom + 320);
    this.pageEl.style.width = `${w}px`;
    this.pageEl.style.height = `${hgt}px`;
    this.pageEl.style.transform = z === 1 ? '' : `scale(${z})`;
    this.sizer.style.width = `${w * z}px`;
    this.sizer.style.height = `${hgt * z}px`;
    this.ink.resize(w, hgt);
  }

  // ------------------------------------------------------------ background

  /** Resolves whether the page surface is dark (follows theme unless switched). */
  isDarkSurface() {
    const themeDark = document.documentElement.dataset.themeResolved === 'dark';
    if (this.page?.color) return false;
    if (this.surface === 'light') return false;
    return themeDark;
  }

  applyBackground() {
    const page = this.page;
    const dark = this.isDarkSurface();
    const themeDark = document.documentElement.dataset.themeResolved === 'dark';
    this.pageEl.classList.toggle('surface-dark', dark);
    this.pageEl.classList.toggle('surface-light', !dark);
    let bg = dark ? '' : themeDark ? '#ffffff' : '';
    if (page?.color) {
      const c = PAGE_COLORS.find((x) => x.id === page.color);
      if (c) bg = themeDark && this.surface !== 'light' ? c.dark : c.light;
      if (themeDark && this.surface !== 'light') {
        this.pageEl.classList.add('surface-dark');
        this.pageEl.classList.remove('surface-light');
      }
    }
    this.scroller.style.setProperty('--page-bg', bg || 'var(--bg-page)');
    this.pageEl.style.backgroundImage = page?.rules ? `url("${ruleImage(page.rules, page.ruleColor, this.pageEl.classList.contains('surface-dark'))}")` : '';
  }

  setSurface(mode) {
    this.surface = mode;
    this.applyBackground();
  }

  // ------------------------------------------------------------ events

  bind() {
    const s = this.scroller;
    s.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    s.addEventListener('input', (e) => this.onInput(e));
    s.addEventListener('keydown', (e) => this.onKeyDown(e));
    s.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    s.addEventListener('focusin', (e) => this.onFocusIn(e));
    s.addEventListener('focusout', (e) => this.onFocusOut(e));
    s.addEventListener('paste', (e) => this.onPaste(e));
    s.addEventListener('drop', (e) => this.onDrop(e));
    s.addEventListener('dragover', (e) => {
      if (!this.readOnly && [...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
    });
    s.addEventListener('click', (e) => this.onClick(e));
    s.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { clientX: e.clientX, clientY: e.clientY });
      }
    }, { passive: false });
    this.titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.focusFirstOutline();
      }
    });
    this.dateBtn.addEventListener('click', () => this.emit('edit-date', 'date'));
    this.timeBtn.addEventListener('click', () => this.emit('edit-date', 'time'));
    this.onSelectionChange = () => {
      const range = currentRange();
      if (range && this.scroller.contains(range.commonAncestorContainer) && editableRoot(range.commonAncestorContainer)) {
        this.lastRange = range.cloneRange();
        this.emit('selection');
      }
    };
    document.addEventListener('selectionchange', this.onSelectionChange);
  }

  pagePoint(e) {
    const r = this.pageEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  onPointerDown(e) {
    if (this.readOnly || !this.page) return;
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.ink.tool !== 'type') return; // overlay handles it
    const bar = e.target.closest('.outline-bar');
    const resize = e.target.closest('.outline-resize');
    const outline = e.target.closest('.outline');
    if (bar) return this.startMove(e, outline);
    if (resize) return this.startResize(e, outline);
    if (e.target.closest('img') && outline) return this.selectImage(e.target.closest('img'), e);
    this.clearImageSelection();
    if (outline || e.target.closest('.page-header')) {
      if (!e.shiftKey) this.selectOutlines([]);
      return;
    }
    if (!this.pageEl.contains(e.target) && e.target !== this.scroller && e.target !== this.sizer) return;
    // Ink under the pointer is selected instead of starting a container.
    const p = this.pagePoint(e);
    if (this.ink.pickAt(p.x, p.y)) {
      e.preventDefault();
      return;
    }
    this.ink.clearSelection();
    this.selectOutlines([]);
    e.preventDefault();
    if (p.y < 0) return;
    this.createOutlineAt(p.x, p.y);
  }

  /** Starts a new, empty note container at a page point and focuses it. */
  createOutlineAt(x, y, html = '') {
    const o = { id: uid('o'), x: Math.max(8, Math.round(x)), y: Math.max(TOP_OF_CONTENT - 20, Math.round(y - 12)), w: null, html };
    this.page.outlines.push(o);
    const el = this.buildOutline(o);
    this.outlinesEl.append(el);
    const body = el.querySelector('.outline-body');
    hydrate(body, this.store);
    body.focus({ preventScroll: true });
    placeCaret(body, true);
    this.layout();
    return el;
  }

  focusFirstOutline() {
    let el = [...this.outlinesEl.children].sort((a, b) => a.offsetTop - b.offsetTop)[0];
    if (!el) el = this.createOutlineAt(48, TOP_OF_CONTENT + 12);
    const body = el.querySelector('.outline-body');
    body.focus({ preventScroll: false });
    placeCaret(body, false);
  }

  startMove(e, outline) {
    e.preventDefault();
    const start = this.pagePoint(e);
    if (!this.selectedOutlines.has(outline)) this.selectOutlines([outline]);
    const moving = [...this.selectedOutlines].map((el) => ({ el, model: this.outlineModel(el), x: el.offsetLeft, y: el.offsetTop }));
    const inkSel = this.ink.selected.size ? this.ink.beginMove() : null;
    let moved = false;
    const onMove = (ev) => {
      const p = this.pagePoint(ev);
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      for (const m of moving) {
        m.el.style.left = `${Math.max(0, m.x + dx)}px`;
        m.el.style.top = `${Math.max(0, m.y + dy)}px`;
      }
      inkSel?.move(dx, dy);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) return;
      for (const m of moving) {
        m.model.x = Math.round(m.el.offsetLeft);
        m.model.y = Math.round(m.el.offsetTop);
      }
      inkSel?.end();
      this.layout();
      this.changed({ structural: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  startResize(e, outline) {
    e.preventDefault();
    const start = this.pagePoint(e);
    const w0 = outline.offsetWidth;
    const model = this.outlineModel(outline);
    const onMove = (ev) => {
      const p = this.pagePoint(ev);
      const w = Math.max(80, Math.round(w0 + p.x - start.x));
      outline.style.width = `${w}px`;
      outline.classList.remove('auto-width');
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      model.w = Math.round(outline.offsetWidth);
      this.layout();
      this.changed({ structural: true });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  selectOutlines(list) {
    for (const el of this.selectedOutlines) el.classList.remove('selected');
    this.selectedOutlines = new Set(list);
    for (const el of this.selectedOutlines) el.classList.add('selected');
    this.emit('selection');
  }

  selectAllOutlines() {
    this.selectOutlines([...this.outlinesEl.children]);
    this.ink.selectAll();
  }

  deleteSelectedOutlines() {
    if (!this.selectedOutlines.size && !this.ink.selected.size) return false;
    for (const el of this.selectedOutlines) {
      this.page.outlines = this.page.outlines.filter((o) => o.id !== el.dataset.id);
      el.remove();
    }
    this.selectedOutlines.clear();
    this.ink.deleteSelection();
    this.layout();
    this.changed({ structural: true });
    return true;
  }

  onFocusIn(e) {
    const outline = e.target.closest?.('.outline');
    if (outline) {
      this.activeOutline?.classList.remove('active');
      this.activeOutline = outline;
      outline.classList.add('active');
    }
    this.emit('selection');
  }

  onFocusOut(e) {
    const outline = e.target.closest?.('.outline');
    if (!outline) return;
    // Wait for focus to land so moves inside the outline are not a blur.
    setTimeout(() => {
      if (outline.contains(document.activeElement)) return;
      outline.classList.remove('active');
      if (this.activeOutline === outline) this.activeOutline = null;
      const body = outline.querySelector('.outline-body');
      if (body && isEmptyBody(body) && outline.isConnected && !this.readOnly) {
        const model = this.outlineModel(outline);
        this.page.outlines = this.page.outlines.filter((o) => o.id !== outline.dataset.id);
        outline.remove();
        this.dirty.delete(outline);
        // A container that never held anything was never saved: no edit to record.
        if (model?.html) this.changed({ structural: true });
        this.layout();
      }
    }, 0);
  }

  onInput(e) {
    if (this.readOnly || !this.page) return;
    if (e.target === this.titleEl) {
      this.commitSoon();
      this.emit('title-input', this.titleEl.textContent.replace(/\n/g, ' '));
      return;
    }
    const outline = e.target.closest?.('.outline');
    if (!outline) return;
    this.dirty.add(outline);
    if (e.inputType === 'insertText' && e.data === ' ') {
      this.autoLink();
      this.autoFormat(outline);
    } else if (e.inputType === 'insertParagraph') this.autoLink({ previousBlock: true });
    this.commitSoon();
    this.layoutSoon();
  }

  layoutSoon() {
    if (this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = null;
      this.layout();
    });
  }

  /**
   * Turns a typed web address into a link when it is followed by a space
   * or Enter.
   */
  autoLink({ previousBlock = false } = {}) {
    const range = currentRange();
    if (!range || !range.collapsed) return;
    let node = range.startContainer;
    let end = range.startOffset;
    if (previousBlock) {
      const body = editableRoot(node);
      const block = blockOf(node, body);
      const prev = block?.previousElementSibling;
      if (!prev) return;
      const walker = document.createTreeWalker(prev, NodeFilter.SHOW_TEXT);
      let last = null;
      while (walker.nextNode()) last = walker.currentNode;
      if (!last) return;
      node = last;
      end = last.nodeValue.length + 1;
    }
    if (node.nodeType !== 3 || node.parentElement.closest('a, pre, code')) return;
    const text = node.nodeValue.slice(0, Math.max(0, end - 1)).replace(/\u00a0/g, ' ');
    const m = text.match(/(?:^|\s)((?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]'])$/i);
    if (!m) return;
    const url = m[1];
    const start = text.length - url.length;
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, start + url.length);
    const a = document.createElement('a');
    a.href = url.startsWith('www.') ? `https://${url}` : url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const saved = currentRange()?.cloneRange();
    r.surroundContents(a);
    if (saved && !previousBlock) {
      const after = a.nextSibling;
      if (after?.nodeType === 3) {
        const c = document.createRange();
        c.setStart(after, Math.min(1, after.length));
        c.collapse(true);
        selectRange(c);
      }
    } else if (saved) selectRange(saved);
  }

  /** List autoformat: "* " / "- " start bullets, "1. " / "1) " start numbers. */
  autoFormat(outline) {
    const range = currentRange();
    if (!range || !range.collapsed) return;
    const body = outline.querySelector('.outline-body');
    const block = blockOf(range.startContainer, body);
    if (!block || block.closest('li, td, th, pre')) return;
    const text = block.textContent.replace(/ /g, ' ');
    const m = text.match(/^(\*|-|1\.|1\)|a\.|a\)) $/);
    if (!m) return;
    const offset = textOffset(block, range.startContainer, range.startOffset);
    if (offset !== m[0].length) return;
    // Clear the marker, then turn the block into a list.
    for (const n of [...block.childNodes]) if (n.nodeType === 3 || n.nodeName === 'BR') n.remove();
    block.append(document.createElement('br'));
    placeCaret(block, false);
    toggleList(m[1] !== '*' && m[1] !== '-');
    fixNesting(body);
    if (m[1].startsWith('a')) {
      const list = blockOf(currentRange().startContainer, body)?.closest('ol');
      if (list) list.style.listStyleType = 'lower-alpha';
    }
  }

  onBeforeInput(e) {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      this.undo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      this.redo();
    }
  }

  onKeyDown(e) {
    if (this.readOnly) return;
    const inBody = e.target.closest?.('.outline-body');
    const mod = modKey(e);
    if (mod && !e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyY') {
      e.preventDefault();
      e.stopPropagation();
      this.redo();
      return;
    }
    if (!inBody) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && (this.selectedOutlines.size || this.ink.selected.size) && !e.target.closest?.('.page-title')) {
        e.preventDefault();
        this.deleteSelectedOutlines();
      } else if (e.key.startsWith('Arrow') && this.selectedOutlines.size && !e.target.closest?.('.page-title')) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 10;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        for (const el of this.selectedOutlines) {
          const m = this.outlineModel(el);
          m.x = Math.max(0, m.x + dx);
          m.y = Math.max(0, m.y + dy);
          this.place(el, m);
        }
        this.layout();
        this.commitNudge ||= debounce(() => this.changed(), 400);
        this.commitNudge();
      } else if (e.key === 'Enter' && this.selectedOutlines.size === 1) {
        e.preventDefault();
        const body = [...this.selectedOutlines][0].querySelector('.outline-body');
        this.selectOutlines([]);
        body.focus();
        placeCaret(body, true);
      } else if (e.key === 'Escape') {
        this.selectOutlines([]);
        this.ink.clearSelection();
      } else if (mod && e.code === 'KeyA' && !e.target.closest?.('.page-title')) {
        e.preventDefault();
        this.selectAllOutlines();
      }
      return;
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (moveCell(e.shiftKey ? -1 : 1)) return;
      indent(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveBlock(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.altKey && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      indent(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (e.key === 'Escape') {
      // Leave text editing and select the container, so arrows and Delete act on it.
      const outline = inBody.closest('.outline');
      e.preventDefault();
      inBody.blur();
      this.scroller.focus({ preventScroll: true });
      if (outline.isConnected) {
        this.selectOutlines([outline]);
        announce('Note container selected. Arrow keys move it, Delete removes it, Enter edits it.');
      }
      return;
    }
    if (mod && e.code === 'KeyA') {
      // First press selects the container's text; the second selects every container.
      const range = currentRange();
      const all = document.createRange();
      all.selectNodeContents(inBody);
      if (range && range.toString() === all.toString() && all.toString().length) {
        e.preventDefault();
        inBody.blur();
        this.scroller.focus({ preventScroll: true });
        this.selectAllOutlines();
      }
    }
  }

  onClick(e) {
    const tag = e.target.closest?.('.nt-tag[role="checkbox"]');
    if (tag && !this.readOnly) {
      e.preventDefault();
      setDone(tag, tag.dataset.done !== 'true');
      const outline = tag.closest('.outline');
      if (outline) {
        this.dirty.add(outline);
        this.commit();
      }
      return;
    }
    const file = e.target.closest?.('.nt-file');
    if (file && !e.target.closest('audio, video')) {
      e.preventDefault();
      this.emit('open-file', file.dataset);
      return;
    }
    const math = e.target.closest?.('.nt-math');
    if (math && !this.readOnly) {
      this.emit('edit-math', math);
      return;
    }
    const link = e.target.closest?.('a[href]');
    if (link && this.scroller.contains(link)) {
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed) return;
      e.preventDefault();
      const href = link.getAttribute('href');
      const internal = href.match(/^#(page|section)=([\w-]+)/);
      if (internal) this.emit('navigate', { kind: internal[1], id: internal[2] });
      else if (safeUrl(href)) window.open(href, '_blank', 'noopener,noreferrer');
    }
  }

  // ------------------------------------------------------------ paste/drop

  async onPaste(e) {
    if (this.readOnly) return;
    const inBody = e.target.closest?.('.outline-body');
    const inTitle = e.target.closest?.('.page-title');
    if (inTitle) return; // plaintext-only handles it
    const dt = e.clipboardData;
    if (!dt) return;
    const files = [...dt.files];
    if (files.length) {
      e.preventDefault();
      await this.insertFiles(files);
      return;
    }
    const html = dt.getData('text/html');
    const text = dt.getData('text/plain');
    if (!inBody) {
      // Pasting onto the page with no caret starts a container.
      if (!html && !text) return;
      e.preventDefault();
      const el = this.createOutlineAt(48, this.nextFreeY());
      el.querySelector('.outline-body').focus();
    } else e.preventDefault();
    if (html) insertHtml(sanitizeHtml(stripPasteWrapper(html)));
    else if (text) insertHtml(textToHtml(text));
  }

  async onDrop(e) {
    if (this.readOnly) return;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    const body = e.target.closest?.('.outline-body');
    if (body) {
      const pos = document.caretPositionFromPoint?.(e.clientX, e.clientY);
      const range = pos ? document.createRange() : document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (pos) range.setStart(pos.offsetNode, pos.offset);
      if (range) {
        range.collapse(true);
        body.focus();
        selectRange(range);
      }
    } else {
      const p = this.pagePoint(e);
      this.createOutlineAt(p.x, p.y);
    }
    await this.insertFiles(files);
  }

  nextFreeY() {
    let bottom = TOP_OF_CONTENT;
    for (const el of this.outlinesEl.children) bottom = Math.max(bottom, el.offsetTop + el.offsetHeight + 24);
    return bottom;
  }

  /** Makes sure there is a caret in an outline, creating one if needed. */
  ensureCaret() {
    const range = currentRange();
    if (range && editableRoot(range.commonAncestorContainer)?.classList.contains('outline-body') && this.scroller.contains(range.commonAncestorContainer)) return range;
    if (this.lastRange && this.scroller.contains(this.lastRange.commonAncestorContainer) && this.lastRange.commonAncestorContainer.isConnected) {
      const root = editableRoot(this.lastRange.commonAncestorContainer);
      if (root?.classList.contains('outline-body')) {
        root.focus({ preventScroll: true });
        selectRange(this.lastRange);
        return this.lastRange;
      }
    }
    const el = this.createOutlineAt(48, this.nextFreeY());
    return currentRange() || (el && currentRange());
  }

  /** Restores the last caret (after a ribbon control took focus). */
  restoreRange() {
    if (!this.lastRange || !this.lastRange.commonAncestorContainer.isConnected) return false;
    const root = editableRoot(this.lastRange.commonAncestorContainer);
    if (!root) return false;
    root.focus({ preventScroll: true });
    selectRange(this.lastRange);
    return true;
  }

  async insertFiles(files) {
    for (const file of files) {
      if (file.type.startsWith('image/')) await this.insertImage(file);
      else await this.insertAttachment(file);
    }
  }

  async insertImage(file, { alt = '' } = {}) {
    // A picture the browser can't show (HEIC outside Safari, a damaged
    // file) goes in as an attachment instead of a broken image.
    const probe = URL.createObjectURL(file);
    const width = await imageWidth(probe);
    URL.revokeObjectURL(probe);
    if (width === null) return this.insertAttachment(file);
    this.ensureCaret();
    const id = await this.store.saveAsset(file, file.name || 'picture.png', { sectionId: this.store.findPage?.(this.page.id)?.section.id });
    const url = await this.store.assetUrl(id);
    const style = width > 600 ? ' style="width: 600px"' : '';
    this.ensureCaret();
    insertHtml(`<img data-asset="${id}" src="${url}" alt="${escapeAttr(alt || file.name || '')}"${style}>`);
    this.markActiveDirty();
  }

  async insertAttachment(file, kind) {
    this.ensureCaret();
    const id = await this.store.saveAsset(file, file.name, { sectionId: this.store.findPage?.(this.page.id)?.section.id });
    this.ensureCaret();
    const span = fileSpan({ asset: id, name: file.name || 'Attachment', size: file.size, type: file.type, kind: kind || (file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file') });
    insertNode(span);
    const body = editableRoot(currentRange()?.startContainer);
    if (body) await hydrate(body, this.store);
    this.markActiveDirty();
  }

  markActiveDirty() {
    const range = currentRange();
    const outline = range && editableRoot(range.startContainer)?.closest('.outline');
    if (outline) this.dirty.add(outline);
    this.commit();
  }

  // ------------------------------------------------------------ images

  selectImage(img, e) {
    this.clearImageSelection();
    img.classList.add('nt-selected');
    this.selectedImage = img;
    const outline = img.closest('.outline');
    const handle = h('div.img-handle', { 'aria-hidden': 'true' });
    const placeHandle = () => {
      const or = outline.getBoundingClientRect();
      const ir = img.getBoundingClientRect();
      handle.style.left = `${(ir.right - or.left) / this.zoom - 5}px`;
      handle.style.top = `${(ir.bottom - or.top) / this.zoom - 5}px`;
    };
    outline.append(handle);
    placeHandle();
    this.imageHandle = handle;
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const start = this.pagePoint(ev);
      const w0 = img.getBoundingClientRect().width / this.zoom;
      const onMove = (m) => {
        const p = this.pagePoint(m);
        img.style.width = `${Math.max(24, Math.round(w0 + p.x - start.x))}px`;
        img.style.height = 'auto';
        placeHandle();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.dirty.add(outline);
        this.commit();
        this.layout();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    if (e) {
      // Select the image as a node so Delete and copy act on it.
      const range = document.createRange();
      range.selectNode(img);
      setTimeout(() => selectRange(range));
    }
    this.emit('selection');
  }

  clearImageSelection() {
    this.selectedImage?.classList.remove('nt-selected');
    this.selectedImage = null;
    this.imageHandle?.remove();
    this.imageHandle = null;
  }

  // ------------------------------------------------------------ commit/undo

  /** Copies edited outlines back into the page model and saves. */
  commit({ structural = false } = {}) {
    if (!this.page || this.readOnly) return;
    this.commitSoon.cancel();
    let any = structural;
    for (const outline of this.dirty) {
      const model = this.outlineModel(outline);
      if (!model || !outline.isConnected) continue;
      const html = serialize(outline.querySelector('.outline-body'));
      if (html !== model.html) {
        model.html = html;
        any = true;
      }
    }
    this.dirty.clear();
    const titleNow = this.titleEl.textContent.replace(/\n/g, ' ');
    if (titleNow !== this.page.title) {
      this.page.title = titleNow;
      any = true;
    }
    if (!any) return;
    this.store.pageChanged(this.page, { title: this.page.title });
    this.history.push(snapshotOf(this.page), this.caret());
    this.emit('change', {});
  }

  /** Records a structural change (move, delete, ink, page settings). */
  changed({ structural = true, quiet = false } = {}) {
    this.commit({ structural });
    if (quiet) return;
  }

  flush() {
    if (this.commitSoon.pending() || this.dirty.size) this.commit();
  }

  caret() {
    const range = currentRange();
    if (!range) return null;
    const root = editableRoot(range.startContainer);
    if (!root || !this.scroller.contains(root)) return null;
    if (root === this.titleEl) return { title: true, start: textOffset(root, range.startContainer, range.startOffset) };
    const outline = root.closest('.outline');
    return { outlineId: outline.dataset.id, start: textOffset(root, range.startContainer, range.startOffset), end: textOffset(root, range.endContainer, range.endOffset) };
  }

  restoreCaret(caret) {
    if (!caret) return;
    let root = null;
    if (caret.title) root = this.titleEl;
    else root = this.outlineEl(caret.outlineId)?.querySelector('.outline-body');
    if (!root) return;
    root.focus({ preventScroll: true });
    selectRange(rangeFromOffsets(root, caret.start, caret.end ?? caret.start));
  }

  async undo() {
    this.flush();
    const entry = this.history.undo();
    if (!entry) return false;
    await this.restoreSnapshot(entry);
    return true;
  }

  async redo() {
    this.flush();
    const entry = this.history.redo();
    if (!entry) return false;
    await this.restoreSnapshot(entry);
    return true;
  }

  async restoreSnapshot(entry) {
    applySnapshot(this.page, entry.snapshot);
    this.store.pageChanged(this.page, { title: this.page.title });
    await this.render();
    this.restoreCaret(entry.caret);
    this.emit('change', { title: true });
  }

  // ------------------------------------------------------------ zoom

  setZoom(z, anchor) {
    const next = clamp(Math.round(z * 100) / 100, 0.25, 4);
    if (next === this.zoom) return;
    const s = this.scroller;
    const r = s.getBoundingClientRect();
    const ax = anchor ? anchor.clientX - r.left : s.clientWidth / 2;
    const ay = anchor ? anchor.clientY - r.top : s.clientHeight / 2;
    const px = (s.scrollLeft + ax) / this.zoom;
    const py = (s.scrollTop + ay) / this.zoom;
    this.zoom = next;
    this.layout();
    s.scrollLeft = px * next - ax;
    s.scrollTop = py * next - ay;
    this.emit('zoom', next);
  }

  stepZoom(direction) {
    const i = ZOOMS.findIndex((z) => z >= this.zoom - 0.001);
    const next = direction > 0 ? ZOOMS.find((z) => z > this.zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < this.zoom - 0.001);
    this.setZoom(next ?? ZOOMS[clamp(i, 0, ZOOMS.length - 1)]);
  }

  /** Zooms so the widest content fits the window. */
  fitWidth() {
    let right = 0;
    for (const el of this.outlinesEl.children) right = Math.max(right, el.offsetLeft + el.offsetWidth);
    right = Math.max(right, this.header.offsetLeft + this.header.offsetWidth) + 40;
    this.setZoom(clamp(this.scroller.clientWidth / right, 0.25, 2));
  }

  destroy() {
    this.flush();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.resizeObserver.disconnect();
    this.scroller.remove();
  }
}

/** A tiled SVG for rule lines and grids. */
export function ruleImage(kind, color, dark) {
  const line = color || (dark ? '#2f4256' : '#c5d9ee');
  const margin = dark ? '#5b3434' : '#efb2b2';
  const sizes = { narrow: 20, college: 24, standard: 29, wide: 34, 'grid-small': 13, 'grid-medium': 20, 'grid-large': 32, 'grid-xl': 48 };
  const s = sizes[kind] || 24;
  let svg;
  if (kind.startsWith('grid')) {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${s}' height='${s}'><path d='M${s - 0.5} 0V${s}M0 ${s - 0.5}H${s}' stroke='${line}' stroke-width='1' fill='none'/></svg>`;
  } else {
    svg = `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='${s}'><path d='M0 ${s - 0.5}H4' stroke='${line}' stroke-width='1'/></svg>`;
    void margin;
  }
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function stripPasteWrapper(html) {
  const m = html.match(/<!--StartFragment-->([\s\S]*)<!--EndFragment-->/);
  return m ? m[1] : html;
}

/** Plain text to paragraphs, keeping URLs as links. */
export function textToHtml(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return linkify(lines[0]);
  return lines.map((l) => `<p>${l ? linkify(l).replace(/\t/g, '&emsp;') : '<br>'}</p>`).join('');
}

function escapeAttr(s) {
  return String(s).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);
}

/** The picture's natural width, or null when the browser can't decode it. */
function imageWidth(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
