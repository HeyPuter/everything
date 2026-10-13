/**
 * On-canvas text editing session for one text object.
 *
 * The text stays in the document and updates live as you type: every edit
 * is a document transaction, and consecutive typing (or deleting) coalesces
 * into one undo step until the caret moves some other way. Keyboard input,
 * IME composition and mobile keyboards arrive through a hidden textarea kept
 * at the caret, so candidate windows and on-screen keyboards appear in the
 * right place. The caret, the selection highlight and the text frame are
 * drawn on the overlay canvas.
 */
import { h } from '../../lib/dom.js';
import { typedQuote } from '../files/type-setup.js';
import { IS_MAC, eventKey } from '../../commands/registry.js';
import { editLayout, caretPosition, hitTestText, selectionPolygons, lineIndexOf, indexInLine } from '../../model/text-layout.js';
import { replaceRange, overridesAt, wordAt, prevWordIndex, nextWordIndex, paragraphRanges, paragraphIndexAt } from '../../model/text-runs.js';
import { apply, invert, multiply } from '../../lib/matrix.js';
import { layerColor } from '../../render/overlay.js';
import { tracePath } from '../../render/draw.js';
import { clipboard } from '../../ops/clipboard.js';
import { rememberRichCopy, pasteIntoSession } from './rich-clipboard.js';

const CLIP_MARK = 'vector-studio-clip:';

/**
 * Text to insert for pasted clipboard text. Copying artwork here also puts
 * its SVG markup on the system clipboard; pasting that into type inserts the
 * text of the copied type objects (nothing for other artwork), not markup.
 */
