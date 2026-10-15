// Editing text strips in place in the preview: Tab (or double click) enters edit mode on the
// active text strip; typing, cursor keys, selection, clipboard and line breaks edit the strip's
// text; Tab / Esc / clicking elsewhere leaves. Operators mirror the keys for menus and search.
import { app, registerOperators, type Operator } from '../app/app';
import { keyInputHooks } from '../app/keymap';
import type { Strip } from './types';
import { seqList, activeStrip, hasEditor, hoverSeq } from './context';
import { activeAt } from './strips';
import { layoutTextStrip, measureText, ASC, DESC, type TextLayoutBox } from './text';
import { placementMatrix } from './gpu';
import { moveCursor, lineOf, colAtX, replaceRange, deleteAt, type CursorMove } from './textcursor';

/** Edit state (UI only, not saved): the edited strip, the cursor and the selection anchor. */
export const textEdit = { strip: null as string | null, cursor: 0, anchor: 0 };

/** The strip being edited, if it still exists, is a text strip and shows at the current frame. */
export function editedText(): Strip | null {
  if (!textEdit.strip || !hasEditor()) return null;
  const s = seqList().find((x) => x.name === textEdit.strip && x.type === 'TEXT');
  if (!s || !activeAt(s, app.doc.scene.frame_current)) return null;
  return s;
}

export const isTextEditing = () => !!editedText();

function res(): [number, number] {
  const r = app.doc.scene.render;
  return [r.resolution_x, r.resolution_y];
}

function clamp(s: Strip) {
  const n = (s.text ?? '').length;
  textEdit.cursor = Math.max(0, Math.min(n, textEdit.cursor));
  textEdit.anchor = Math.max(0, Math.min(n, textEdit.anchor));
}

export function startTextEdit(s: Strip, at?: number) {
  textEdit.strip = s.name;
  const n = (s.text ?? '').length;
  textEdit.cursor = textEdit.anchor = at ?? n;
  app.changed('ui');
  hoverSeq()?.requestPreview();
}

export function endTextEdit() {
  if (!textEdit.strip) return;
  textEdit.strip = null;
  flushUndo();
  app.changed('ui');
}

let undoTimer = 0;
/** Text changes are grouped into one undo step per pause in typing. */
function scheduleUndo() {
  clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => {
    undoTimer = 0;
    app.pushUndo('Edit Text');
  }, 600);
}
function flushUndo() {
  if (!undoTimer) return;
  clearTimeout(undoTimer);
  undoTimer = 0;
  app.pushUndo('Edit Text');
}

function setText(s: Strip, text: string, cursor: number) {
  s.text = text;
  textEdit.cursor = textEdit.anchor = cursor;
  app.changed('doc');
  scheduleUndo();
}

const selRange = (): [number, number] => [Math.min(textEdit.cursor, textEdit.anchor), Math.max(textEdit.cursor, textEdit.anchor)];

// ---------------------------------------------------------------------------
// geometry (output pixels, y up)

interface Geometry {
  L: TextLayoutBox;
  M: number[];
}

function geometry(s: Strip): Geometry {
  const [W, H] = res();
  return { L: layoutTextStrip(s, W, H, 1), M: placementMatrix(W, H, W, H, s.transform, 1) };
}

const apply = (M: number[], x: number, y: number): [number, number] => [M[0] * x + M[3] * y + M[6], M[1] * x + M[4] * y + M[7]];

function invert(M: number[], x: number, y: number): [number, number] {
  const a = M[0],
    b = M[1],
    d = M[3],
    e = M[4];
  const det = a * e - b * d || 1e-9;
  const px = x - M[6],
    py = y - M[7];
  return [(e * px - d * py) / det, (-b * px + a * py) / det];
}

