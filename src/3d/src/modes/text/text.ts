// Text Edit Mode: type directly into a text object in the 3D viewport. Caret movement, selection,
// deletion, clipboard, case, styles (bold / italic / underline / small caps), kerning, special
// characters, Unicode input, paste from file and text boxes are operators (menus, keys, F3).
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { keyInputHooks } from '../../app/keymap';
import { modeMenus } from '../../editors/view3d/modemenus';
import { activeTools } from '../../app/prefs';
import { toolsByMode, COMMON_TOOLS } from '../../editors/view3d/toolbar';
import { registerIcons } from '../../ui/icons';
import { h } from '../../ui/h';
import type { CharFormat, CurveData, ObjectData } from '../../data/types';
import { layoutText, fontLoadListeners } from '../../io/fonts';
import { pickFile } from '../../io/native';
import { promptText, type MenuItem } from '../../ui/menu';
import type { View3D } from '../../editors/view3d/view3d';
import * as T from './textops';

export function activeText(): { ob: ObjectData; cu: CurveData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'FONT' || !ob.data) return null;
  const cu = app.doc.curves[ob.data];
  return cu ? { ob, cu } : null;
}
export const inTextEdit = () => app.doc.mode === 'EDIT' && !!activeText();

/** caret index and selection anchor per text datablock (session state) */
const carets = new Map<string, number>();
let selAnchor: number | null = null;
/** style applied to newly typed characters */
export const editFormat: CharFormat = {};

function caret(cu: CurveData) {
  const len = (cu.body ?? '').length;
  return Math.max(0, Math.min(len, carets.get(cu.id) ?? len));
}

export function textState() {
  const t = activeText();
  if (!t) return null;
  return { ...t, caret: caret(t.cu), anchor: selAnchor };
}

function selection(cu: CurveData): [number, number] | null {
  if (selAnchor === null) return null;
  const c = caret(cu);
  if (selAnchor === c) return null;
  return [Math.min(selAnchor, c), Math.max(selAnchor, c)];
}

function setCaret(cu: CurveData, to: number, extend = false) {
  const c = caret(cu);
  if (extend) selAnchor ??= c;
  else selAnchor = null;
  carets.set(cu.id, Math.max(0, Math.min((cu.body ?? '').length, to)));
}

/** Replace the selection (or insert at the caret) with text in the current edit style. */
function insert(cu: CurveData, text: string) {
  const sel = selection(cu);
  const [a, b] = sel ?? [caret(cu), caret(cu)];
  // new characters take the style of the edit format (or of the character before)
  const before = cu.body_format?.[a - 1];
  const fmt: CharFormat = { ...(before ?? {}), ...editFormat, kerning: 0 };
  T.replaceRange(cu, a, b, text, fmt);
  selAnchor = null;
  carets.set(cu.id, a + text.length);
}

const lay = (cu: CurveData) => layoutText(cu);

/** Caret target for a movement type. */
function moveTarget(cu: CurveData, type: string): number {
  const body = cu.body ?? '';
  const c = caret(cu);
  const l = lay(cu);
  switch (type) {
    case 'LINE_BEGIN':
      return T.visualLine(l, c).start;
    case 'LINE_END':
      return T.visualLine(l, c).end;
    case 'TEXT_BEGIN':
      return 0;
    case 'TEXT_END':
      return body.length;
    case 'PREVIOUS_CHARACTER':
      return T.prevChar(body, c);
    case 'NEXT_CHARACTER':
      return T.nextChar(body, c);
    case 'PREVIOUS_WORD':
      return T.prevWord(body, c);
    case 'NEXT_WORD':
      return T.nextWord(body, c);
    case 'PREVIOUS_LINE':
      return T.verticalMove(l, c, -1);
    case 'NEXT_LINE':
      return T.verticalMove(l, c, 1);
    case 'PREVIOUS_PAGE':
      return T.verticalMove(l, c, -10);
    case 'NEXT_PAGE':
      return T.verticalMove(l, c, 10);
  }
  return c;
}

