import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { hyperlinkRanges, internalHyperlink } from '../engine/hyperlinks.js';
import { captureFormat, applyFormat } from '../engine/home-editing.js';

/**
 * The Edit menu's own commands: Repeat, Copy and Paste Formatting, Clear (formatting or contents), Find
 * Next and Previous, and the Links dialog. Every document change goes through the engine's
 * transactions, so it is one undo step and respects read-only and view-only documents.
 */
export function createEditCommands({ editor, pkg, editLink, searchQuery = () => '', onChange = () => {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly && !engine.viewOnly ? engine : null; };
  let repeatable = null; // { label, run }
  let copiedFormat = null;
  let lastQuery = '';

  /** Remember a command the user ran so Repeat (F4, or Cmd/Ctrl+Y with nothing to redo) can run it again. */
  function record(label, run) {
    if (!label || typeof run !== 'function') return;
    repeatable = { label, run };
  }

  const commands = {
    recordRepeat: record,
    repeatLabel: () => repeatable?.label || null,
    canRepeat: () => !!repeatable && !!ready(),
    repeat() {
      const engine = ready(); if (!engine || !repeatable) return false;
      engine.finishComposition();
      repeatable.run();
      return true;
    },
    /** Cmd/Ctrl+Y: redo what was undone, else repeat the last command. */
    redoOrRepeat() {
      const engine = ready(); if (!engine) return false;
      if (engine.session.future.length) { engine.redo(); return true; }
      return commands.repeat();
    },

    copyFormat() {
      const engine = ready() || editor(); if (!engine) return;
      engine.finishComposition();
      copiedFormat = captureFormat(engine.model);
      toast('Formatting copied. Select text and choose Paste Formatting.', { icon: 'formatPainter', duration: 2500 });
      onChange();
    },
    hasCopiedFormat: () => !!copiedFormat,
    pasteFormat() {
      const engine = ready(); if (!engine || !copiedFormat) return false;
      engine.finishComposition();
      const captured = copiedFormat;
      engine.execute(() => applyFormat(engine.model, captured));
      record('Paste Formatting', () => commands.pasteFormat());
      engine.focus();
      return true;
    },
    /** Paste with Cmd/Ctrl+Shift+V pastes formatting only right after Copy Formatting. */
    takeFormatPaste() { return !!copiedFormat; },
    forgetCopiedFormat() { copiedFormat = null; },

    /** Clear → Formatting: direct text and paragraph formatting go; styles, links and content stay. */
    clearFormatting() {
      const engine = ready(); if (!engine) return;
      engine.finishComposition();
      engine.execute(() => { const a = engine.model.clearDirectTextFormatting(); const b = engine.model.clearDirectParagraphFormatting(); return a !== false || b !== false; });
      record('Clear Formatting', () => commands.clearFormatting());
      engine.focus();
    },
    /** Clear → Contents: delete the selection without touching the clipboard. */
    clearContents() {
      const engine = ready(); if (!engine) return;
      const [start, end] = engine.model.range;
      if (start === end && !engine.model.selectedImage) return;
      engine.finishComposition();
      engine.execute(() => engine.model.replace(''));
      engine.focus();
    },
    canClearContents: () => { const engine = ready(); return !!engine && (engine.model.range[0] !== engine.model.range[1] || !!engine.model.selectedImage); },

    /** Find Next / Previous: the next match of the last search after (or before) the selection. */
    findNext(direction = 1) {
      const engine = editor(); if (!engine) return false;
      const [start, end] = engine.model.range;
      const query = searchQuery() || lastQuery || (end > start && end - start <= 255 ? engine.model.text.slice(start, end) : '');
      if (!query || /[\n\f\v]/.test(query)) { toast('Search for something first (Find).', { icon: 'search', duration: 2500 }); return false; }
      lastQuery = query;
      let matches = [];
      try { matches = engine.model.findMatches(query, {}); } catch { matches = []; }
      if (!matches.length) { toast(`“${query}” was not found.`, { icon: 'search', duration: 2500 }); return false; }
      const next = direction > 0 ? matches.find(m => m.start >= end && !(m.start === start && m.end === end)) || matches[0]
        : [...matches].reverse().find(m => m.end <= start && !(m.start === start && m.end === end)) || matches.at(-1);
      engine.selectMatch(next); engine.focus();
      return true;
    },
    setSearchQuery(text) { lastQuery = String(text || ''); },

    /** Edit → Links: every hyperlink in the body, with its address; select, edit or remove each. */
    editLinks() {
      const engine = editor(); if (!engine) return;
      engine.finishComposition();
      if (engine.session.path !== null) engine.editStory(null);
      const list = el('div.ed-links-list', { role: 'list' });
      const status = el('p.field-hint', { role: 'status' });
      const editable = () => !!ready();
      const render = () => {
        const current = editor(); if (!current) return;
        const links = hyperlinkRanges(current.model.paragraphs);
        status.textContent = !links.length ? 'This document has no links.' : `${links.length} ${links.length === 1 ? 'link' : 'links'}`;
        list.replaceChildren(...links.map(range => {
          const text = current.model.text.slice(range.start, range.end).replace(/￼/g, '').trim() || '(picture)';
          const address = internalHyperlink(range.link) ? `Bookmark: ${range.link.anchor || 'Start of document'}` : range.link.target || '';
          const select = () => { current.model.select(range.start, range.end); current.syncInput(); current.paint(); current.revealCaret?.(); current.onSelection(); };
          return el('div.ed-link-row', { role: 'listitem' },
            el('button.ed-link-main', { type: 'button', title: 'Select this link in the document', onclick: () => { modal.close(); select(); current.focus(); } },
              el('span.ed-link-text', {}, text), el('span.ed-link-address', {}, address)),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', disabled: !editable() || range.drawing, onclick: () => { modal.close(); select(); editLink(); } }, 'Edit…'),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', disabled: !editable(), onclick: () => { select(); current.execute(() => current.model.removeHyperlink()); onChange(); render(); } }, 'Remove'));
        }));
      };
      const removeAll = el('button.btn.btn-ghost', { type: 'button', onclick: () => {
        const current = ready(); if (!current) return;
        const links = hyperlinkRanges(current.model.paragraphs);
        if (!links.length) return;
        const [a, b] = current.model.range;
        current.execute(() => { let changed = false; for (const range of [...links].reverse()) { current.model.select(range.start, range.end); changed = current.model.removeHyperlink() !== false || changed; } current.model.select(Math.min(a, current.model.text.length), Math.min(b, current.model.text.length)); return changed; });
        onChange(); render();
      } }, 'Remove All Links');
      const modal = openModal({ title: 'Links', wide: true, onClose: () => queueMicrotask(() => editor()?.focus()),
        content: el('div.ed-dialog-body', {}, status, list,
          el('div.row.row-end', {}, removeAll, el('button.btn.btn-primary', { type: 'button', onclick: () => modal.close() }, 'Close'))) });
      render();
      removeAll.disabled = !editable();
      return modal;
    },
  };
  return commands;
}