/** Text position nearest to a point in output pixels (y up). */
export function indexAt(s: Strip, fx: number, fy: number): number {
  const { L, M } = geometry(s);
  const [x, y] = invert(M, fx, fy);
  const fs = L.fontPx;
  let li = 0,
    bd = Infinity;
  L.lines.forEach((l, i) => {
    const mid = l.baseline + ((ASC - DESC) * fs) / 2;
    const d = Math.abs(y - mid);
    if (d < bd) {
      bd = d;
      li = i;
    }
  });
  const line = L.lines[li];
  return line.start + colAtX(line, x - line.x, (t) => measureText(s, fs, t));
}

/** Whether a point (output pixels) is on the strip's text block. */
export function hitsText(s: Strip, fx: number, fy: number): boolean {
  const { L, M } = geometry(s);
  const [x, y] = invert(M, fx, fy);
  const pad = L.fontPx * 0.3;
  return x >= L.left - pad && x <= L.right + pad && y >= L.bottom - pad && y <= L.top + pad;
}

/** Cursor and selection drawn over the preview; `toLocal` maps output pixels to canvas pixels. */
export function drawTextEditOverlay(g: CanvasRenderingContext2D, toLocal: (x: number, y: number) => [number, number]) {
  const s = editedText();
  if (!s) return;
  clamp(s);
  const { L, M } = geometry(s);
  const fs = L.fontPx;
  const quad = (x0: number, x1: number, b: number) =>
    [
      [x0, b - DESC * fs],
      [x1, b - DESC * fs],
      [x1, b + ASC * fs],
      [x0, b + ASC * fs],
    ].map(([x, y]) => toLocal(...apply(M, x, y)));
  const path = (pts: [number, number][]) => {
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
  };
  const [a, b] = selRange();
  const xAt = (li: number, i: number) => L.lines[li].x + measureText(s, fs, L.lines[li].text.slice(0, Math.max(0, Math.min(i - L.lines[li].start, L.lines[li].text.length))));
  if (b > a) {
    g.fillStyle = 'rgba(90, 138, 252,0.4)';
    L.lines.forEach((l, li) => {
      const end = l.start + l.text.length;
      const lo = Math.max(a, l.start),
        hi = Math.min(b, end);
      const past = b > end && a <= end && li < L.lines.length - 1; // selection runs on past the line end
      if (hi < lo || (hi === lo && !past)) return;
      path(quad(xAt(li, lo), xAt(li, hi) + (past ? fs * 0.25 : 0), l.baseline));
      g.fill();
    });
  }
  // block outline and cursor
  g.save();
  g.setLineDash([3, 3]);
  g.strokeStyle = 'rgba(255, 255, 255,0.5)';
  path(
    [
      [L.left, L.bottom],
      [L.right, L.bottom],
      [L.right, L.top],
      [L.left, L.top],
    ].map(([x, y]) => toLocal(...apply(M, x, y))),
  );
  g.stroke();
  g.restore();
  const li = lineOf(L.lines, textEdit.cursor);
  const cx = xAt(li, textEdit.cursor);
  const bl = L.lines[li].baseline;
  const [p0, p1] = [toLocal(...apply(M, cx, bl - DESC * fs)), toLocal(...apply(M, cx, bl + ASC * fs))];
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(...p0);
  g.lineTo(...p1);
  g.stroke();
  g.lineWidth = 1;
}

// ---------------------------------------------------------------------------
// operators

function edited(): Strip {
  const s = editedText()!;
  clamp(s);
  return s;
}

function move(type: CursorMove, select: boolean) {
  const s = edited();
  const { L } = geometry(s);
  const text = s.text ?? '';
  const fs = L.fontPx;
  textEdit.cursor = moveCursor(text, L.lines, textEdit.cursor, type, (t) => measureText(s, fs, t), (l) => L.lines[l].x);
  if (!select) textEdit.anchor = textEdit.cursor;
  app.changed('ui');
  hoverSeq()?.requestPreview();
}

async function writeClipboard(text: string) {
  clip = text;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // the internal copy still works
  }
}
let clip = '';

const MOVES: [CursorMove, string][] = [
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
];