const MOVE_TYPES: [string, string][] = [
  ['LINE_BEGIN', 'Line Begin'],
  ['LINE_END', 'Line End'],
  ['TEXT_BEGIN', 'Text Begin'],
  ['TEXT_END', 'Text End'],
  ['PREVIOUS_CHARACTER', 'Previous Character'],
  ['NEXT_CHARACTER', 'Next Character'],
  ['PREVIOUS_WORD', 'Previous Word'],
  ['NEXT_WORD', 'Next Word'],
  ['PREVIOUS_LINE', 'Previous Line'],
  ['NEXT_LINE', 'Next Line'],
  ['PREVIOUS_PAGE', 'Previous Page'],
  ['NEXT_PAGE', 'Next Page'],
];

const STYLES: [string, string][] = [
  ['BOLD', 'Bold'],
  ['ITALIC', 'Italic'],
  ['UNDERLINE', 'Underline'],
  ['SMALL_CAPS', 'Small Caps'],
];

/** Range a style / case / kerning command applies to: the selection, else the character before the caret. */
function targetRange(cu: CurveData): [number, number] | null {
  const sel = selection(cu);
  if (sel) return sel;
  const c = caret(cu);
  return c > 0 ? [T.prevChar(cu.body ?? '', c), c] : null;
}

let clipboard = '';
let clipboardFormat: CharFormat[] = [];

function copySelection(cu: CurveData) {
  const sel = selection(cu);
  if (!sel) return false;
  clipboard = (cu.body ?? '').slice(sel[0], sel[1]);
  clipboardFormat = T.formats(cu).slice(sel[0], sel[1]).map((f) => ({ ...f }));
  void navigator.clipboard?.writeText(clipboard).catch(() => {});
  return true;
}

function pasteText(cu: CurveData, text: string) {
  const t = text.replace(/\r\n?/g, '\n');
  const sel = selection(cu);
  const at = sel ? sel[0] : caret(cu);
  insert(cu, t);
  // keep styles when pasting what was copied here
  if (t === clipboard && clipboardFormat.length === t.length) {
    const f = T.formats(cu);
    for (let i = 0; i < t.length; i++) f[at + i] = { ...clipboardFormat[i] };
  }
}

const poll = () => inTextEdit();
const geo = () => app.changed('doc', 'geometry');