export function pastedText(t) {
  if (!t || !t.includes(CLIP_MARK)) return t;
  const data = clipboard.data;
  if (data && t.includes(`${CLIP_MARK}${data.stamp}`)) {
    const out = [];
    for (const item of data.items || []) for (const n of item.nodes || []) if (n.type === 'text' && n.text) out.push(n.text);
    return out.join('\n');
  }
  try {
    const svg = new DOMParser().parseFromString(t.slice(t.search(/<svg[\s>]/i)), 'image/svg+xml');
    return [...svg.querySelectorAll('text')].map((el) => el.textContent).filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

const reduceMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let textarea = null;

function hiddenInput(app) {
  if (textarea && textarea.isConnected) return textarea;
  textarea = h('textarea.vs-type-input', {
    'aria-label': 'Text',
    autocapitalize: 'off',
    autocomplete: 'off',
    spellcheck: false,
    rows: 1,
    tabindex: '-1',
  });
  textarea.setAttribute('autocorrect', 'off');
  app.canvasHost.append(textarea);
  const route = (fn) => (e) => {
    const s = app.typeSession;
    if (s && !s.ended) fn(s, e);
  };
  textarea.addEventListener('beforeinput', route((s, e) => s.onBeforeInput(e)));
  textarea.addEventListener('input', route((s, e) => s.onInput(e)));
  textarea.addEventListener('compositionstart', route((s, e) => s.onCompositionStart(e)));
  textarea.addEventListener('compositionupdate', route((s, e) => s.onCompositionUpdate(e)));
  textarea.addEventListener('compositionend', route((s, e) => s.onCompositionEnd(e)));
  textarea.addEventListener('copy', route((s, e) => s.onCopy(e, false)));
  textarea.addEventListener('cut', route((s, e) => s.onCopy(e, true)));
  textarea.addEventListener('paste', route((s, e) => s.onPaste(e)));
  return textarea;
}

export class TextSession {
  /** (session, keydown event) => true when handled; see handleKey(). */
  static keyHooks = [];

  constructor(app, editor, id, { caret = 0, anchor = caret, created = false } = {}) {
    this.app = app;
    this.editor = editor;
    this.doc = editor.doc;
    this.id = id;
    this.caret = caret;
    this.anchor = anchor;
    this.created = created;
    this.pending = null;
    this.goalU = null;
    this.burst = 0;
    this.lastKind = null;
    this.composing = null;
    this.blinkOn = true;
    this.ended = false;
    this.input = hiddenInput(app);
    this.unsub = this.doc.on('change', () => this.#docChanged());
    editor.textEdit = { id, caret, anchor };
    editor.select([id]);
    this.#startBlink();
    this.focus();
    this.sync();
  }

  node() {
    return this.doc.get(this.id);
  }

  /** The layout carets and selections use (all frames of a threaded story, in this node's space). */
  layout() {
    const n = this.node();
    return n ? editLayout(n) : null;
  }

  range() {
    return [Math.min(this.caret, this.anchor), Math.max(this.caret, this.anchor)];
  }

  selectedText() {
    const n = this.node();
    const [a, b] = this.range();
    return n ? n.text.slice(a, b) : '';
  }

  focus() {
    try {
      this.input.focus({ preventScroll: true });
    } catch {
      // Focus can fail while the element is hidden; the next pointer event retries.
    }
  }

  #startBlink() {
    clearInterval(this.blinkTimer);
    this.blinkOn = true;
    if (reduceMotion()) return;
    this.blinkTimer = setInterval(() => {
      this.blinkOn = !this.blinkOn;
      this.editor.emit('overlay');
    }, 530);
  }

  #docChanged() {
    if (this.ended) return;
    const n = this.node();
    if (!n) {
      this.app.tool?.endEditing?.({ select: false, removed: true });
      return;
    }
    const len = n.text.length;
    if (this.caret > len || this.anchor > len) {
      this.caret = Math.min(this.caret, len);
      this.anchor = Math.min(this.anchor, len);
      this.sync();
    } else this.#placeInput();
  }

  /** Publish the selection to the editor, panels and overlay. */
  sync({ keepPending = false } = {}) {
    if (this.ended) return;
    const n = this.node();
    const len = n ? n.text.length : 0;
    this.caret = Math.max(0, Math.min(len, this.caret));
    this.anchor = Math.max(0, Math.min(len, this.anchor));
    if (!keepPending) this.pending = null;
    this.editor.textEdit = { id: this.id, caret: this.caret, anchor: this.anchor };
    this.#startBlink();
    this.#placeInput();
    this.editor.emit('overlay');
    this.app.dock?.update();
    this.app.emit('text-selection', this);
  }

  /** After an external change (panel edit): redraw and refresh without resetting the pending style. */
  changed() {
    this.sync({ keepPending: true });
  }

  /** Overrides for typed text: the neighbor's style plus any pending style from the panels. */
  insertOverrides(node, at) {
    if (!this.pending) return null;
    const { altGlyph, ...inherited } = overridesAt(node, at > 0 ? at - 1 : at); // eslint-disable-line no-unused-vars
    return { ...inherited, ...this.pending };
  }

  setPending(p) {
    this.pending = p;
    this.app.dock?.update();
  }

  setSelection(anchor, caret, { keepGoal = false } = {}) {
    this.anchor = anchor;
    this.caret = caret;
    if (!keepGoal) this.goalU = null;
    this.burst++;
    this.lastKind = null;
    this.sync();
  }

  #placeInput() {
    const n = this.node();
    const lay = this.layout();
    if (!n || !lay) return;
    const c = caretPosition(lay, this.caret);
    const p = apply(n.transform, c.x, c.y);
    const s = this.editor.view.toScreen(p.x, p.y);
    const ta = this.input;
    ta.style.left = `${Math.round(Math.max(0, Math.min(this.editor.view.width - 2, s.x)))}px`;
    ta.style.top = `${Math.round(Math.max(0, Math.min(this.editor.view.height - 20, s.y - 16)))}px`;
  }

  // ---- editing ----

  /** Replace the selection with text as one (coalescing) undo step. */
  insert(text, kind = 'typing') {
    const n = this.node();
    if (!n) return;
    text = String(text).replace(/\r\n?/g, '\n');
    const [a, b] = this.range();
    // Straight quotes typed become the document's typographer's quotes (Document Setup).
    if (kind === 'typing' && (text === '"' || text === "'")) text = typedQuote(this.doc.root, n.text, a, text);
    if (kind !== this.lastKind) this.burst++;
    this.lastKind = kind;
    const coalesce = kind === 'paste' ? null : `type:${this.id}:${this.burst}`;
    const label = kind === 'paste' ? 'Paste' : kind === 'delete' ? 'Clear' : 'Typing';
    const pending = this.pending;
    const overrides = this.insertOverrides(n, a);
    this.doc.transact(label, () => this.doc.update(n.id, replaceRange(n, a, b, text, overrides)), { coalesce });
    this.caret = this.anchor = a + text.length;
    this.goalU = null;
    this.sync({ keepPending: Boolean(pending) && kind === 'typing' });
    if (kind === 'paste') this.burst++;
  }

  deleteRange(a, b) {
    const n = this.node();
    if (!n || b <= a) return;
    if (this.lastKind !== 'delete') this.burst++;
    this.lastKind = 'delete';
    this.doc.transact('Clear', () => this.doc.update(n.id, replaceRange(n, a, b, '')), { coalesce: `type:${this.id}:${this.burst}` });
    this.caret = this.anchor = a;
    this.goalU = null;
    this.sync();
  }

  deleteBackward(unit = 'char') {
    const [a, b] = this.range();
    if (a !== b) return this.deleteRange(a, b);
    const n = this.node();
    if (!n || a === 0) return;
    let from = a - 1;
    if (unit === 'word') from = prevWordIndex(n.text, a);
    else if (unit === 'line') from = this.#lineStart(a);
    else {
      // Keep surrogate pairs together.
      const code = n.text.charCodeAt(a - 1);
      if (code >= 0xdc00 && code <= 0xdfff && a > 1) from = a - 2;
    }
    this.deleteRange(Math.min(from, a - 1), a);
  }

  deleteForward(unit = 'char') {
    const [a, b] = this.range();
    if (a !== b) return this.deleteRange(a, b);
    const n = this.node();
    if (!n || a >= n.text.length) return;
    let to = a + 1;
    if (unit === 'word') to = nextWordIndex(n.text, a);
    else {
      const code = n.text.charCodeAt(a);
      if (code >= 0xd800 && code <= 0xdbff) to = a + 2;
    }
    this.deleteRange(a, Math.max(to, a + 1));
  }

  // ---- navigation ----

  #lineStart(i) {
    const lay = this.layout();
    const li = lineIndexOf(lay, i);
    return li < 0 ? 0 : lay.lines[li].start;
  }

  #lineEnd(i) {
    const lay = this.layout();
    const li = lineIndexOf(lay, i);
    if (li < 0) return 0;
    const l = lay.lines[li];
    const next = lay.lines[li + 1];
    // A soft-wrapped line ends before its trailing space so the caret stays on it.
    return next && next.start === l.end && l.end > l.start ? Math.max(l.start, l.contentEnd < l.end ? l.end - 1 : l.end) : l.end;
  }

  move(to, extend) {
    const n = this.node();
    const len = n ? n.text.length : 0;
    to = Math.max(0, Math.min(len, to));
    this.caret = to;
    if (!extend) this.anchor = to;
    // Up/Down after a sideways move start from the new caret position.
    this.goalU = null;
    this.burst++;
    this.lastKind = null;
    this.sync();
  }

  moveVertical(dir, extend) {
    const lay = this.layout();
    if (!lay || !lay.lines.length) return;
    const li = lineIndexOf(lay, this.caret);
    const c = caretPosition(lay, this.caret);
    if (this.goalU == null) this.goalU = c.u;
    const goal = this.goalU;
    const target = li + dir;
    let idx;
    if (target < 0) idx = 0;
    else if (target >= lay.lines.length) idx = this.node().text.length;
    else idx = indexInLine(lay, target, goal);
    this.caret = idx;
    if (!extend) this.anchor = idx;
    this.burst++;
    this.sync();
    this.goalU = goal;
  }

  selectAll() {
    const n = this.node();
    this.setSelection(0, n ? n.text.length : 0);
  }

  selectWord(i) {
    const [a, b] = wordAt(this.node().text, i);
    this.setSelection(a, b);
  }

  selectParagraph(i) {
    const text = this.node().text;
    const pr = paragraphRanges(text)[paragraphIndexAt(text, i)];
    this.setSelection(pr.start, Math.min(text.length, pr.end + (text[pr.end] === '\n' ? 1 : 0)));
  }

  /** Caret index under a document point. */
  indexAt(x, y) {
    const n = this.node();
    const lay = this.layout();
    if (!n || !lay) return 0;
    const p = apply(invert(n.transform), x, y);
    return hitTestText(lay, p.x, p.y);
  }

  // ---- clipboard ----

  onCopy(e, cut) {
    const t = this.selectedText();
    e.preventDefault();
    if (!t) return;
    e.clipboardData?.setData('text/plain', t);
    rememberRichCopy(this);
    if (cut) {
      const [a, b] = this.range();
      this.burst++;
      this.doc.transact('Cut', () => this.doc.update(this.id, replaceRange(this.node(), a, b, '')));
      this.caret = this.anchor = a;
      this.sync();
    }
  }

  onPaste(e) {
    e.preventDefault();
    const t = pastedText(e.clipboardData?.getData('text/plain'));
    if (t) pasteIntoSession(this, t);
  }

  async clipboardCopy(cut) {
    const t = this.selectedText();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      rememberRichCopy(this);
    } catch {
      this.app.notify('The browser blocked clipboard access.', { error: true });
      return;
    }
    if (cut) this.deleteRange(...this.range());
  }

  async clipboardPaste({ plain = false } = {}) {
    try {
      const t = pastedText(await navigator.clipboard.readText());
      if (t) pasteIntoSession(this, t, { plain });
    } catch {
      this.app.notify('The browser blocked clipboard access. Use the keyboard shortcut to paste.', { error: true });
    }
  }

  // ---- input events ----

  onBeforeInput(e) {
    if (e.isComposing || this.composing) return;
    switch (e.inputType) {
      case 'insertText':
      case 'insertReplacementText':
        if (e.data != null && e.cancelable) {
          e.preventDefault();
          this.insert(e.data);
        }
        break;
      case 'insertLineBreak':
      case 'insertParagraph':
        if (e.cancelable) {
          e.preventDefault();
          this.insert('\n');
        }
        break;
      case 'deleteContentBackward':
        if (e.cancelable) {
          e.preventDefault();
          this.deleteBackward();
        }
        break;
      case 'deleteContentForward':
        if (e.cancelable) {
          e.preventDefault();
          this.deleteForward();
        }
        break;
      case 'deleteWordBackward':
        if (e.cancelable) {
          e.preventDefault();
          this.deleteBackward('word');
        }
        break;
      case 'deleteWordForward':
        if (e.cancelable) {
          e.preventDefault();
          this.deleteForward('word');
        }
        break;
      case 'historyUndo':
      case 'historyRedo':
        e.preventDefault();
        this.undo(e.inputType === 'historyRedo');
        break;
      default:
        break;
    }
  }

  onInput(e) {
    if (e.isComposing || this.composing) return;
    // Input the browser did not let us cancel: take whatever landed in the textarea.
    const v = this.input.value;
    if (v) {
      this.input.value = '';
      this.insert(v);
    }
  }

  onCompositionStart() {
    const [a, b] = this.range();
    this.burst++;
    const n = this.node();
    if (a !== b && n) {
      // Replacing the selection and the composed text are one undo step.
      this.doc.transact('Typing', () => this.doc.update(n.id, replaceRange(n, a, b, '')), { coalesce: `type:${this.id}:${this.burst}` });
      this.caret = this.anchor = a;
      this.sync({ keepPending: true });
    }
    this.composing = { start: a, len: 0 };
  }

  onCompositionUpdate(e) {
    const c = this.composing;
    const n = this.node();
    if (!c || !n) return;
    const data = e.data || '';
    this.doc.transact('Typing', () => this.doc.update(n.id, replaceRange(n, c.start, c.start + c.len, data, this.insertOverrides(n, c.start))), { coalesce: `type:${this.id}:${this.burst}` });
    c.len = data.length;
    this.caret = this.anchor = c.start + c.len;
    this.sync({ keepPending: true });
  }

  onCompositionEnd(e) {
    const c = this.composing;
    this.composing = null;
    const n = this.node();
    this.input.value = '';
    if (!c || !n) return;
    const data = e.data || '';
    this.doc.transact('Typing', () => this.doc.update(n.id, replaceRange(n, c.start, c.start + c.len, data, this.insertOverrides(n, c.start))), { coalesce: `type:${this.id}:${this.burst}` });
    this.caret = this.anchor = c.start + data.length;
    this.lastKind = 'typing';
    this.sync();
  }

  undo(redo = false) {
    const before = this.node()?.text ?? '';
    if (redo) this.doc.redo();
    else this.doc.undo();
    this.burst++;
    this.lastKind = null;
    const n = this.node();
    if (!n || this.ended) return;
    const after = n.text;
    if (after === before) {
      // A style change: keep the characters selected (sync clamps the range).
      this.sync();
      if (!this.editor.selection.has(this.id)) this.editor.select([this.id]);
      return;
    }
    // Put the caret where the text changed.
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    let q = 0;
    while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
    this.anchor = p;
    this.caret = after.length - q;
    if (this.caret < this.anchor) this.caret = this.anchor;
    this.sync();
    this.editor.textEdit = { id: this.id, caret: this.caret, anchor: this.anchor };
    if (!this.editor.selection.has(this.id)) this.editor.select([this.id]);
  }

  // ---- keyboard ----

  /** Handle a keydown while editing; returns true when consumed. */
  handleKey(e, actions) {
    if (e.isComposing || e.keyCode === 229 || this.composing) return false;
    const t = e.target;
    const ours = t === this.input;
    if (!ours && t && t.tagName && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes(t.type)))) return false;
    if (!ours && t && t.closest && t.closest('.panel-body, .panel-flyout, .popover, .menu, dialog, .dock')) return false;
    // Feature shortcuts that only apply while typing (they take precedence over global commands).
    for (const hook of TextSession.keyHooks) if (hook(this, e)) return true;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const k = eventKey(e);
    const key = e.key;
    const shift = e.shiftKey;
    const alt = e.altKey;
    if (mod && shift && !alt && ['l', 'c', 'r', 'j', 'f'].includes(k)) {
      actions.align({ l: 'left', c: 'center', r: 'right', j: 'justify', f: 'justify-all' }[k]);
      return true;
    }
    if (mod && shift && (k === '.' || k === ',')) {
      actions.size(k === '.' ? 1 : -1, alt ? 5 : 1);
      return true;
    }
    if (mod && alt && !shift && k === 'q') {
      actions.clearTracking();
      return true;
    }
    if (mod && shift && !alt && k === 'x') {
      actions.clearScale();
      return true;
    }
    if (mod && shift && !alt && ['u', 'b', 'i'].includes(k)) {
      actions.toggle({ u: 'underline', b: 'bold', i: 'italic' }[k]);
      return true;
    }
    if (mod && shift && k === '=') {
      actions.toggle(alt ? 'sub' : 'super');
      return true;
    }
    if (mod && !shift && !alt && k === 'a') {
      this.selectAll();
      return true;
    }
    if (mod && !alt && k === 'z') {
      this.undo(shift);
      return true;
    }
    if (mod && !alt && !shift && ['c', 'x', 'v'].includes(k)) {
      if (ours) return false; // native copy/cut/paste events on the textarea
      if (k === 'v') this.clipboardPaste();
      else this.clipboardCopy(k === 'x');
      return true;
    }
    if (alt && !shift && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      actions.kern(key === 'ArrowRight' ? 1 : -1, mod ? 5 : 1);
      return true;
    }
    if (alt && (key === 'ArrowUp' || key === 'ArrowDown')) {
      if (shift) actions.baseline(key === 'ArrowUp' ? 1 : -1, mod ? 5 : 1);
      else actions.leading(key === 'ArrowUp' ? -1 : 1, mod ? 5 : 1);
      return true;
    }
    const n = this.node();
    if (!n) return false;
    const [a, b] = this.range();
    // Vertical type: Up/Down move along a column, Left/Right between columns (which run right to left).
    const nav = n.vertical ? { ArrowDown: 'ArrowRight', ArrowUp: 'ArrowLeft', ArrowLeft: 'ArrowDown', ArrowRight: 'ArrowUp' }[key] || key : key;
    switch (nav) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        const right = nav === 'ArrowRight';
        if (!shift && a !== b && !mod) this.move(right ? b : a, false);
        else if (mod) this.move(right ? nextWordIndex(n.text, this.caret) : prevWordIndex(n.text, this.caret), shift);
        else this.move(this.caret + (right ? 1 : -1), shift);
        return true;
      }
      case 'ArrowUp':
      case 'ArrowDown': {
        const down = nav === 'ArrowDown';
        if (mod) {
          const ranges = paragraphRanges(n.text);
          const pi = paragraphIndexAt(n.text, this.caret);
          const pr = ranges[pi];
          let to;
          if (down) to = this.caret < pr.end ? pr.end : ranges[pi + 1]?.end ?? n.text.length;
          else to = this.caret > pr.start ? pr.start : ranges[pi - 1]?.start ?? 0;
          this.move(to, shift);
        } else if (!this.layout().lines.length) this.move(down ? n.text.length : 0, shift);
        else this.moveVertical(down ? 1 : -1, shift);
        return true;
      }
      case 'Home':
        this.move(mod ? 0 : this.#lineStart(this.caret), shift);
        return true;
      case 'End':
        this.move(mod ? n.text.length : this.#lineEnd(this.caret), shift);
        return true;
      case 'PageUp':
        this.move(0, shift);
        return true;
      case 'PageDown':
        this.move(n.text.length, shift);
        return true;
      case 'Backspace':
        this.deleteBackward(alt ? 'word' : mod ? 'line' : 'char');
        return true;
      case 'Delete':
        this.deleteForward(alt || mod ? 'word' : 'char');
        return true;
      case 'Enter':
        if (e.code === 'NumpadEnter') {
          actions.exit();
          return true;
        }
        this.insert('\n');
        return true;
      case 'Tab':
        this.insert('\t');
        return true;
      case 'Escape':
        actions.exit();
        return true;
      default:
        break;
    }
    if (mod) {
      // Other shortcuts (save, panels, outlines...) still work while typing.
      const cmd = this.app.commands.match(e);
      if (cmd) {
        this.app.commands.run(cmd);
        return true;
      }
      return false;
    }
    if (!ours && key.length === 1 && !e.ctrlKey && !e.metaKey) {
      this.insert(key);
      this.focus();
      return true;
    }
    return false;
  }

  // ---- drawing ----

  drawOverlay(ctx, editor) {
    const n = this.node();
    const lay = this.layout();
    if (!n || !lay || this.ended) return;
    const view = editor.view;
    const m = multiply(view.matrix, n.transform);
    const dpr = view.dpr;
    const s = Math.hypot(m[0], m[1]) || 1;
    const color = layerColor(editor, n.id);
    ctx.save();
    ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = color;
    // Frame: the area or path the text lives in.
    if (lay.composite) {
      // A threaded story: every frame, each in its own placement.
      const inv = invert(n.transform);
      for (const f of lay.frames) {
        const fm = multiply(inv, f.transform);
        ctx.save();
        ctx.transform(fm[0], fm[1], fm[2], fm[3], fm[4], fm[5]);
        ctx.beginPath();
        if (f.areaPath?.length > 2 && !f.vertical) tracePath(ctx, f.areaPath, true);
        else ctx.rect(f.x, f.y, f.width, f.height);
        ctx.restore();
        ctx.stroke();
      }
    } else if (lay.kind === 'area' || lay.kind === 'path') {
      ctx.beginPath();
      if (lay.kind === 'path') tracePath(ctx, n.pathAnchors, Boolean(n.pathClosed));
      else if (n.areaPath?.length > 2 && !n.vertical) tracePath(ctx, n.areaPath, true);
      else ctx.rect(n.x, n.y, n.width, n.height);
      ctx.stroke();
    }
    const [a, b] = this.range();
    if (a !== b) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.32;
      for (const poly of selectionPolygons(lay, a, b)) {
        ctx.beginPath();
        poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (this.blinkOn) {
      const c = caretPosition(lay, this.caret);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5 / s;
      ctx.beginPath();
      ctx.moveTo(c.top.x, c.top.y);
      ctx.lineTo(c.bottom.x, c.bottom.y);
      ctx.stroke();
      // A white halo keeps the caret visible on dark artwork.
      ctx.globalCompositeOperation = 'destination-over';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3.5 / s;
      ctx.stroke();
    }
    ctx.restore();
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.blinkTimer);
    this.unsub?.();
    this.input.value = '';
    if (document.activeElement === this.input) this.app.canvasHost?.focus({ preventScroll: true });
    if (this.editor.textEdit?.id === this.id) this.editor.textEdit = null;
    this.editor.emit('overlay');
    this.app.dock?.update();
  }
}