const ops: Operator[] = [
  {
    idname: 'sequencer.text_edit_mode_toggle',
    label: 'Toggle Text Editing',
    description: 'Edit the active text strip’s text directly in the preview',
    undo: false,
    poll: () => isTextEditing() || (hasEditor() && activeStrip()?.type === 'TEXT' && activeAt(activeStrip()!, app.doc.scene.frame_current)),
    exec: () => {
      if (isTextEditing()) endTextEdit();
      else startTextEdit(activeStrip()!);
    },
  },
  {
    idname: 'sequencer.text_cursor_move',
    label: 'Move Cursor',
    description: 'Move the text cursor',
    undo: false,
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'LINE_BEGIN', items: MOVES },
      { id: 'select_text', label: 'Select Text', type: 'bool', default: false },
    ],
    poll: isTextEditing,
    exec: (_c, p) => move(p.type as CursorMove, !!p.select_text),
  },
  {
    idname: 'sequencer.text_insert',
    label: 'Insert Text',
    description: 'Insert text at the cursor, replacing the selection',
    undo: false,
    props: [{ id: 'string', label: 'String', type: 'string', default: '' }],
    poll: isTextEditing,
    exec: (_c, p) => {
      const s = edited();
      const r = replaceRange(s.text ?? '', textEdit.cursor, textEdit.anchor, p.string as string);
      setText(s, r.text, r.cursor);
    },
  },
  {
    idname: 'sequencer.text_delete',
    label: 'Delete Text',
    description: 'Delete the selection or the character next to the cursor',
    undo: false,
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'NEXT_OR_SELECTION',
        items: [
          ['NEXT_OR_SELECTION', 'Next or Selection'],
          ['PREVIOUS_OR_SELECTION', 'Previous or Selection'],
        ],
      },
    ],
    poll: isTextEditing,
    exec: (_c, p) => {
      const s = edited();
      const r = deleteAt(s.text ?? '', textEdit.cursor, textEdit.anchor, p.type === 'NEXT_OR_SELECTION');
      setText(s, r.text, r.cursor);
    },
  },
  {
    idname: 'sequencer.text_line_break',
    label: 'Insert Line Break',
    description: 'Start a new line at the cursor',
    undo: false,
    poll: isTextEditing,
    exec: () => {
      const s = edited();
      const r = replaceRange(s.text ?? '', textEdit.cursor, textEdit.anchor, '\n');
      setText(s, r.text, r.cursor);
    },
  },
  {
    idname: 'sequencer.text_select_all',
    label: 'Select All',
    description: 'Select all of the text',
    undo: false,
    poll: isTextEditing,
    exec: () => {
      const s = edited();
      textEdit.anchor = 0;
      textEdit.cursor = (s.text ?? '').length;
      app.changed('ui');
    },
  },
  {
    idname: 'sequencer.text_deselect_all',
    label: 'Deselect All',
    description: 'Clear the text selection',
    undo: false,
    poll: isTextEditing,
    exec: () => {
      textEdit.anchor = textEdit.cursor;
      app.changed('ui');
    },
  },
  {
    idname: 'sequencer.text_edit_copy',
    label: 'Copy Text',
    description: 'Copy the selected text to the clipboard',
    undo: false,
    poll: () => isTextEditing() && textEdit.cursor !== textEdit.anchor,
    exec: () => {
      const s = edited();
      const [a, b] = selRange();
      void writeClipboard((s.text ?? '').slice(a, b));
    },
  },
  {
    idname: 'sequencer.text_edit_cut',
    label: 'Cut Text',
    description: 'Cut the selected text to the clipboard',
    undo: false,
    poll: () => isTextEditing() && textEdit.cursor !== textEdit.anchor,
    exec: () => {
      const s = edited();
      const [a, b] = selRange();
      void writeClipboard((s.text ?? '').slice(a, b));
      const r = replaceRange(s.text ?? '', a, b, '');
      setText(s, r.text, r.cursor);
    },
  },
  {
    idname: 'sequencer.text_edit_paste',
    label: 'Paste Text',
    description: 'Paste text from the clipboard at the cursor',
    undo: false,
    poll: isTextEditing,
    exec: () => {
      const insert = (t: string) => {
        if (!isTextEditing()) return;
        const s = edited();
        const r = replaceRange(s.text ?? '', textEdit.cursor, textEdit.anchor, t.replace(/\r\n?/g, '\n'));
        setText(s, r.text, r.cursor);
      };
      if (navigator.clipboard?.readText)
        navigator.clipboard.readText().then(
          (t) => insert(t || clip),
          () => insert(clip),
        );
      else insert(clip);
    },
  },
  {
    idname: 'sequencer.text_cursor_set',
    label: 'Set Cursor',
    description: 'Put the text cursor at the pointer in the preview',
    undo: false,
    props: [{ id: 'select_text', label: 'Select Text', type: 'bool', default: false }],
    poll: () => isTextEditing() && hoverSeq()?.hover === 'preview',
    exec: (_c, p) => {
      const s = edited();
      const [fx, fy] = hoverSeq()!.previewToFrame(app.pointer.x, app.pointer.y);
      textEdit.cursor = indexAt(s, fx, fy);
      if (!p.select_text) textEdit.anchor = textEdit.cursor;
      app.changed('ui');
    },
  },
];