registerOperators([
  {
    idname: 'font.move',
    label: 'Move Cursor',
    description: 'Move the text cursor',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: MOVE_TYPES }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      setCaret(cu, moveTarget(cu, p.type as string));
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'font.move_select',
    label: 'Move Select',
    description: 'Move the text cursor, extending the selection',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: MOVE_TYPES }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      setCaret(cu, moveTarget(cu, p.type as string), true);
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'font.select_all',
    label: 'Select All',
    description: 'Select all text',
    poll,
    exec: () => {
      const { cu } = activeText()!;
      selAnchor = 0;
      carets.set(cu.id, (cu.body ?? '').length);
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'font.select_word',
    label: 'Select Word',
    description: 'Select the word under the cursor',
    poll,
    exec: () => {
      const { cu } = activeText()!;
      const [a, b] = T.wordAt(cu.body ?? '', caret(cu));
      selAnchor = a;
      carets.set(cu.id, b);
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'font.text_insert',
    label: 'Insert Text',
    description: 'Insert text at the cursor (replacing the selection)',
    props: [
      { id: 'text', label: 'Text', type: 'string', default: '' },
      { id: 'accent', label: 'Accent Mode', type: 'bool', default: false },
    ],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      if (p.accent) {
        // combine the previous character with the typed accent (e.g. e + ' → é)
        const c = caret(cu);
        const body = cu.body ?? '';
        const prev = body[c - 1];
        const next = prev && p.text ? T.accentCombine(prev, p.text as string) : null;
        if (!next) return 'CANCELLED';
        T.replaceRange(cu, c - 1, c, next, T.formats(cu)[c - 1]);
        carets.set(cu.id, c);
        geo();
        return;
      }
      if (!p.text) return 'CANCELLED';
      insert(cu, p.text as string);
      geo();
    },
  },
  {
    idname: 'font.line_break',
    label: 'Line Break',
    description: 'Insert a line break at the cursor',
    poll,
    exec: () => {
      insert(activeText()!.cu, '\n');
      geo();
    },
  },
  {
    idname: 'font.delete',
    label: 'Delete',
    description: 'Delete text by cursor position',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'PREVIOUS_OR_SELECTION',
        items: [
          ['NEXT_OR_SELECTION', 'Next or Selection'],
          ['PREVIOUS_OR_SELECTION', 'Previous or Selection'],
          ['SELECTION', 'Selection'],
          ['NEXT_CHARACTER', 'Next Character'],
          ['PREVIOUS_CHARACTER', 'Previous Character'],
          ['NEXT_WORD', 'Next Word'],
          ['PREVIOUS_WORD', 'Previous Word'],
        ],
      },
    ],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const body = cu.body ?? '';
      const type = p.type as string;
      const sel = selection(cu);
      if (sel && (type.endsWith('_OR_SELECTION') || type === 'SELECTION')) {
        insert(cu, '');
        geo();
        return;
      }
      if (type === 'SELECTION') return 'CANCELLED';
      const c = caret(cu);
      let a = c,
        b = c;
      if (type.startsWith('PREVIOUS')) a = type === 'PREVIOUS_WORD' ? T.prevWord(body, c) : T.prevChar(body, c);
      else b = type === 'NEXT_WORD' ? T.nextWord(body, c) : T.nextChar(body, c);
      if (a === b) return 'CANCELLED';
      selAnchor = null;
      T.replaceRange(cu, a, b, '');
      carets.set(cu.id, a);
      geo();
    },
  },
  {
    idname: 'font.text_copy',
    label: 'Copy Text',
    description: 'Copy the selected text to the clipboard',
    poll,
    exec: () => (copySelection(activeText()!.cu) ? 'FINISHED' : 'CANCELLED'),
    undo: false,
  },
  {
    idname: 'font.text_cut',
    label: 'Cut Text',
    description: 'Cut the selected text to the clipboard',
    poll,
    exec: () => {
      const { cu } = activeText()!;
      if (!copySelection(cu)) return 'CANCELLED';
      insert(cu, '');
      geo();
    },
  },
  {
    idname: 'font.text_paste',
    label: 'Paste Text',
    description: 'Paste text from the clipboard',
    props: [{ id: 'text', label: 'Text', type: 'string', default: '', hidden: true }],
    poll,
    invoke: () => {
      const run = (t: string) => t && app.run('font.text_paste', { text: t }, { invoke: false });
      if (navigator.clipboard?.readText)
        void navigator.clipboard
          .readText()
          .then((t) => run(t || clipboard))
          .catch(() => run(clipboard));
      else run(clipboard);
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      if (!p.text) return 'CANCELLED';
      pasteText(activeText()!.cu, p.text as string);
      geo();
    },
  },
  {
    idname: 'font.text_paste_from_file',
    label: 'Paste File',
    description: 'Insert the contents of a plain text file at the cursor',
    props: [{ id: 'text', label: 'Text', type: 'string', default: '', hidden: true }],
    poll,
    invoke: () => {
      void pickFile('.txt,.md,.csv,.json,.text,text/*').then(async (f) => {
        if (!f) return;
        if (f.size > 2_000_000) {
          app.report('ERROR', 'File too large to paste');
          return;
        }
        app.run('font.text_paste_from_file', { text: await f.text() }, { invoke: false });
      });
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      if (!p.text) return 'CANCELLED';
      insert(activeText()!.cu, (p.text as string).replace(/\r\n?/g, '\n'));
      geo();
    },
  },
  {
    idname: 'font.text_insert_unicode',
    label: 'Insert Unicode',
    description: 'Insert a character by its Unicode code point (hexadecimal, e.g. 00E9 or U+1F600)',
    props: [{ id: 'code', label: 'Code', type: 'string', default: '' }],
    poll,
    invoke: () => {
      promptText('Insert Unicode (hex code point)', '', (v) => v && app.run('font.text_insert_unicode', { code: v }, { invoke: false }));
      return 'CANCELLED';
    },
    exec: (_c, p) => {
      const ch = T.unicodeChar(p.code as string);
      if (!ch) {
        app.report('ERROR', `Not a valid code point: ${p.code}`);
        return 'CANCELLED';
      }
      insert(activeText()!.cu, ch);
      geo();
    },
  },
  {
    idname: 'font.case_set',
    label: 'Set Case',
    description: 'Set the case of the selection (or of the word at the cursor)',
    props: [{ id: 'case', label: 'Case', type: 'enum', default: 'LOWER', items: [['LOWER', 'Lower'], ['UPPER', 'Upper']] }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const r = selection(cu) ?? T.wordAt(cu.body ?? '', caret(cu));
      if (r[0] === r[1]) return 'CANCELLED';
      T.setCase(cu, r[0], r[1], p.case === 'UPPER' ? 'UPPER' : 'LOWER');
      geo();
    },
  },
  {
    idname: 'font.case_toggle',
    label: 'Toggle Case',
    description: 'Toggle the case of the selection (or of the word at the cursor)',
    poll,
    exec: () => {
      const { cu } = activeText()!;
      const r = selection(cu) ?? T.wordAt(cu.body ?? '', caret(cu));
      if (r[0] === r[1]) return 'CANCELLED';
      const s = (cu.body ?? '').slice(r[0], r[1]);
      T.setCase(cu, r[0], r[1], s === s.toUpperCase() ? 'LOWER' : 'UPPER');
      geo();
    },
  },
  {
    idname: 'font.style_toggle',
    label: 'Toggle Style',
    description: 'Toggle a font style of the selection (and of new text)',
    props: [{ id: 'style', label: 'Style', type: 'enum', default: 'BOLD', items: STYLES }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const key = T.styleKey(p.style as string);
      const sel = selection(cu);
      if (sel) {
        const on = !T.formats(cu).slice(sel[0], sel[1]).every((f) => !!f[key]);
        T.setStyle(cu, sel[0], sel[1], key, on);
        editFormat[key] = on;
      } else editFormat[key] = !editFormat[key];
      geo();
    },
  },
  {
    idname: 'font.style_set',
    label: 'Set Style',
    description: 'Set or clear a font style of the selection',
    props: [
      { id: 'style', label: 'Style', type: 'enum', default: 'BOLD', items: STYLES },
      { id: 'clear', label: 'Clear', type: 'bool', default: false },
    ],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const key = T.styleKey(p.style as string);
      const sel = selection(cu);
      if (sel) T.setStyle(cu, sel[0], sel[1], key, !p.clear);
      editFormat[key] = !p.clear;
      geo();
    },
  },
  {
    idname: 'font.change_spacing',
    label: 'Change Spacing',
    description: 'Change the kerning of the selection (or of the character before the cursor)',
    props: [{ id: 'delta', label: 'Delta', type: 'float', default: 1, min: -20, max: 20 }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const r = targetRange(cu);
      if (!r) return 'CANCELLED';
      const f = T.formats(cu);
      for (let i = r[0]; i < r[1]; i++) f[i].kerning = Math.max(-20, Math.min(20, (f[i].kerning ?? 0) + (p.delta as number)));
      geo();
    },
  },
  {
    idname: 'font.change_character',
    label: 'Change Character',
    description: 'Change the character before the cursor to the next / previous code point',
    props: [{ id: 'delta', label: 'Delta', type: 'int', default: 1, min: -255, max: 255 }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      const c = caret(cu);
      const body = cu.body ?? '';
      if (c === 0 || body[c - 1] === '\n') return 'CANCELLED';
      const code = body.charCodeAt(c - 1) + (p.delta as number);
      if (code < 32 || code > 0xd7ff) return 'CANCELLED';
      T.replaceRange(cu, c - 1, c, String.fromCharCode(code), T.formats(cu)[c - 1]);
      carets.set(cu.id, c);
      geo();
    },
  },
  {
    idname: 'font.selection_set',
    label: 'Set Selection',
    description: 'Place the cursor by clicking, drag to select',
    props: [{ id: 'index', label: 'Index', type: 'int', default: -1, hidden: true }],
    poll,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      if ((p.index as number) < 0) return 'CANCELLED';
      setCaret(cu, p.index as number);
      app.changed('ui');
    },
    undo: false,
  },
  {
    idname: 'font.textbox_add',
    label: 'Add Text Box',
    description: 'Add a text box after the active one (text flows into it when a box is full)',
    poll: () => !!activeText(),
    exec: () => {
      const { cu } = activeText()!;
      T.addTextBox(cu);
      geo();
    },
  },
  {
    idname: 'font.textbox_remove',
    label: 'Remove Text Box',
    description: 'Remove a text box',
    props: [{ id: 'index', label: 'Index', type: 'int', default: 0, min: 0 }],
    poll: () => (activeText()?.cu.text_boxes?.length ?? 0) > 1,
    exec: (_c, p) => {
      const { cu } = activeText()!;
      if (!T.removeTextBox(cu, p.index as number)) return 'CANCELLED';
      geo();
    },
  },
]);

