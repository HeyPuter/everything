/**
 * The block editor for one page. Each text block is its own contenteditable
 * element bound to a Y.Text; structure (adding, splitting, merging, moving,
 * indenting blocks) goes through data/page.js so it merges with everyone
 * else's edits. Remote changes re-render only the blocks they touch, and a
 * caret inside a changed block keeps its place through Yjs relative
 * positions.
 */
import { Y, LOCAL } from '../data/ydoc.js';
import * as P from '../data/page.js';
import { domToDelta, renderDelta, getSelectionOffsets, setSelectionOffsets, formatAt, deltaText, textLength, splitDelta, applyDelta, cleanDelta } from '../data/richtext.js';
import { markdownToBlocks, htmlToBlocks, blocksToMarkdown, blocksToHtml } from '../data/markdown.js';
import { h, modKey, modLabel, announce, debounce, fill } from '../lib/dom.js';
import { icon, pageIcon, hasIcon } from '../lib/icons.js';
import { safeUrl, COLORS } from '../lib/sanitize.js';
import { Menu, openMenu } from '../ui/menu.js';
import { Popover } from '../ui/popover.js';
import { INSERTABLE, PAGE_COMMANDS, TEXT_TYPES, PLACEHOLDERS, SHORTCUTS, CODE_LANGUAGES } from './commands.js';
import { onFirstLine, onLastLine, placeCaretAtX } from './caret.js';
import { InlineToolbar } from './toolbar.js';
import { MobileBar } from './mobilebar.js';
import { renderTable } from './table.js';
import { getPage, displayTitle } from '../data/tree.js';

const CLIP_TYPE = 'application/x-wiki-blocks';
const typeLabel = (type) => P.BLOCK_TYPES[type]?.label || 'Text';