registerOperators(ops);

// ---------------------------------------------------------------------------
// keys: while editing, typing goes to the text (over any sequencer region)

const NAV: Record<string, CursorMove> = {
  ArrowLeft: 'PREVIOUS_CHARACTER',
  ArrowRight: 'NEXT_CHARACTER',
  ArrowUp: 'PREVIOUS_LINE',
  ArrowDown: 'NEXT_LINE',
  Home: 'LINE_BEGIN',
  End: 'LINE_END',
  PageUp: 'TEXT_BEGIN',
  PageDown: 'TEXT_END',
};

keyInputHooks.push((e) => {
  if (!textEdit.strip) return false;
  if (!isTextEditing()) {
    endTextEdit();
    return false;
  }
  if (!hoverSeq()) return false;
  const ctrl = e.ctrlKey || e.metaKey;
  const run = (id: string, props: Record<string, unknown> = {}) => (app.run(id, props, { invoke: false }), true);
  if (e.key === 'Tab') return run('sequencer.text_edit_mode_toggle');
  if (e.key === 'Escape') {
    if (textEdit.cursor !== textEdit.anchor) return run('sequencer.text_deselect_all');
    endTextEdit();
    return true;
  }
  if (NAV[e.key]) {
    let type = NAV[e.key];
    if (ctrl && type === 'PREVIOUS_CHARACTER') type = 'PREVIOUS_WORD';
    if (ctrl && type === 'NEXT_CHARACTER') type = 'NEXT_WORD';
    return run('sequencer.text_cursor_move', { type, select_text: e.shiftKey });
  }
  if (e.key === 'Backspace') return run('sequencer.text_delete', { type: 'PREVIOUS_OR_SELECTION' });
  if (e.key === 'Delete') return run('sequencer.text_delete', { type: 'NEXT_OR_SELECTION' });
  if (e.key === 'Enter') return run('sequencer.text_line_break');
  if (ctrl) {
    const k = e.key.toLowerCase();
    if (k === 'a') return run('sequencer.text_select_all');
    if (k === 'c') return (app.poll('sequencer.text_edit_copy') && run('sequencer.text_edit_copy'), true);
    if (k === 'x') return (app.poll('sequencer.text_edit_cut') && run('sequencer.text_edit_cut'), true);
    if (k === 'v') return run('sequencer.text_edit_paste');
    if (k === 'z') flushUndo();
    return false;
  }
  if (e.key.length === 1) return run('sequencer.text_insert', { string: e.key });
  return false;
});