// ---------------------------------------------------------------------------
// keyboard: printable characters go straight into the text, the rest maps to operators

const KEYS: Record<string, [string, Record<string, unknown>]> = {
  Home: ['font.move', { type: 'LINE_BEGIN' }],
  End: ['font.move', { type: 'LINE_END' }],
  ArrowLeft: ['font.move', { type: 'PREVIOUS_CHARACTER' }],
  ArrowRight: ['font.move', { type: 'NEXT_CHARACTER' }],
  ArrowUp: ['font.move', { type: 'PREVIOUS_LINE' }],
  ArrowDown: ['font.move', { type: 'NEXT_LINE' }],
  PageUp: ['font.move', { type: 'PREVIOUS_PAGE' }],
  PageDown: ['font.move', { type: 'NEXT_PAGE' }],
};
const WORD: Record<string, string> = { ArrowLeft: 'PREVIOUS_WORD', ArrowRight: 'NEXT_WORD', Home: 'TEXT_BEGIN', End: 'TEXT_END' };

keyInputHooks.push((e) => {
  if (!inTextEdit()) return false;
  // keep Tab (leave edit mode) and F-keys for the keymaps
  if (e.key === 'Tab' || /^F\d+$/.test(e.key)) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const run = (op: string, props: Record<string, unknown> = {}) => (app.run(op, props), true);
  if (e.altKey && !ctrl) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return run('font.change_spacing', { delta: (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 0.1 : 1) });
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return run('font.change_character', { delta: e.key === 'ArrowUp' ? 1 : -1 });
    if (e.key === 'Backspace') {
      pendingAccent = true;
      return true;
    }
  }
  const nav = KEYS[e.key];
  if (nav) {
    const type = ctrl && WORD[e.key] ? WORD[e.key] : (nav[1].type as string);
    return run(e.shiftKey ? 'font.move_select' : 'font.move', { type });
  }
  switch (e.key) {
    case 'Backspace':
      return run('font.delete', { type: ctrl ? 'PREVIOUS_WORD' : 'PREVIOUS_OR_SELECTION' });
    case 'Delete':
      return run('font.delete', { type: ctrl ? 'NEXT_WORD' : 'NEXT_OR_SELECTION' });
    case 'Enter':
      return run('font.line_break');
    case 'Escape':
      selAnchor = null;
      app.changed('ui');
      return false;
  }
  if (ctrl) {
    const k = e.key.toLowerCase();
    if (e.shiftKey) return false;
    const map: Record<string, [string, Record<string, unknown>?]> = {
      a: ['font.select_all'],
      c: ['font.text_copy'],
      x: ['font.text_cut'],
      v: ['font.text_paste'],
      b: ['font.style_toggle', { style: 'BOLD' }],
      i: ['font.style_toggle', { style: 'ITALIC' }],
      u: ['font.style_toggle', { style: 'UNDERLINE' }],
      p: ['font.style_toggle', { style: 'SMALL_CAPS' }],
    };
    const m = map[k];
    if (m) {
      app.run(m[0], m[1] ?? {}, { invoke: m[0] !== 'font.text_paste' ? false : true });
      return true;
    }
    return false; // Ctrl+Z etc. go to the keymaps
  }
  if (e.key.length === 1 && !e.altKey) {
    if (pendingAccent) {
      pendingAccent = false;
      if (app.run('font.text_insert', { text: e.key, accent: true }) === 'FINISHED') return true;
    }
    return run('font.text_insert', { text: e.key });
  }
  return false;
});
let pendingAccent = false;