export class Editor {
  /**
   * ctx: { space, pageId, tree, readOnly, navigate(pageId), createChild(kind), pageTitle(id),
   *        toast(msg, opts), pickIcon(anchor, current, cb), trashPage(id), onTextChange() }
   */
  constructor(host, doc, ctx) {
    this.host = host;
    this.doc = doc;
    this.ctx = ctx;
    this.readOnly = !!ctx.readOnly;
    this.blocks = doc.getMap('blocks');
    this.els = new Map();
    this.rendered = new Map();
    this.selected = new Set();
    this.root = h('div.editor', { role: 'region', 'aria-label': 'Page content', tabindex: '-1' });
    this.handle = h(
      'div.blk-handle',
      { 'aria-hidden': 'true' },
      h('button.handle-btn', { type: 'button', tabindex: '-1', 'data-tip': 'Add a block below', onclick: (e) => this.handleAdd(e) }, icon('plus', 16)),
      h('button.handle-btn.grip', { type: 'button', tabindex: '-1', 'data-tip': 'Drag to move, click for options' }, icon('grip', 16)),
    );
    this.dropLine = h('div.drop-line', { 'aria-hidden': 'true' });
    host.append(this.root, this.handle, this.dropLine);
    this.toolbar = new InlineToolbar(this);
    this.mobileBar = new MobileBar(this);
    this.undo = new Y.UndoManager(this.blocks, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
    this.undo.on('stack-item-added', (e) => e.stackItem.meta.set('sel', this.currentSel()));
    this.undo.on('stack-item-popped', (e) => {
      const sel = e.stackItem.meta.get('sel');
      if (sel && this.blocks.has(sel.id)) this.pendingSel = sel;
    });
    this.dirty = new Set();
    this.structural = true;
    this.observer = (events, tx) => {
      // Note what changed: a block's text or style re-renders just that
      // block; adding, removing, moving, indenting or retyping blocks
      // re-renders the list.
      for (const e of events) {
        const [id] = e.path;
        if (!id) this.structural = true;
        else if (e.path.length === 1 && [...(e.keysChanged || [])].some((k) => ['type', 'indent', 'order', 'collapsed'].includes(k))) this.structural = true;
        else this.dirty.add(id);
      }
      if (tx.origin !== LOCAL) this.ctx.onRemoteChange?.();
      this.renderSoon();
      this.ctx.onTextChange?.();
    };
    this.blocks.observeDeep(this.observer);
    this.bind();
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this.blocks.unobserveDeep(this.observer);
    this.undo.destroy();
    this.toolbar.destroy();
    this.mobileBar.destroy();
    this.closeMenus();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
    this.root.remove();
    this.handle.remove();
    this.dropLine.remove();
  }

  setReadOnly(readOnly) {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    this.handle.classList.remove('visible');
    this.toolbar.update(null);
    this.rendered.clear();
    for (const el of this.els.values()) el.remove();
    this.els.clear();
    this.structural = true;
    this.render();
  }

  /* ---------- rendering ---------- */

  renderSoon() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      if (!this.destroyed) this.render();
    });
  }

  render() {
    if (!this.structural && this.dirty.size && !this.pendingSel) {
      const focused = this.focusedBlockId();
      for (const id of this.dirty) {
        const el = this.els.get(id);
        const b = el && this.block(id);
        if (b) this.updateBlock(el, b, null, -1, focused === id);
      }
      this.dirty.clear();
      this.ctx.onRender?.();
      return;
    }
    this.structural = false;
    this.dirty.clear();
    const list = P.listBlocks(this.doc);
    if (!list.length && !this.readOnly) {
      P.ensureBlock(this.doc);
      return;
    }
    const visible = [];
    let hideBelow = Infinity;
    for (const b of list) {
      if (b.indent > hideBelow) continue;
      hideBelow = Infinity;
      visible.push(b);
      if (b.type === 'toggle' && b.collapsed) hideBelow = b.indent;
    }
    const focused = this.focusedBlockId();
    const keep = new Set();
    let prev = null;
    visible.forEach((b, i) => {
      keep.add(b.id);
      let el = this.els.get(b.id);
      if (el && el.dataset.type !== b.type) {
        el.remove();
        el = null;
        this.rendered.delete(b.id);
      }
      if (!el) {
        el = this.createBlock(b);
        this.els.set(b.id, el);
      }
      this.updateBlock(el, b, visible, i, focused === b.id);
      const want = prev ? prev.nextSibling : this.root.firstChild;
      if (want !== el) this.root.insertBefore(el, want);
      prev = el;
    });
    for (const [id, el] of this.els) {
      if (!keep.has(id)) {
        el.remove();
        this.els.delete(id);
        this.rendered.delete(id);
        this.selected.delete(id);
      }
    }
    this.root.classList.toggle('single', visible.length === 1 && !deltaText(visible[0].delta) && visible[0].type === 'paragraph');
    if (this.pendingSel) {
      const sel = this.pendingSel;
      this.pendingSel = null;
      this.focusBlock(sel.id, sel.start, sel.end);
    }
    this.ctx.onRender?.();
  }

  createBlock(b) {
    const el = h(`div.blk.blk-${b.type}`, { 'data-id': b.id, 'data-type': b.type });
    const type = b.type;
    if (TEXT_TYPES.has(type)) {
      const text = h('div.blk-text', {
        contenteditable: this.readOnly ? 'false' : 'true',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': typeLabel(type),
        spellcheck: type === 'code' ? 'false' : 'true',
        'data-placeholder': PLACEHOLDERS[type] || '',
      });
      if (type === 'code') {
        const lang = h('button.code-lang', { type: 'button', 'aria-label': 'Code language', disabled: this.readOnly }, 'Plain text');
        lang.addEventListener('click', () => this.pickLanguage(b.id, lang));
        const copy = h('button.code-copy', { type: 'button', 'aria-label': 'Copy code', 'data-tip': 'Copy code' }, icon('copy', 14));
        copy.addEventListener('click', () => {
          navigator.clipboard?.writeText(this.textOf(b.id)).then(() => this.ctx.toast('Code copied'));
        });
        el.append(h('div.code-head', { contenteditable: 'false' }, lang, copy), h('div.blk-main', text));
      } else {
        const marker = this.marker(b);
        el.append(...(marker ? [marker] : []), h('div.blk-main', text));
      }
      return el;
    }
    if (type === 'divider') {
      el.append(h('div.blk-main.divider', { tabindex: '-1', role: 'separator', 'aria-label': 'Divider' }, h('hr')));
      return el;
    }
    if (type === 'page') {
      const link = h('a.page-block', { href: '#', 'data-page': b.page || '' });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        if (b.page) this.ctx.navigate(b.page);
      });
      el.append(h('div.blk-main', link));
      return el;
    }
    if (type === 'image') {
      el.append(h('div.blk-main.image-main'));
      return el;
    }
    if (type === 'bookmark') {
      el.append(h('div.blk-main.bookmark-main'));
      return el;
    }
    if (type === 'table') {
      el.append(h('div.blk-main.table-main'));
      return el;
    }
    el.append(h('div.blk-main'));
    return el;
  }

  marker(b) {
    if (b.type === 'bulleted') return h('span.blk-marker.bullet', { 'aria-hidden': 'true' });
    if (b.type === 'numbered') return h('span.blk-marker.number', { 'aria-hidden': 'true' });
    if (b.type === 'todo') {
      const box = h('button.blk-marker.check', { type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': 'Done', disabled: this.readOnly }, icon('check', 13, { stroke: 3 }));
      box.addEventListener('click', () => this.toggleChecked(b.id));
      return box;
    }
    if (b.type === 'toggle') {
      const btn = h('button.blk-marker.toggle', { type: 'button', 'aria-expanded': 'true', 'aria-label': 'Show content' }, icon('chevronRight', 15));
      btn.addEventListener('click', () => this.toggleCollapsed(b.id));
      return btn;
    }
    if (b.type === 'callout') {
      const btn = h('button.blk-marker.callout-icon', { type: 'button', 'aria-label': 'Change callout icon', disabled: this.readOnly });
      btn.addEventListener('click', () => this.ctx.pickIcon?.(btn, { name: this.block(b.id)?.icon }, (picked) => P.setBlock(this.doc, b.id, { icon: picked?.name || 'lightbulb' })));
      return btn;
    }
    return null;
  }

  updateBlock(el, b, visible, index, focused) {
    el.style.setProperty('--indent', b.indent || 0);
    el.dataset.indent = b.indent || 0;
    el.classList.toggle('selected', this.selected.has(b.id));
    el.classList.toggle('has-color', !!(b.color || b.bg));
    if (b.color) el.dataset.color = b.color;
    else delete el.dataset.color;
    if (b.bg) el.dataset.bg = b.bg;
    else delete el.dataset.bg;
    const snap = JSON.stringify(b);
    const same = this.rendered.get(b.id) === snap;
    if (b.type === 'numbered' && visible) el.querySelector('.blk-marker.number').textContent = `${P.listNumber(visible, index)}.`;
    if (b.type === 'bulleted') el.querySelector('.blk-marker.bullet').dataset.level = (b.indent || 0) % 3;
    if (same && b.type !== 'page') return;
    this.rendered.set(b.id, snap);
    if (TEXT_TYPES.has(b.type)) {
      const text = el.querySelector('.blk-text');
      if (this.composing && this.compose?.id === b.id) {
        // Shown after the composition ends (see compositionEnd).
        this.compose.remote = true;
        this.rendered.delete(b.id);
        return;
      }
      const current = JSON.stringify(domToDelta(text));
      if (current !== JSON.stringify(b.delta)) {
        const restore = focused ? this.relativeSel(b.id) : null;
        renderDelta(text, b.delta, { pageTitle: (id) => this.ctx.pageTitle(id) });
        if (restore) this.restoreRelative(b.id, restore);
      }
      if (b.type === 'todo') {
        const box = el.querySelector('.check');
        box.setAttribute('aria-checked', String(!!b.checked));
        el.classList.toggle('checked', !!b.checked);
      }
      if (b.type === 'toggle') {
        const btn = el.querySelector('.toggle');
        btn.setAttribute('aria-expanded', String(!b.collapsed));
        btn.setAttribute('aria-label', b.collapsed ? 'Show content' : 'Hide content');
        el.classList.toggle('collapsed', !!b.collapsed);
      }
      if (b.type === 'callout') {
        const btn = el.querySelector('.callout-icon');
        btn.replaceChildren(icon(hasIcon(b.icon) ? b.icon : 'lightbulb', 18));
      }
      if (b.type === 'code') {
        el.querySelector('.code-lang').textContent = b.language || 'Plain text';
        el.querySelector('.blk-text').setAttribute('aria-label', `Code, ${b.language || 'plain text'}`);
      }
      return;
    }
    if (b.type === 'page') this.renderPageLink(el, b);
    else if (b.type === 'image') this.renderImage(el, b);
    else if (b.type === 'bookmark') this.renderBookmark(el, b);
    else if (b.type === 'table') renderTable(this, el.querySelector('.table-main'), b);
  }

  renderPageLink(el, b) {
    const link = el.querySelector('.page-block');
    const page = b.page ? this.ctx.lookup?.(b.page) || getPage(this.ctx.tree(), b.page) : null;
    const key = page ? `${page.title}|${JSON.stringify(page.icon)}|${page.trashed}` : 'missing';
    if (link.dataset.key === key) return;
    link.dataset.key = key;
    link.dataset.page = b.page || '';
    fill(link, page ? pageIcon(page, 18) : icon('fileText', 18), h('span.page-block-title', page ? displayTitle(page) : 'Page not found'), page?.trashed ? h('span.page-block-note', 'In trash') : null);
    link.setAttribute('aria-label', page ? `Open page ${displayTitle(page)}` : 'Page not found');
  }

  async renderImage(el, b) {
    const main = el.querySelector('.image-main');
    // Only the caption changed (it saves while typing): update it in place.
    const key = `${b.asset || ''}|${b.url || ''}|${b.width || ''}|${this.readOnly}`;
    const existingCaption = main.querySelector('.media-caption');
    if (main.dataset.key === key && existingCaption) {
      if (document.activeElement !== existingCaption && existingCaption.textContent !== (b.caption || '')) existingCaption.textContent = b.caption || '';
      return;
    }
    main.dataset.key = key;
    if (!b.asset && !b.url) {
      main.replaceChildren(this.readOnly ? h('div.media-empty', icon('image', 18), 'No image') : this.imagePicker(b.id));
      return;
    }
    const caption = h('div.media-caption', { contenteditable: this.readOnly ? 'false' : 'true', role: 'textbox', 'aria-label': 'Image caption', 'data-placeholder': 'Add a caption' });
    caption.textContent = b.caption || '';
    caption.addEventListener('input', debounce(() => P.setBlock(this.doc, b.id, { caption: caption.textContent.slice(0, 1000) || null }), 400));
    caption.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.insertAfter(b.id, { type: 'paragraph' });
      }
    });
    const img = h('img', { alt: b.caption || 'Image', draggable: 'false' });
    const frame = h('div.media-frame', { style: { width: b.width ? `${b.width}%` : null } }, img);
    if (!this.readOnly) {
      for (const side of ['left', 'right']) {
        const grip = h(`span.media-resize.${side}`, { 'aria-hidden': 'true' });
        grip.addEventListener('pointerdown', (e) => this.resizeImage(e, b.id, frame, side));
        frame.append(grip);
      }
    }
    main.replaceChildren(frame, caption);
    const src = b.url ? safeUrl(b.url) : await this.ctx.space.assetUrl(b.asset).catch(() => null);
    if (src) img.src = src;
    else frame.replaceChildren(h('div.media-empty', icon('image', 18), 'This image could not be loaded'));
  }

  imagePicker(id) {
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    file.addEventListener('change', () => file.files[0] && this.uploadImage(id, file.files[0]));
    const up = h('button.btn.small', { type: 'button' }, icon('upload', 15), 'Upload');
    up.addEventListener('click', () => file.click());
    const linkBtn = h('button.btn.small.ghost', { type: 'button' }, icon('link', 15), 'Link');
    linkBtn.addEventListener('click', () => {
      const input = h('input.field', { type: 'url', placeholder: 'Paste an image link', 'aria-label': 'Image link' });
      const form = h('form.inline-form', input, h('button.btn.primary.small', { type: 'submit' }, 'Embed'));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = safeUrl(input.value);
        if (url && /^https?:/i.test(url)) P.setBlock(this.doc, id, { url });
        else input.setCustomValidity('Enter a web address that starts with https://');
        input.reportValidity();
      });
      linkBtn.parentElement.replaceWith(form);
      input.focus();
    });
    return h('div.media-empty.picker', icon('image', 18), h('span', 'Add an image'), h('div.media-actions', up, linkBtn), file);
  }

  async uploadImage(id, fileOrBlob) {
    if (!/^image\//.test(fileOrBlob.type)) return this.ctx.toast('Only images can be added here.', { kind: 'error' });
    if (fileOrBlob.size > 10 * 1024 * 1024) return this.ctx.toast('Images can be up to 10 MB.', { kind: 'error' });
    try {
      this.ctx.toast('Uploading image...');
      const asset = await this.ctx.space.putAsset(fileOrBlob);
      if (this.blocks.has(id)) P.setBlock(this.doc, id, { asset, url: null });
    } catch (err) {
      this.ctx.toast(err.message || 'The image could not be uploaded.', { kind: 'error' });
    }
  }

  resizeImage(e, id, frame, side) {
    e.preventDefault();
    const main = frame.parentElement;
    const total = main.getBoundingClientRect().width;
    const start = e.clientX;
    const startW = frame.getBoundingClientRect().width;
    let pct = null;
    const move = (ev) => {
      const dx = (ev.clientX - start) * (side === 'left' ? -2 : 2);
      pct = Math.max(20, Math.min(100, ((startW + dx) / total) * 100));
      frame.style.width = `${pct}%`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (pct) P.setBlock(this.doc, id, { width: Math.round(pct) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  renderBookmark(el, b) {
    const main = el.querySelector('.bookmark-main');
    if (!b.url) {
      if (this.readOnly) return main.replaceChildren(h('div.media-empty', icon('bookmark', 18), 'No link'));
      const input = h('input.field', { type: 'url', placeholder: 'Paste a link, then press Enter', 'aria-label': 'Bookmark link' });
      const form = h('form.media-empty.picker', icon('bookmark', 18), input);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = safeUrl(input.value);
        if (!url || !/^https?:/i.test(url)) return;
        P.setBlock(this.doc, b.id, { url, name: null });
        this.ctx.fetchTitle?.(url).then((name) => name && this.blocks.has(b.id) && P.setBlock(this.doc, b.id, { name: name.slice(0, 300) }));
      });
      main.replaceChildren(form);
      return;
    }
    let host = '';
    try {
      host = new URL(b.url).hostname.replace(/^www\./, '');
    } catch {
      host = b.url;
    }
    main.replaceChildren(
      h('a.bookmark', { href: safeUrl(b.url) || '#', target: '_blank', rel: 'noopener noreferrer' }, h('span.bookmark-icon', icon('globe', 18)), h('span.bookmark-text', h('span.bookmark-title', b.name || host), h('span.bookmark-url', b.url)), icon('externalLink', 15)),
    );
  }

  /* ---------- reading blocks ---------- */

  block(id) {
    return P.getBlock(this.doc, id);
  }

  textEl(id) {
    return this.els.get(id)?.querySelector('.blk-text') || null;
  }

  textOf(id) {
    return P.textOf(this.doc, id)?.toString() || '';
  }

  visibleIds() {
    return [...this.root.children].map((el) => el.dataset.id).filter(Boolean);
  }

  focusedBlockId() {
    const el = document.activeElement?.closest?.('.blk');
    return el && this.root.contains(el) ? el.dataset.id : null;
  }

  currentSel() {
    const id = this.focusedBlockId();
    const el = id && this.textEl(id);
    // A table cell or caption keeps its own focus through undo; restoring it
    // as a block selection would put the next keystroke on the whole block.
    if (id && !el?.contains(document.activeElement)) return null;
    const off = el && getSelectionOffsets(el);
    return id ? { id, start: off?.start ?? 0, end: off?.end ?? off?.start ?? 0 } : null;
  }

  relativeSel(id) {
    const el = this.textEl(id);
    const yt = P.textOf(this.doc, id);
    const off = el && getSelectionOffsets(el);
    if (!off || !yt) return null;
    // Positions in the old text, anchored to characters so they move with edits.
    return this.lastRel?.id === id ? this.lastRel : { id, start: off.start, end: off.end, abs: true };
  }

  restoreRelative(id, rel) {
    const el = this.textEl(id);
    if (!el) return;
    if (rel.abs) {
      setSelectionOffsets(el, rel.start, rel.end);
      return;
    }
    const a = Y.createAbsolutePositionFromRelativePosition(rel.anchor, this.doc);
    const f = Y.createAbsolutePositionFromRelativePosition(rel.head, this.doc);
    if (a && f) setSelectionOffsets(el, Math.min(a.index, f.index), Math.max(a.index, f.index));
  }

  /** Puts the caret in a block (start, end, or an offset). */
  focusBlock(id, start = 'end', end = start) {
    const el = this.els.get(id);
    if (!el) return false;
    this.clearSelection();
    const text = el.querySelector('.blk-text');
    if (!text || this.readOnly) {
      if (!text && !this.readOnly) this.selectBlocks([id]);
      return false;
    }
    text.focus({ preventScroll: true });
    const len = textLength(text);
    const s = start === 'end' ? len : start === 'start' ? 0 : Math.min(start, len);
    const e = end === 'end' ? len : end === 'start' ? 0 : Math.min(end ?? s, len);
    setSelectionOffsets(text, s, e);
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  focusStart() {
    const first = this.visibleIds()[0];
    if (first) this.focusBlock(first, 'start');
  }

  focusEnd() {
    const ids = this.visibleIds();
    const last = ids.at(-1);
    if (!last) return;
    const b = this.block(last);
    // Clicking below the last block adds a line to type in, unless one is there.
    if (!this.readOnly && (!TEXT_TYPES.has(b.type) || b.type !== 'paragraph' || deltaText(b.delta))) {
      this.pendingSel = { id: P.insertBlock(this.doc, { type: 'paragraph' }, { after: last }), start: 0, end: 0 };
    } else this.focusBlock(last, 'end');
  }

  /* ---------- events ---------- */

  bind() {
    const r = this.root;
    r.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    r.addEventListener('input', (e) => this.onInput(e));
    r.addEventListener('keydown', (e) => this.onKeyDown(e));
    r.addEventListener('compositionstart', (e) => this.compositionStart(e));
    r.addEventListener('compositionend', (e) => this.compositionEnd(e));
    r.addEventListener('paste', (e) => this.onPaste(e));
    r.addEventListener('copy', (e) => this.onCopy(e, false));
    r.addEventListener('cut', (e) => this.onCopy(e, true));
    r.addEventListener('click', (e) => this.onClick(e));
    r.addEventListener('focusin', (e) => {
      const blk = e.target.closest('.blk');
      for (const el of this.root.querySelectorAll('.blk.focused')) el.classList.remove('focused');
      if (blk && e.target.classList.contains('blk-text')) blk.classList.add('focused');
    });
    r.addEventListener('focusout', (e) => {
      if (!this.root.contains(e.relatedTarget)) for (const el of this.root.querySelectorAll('.blk.focused')) el.classList.remove('focused');
    });
    this.host.addEventListener('pointermove', (e) => this.onHover(e));
    this.host.addEventListener('pointerleave', () => {
      if (!this.dragging) this.handle.classList.remove('visible');
    });
    this.handle.querySelector('.grip').addEventListener('pointerdown', (e) => this.startDrag(e));
    this.host.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files') && !this.readOnly) {
        e.preventDefault();
        this.showDropAt(e.clientY);
      }
    });
    this.host.addEventListener('dragleave', () => this.dropLine.classList.remove('visible'));
    this.host.addEventListener('drop', (e) => this.onDropFiles(e));
    this.onSelectionChange = () => this.selectionChanged();
    document.addEventListener('selectionchange', this.onSelectionChange);
    this.onDocPointerDown = (e) => {
      if (this.selected.size && !e.target.closest?.('.popover') && !this.handle.contains(e.target)) this.clearSelection();
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  selectionChanged() {
    let id = this.focusedBlockId();
    // Read-only text is not focusable; follow the selection instead.
    if (!id && this.readOnly) {
      const node = document.getSelection()?.anchorNode;
      const blk = node && (node.nodeType === 1 ? node : node.parentElement)?.closest?.('.blk');
      if (blk && this.root.contains(blk)) id = blk.dataset.id;
    }
    const el = id && this.textEl(id);
    const off = el && getSelectionOffsets(el);
    const yt = id && P.textOf(this.doc, id);
    if (off && yt) {
      this.lastRel = { id, anchor: Y.createRelativePositionFromTypeIndex(yt, off.start), head: Y.createRelativePositionFromTypeIndex(yt, off.end) };
    }
    if (this.override && (this.override.id !== id || !off || off.start !== this.override.pos || off.end !== off.start)) this.override = null;
    if (this.slash || this.mention) this.updateTrigger();
    this.toolbar.update(id && off && off.end > off.start && (!this.readOnly || this.ctx.toolbarExtras) ? { id, el, ...off } : null);
  }

  onClick(e) {
    const link = e.target.closest('a[data-page]');
    if (link && !e.target.closest('.page-block')) {
      e.preventDefault();
      if (link.dataset.page) this.ctx.navigate(link.dataset.page);
      return;
    }
    const a = e.target.closest('a[href]');
    if (a && a.closest('.blk-text') && (modKey(e) || this.readOnly)) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
    const divider = e.target.closest('.divider, .image-main .media-frame');
    if (divider && !this.readOnly) this.selectBlocks([divider.closest('.blk').dataset.id]);
  }

  onHover(e) {
    if (this.readOnly || this.dragging || e.pointerType === 'touch') return;
    const blk = e.target.closest?.('.blk');
    if (!blk || !this.root.contains(blk)) {
      if (!this.handle.contains(e.target)) this.handle.classList.remove('visible');
      return;
    }
    if (this.hoverId === blk.dataset.id && this.handle.classList.contains('visible')) return;
    this.hoverId = blk.dataset.id;
    const hostRect = this.host.getBoundingClientRect();
    const main = blk.querySelector('.blk-main') || blk;
    const target = blk.querySelector('.blk-marker') || main;
    const r = target.getBoundingClientRect();
    const textEl = blk.querySelector('.blk-text');
    const lh = textEl ? parseFloat(getComputedStyle(textEl).lineHeight) || 24 : 28;
    const top = (textEl ? textEl.getBoundingClientRect().top : r.top) - hostRect.top + Math.max(0, (Math.min(lh, 40) - 24) / 2);
    this.handle.style.transform = `translate(${Math.round(r.left - hostRect.left - 50)}px, ${Math.round(top)}px)`;
    this.handle.classList.add('visible');
  }

  onBeforeInput(e) {
    if (this.readOnly) return e.preventDefault();
    const textEl = e.target.closest?.('.blk-text');
    if (!textEl) return;
    const id = textEl.closest('.blk').dataset.id;
    const t = e.inputType;
    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      this.flushInput();
      t === 'historyUndo' ? this.undo.undo() : this.undo.redo();
      return;
    }
    if (t === 'formatBold' || t === 'formatItalic' || t === 'formatUnderline' || t === 'formatStrikeThrough') {
      e.preventDefault();
      this.toggleMark({ formatBold: 'bold', formatItalic: 'italic', formatUnderline: 'underline', formatStrikeThrough: 'strike' }[t]);
      return;
    }
    if (t === 'insertText' && e.data && this.override && !this.composing) {
      const off = getSelectionOffsets(textEl);
      const o = this.override;
      if (o.id === id && off && off.start === off.end && off.start === o.pos) {
        // Formatting picked for the next characters (after **bold**, or
        // Ctrl+B with nothing selected) applies to what is typed now.
        e.preventDefault();
        this.syncText(id, textEl);
        const yt = P.textOf(this.doc, id);
        const attrs = { bold: null, italic: null, underline: null, strike: null, code: null, link: null, page: null, color: null, bg: null, ...o.attrs };
        this.doc.transact(() => yt.insert(o.pos, e.data, attrs), LOCAL);
        // The caret now sits in text with the chosen formatting, so the
        // browser carries it on by itself.
        this.override = null;
        this.rendered.delete(id);
        this.render();
        setSelectionOffsets(textEl, o.pos + e.data.length);
        if (this.slash || this.mention) this.updateTrigger();
        this.afterTyping(id, textEl, e.data);
        return;
      }
      this.override = null;
    }
    if (t === 'insertParagraph') {
      e.preventDefault();
      if (this.slash || this.mention) return;
      this.enter(id, textEl);
      return;
    }
    if (t === 'insertLineBreak') {
      e.preventDefault();
      this.insertText(id, '\n');
      return;
    }
    if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
      const off = getSelectionOffsets(textEl);
      if (!off || off.start !== off.end) return;
      if (t === 'deleteContentBackward' && off.start === 0) {
        e.preventDefault();
        this.backspaceAtStart(id);
      } else if (t === 'deleteContentForward' && off.start === textLength(textEl)) {
        e.preventDefault();
        this.deleteAtEnd(id);
      }
    }
  }

  /**
   * While an input method composes text (Chinese, Japanese, Korean, many
   * phone keyboards), the block's DOM is the browser's; edits arriving from
   * others meanwhile are kept in the document and shown when it ends.
   */
  compositionStart(e) {
    this.composing = true;
    const textEl = e.target.closest?.('.blk-text');
    const id = textEl?.closest('.blk')?.dataset.id;
    const yt = id && P.textOf(this.doc, id);
    const off = textEl && getSelectionOffsets(textEl);
    if (!yt || !off) {
      this.compose = null;
      return;
    }
    this.compose = { id, start: off.start, selLen: off.end - off.start, baseLen: textLength(textEl), rel: Y.createRelativePositionFromTypeIndex(yt, off.start), remote: false };
  }

  compositionEnd(e) {
    this.composing = false;
    const c = this.compose;
    this.compose = null;
    const textEl = e.target.closest?.('.blk-text');
    if (!c || !c.remote || !textEl || textEl.closest('.blk')?.dataset.id !== c.id) return this.onInput(e);
    // Others changed this block while composing: insert only what was
    // composed, where it was composed, then show the merged text.
    const yt = P.textOf(this.doc, c.id);
    const domText = deltaText(domToDelta(textEl));
    const insertedLen = Math.max(0, domText.length - c.baseLen + c.selLen);
    const inserted = domText.slice(c.start, c.start + insertedLen);
    const at = Y.createAbsolutePositionFromRelativePosition(c.rel, this.doc)?.index ?? c.start;
    const attrs = { ...formatAt(yt, at, at) };
    this.doc.transact(() => {
      if (c.selLen) yt.delete(at, Math.min(c.selLen, yt.length - at));
      if (inserted) yt.insert(at, inserted, { bold: null, italic: null, underline: null, strike: null, code: null, link: null, page: null, color: null, bg: null, ...attrs });
    }, LOCAL);
    this.rendered.delete(c.id);
    this.render();
    setSelectionOffsets(textEl, at + inserted.length);
  }

  onInput(e) {
    if (this.composing || this.readOnly) return;
    const textEl = e.target.closest?.('.blk-text');
    if (!textEl) return;
    const blk = textEl.closest('.blk');
    const id = blk.dataset.id;
    this.syncText(id, textEl);
    // Follow the "/" or "@" query here too: selectionchange is not always fired for typing.
    if (this.slash || this.mention) this.updateTrigger();
    if (e.inputType === 'insertText' || e.type === 'compositionend') this.afterTyping(id, textEl, e.data);
  }

  /** Copies what is in a block's DOM into its Y.Text. */
  syncText(id, textEl = this.textEl(id)) {
    const yt = P.textOf(this.doc, id);
    if (!yt || !textEl) return;
    let delta = domToDelta(textEl);
    const b = this.block(id);
    if (b.type === 'code') delta = [{ insert: deltaText(delta) }].filter((op) => op.insert);
    const before = JSON.stringify(yt.toDelta());
    if (before === JSON.stringify(delta)) return;
    this.doc.transact(() => applyDelta(yt, delta), LOCAL);
    const snap = JSON.stringify(this.block(id));
    this.rendered.set(id, snap);
    // Keep the DOM in the shape the renderer produces (browsers sometimes
    // wrap typed text in stray elements).
    const probe = document.createElement('div');
    renderDelta(probe, yt.toDelta());
    if (probe.innerHTML !== textEl.innerHTML && !/^(<br>)?$/.test(textEl.innerHTML)) {
      const off = getSelectionOffsets(textEl);
      renderDelta(textEl, yt.toDelta(), { pageTitle: (pid) => this.ctx.pageTitle(pid) });
      if (off) setSelectionOffsets(textEl, off.start, off.end);
    }
  }

  flushInput() {
    // Table cells save on their own a moment after typing.
    const table = document.activeElement?.closest?.('.table-main');
    if (table && this.root.contains(table)) table._save?.flush();
    // A render still pending means the DOM is older than the document; it
    // holds nothing new to save.
    if (this.renderQueued) return;
    const id = this.focusedBlockId();
    if (id && this.textEl(id)) this.syncText(id);
  }

  afterTyping(id, textEl, data) {
    const b = this.block(id);
    const off = getSelectionOffsets(textEl);
    if (!off || off.start !== off.end) return;
    const text = this.textOf(id);
    const before = text.slice(0, off.start);
    if (data === '/' && !this.slash) return this.openSlash(id, off.start - 1);
    if (data === '@' && !this.mention && (off.start === 1 || /\s/.test(text[off.start - 2]))) return this.openMention(id, off.start - 1);
    if (b.type === 'code') return;
    // Block shortcuts: typed at the start of a text block, then a space.
    if (data === ' ' && b.type === 'paragraph') {
      const lead = before.slice(0, -1);
      for (const [re, spec] of SHORTCUTS) {
        if (re.test(lead)) {
          this.doc.transact(() => {
            P.textOf(this.doc, id).delete(0, lead.length + 1);
            P.setType(this.doc, id, spec.type, spec.checked !== undefined ? { checked: spec.checked } : {});
          }, LOCAL);
          this.pendingSel = { id, start: 0, end: 0 };
          announce(`${typeLabel(spec.type)}`);
          return;
        }
      }
    }
    if (b.type === 'paragraph' && /^```$/.test(before) && off.start === text.length) {
      this.doc.transact(() => {
        P.textOf(this.doc, id).delete(0, 3);
        P.setType(this.doc, id, 'code');
      }, LOCAL);
      this.pendingSel = { id, start: 0, end: 0 };
      return;
    }
    if (b.type === 'paragraph' && before === '---' && text === '---') {
      this.doc.transact(() => {
        P.setType(this.doc, id, 'divider');
        P.textOf(this.doc, id).delete(0, 3);
      }, LOCAL);
      this.pendingSel = { id: P.insertBlock(this.doc, { type: 'paragraph' }, { after: id }), start: 0 };
      return;
    }
    // Inline Markdown: **bold**, *italic*, `code`, ~~strike~~ when closed.
    const inline = [
      [/\*\*([^*\s][^*]*?[^*\s]|[^*\s])\*\*$/, 'bold', 2],
      [/~~([^~\s][^~]*?[^~\s]|[^~\s])~~$/, 'strike', 2],
      [/(?:^|[^*\w])\*([^*\s][^*]*?[^*\s]|[^*\s])\*$/, 'italic', 1],
      [/(?:^|[^_\w])_([^_\s][^_]*?[^_\s]|[^_\s])_$/, 'italic', 1],
      [/`([^`]+)`$/, 'code', 1],
    ];
    for (const [re, mark, n] of inline) {
      const m = re.exec(before);
      if (!m) continue;
      const inner = m[1];
      const end = off.start;
      const start = end - inner.length - n * 2;
      this.doc.transact(() => {
        const yt = P.textOf(this.doc, id);
        yt.delete(end - n, n);
        yt.delete(start, n);
        yt.format(start, inner.length, { [mark]: true });
        // Typing continues without the mark.
      }, LOCAL);
      this.pendingSel = { id, start: start + inner.length, end: start + inner.length };
      this.rendered.delete(id);
      this.render();
      const rest = { ...formatAt(P.textOf(this.doc, id), start + inner.length, start + inner.length) };
      delete rest[mark];
      this.override = { id, pos: start + inner.length, attrs: rest };
      return;
    }
  }

  onKeyDown(e) {
    if (this.handleMenuKey(e)) return;
    const textEl = e.target.closest?.('.blk-text');
    const mod = modKey(e);
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      e.preventDefault();
      this.flushInput();
      if (e.key === 'y' || e.shiftKey) this.undo.redo();
      else this.undo.undo();
      return;
    }
    if (this.selected.size && !textEl) return this.onSelectionKey(e);
    if (!textEl || this.readOnly) return;
    const id = textEl.closest('.blk').dataset.id;
    const b = this.block(id);
    const off = getSelectionOffsets(textEl) || { start: 0, end: 0 };
    const collapsed = off.start === off.end;
    const len = textLength(textEl);
    if (mod && !e.altKey && !e.shiftKey) {
      const marks = { b: 'bold', i: 'italic', u: 'underline', e: 'code' };
      if (marks[e.key.toLowerCase()]) {
        e.preventDefault();
        return this.toggleMark(marks[e.key.toLowerCase()]);
      }
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        return this.toolbar.editLink();
      }
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.flushInput();
        const ids = P.duplicateBlocks(this.doc, [id]);
        this.pendingSel = { id: ids[0], start: 'end' };
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        return this.openBlockMenu(this.els.get(id), [id]);
      }
      if (e.key === 'Enter' && b.type === 'todo') {
        e.preventDefault();
        return this.toggleChecked(id);
      }
    }
    if (mod && e.shiftKey && !e.altKey) {
      if (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'x') {
        e.preventDefault();
        return this.toggleMark('strike');
      }
      if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        return this.toggleMark('bg', 'yellow');
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        return this.moveBy([id], e.key === 'ArrowUp' ? -1 : 1);
      }
    }
    if (mod && e.altKey) {
      const map = { 0: 'paragraph', 1: 'h1', 2: 'h2', 3: 'h3', 4: 'todo', 5: 'bulleted', 6: 'numbered', 7: 'toggle', 8: 'code' };
      const digit = /^Digit(\d)$/.exec(e.code)?.[1];
      if (digit && map[digit]) {
        e.preventDefault();
        return this.turnInto([id], map[digit]);
      }
    }
    if (e.key === 'Enter' && mod && b.type === 'code') {
      e.preventDefault();
      return this.insertAfter(id, { type: 'paragraph' });
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (b.type === 'code') return this.insertText(id, '\n');
      return this.enter(id, textEl);
    }
    if (e.key === 'Enter' && e.shiftKey && !mod) {
      e.preventDefault();
      return this.insertText(id, '\n');
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (b.type === 'code' && !e.shiftKey) {
        e.preventDefault();
        return this.insertText(id, '  ');
      }
      e.preventDefault();
      this.flushInput();
      if (e.shiftKey) P.indentBlocks(this.doc, [id], -1);
      else if (P.canIndent(this.doc, id)) P.indentBlocks(this.doc, [id], 1);
      else return;
      this.pendingSel = { id, start: off.start, end: off.end };
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.flushInput();
      textEl.blur();
      this.selectBlocks([id]);
      return;
    }
    if (e.key === 'Backspace' && collapsed && off.start === 0 && !e.isComposing) {
      e.preventDefault();
      return this.backspaceAtStart(id);
    }
    if (e.key === 'Delete' && collapsed && off.start === len) {
      e.preventDefault();
      return this.deleteAtEnd(id);
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !mod && !e.altKey) {
      const up = e.key === 'ArrowUp';
      if (up ? onFirstLine(textEl) : onLastLine(textEl)) {
        const target = this.neighbor(id, up ? -1 : 1);
        if (!target) {
          if (up) this.ctx.focusTitle?.();
          return;
        }
        e.preventDefault();
        const x = textEl.ownerDocument.getSelection()?.rangeCount ? textEl.ownerDocument.getSelection().getRangeAt(0).getBoundingClientRect().left : 0;
        const tEl = this.textEl(target);
        if (tEl) {
          if (!placeCaretAtX(tEl, x, !up)) this.focusBlock(target, up ? 'end' : 'start');
          this.els.get(target)?.scrollIntoView({ block: 'nearest' });
        } else this.selectBlocks([target]);
      }
      return;
    }
    if (e.key === 'ArrowUp' && e.shiftKey && collapsed && off.start === 0) {
      e.preventDefault();
      this.selectBlocks([id]);
      return;
    }
    if (e.key === 'ArrowLeft' && collapsed && off.start === 0 && !e.shiftKey) {
      const target = this.neighbor(id, -1);
      if (target && this.textEl(target)) {
        e.preventDefault();
        this.focusBlock(target, 'end');
      }
      return;
    }
    if (e.key === 'ArrowRight' && collapsed && off.start === len && !e.shiftKey) {
      const target = this.neighbor(id, 1);
      if (target && this.textEl(target)) {
        e.preventDefault();
        this.focusBlock(target, 'start');
      }
    }
  }

  neighbor(id, dir) {
    const ids = this.visibleIds();
    const i = ids.indexOf(id);
    return ids[i + dir] || null;
  }

  /* ---------- structure ---------- */

  insertText(id, text) {
    const el = this.textEl(id);
    this.syncText(id, el);
    const off = getSelectionOffsets(el) || { start: 0, end: 0 };
    const yt = P.textOf(this.doc, id);
    this.doc.transact(() => {
      if (off.end > off.start) yt.delete(off.start, off.end - off.start);
      yt.insert(off.start, text, {});
    }, LOCAL);
    this.rendered.delete(id);
    this.pendingSel = { id, start: off.start + text.length, end: off.start + text.length };
    this.render();
  }

  enter(id, textEl) {
    this.syncText(id, textEl);
    const b = this.block(id);
    const off = getSelectionOffsets(textEl) || { start: 0, end: 0 };
    const empty = !deltaText(b.delta).length;
    // Enter on an empty list item leaves the list (outdenting first).
    if (empty && ['bulleted', 'numbered', 'todo', 'toggle', 'quote', 'callout'].includes(b.type)) {
      if (b.indent > 0) P.indentBlocks(this.doc, [id], -1);
      else P.setType(this.doc, id, 'paragraph');
      this.pendingSel = { id, start: 0 };
      return;
    }
    if (empty && b.indent > 0 && b.type === 'paragraph') {
      P.indentBlocks(this.doc, [id], -1);
      this.pendingSel = { id, start: 0 };
      return;
    }
    let newId;
    this.doc.transact(() => {
      const yt = P.textOf(this.doc, id);
      if (off.end > off.start) yt.delete(off.start, off.end - off.start);
      // Enter at the very start of a non-empty block pushes it down instead.
      if (off.start === 0 && deltaText(b.delta).length && off.end === off.start) {
        newId = P.insertBlock(this.doc, { type: 'paragraph', indent: b.indent }, { before: id });
        this.pendingSel = { id, start: 0 };
      } else {
        newId = P.splitBlock(this.doc, id, off.start);
        this.pendingSel = { id: newId, start: 0 };
      }
    }, LOCAL);
    this.rendered.delete(id);
  }

  backspaceAtStart(id) {
    this.flushInput();
    const b = this.block(id);
    if (b.type !== 'paragraph') {
      P.setType(this.doc, id, 'paragraph');
      this.pendingSel = { id, start: 0 };
      return;
    }
    if (b.indent > 0) {
      P.indentBlocks(this.doc, [id], -1);
      this.pendingSel = { id, start: 0 };
      return;
    }
    const prevId = this.neighbor(id, -1);
    if (!prevId) return;
    const prev = this.block(prevId);
    if (!TEXT_TYPES.has(prev.type)) {
      if (!deltaText(b.delta).length) {
        P.deleteBlocks(this.doc, [id]);
        this.selectBlocks([prevId]);
      } else this.selectBlocks([prevId]);
      return;
    }
    const res = P.mergeIntoPrevious(this.doc, id);
    if (res && !res.blocked) {
      this.rendered.delete(prevId);
      this.pendingSel = { id: res.id, start: res.offset };
    }
  }

  deleteAtEnd(id) {
    this.flushInput();
    const nextId = this.neighbor(id, 1);
    if (!nextId) return;
    const next = this.block(nextId);
    if (!TEXT_TYPES.has(next.type)) {
      this.selectBlocks([nextId]);
      return;
    }
    const len = this.textOf(id).length;
    const res = P.mergeIntoPrevious(this.doc, nextId);
    if (res && !res.blocked) {
      this.rendered.delete(id);
      this.pendingSel = { id, start: len };
    }
  }

  insertAfter(id, spec, { focus = true } = {}) {
    this.flushInput();
    const b = this.block(id);
    const after = b?.type === 'toggle' && b.collapsed ? P.withChildren(this.doc, id).at(-1) : id;
    const newId = P.insertBlock(this.doc, { indent: b?.indent || 0, ...spec }, { after });
    if (focus) this.pendingSel = { id: newId, start: 0 };
    return newId;
  }

  toggleChecked(id) {
    if (this.readOnly) return;
    const b = this.block(id);
    P.setBlock(this.doc, id, { checked: !b.checked });
    announce(b.checked ? 'Not done' : 'Done');
  }

  toggleCollapsed(id) {
    const b = this.block(id);
    // Viewers can fold toggles for themselves without saving anything.
    if (this.readOnly) {
      const el = this.els.get(id);
      el.classList.toggle('collapsed');
      const collapsed = el.classList.contains('collapsed');
      let next = el.nextElementSibling;
      while (next && Number(next.dataset.indent) > b.indent) {
        next.hidden = collapsed;
        next = next.nextElementSibling;
      }
      el.querySelector('.toggle').setAttribute('aria-expanded', String(!collapsed));
      return;
    }
    P.setBlock(this.doc, id, { collapsed: !b.collapsed });
  }

  turnInto(ids, type, extra = {}) {
    this.flushInput();
    const focus = this.currentSel();
    this.doc.transact(() => {
      for (const id of ids) {
        const b = this.block(id);
        if (!b || !TEXT_TYPES.has(b.type)) continue;
        P.setType(this.doc, id, type, { ...(type === 'todo' ? { checked: false } : {}), ...(type === 'callout' ? { icon: 'lightbulb' } : {}), ...extra });
      }
    }, LOCAL);
    if (focus && ids.includes(focus.id)) this.pendingSel = focus;
    announce(`Turned into ${typeLabel(type)}`);
  }

  moveBy(ids, dir) {
    this.flushInput();
    const visible = this.visibleIds();
    const sorted = ids.slice().sort((a, b) => visible.indexOf(a) - visible.indexOf(b));
    const focus = this.currentSel();
    const list = P.listBlocks(this.doc);
    const first = list.findIndex((b) => b.id === sorted[0]);
    const lastGroup = P.withChildren(this.doc, sorted.at(-1));
    const last = list.findIndex((b) => b.id === lastGroup.at(-1));
    if (dir < 0) {
      // Move above the previous block at the same or lower indent.
      let j = first - 1;
      while (j >= 0 && list[j].indent > list[first].indent) j--;
      if (j < 0) return;
      P.moveBlocks(this.doc, sorted, { before: list[j].id });
    } else {
      const next = list[last + 1];
      if (!next) return;
      P.moveBlocks(this.doc, sorted, { after: next.id });
    }
    if (focus) this.pendingSel = focus;
    else this.renderSoon();
    if (this.selected.size) queueMicrotask(() => this.selectBlocks(sorted));
    announce(dir < 0 ? 'Moved up' : 'Moved down');
  }

  /* ---------- formatting ---------- */

  toggleMark(mark, value = true) {
    const id = this.focusedBlockId() || this.toolbar.target?.id;
    const el = id && this.textEl(id);
    if (!el || this.readOnly || this.block(id).type === 'code') return;
    this.syncText(id, el);
    const off = getSelectionOffsets(el) || this.toolbar.target;
    if (!off) return;
    const yt = P.textOf(this.doc, id);
    if (off.end === off.start) {
      const base = this.override?.id === id && this.override.pos === off.start ? this.override.attrs : formatAt(yt, off.start, off.start);
      const attrs = { ...base };
      if (attrs[mark] === value) delete attrs[mark];
      else attrs[mark] = value;
      this.override = { id, pos: off.start, attrs };
      announce(`${mark[0].toUpperCase() + mark.slice(1)} ${attrs[mark] ? 'on' : 'off'}`);
      return;
    }
    const has = formatAt(yt, off.start, off.end)[mark] === value;
    this.applyFormat(id, off, { [mark]: has ? null : value });
    announce(`${mark === 'bg' ? 'Highlight' : mark[0].toUpperCase() + mark.slice(1)} ${has ? 'off' : 'on'}`);
  }

  applyFormat(id, off, attrs) {
    const yt = P.textOf(this.doc, id);
    this.doc.transact(() => yt.format(off.start, off.end - off.start, attrs), LOCAL);
    this.rendered.delete(id);
    this.pendingSel = { id, start: off.start, end: off.end };
    this.render();
    this.selectionChanged();
  }

  setBlockColor(ids, { color, bg }) {
    this.doc.transact(() => {
      for (const id of ids) P.setBlock(this.doc, id, { color: color ?? null, bg: bg ?? null });
    }, LOCAL);
  }

  /* ---------- "/" and "@" menus ---------- */

  closeMenus() {
    this.slash?.pop.close({ focus: false });
    this.mention?.pop.close({ focus: false });
    this.slash = null;
    this.mention = null;
  }

  openSlash(id, at) {
    const items = [
      { type: 'header', label: 'Basic blocks' },
      ...INSERTABLE.map((c) => ({ ...c, hint: c.shortcut, run: () => this.applySlash(c) })),
      { type: 'header', label: 'Pages' },
      ...PAGE_COMMANDS.map((c) => ({ ...c, run: () => this.applySlash(c) })),
    ];
    this.openTrigger('slash', id, at, items, 'Insert a block');
  }

  openMention(id, at) {
    this.openTrigger('mention', id, at, this.mentionItems(''), 'Link to a page');
  }

  mentionItems(q) {
    return (this.ctx.searchPages?.(q) || []).slice(0, 12).map((r) => ({
      label: r.title,
      icon: pageIcon(r.page, 16),
      description: r.path.join(' / '),
      run: () => this.applyMention(r.page.id, r.title),
    }));
  }

  openTrigger(kind, id, at, items, label) {
    this.closeMenus();
    const el = this.textEl(id);
    const range = document.getSelection().getRangeAt(0).getBoundingClientRect();
    const menu = new Menu(items, { label, external: true, empty: kind === 'mention' ? 'No pages found' : 'No matching blocks', className: 'slash-menu' });
    const pop = new Popover({ anchor: range.height ? range : el.getBoundingClientRect(), content: menu.el, className: 'menu-pop', role: null, returnFocus: false, onClose: () => {
      if (this[kind]?.menu === menu) this[kind] = null;
      el.removeAttribute('aria-controls');
      el.removeAttribute('aria-activedescendant');
    } });
    menu.popover = pop;
    el.setAttribute('aria-controls', menu.id);
    this[kind] = { id, at, menu, pop, kind };
    // Choosing closes the menu (which clears this[kind]) before running the item.
    this.lastTrigger = this[kind];
  }

  /** Follows typing after "/" or "@" to filter the menu. */
  updateTrigger() {
    const t = this.slash || this.mention;
    if (!t) return;
    const el = this.textEl(t.id);
    const off = el && document.activeElement === el ? getSelectionOffsets(el) : null;
    const text = this.textOf(t.id);
    const trigger = t.kind === 'slash' ? '/' : '@';
    if (!off || off.start <= t.at || text[t.at] !== trigger) return this.closeMenus();
    const q = text.slice(t.at + 1, off.start);
    if (q.length > 40 || /\n/.test(q) || (t.kind === 'slash' && /\s\s/.test(q))) return this.closeMenus();
    if (t.kind === 'mention') {
      t.menu.allItems = this.mentionItems(q);
      t.menu.render();
    } else t.menu.setQuery(q);
    // Too many characters with nothing matching ends the slash menu.
    if (t.kind === 'slash' && !t.menu.selectable().length && q.length > 6) this.closeMenus();
    if (t.menu.active >= 0) el.setAttribute('aria-activedescendant', `${t.menu.id}-${t.menu.active}`);
  }

  handleMenuKey(e) {
    const t = this.slash || this.mention;
    if (!t) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.closeMenus();
      return true;
    }
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(e.key)) {
      if (e.key === 'Tab') {
        e.preventDefault();
        t.menu.move(e.shiftKey ? -1 : 1);
        return true;
      }
      const handled = t.menu.handleKey(e);
      const el = this.textEl(t.id);
      if (el && t.menu.active >= 0) el.setAttribute('aria-activedescendant', `${t.menu.id}-${t.menu.active}`);
      return handled;
    }
    return false;
  }

  /** Removes the "/query" or "@query" text the menu was opened with. */
  removeTrigger(t) {
    const el = this.textEl(t.id);
    this.syncText(t.id, el);
    const off = getSelectionOffsets(el);
    const end = Math.max(t.at + 1, off?.start ?? t.at + 1);
    const yt = P.textOf(this.doc, t.id);
    this.doc.transact(() => yt.delete(t.at, Math.min(end, yt.length) - t.at), LOCAL);
    this.rendered.delete(t.id);
    // The DOM must match before anything reads it back into the document.
    this.render();
    setSelectionOffsets(this.textEl(t.id), t.at);
    return t.at;
  }

  async applySlash(cmd) {
    const t = this.slash || (this.lastTrigger?.kind === 'slash' ? this.lastTrigger : null);
    this.lastTrigger = null;
    if (!t) return;
    this.slash = null;
    t.pop.close({ focus: false });
    const at = this.removeTrigger(t);
    const id = t.id;
    const b = this.block(id);
    const empty = !deltaText(b.delta).length;
    if (cmd.action === 'mention') {
      this.pendingSel = { id, start: at };
      this.render();
      this.insertText(id, '@');
      this.openMention(id, at);
      return;
    }
    if (cmd.action === 'page' || cmd.action === 'database') {
      const childId = await this.ctx.createChild(cmd.action === 'database' ? 'database' : 'page');
      if (!childId) return;
      if (empty) P.setType(this.doc, id, 'page', { page: childId });
      else P.insertBlock(this.doc, { type: 'page', page: childId, indent: b.indent }, { after: id });
      this.ctx.navigate(childId, { focusTitle: true });
      return;
    }
    const type = cmd.type;
    if (TEXT_TYPES.has(type)) {
      if (empty || type === b.type) {
        this.turnInto([id], type);
        this.pendingSel = { id, start: at };
      } else {
        this.pendingSel = { id: this.insertAfter(id, { type, ...(type === 'todo' ? { checked: false } : {}), ...(type === 'callout' ? { icon: 'lightbulb' } : {}) }), start: 0 };
      }
      return;
    }
    // Media and structure blocks replace an empty line or go below it.
    const extra = type === 'table' ? { table: { rows: [['', '', ''], ['', '', ''], ['', '', '']], header: true } } : {};
    let target = id;
    if (empty) P.setType(this.doc, id, type, extra);
    else target = P.insertBlock(this.doc, { type, indent: b.indent, ...extra }, { after: id });
    if (type === 'divider') {
      this.pendingSel = { id: P.insertBlock(this.doc, { type: 'paragraph', indent: b.indent }, { after: target }), start: 0 };
      return;
    }
    this.render();
    if (type === 'image') this.els.get(target)?.querySelector('.media-actions .btn')?.focus();
    else if (type === 'bookmark') this.els.get(target)?.querySelector('input')?.focus();
    else if (type === 'table') this.els.get(target)?.querySelector('td, th')?.focus();
  }

  applyMention(pageId, title) {
    const t = this.mention || (this.lastTrigger?.kind === 'mention' ? this.lastTrigger : null);
    this.lastTrigger = null;
    if (!t) return;
    this.mention = null;
    t.pop.close({ focus: false });
    const at = this.removeTrigger(t);
    const yt = P.textOf(this.doc, t.id);
    const label = title || 'Untitled';
    this.doc.transact(() => {
      yt.insert(at, label, { page: pageId });
      yt.insert(at + label.length, ' ', {});
    }, LOCAL);
    this.rendered.delete(t.id);
    this.pendingSel = { id: t.id, start: at + label.length + 1 };
    this.render();
  }

  pickLanguage(id, anchor) {
    const cur = this.block(id)?.language || 'Plain text';
    openMenu(anchor, CODE_LANGUAGES.map((l) => ({ label: l, checked: l === cur, radio: true, run: () => P.setBlock(this.doc, id, { language: l === 'Plain text' ? null : l }) })), { label: 'Code language', filter: true, filterPlaceholder: 'Search languages' });
  }

  /* ---------- block handle, block menu and block selection ---------- */

  handleAdd(e) {
    const id = this.hoverId;
    if (!id || !this.blocks.has(id)) return;
    const b = this.block(id);
    // Alt-click adds above, like most outliners.
    const newId = e.altKey ? P.insertBlock(this.doc, { type: 'paragraph', indent: b.indent }, { before: id }) : this.insertAfter(id, { type: 'paragraph' }, { focus: false });
    this.render();
    this.focusBlock(newId, 'start');
    this.insertText(newId, '/');
    this.openSlash(newId, 0);
  }

  selectBlocks(ids, { anchor = null } = {}) {
    this.closeMenus();
    for (const id of this.selected) this.els.get(id)?.classList.remove('selected');
    this.selected = new Set(ids.filter((id) => this.els.has(id)));
    this.selectAnchor = anchor ?? ids[0];
    for (const id of this.selected) this.els.get(id)?.classList.add('selected');
    if (this.selected.size) {
      document.getSelection()?.removeAllRanges();
      this.root.focus({ preventScroll: true });
      this.els.get(ids.at(-1))?.scrollIntoView({ block: 'nearest' });
      announce(`${this.selected.size} block${this.selected.size === 1 ? '' : 's'} selected`);
    }
    this.toolbar.update(null);
  }

  clearSelection() {
    if (!this.selected.size) return;
    for (const id of this.selected) this.els.get(id)?.classList.remove('selected');
    this.selected.clear();
  }

  orderedSelection() {
    const visible = this.visibleIds();
    return [...this.selected].sort((a, b) => visible.indexOf(a) - visible.indexOf(b));
  }

  onSelectionKey(e) {
    const ids = this.orderedSelection();
    const visible = this.visibleIds();
    const mod = modKey(e);
    if (e.key === 'Escape') {
      e.preventDefault();
      this.clearSelection();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const id = ids.at(-1);
      if (this.textEl(id)) this.focusBlock(id, 'end');
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (mod && e.shiftKey) return this.moveBy(ids, e.key === 'ArrowUp' ? -1 : 1);
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (e.shiftKey) {
        const anchorIdx = visible.indexOf(this.selectAnchor);
        const edge = dir < 0 ? visible.indexOf(ids[0]) : visible.indexOf(ids.at(-1));
        const headIdx = (ids.length === 1 ? anchorIdx : edge === anchorIdx ? visible.indexOf(dir < 0 ? ids.at(-1) : ids[0]) : edge) + dir;
        const h2 = Math.max(0, Math.min(visible.length - 1, headIdx));
        const [a, b] = [Math.min(anchorIdx, h2), Math.max(anchorIdx, h2)];
        this.selectBlocks(visible.slice(a, b + 1), { anchor: this.selectAnchor });
      } else {
        const i = dir < 0 ? visible.indexOf(ids[0]) - 1 : visible.indexOf(ids.at(-1)) + 1;
        if (visible[i]) this.selectBlocks([visible[i]]);
      }
      return;
    }
    if (this.readOnly) {
      if (mod && e.key.toLowerCase() === 'c') return;
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      return this.deleteBlocks(ids);
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      P.indentBlocks(this.doc, ids, e.shiftKey ? -1 : 1);
      queueMicrotask(() => this.selectBlocks(ids));
      return;
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      const copies = P.duplicateBlocks(this.doc, ids);
      queueMicrotask(() => this.selectBlocks(copies));
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectBlocks(visible);
      return;
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      this.openBlockMenu(this.els.get(ids[0]), ids);
    }
  }

  deleteBlocks(ids) {
    const all = new Set();
    for (const id of ids) for (const c of P.withChildren(this.doc, id)) all.add(c);
    const visible = this.visibleIds();
    const before = visible[visible.indexOf(ids[0]) - 1];
    const pageBlocks = [...all].map((id) => this.block(id)).filter((b) => b?.type === 'page' && b.page);
    P.deleteBlocks(this.doc, [...all]);
    for (const b of pageBlocks) this.ctx.trashPage?.(b.page);
    this.selected.clear();
    if (before && this.blocks.has(before)) this.pendingSel = { id: before, start: 'end' };
    announce(`${all.size} block${all.size === 1 ? '' : 's'} deleted`);
  }

  blockMenuItems(ids) {
    const first = this.block(ids[0]);
    const textual = ids.every((id) => TEXT_TYPES.has(this.block(id)?.type));
    const colorItems = (key) => [
      { label: 'Default', checked: !first[key], radio: true, run: () => this.setBlockColor(ids, { color: key === 'color' ? null : first.color, bg: key === 'bg' ? null : first.bg }) },
      ...COLORS.map((c) => ({
        label: c[0].toUpperCase() + c.slice(1),
        icon: h(`span.swatch.${key === 'bg' ? 'bg' : 'fg'}`, { 'data-c': c }, key === 'color' ? 'A' : ''),
        checked: first[key] === c,
        run: () => this.setBlockColor(ids, { color: key === 'color' ? c : first.color, bg: key === 'bg' ? c : first.bg }),
      })),
    ];
    const items = [];
    if (textual) {
      items.push({
        label: 'Turn into',
        icon: 'refresh',
        submenu: () => INSERTABLE.filter((c) => TEXT_TYPES.has(c.type)).map((c) => ({ label: c.label, icon: c.icon, checked: ids.every((id) => this.block(id).type === c.type), run: () => this.turnInto(ids, c.type) })),
      });
      items.push({ label: 'Text color', icon: 'baseline', submenu: () => colorItems('color') }, { label: 'Background', icon: 'palette', submenu: () => colorItems('bg') });
    }
    items.push(
      { type: 'sep' },
      { label: 'Duplicate', icon: 'copy', hint: `${modLabel}D`, run: () => P.duplicateBlocks(this.doc, ids) },
      { label: 'Move up', icon: 'arrowUp', run: () => this.moveBy(ids, -1) },
      { label: 'Move down', icon: 'arrowDown', run: () => this.moveBy(ids, 1) },
      { label: 'Copy link to block', icon: 'link', run: () => this.ctx.copyBlockLink?.(ids[0]) },
      ...(this.ctx.blockMenuExtras?.(ids) || []),
      { type: 'sep' },
      { label: 'Delete', icon: 'trash', danger: true, hint: 'Del', run: () => this.deleteBlocks(ids) },
    );
    return items;
  }

  openBlockMenu(anchor, ids) {
    if (this.readOnly) return;
    this.flushInput();
    if (!ids.every((id) => this.selected.has(id))) this.selectBlocks(ids);
    openMenu(anchor, this.blockMenuItems(ids), { label: 'Block actions', filter: true, filterPlaceholder: 'Search actions', onClose: () => {} });
  }

  /* ---------- dragging blocks ---------- */

  startDrag(e) {
    if (this.readOnly || e.button !== 0) return;
    e.preventDefault();
    const id = this.hoverId;
    if (!id || !this.els.has(id)) return;
    const ids = this.selected.has(id) ? this.orderedSelection() : [id];
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let drop = null;
    const grip = this.handle.querySelector('.grip');
    const move = (ev) => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!started) {
        started = true;
        this.dragging = true;
        this.selectBlocks(ids);
        this.root.classList.add('dragging');
      }
      drop = this.dropTarget(ev.clientX, ev.clientY, ids);
      this.autoScroll(ev.clientY);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      this.dragging = false;
      this.root.classList.remove('dragging');
      this.dropLine.classList.remove('visible');
      clearInterval(this.scrollTimer);
      if (!started) {
        this.openBlockMenu(grip, ids);
        return;
      }
      if (drop) {
        P.moveBlocks(this.doc, ids, drop);
        queueMicrotask(() => this.selectBlocks(ids));
        announce('Moved');
      }
    };
    const key = (ev) => {
      if (ev.key === 'Escape') {
        drop = null;
        up();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  }

  dropTarget(x, y, moving) {
    const els = [...this.root.children].filter((el) => !moving.includes(el.dataset.id));
    if (!els.length) return null;
    let target = els.at(-1);
    let before = false;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = el;
        before = true;
        break;
      }
    }
    const id = target.dataset.id;
    const tb = this.block(id);
    const hostRect = this.host.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const textLeft = (target.querySelector('.blk-main') || target).getBoundingClientRect().left;
    // Dragging to the right of a block nests the moved blocks under it.
    let indent = tb.indent;
    if (!before && x > textLeft + 48 && P.MAX_INDENT > tb.indent) indent = tb.indent + 1;
    this.dropLine.style.transform = `translate(${Math.round(textLeft - hostRect.left + (indent - tb.indent) * 24)}px, ${Math.round((before ? r.top : r.bottom) - hostRect.top - 1)}px)`;
    this.dropLine.style.width = `${Math.max(40, r.right - textLeft - (indent - tb.indent) * 24)}px`;
    this.dropLine.classList.add('visible');
    return before ? { before: id, indent } : { after: id, indent };
  }

  autoScroll(y) {
    const scroller = this.host.closest('.page-scroll');
    if (!scroller) return;
    clearInterval(this.scrollTimer);
    const r = scroller.getBoundingClientRect();
    const speed = y < r.top + 60 ? -12 : y > r.bottom - 60 ? 12 : 0;
    if (speed) this.scrollTimer = setInterval(() => (scroller.scrollTop += speed), 16);
  }

  showDropAt(y) {
    this.dropTarget(0, y, []);
  }

  async onDropFiles(e) {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    this.dropLine.classList.remove('visible');
    if (!files.length || this.readOnly) return;
    e.preventDefault();
    const target = this.dropTarget(e.clientX, e.clientY, []);
    let anchor = target?.after || target?.before || this.visibleIds().at(-1);
    for (const file of files) {
      const id = P.insertBlock(this.doc, { type: 'image' }, target?.before && anchor === target.before ? { before: anchor } : { after: anchor });
      anchor = id;
      await this.uploadImage(id, file);
    }
  }

  /* ---------- clipboard ---------- */

  onCopy(e, cut) {
    if (!this.selected.size) return;
    e.preventDefault();
    const ids = this.orderedSelection();
    const all = new Set();
    for (const id of ids) for (const c of P.withChildren(this.doc, id)) all.add(c);
    const blocks = P.listBlocks(this.doc).filter((b) => all.has(b.id));
    const min = Math.min(...blocks.map((b) => b.indent || 0));
    const norm = blocks.map(({ id, order, ...b }) => ({ ...b, indent: (b.indent || 0) - min }));
    const opts = { pageTitle: (pid) => this.ctx.pageTitle(pid) };
    e.clipboardData.setData('text/plain', blocksToMarkdown(norm, opts).trim());
    e.clipboardData.setData('text/html', blocksToHtml(norm, opts));
    e.clipboardData.setData(CLIP_TYPE, JSON.stringify(norm.map((b) => (b.type === 'page' ? { type: 'paragraph', delta: [{ insert: this.ctx.pageTitle(b.page), attributes: { page: b.page } }], indent: b.indent } : b))));
    announce(`${blocks.length} block${blocks.length === 1 ? '' : 's'} copied`);
    if (cut && !this.readOnly) this.deleteBlocks(ids);
  }

  async onPaste(e) {
    if (this.readOnly) return e.preventDefault();
    const data = e.clipboardData;
    if (!data) return;
    const textEl = e.target.closest?.('.blk-text');
    const id = textEl?.closest('.blk').dataset.id || this.orderedSelection().at(-1);
    if (!id) return;
    const images = [...data.files].filter((f) => f.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      let after = id;
      for (const img of images) {
        const nid = P.insertBlock(this.doc, { type: 'image' }, { after });
        after = nid;
        await this.uploadImage(nid, img);
      }
      return;
    }
    const b = this.block(id);
    const plain = data.getData('text/plain');
    if (b?.type === 'code' && textEl) {
      e.preventDefault();
      this.insertText(id, plain);
      return;
    }
    let specs = null;
    const own = data.getData(CLIP_TYPE);
    if (own) {
      try {
        // Clipboard data can come from anywhere: keep known types and clean text.
        specs = JSON.parse(own)
          .filter((s) => s && P.BLOCK_TYPES[s.type])
          .map((s) => ({ type: s.type, indent: Number(s.indent) || 0, delta: cleanDelta(s.delta), ...(s.type === 'todo' ? { checked: !!s.checked } : {}), ...(s.type === 'code' && typeof s.language === 'string' ? { language: s.language.slice(0, 40) } : {}), ...(s.type === 'table' && s.table ? { table: s.table } : {}), ...(s.type === 'image' && safeUrl(s.url) ? { url: safeUrl(s.url), caption: String(s.caption || '').slice(0, 1000) } : {}), ...(s.type === 'bookmark' && safeUrl(s.url) ? { url: safeUrl(s.url), name: String(s.name || '').slice(0, 300) } : {}) }));
      } catch {
        specs = null;
      }
    }
    const html = data.getData('text/html');
    if (!specs && html) specs = htmlToBlocks(html);
    if (!specs && plain) specs = /\n/.test(plain.trim()) || /^(#{1,3}|[-*+]|\d+[.)]|>|```|\[[ x]\])\s/.test(plain) ? markdownToBlocks(plain) : null;
    // A link pasted over selected text links it.
    const url = safeUrl(plain.trim());
    if (textEl && url && /^https?:\/\/\S+$/.test(plain.trim())) {
      const off = getSelectionOffsets(textEl);
      if (off && off.end > off.start) {
        e.preventDefault();
        this.applyFormat(id, off, { link: url });
        return;
      }
    }
    if (!specs || !specs.length) {
      if (!textEl) return;
      e.preventDefault();
      this.insertText(id, plain.replace(/\r\n?/g, '\n'));
      return;
    }
    e.preventDefault();
    // One pasted line of text goes into the current block.
    if (textEl && specs.length === 1 && TEXT_TYPES.has(specs[0].type) && specs[0].type !== 'code' && (specs[0].type === 'paragraph' || deltaText(b.delta).length)) {
      this.insertDelta(id, specs[0].delta || [{ insert: specs[0].text || '' }]);
      return;
    }
    this.syncText(id, textEl);
    // Pasting over selected text replaces it.
    const selected = textEl && getSelectionOffsets(textEl);
    if (selected && selected.end > selected.start) {
      const yt = P.textOf(this.doc, id);
      this.doc.transact(() => yt.delete(selected.start, selected.end - selected.start), LOCAL);
      this.rendered.delete(id);
      this.render();
      setSelectionOffsets(textEl, selected.start);
    }
    const base = b?.indent || 0;
    const empty = b && TEXT_TYPES.has(b.type) && !this.textOf(id).length;
    let anchor = id;
    if (textEl && !empty) {
      const off = getSelectionOffsets(textEl);
      if (off && off.start < this.textOf(id).length) {
        P.splitBlock(this.doc, id, off.start);
      }
    }
    const ids = P.insertBlocks(this.doc, specs.map((s) => ({ ...s, indent: Math.min(P.MAX_INDENT, (s.indent || 0) + base) })), { after: anchor });
    if (empty) P.deleteBlocks(this.doc, [id]);
    const last = ids.at(-1);
    this.render();
    if (this.textEl(last)) this.focusBlock(last, 'end');
    else this.selectBlocks([last]);
    announce(`Pasted ${ids.length} blocks`);
  }

  insertDelta(id, delta) {
    const el = this.textEl(id);
    this.syncText(id, el);
    const off = getSelectionOffsets(el) || { start: 0, end: 0 };
    const yt = P.textOf(this.doc, id);
    const len = delta.reduce((n, op) => n + (op.insert?.length || 0), 0);
    this.doc.transact(() => {
      if (off.end > off.start) yt.delete(off.start, off.end - off.start);
      yt.applyDelta([{ retain: off.start }, ...delta.map((op) => ({ insert: op.insert, attributes: op.attributes || {} }))]);
    }, LOCAL);
    this.rendered.delete(id);
    this.pendingSel = { id, start: off.start + len };
    this.render();
  }
}

export { splitDelta };