// ---------------------------------------------------------------------------
// clicking places the cursor (drag selects, double-click selects a word)

/** Character index nearest to a viewport position. */
export function indexAt(v: View3D, x: number, y: number): number {
  const t = activeText();
  if (!t) return 0;
  const w = app.graph.get(t.ob.id)?.world ?? new Matrix4();
  const l = lay(t.cu);
  let best = 0,
    bd = Infinity;
  l.carets.forEach((c, i) => {
    // compare against the caret's vertical middle
    const p = v.project(new Vector3(c[0], c[1] + l.size * 0.3, 0).applyMatrix4(w));
    const d = Math.hypot((p.x - x) * 1, (p.y - y) * 2.5);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

editModeHooks.pointer.push((v, e) => {
  if (!inTextEdit() || activeTools.EDIT !== 'builtin.select_text') return false;
  const { cu } = activeText()!;
  const r = v.el.getBoundingClientRect();
  const at = (ev: { clientX: number; clientY: number }) => indexAt(v, ev.clientX - r.left, ev.clientY - r.top);
  if (e.detail === 2) {
    setCaret(cu, at(e));
    app.run('font.select_word');
    return true;
  }
  setCaret(cu, at(e), e.shiftKey);
  const anchor = selAnchor ?? caret(cu);
  app.changed('ui');
  const move = (m: PointerEvent) => {
    selAnchor = anchor;
    carets.set(cu.id, at(m));
    app.changed('ui');
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  return true;
});

// caret & selection overlay
editModeHooks.svg.push((v) => {
  if (!inTextEdit()) return null;
  const { ob, cu } = activeText()!;
  const w = app.graph.get(ob.id)?.world ?? new Matrix4();
  const l = lay(cu);
  const c = caret(cu);
  const at = (i: number) => l.carets[Math.min(i, l.carets.length - 1)] ?? [0, 0];
  const P = (x: number, y: number) => v.project(new Vector3(x, y, 0).applyMatrix4(w));
  const parts = [];
  const sel = selection(cu);
  if (sel) {
    for (let i = sel[0]; i < sel[1]; i++) {
      const [x0, y0] = at(i),
        [x1, y1] = at(i + 1);
      if (y1 !== y0) continue; // line break
      const a = P(x0, y0 - l.size * 0.2),
        b = P(x1, y0 - l.size * 0.2),
        cc = P(x1, y0 + l.size * 0.8),
        d = P(x0, y0 + l.size * 0.8);
      parts.push(h('polygon', { points: `${a.x},${a.y} ${b.x},${b.y} ${cc.x},${cc.y} ${d.x},${d.y}`, fill: 'rgba(80,140,255,.35)' }));
    }
  }
  const [x, y] = at(c);
  const p0 = P(x, y - l.size * 0.2),
    p1 = P(x, y + l.size * 0.8);
  parts.push(h('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: '#ffffff', 'stroke-width': 2 }));
  // text box frames
  for (const b of cu.text_boxes ?? []) {
    if (!(b.width > 0)) continue;
    const hgt = b.height > 0 ? b.height : l.lineHeight;
    const q = [P(b.x, b.y + l.size), P(b.x + b.width, b.y + l.size), P(b.x + b.width, b.y + l.size - hgt), P(b.x, b.y + l.size - hgt)];
    parts.push(h('polygon', { points: q.map((pt) => `${pt.x},${pt.y}`).join(' '), fill: 'none', stroke: '#9a9a9a', 'stroke-dasharray': '4 3', 'stroke-width': 1 }));
  }
  return h('g', { class: 'text-edit' }, parts);
});

// styled fonts load lazily: re-evaluate text objects when one arrives
fontLoadListeners.push(() => {
  for (const o of Object.values(app.doc.objects)) if (o.type === 'FONT') app.graph.invalidate(o.id);
  app.changed('doc', 'geometry');
});

// ---------------------------------------------------------------------------
// toolbar

registerIcons({
  select_text: '<path class="s" d="M5.5 2.5h5M5.5 13.5h5M8 2.5v11" fill="none" stroke-width="1.3"/>',
  font_data: '<path class="f" d="M2 13 6.2 2.5h1.6L12 13h-1.9l-1-2.7H4.9L3.9 13zm3.5-4.3h3L7 4.6z"/><path class="s" d="M12.5 8.5v5M10 13.5h5" stroke-width="1.1"/>',
});

toolsByMode.EDIT_FONT = [{ id: 'builtin.select_text', label: 'Select Text', icon: 'select_text', description: 'Click to place the cursor, drag to select, double-click selects a word' }, ...COMMON_TOOLS];

// ---------------------------------------------------------------------------
// menus

const SPECIAL: ([string, string] | null)[] = [
  ['Copyright', '©'],
  ['Registered Trademark', '®'],
  null,
  ['Degree', '°'],
  ['Multiplication', '×'],
  ['Circle', '•'],
  null,
  ['Superscript', '¹'],
  ['Superscript', '²'],
  ['Superscript', '³'],
  null,
  ['Guillemet', '»'],
  ['Guillemet', '«'],
  ['Per Mille', '‰'],
  null,
  ['Euro', '€'],
  ['Florin', 'ƒ'],
  ['Pound', '£'],
  ['Yen', '¥'],
  null,
  ['German Eszett', 'ß'],
  ['Inverted Question Mark', '¿'],
  ['Inverted Exclamation Mark', '¡'],
];

function specialMenu(): MenuItem[] {
  return SPECIAL.map((s) => (s ? { label: `${s[0]} ${s[1]}`, op: 'font.text_insert', props: { text: s[1] } } : { separator: true }));
}

function kerningMenu(): MenuItem[] {
  return [
    { label: 'Decrease Kerning', op: 'font.change_spacing', props: { delta: -1 }, shortcut: 'Alt ←' },
    { label: 'Increase Kerning', op: 'font.change_spacing', props: { delta: 1 }, shortcut: 'Alt →' },
  ];
}

function deleteMenu(): MenuItem[] {
  return [
    { label: 'Previous Character', op: 'font.delete', props: { type: 'PREVIOUS_CHARACTER' }, shortcut: 'Backspace' },
    { label: 'Next Character', op: 'font.delete', props: { type: 'NEXT_CHARACTER' }, shortcut: 'Delete' },
    { label: 'Previous Word', op: 'font.delete', props: { type: 'PREVIOUS_WORD' }, shortcut: 'Ctrl Backspace' },
    { label: 'Next Word', op: 'font.delete', props: { type: 'NEXT_WORD' }, shortcut: 'Ctrl Delete' },
  ];
}

const styleItem = (style: string, label: string, key: string) => ({ label, op: 'font.style_toggle', props: { style }, shortcut: key, checked: !!editFormat[T.styleKey(style)] });

function textMenu(): MenuItem[] {
  return [
    { label: 'Cut', op: 'font.text_cut', shortcut: 'Ctrl X' },
    { label: 'Copy', op: 'font.text_copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'font.text_paste', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Paste File…', op: 'font.text_paste_from_file' },
    { separator: true },
    { label: 'To Uppercase', op: 'font.case_set', props: { case: 'UPPER' } },
    { label: 'To Lowercase', op: 'font.case_set', props: { case: 'LOWER' } },
    { label: 'Toggle Case', op: 'font.case_toggle' },
    { separator: true },
    { label: 'Insert Unicode…', op: 'font.text_insert_unicode' },
    { label: 'Special Characters', submenu: specialMenu },
    { separator: true },
    styleItem('BOLD', 'Toggle Bold', 'Ctrl B'),
    styleItem('ITALIC', 'Toggle Italic', 'Ctrl I'),
    styleItem('UNDERLINE', 'Toggle Underline', 'Ctrl U'),
    styleItem('SMALL_CAPS', 'Toggle Small Caps', 'Ctrl P'),
    { label: 'Kerning', submenu: kerningMenu },
    { separator: true },
    { label: 'Delete', submenu: deleteMenu },
  ];
}

function selectMenu(): MenuItem[] {
  const ms = (type: string, label: string, shortcut?: string): MenuItem => ({ label, op: 'font.move_select', props: { type }, shortcut });
  return [
    { label: 'All', op: 'font.select_all', shortcut: 'Ctrl A' },
    { separator: true },
    ms('TEXT_BEGIN', 'Top', 'Shift Ctrl Home'),
    ms('TEXT_END', 'Bottom', 'Shift Ctrl End'),
    { separator: true },
    ms('PREVIOUS_PAGE', 'Previous Block', 'Shift Page Up'),
    ms('NEXT_PAGE', 'Next Block', 'Shift Page Down'),
    { separator: true },
    ms('LINE_BEGIN', 'Line Begin', 'Shift Home'),
    ms('LINE_END', 'Line End', 'Shift End'),
    { separator: true },
    ms('PREVIOUS_LINE', 'Previous Line', 'Shift ↑'),
    ms('NEXT_LINE', 'Next Line', 'Shift ↓'),
    { separator: true },
    ms('PREVIOUS_WORD', 'Previous Word', 'Shift Ctrl ←'),
    ms('NEXT_WORD', 'Next Word', 'Shift Ctrl →'),
  ];
}

function contextMenu(): MenuItem[] {
  return [
    { heading: 'Text' },
    { label: 'Cut', op: 'font.text_cut', shortcut: 'Ctrl X' },
    { label: 'Copy', op: 'font.text_copy', shortcut: 'Ctrl C' },
    { label: 'Paste', op: 'font.text_paste', shortcut: 'Ctrl V' },
    { separator: true },
    { label: 'Select All', op: 'font.select_all', shortcut: 'Ctrl A' },
    { separator: true },
    { label: 'Text', submenu: textMenu },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inTextEdit() ? [['Text', textMenu]] : prevEdit?.header?.() ?? []),
  select: () => (inTextEdit() ? selectMenu() : prevEdit?.select?.() ?? []),
  add: () => (inTextEdit() ? [] : prevEdit?.add?.() ?? []),
  context: () => (inTextEdit() ? contextMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inTextEdit() ? null : prevEdit?.headerExtra?.() ?? null),
};
