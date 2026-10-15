// Text Edit Mode: type directly into a text object in the 3D viewport.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { editModeHooks } from '../../editors/view3d/hooks';
import { keyInputHooks } from '../../app/keymap';
import { modeMenus } from '../../editors/view3d/modemenus';
import { h } from '../../ui/h';
import type { CurveData, ObjectData } from '../../data/types';
import { layoutText } from '../../io/fonts';
import type { MenuItem } from '../../ui/menu';

function activeText(): { ob: ObjectData; cu: CurveData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'FONT' || !ob.data) return null;
  const cu = app.doc.curves[ob.data];
  return cu ? { ob, cu } : null;
}
const inTextEdit = () => app.doc.mode === 'EDIT' && !!activeText();

/** caret index per text datablock (session state) */
const carets = new Map<string, number>();
let selAnchor: number | null = null;

function caret(cu: CurveData) {
  const len = (cu.body ?? '').length;
  const c = carets.get(cu.id) ?? len;
  return Math.max(0, Math.min(len, c));
}

function setBody(cu: CurveData, body: string, at: number, label: string) {
  cu.body = body;
  carets.set(cu.id, at);
  app.pushUndo(label);
  app.changed('doc', 'geometry');
}

function selection(cu: CurveData): [number, number] | null {
  if (selAnchor === null) return null;
  const c = caret(cu);
  if (selAnchor === c) return null;
  return [Math.min(selAnchor, c), Math.max(selAnchor, c)];
}

function insert(cu: CurveData, text: string) {
  const body = cu.body ?? '';
  const sel = selection(cu);
  const [a, b] = sel ?? [caret(cu), caret(cu)];
  selAnchor = null;
  setBody(cu, body.slice(0, a) + text + body.slice(b), a + text.length, 'Insert Text');
}

/** Character index of the line start / end around `i`. */
function lineBounds(body: string, i: number): [number, number] {
  const start = body.lastIndexOf('\n', i - 1) + 1;
  let end = body.indexOf('\n', i);
  if (end < 0) end = body.length;
  return [start, end];
}

keyInputHooks.push((e) => {
  if (!inTextEdit()) return false;
  // keep Tab (leave edit mode), F-keys and modifier shortcuts other than editing ones for the keymaps
  if (e.key === 'Tab' || /^F\d+$/.test(e.key)) return false;
  const { cu } = activeText()!;
  const body = cu.body ?? '';
  let c = caret(cu);
  const ctrl = e.ctrlKey || e.metaKey;
  const move = (to: number) => {
    if (e.shiftKey) selAnchor ??= c;
    else selAnchor = null;
    carets.set(cu.id, Math.max(0, Math.min(body.length, to)));
    app.changed('ui');
  };
  switch (e.key) {
    case 'ArrowLeft':
      move(ctrl ? body.lastIndexOf(' ', c - 2) + 1 : c - 1);
      return true;
    case 'ArrowRight': {
      const n = body.indexOf(' ', c + 1);
      move(ctrl ? (n < 0 ? body.length : n) : c + 1);
      return true;
    }
    case 'Home':
      move(lineBounds(body, c)[0]);
      return true;
    case 'End':
      move(lineBounds(body, c)[1]);
      return true;
    case 'ArrowUp':
    case 'ArrowDown': {
      const [s] = lineBounds(body, c);
      const col = c - s;
      if (e.key === 'ArrowUp') {
        if (s === 0) return true;
        const [ps, pe] = lineBounds(body, s - 1);
        move(Math.min(ps + col, pe));
      } else {
        const [, end] = lineBounds(body, c);
        if (end >= body.length) return true;
        const [ns, ne] = lineBounds(body, end + 1);
        move(Math.min(ns + col, ne));
      }
      return true;
    }
    case 'Backspace': {
      const sel = selection(cu);
      if (sel) return insert(cu, ''), true;
      if (c === 0) return true;
      const from = ctrl ? body.lastIndexOf(' ', c - 2) + 1 : c - 1;
      setBody(cu, body.slice(0, from) + body.slice(c), from, 'Delete Text');
      return true;
    }
    case 'Delete': {
      const sel = selection(cu);
      if (sel) return insert(cu, ''), true;
      if (c >= body.length) return true;
      setBody(cu, body.slice(0, c) + body.slice(c + 1), c, 'Delete Text');
      return true;
    }
    case 'Enter':
      insert(cu, '\n');
      return true;
    case 'Escape':
      selAnchor = null;
      app.changed('ui');
      return false;
  }
  if (ctrl) {
    const k = e.key.toLowerCase();
    if (k === 'a') {
      selAnchor = 0;
      carets.set(cu.id, body.length);
      app.changed('ui');
      return true;
    }
    if (k === 'c' || k === 'x') {
      const sel = selection(cu);
      if (sel) {
        void navigator.clipboard?.writeText(body.slice(sel[0], sel[1])).catch(() => {});
        if (k === 'x') insert(cu, '');
      }
      return true;
    }
    if (k === 'v') {
      void navigator.clipboard
        ?.readText()
        .then((t) => t && insert(cu, t.replace(/\r\n?/g, '\n')))
        .catch(() => app.report('WARNING', 'Clipboard access was denied'));
      return true;
    }
    return false; // Ctrl+Z etc. go to the keymaps
  }
  if (e.key.length === 1 && !e.altKey) {
    insert(cu, e.key);
    return true;
  }
  return false;
});

// caret & selection overlay
editModeHooks.svg.push((v) => {
  if (!inTextEdit()) return null;
  const { ob, cu } = activeText()!;
  const w = app.graph.get(ob.id)?.world ?? new Matrix4();
  const lay = layoutText(cu);
  const c = caret(cu);
  const at = (i: number) => lay.carets[Math.min(i, lay.carets.length - 1)] ?? [0, 0];
  const P = (x: number, y: number) => v.project(new Vector3(x, y, 0).applyMatrix4(w));
  const parts = [];
  const sel = selection(cu);
  if (sel) {
    for (let i = sel[0]; i < sel[1]; i++) {
      const [x0, y0] = at(i),
        [x1, y1] = at(i + 1);
      if (y1 !== y0) continue; // line break
      const a = P(x0, y0 - lay.size * 0.2),
        b = P(x1, y0 - lay.size * 0.2),
        cc = P(x1, y0 + lay.size * 0.8),
        d = P(x0, y0 + lay.size * 0.8);
      parts.push(h('polygon', { points: `${a.x},${a.y} ${b.x},${b.y} ${cc.x},${cc.y} ${d.x},${d.y}`, fill: 'rgba(80,140,255,.35)' }));
    }
  }
  const [x, y] = at(c);
  const p0 = P(x, y - lay.size * 0.2),
    p1 = P(x, y + lay.size * 0.8);
  parts.push(h('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: '#ffffff', 'stroke-width': 2 }));
  return h('g', { class: 'text-edit' }, parts);
});

registerOperators([
  {
    idname: 'font.select_all',
    label: 'Select All',
    poll: inTextEdit,
    exec: () => {
      const { cu } = activeText()!;
      selAnchor = 0;
      carets.set(cu.id, (cu.body ?? '').length);
    },
    undo: false,
  },
  {
    idname: 'font.text_insert',
    label: 'Insert Text',
    props: [{ id: 'text', label: 'Text', type: 'string', default: '' }],
    poll: inTextEdit,
    exec: (_ctx, p) => {
      const { cu } = activeText()!;
      insert(cu, p.text as string);
      return 'CANCELLED'; // insert() already recorded the undo step
    },
  },
  {
    idname: 'font.delete',
    label: 'Delete',
    props: [{ id: 'type', label: 'Type', type: 'enum', default: 'PREVIOUS_OR_SELECTION', items: [['PREVIOUS_OR_SELECTION', 'Previous Character or Selection'], ['NEXT_OR_SELECTION', 'Next Character or Selection'], ['SELECTION', 'Selection']] }],
    poll: inTextEdit,
    exec: (_ctx, p) => {
      const { cu } = activeText()!;
      const body = cu.body ?? '';
      const sel = selection(cu);
      if (sel) insert(cu, '');
      else if (p.type !== 'SELECTION') {
        const c = caret(cu);
        if (p.type === 'PREVIOUS_OR_SELECTION' && c > 0) setBody(cu, body.slice(0, c - 1) + body.slice(c), c - 1, 'Delete Text');
        if (p.type === 'NEXT_OR_SELECTION' && c < body.length) setBody(cu, body.slice(0, c) + body.slice(c + 1), c, 'Delete Text');
      }
      return 'CANCELLED';
    },
  },
]);

function textMenu(): MenuItem[] {
  return [
    { label: 'Select All', op: 'font.select_all', shortcut: 'Ctrl A' },
    { separator: true },
    { label: 'Delete Previous', op: 'font.delete', props: { type: 'PREVIOUS_OR_SELECTION' }, shortcut: 'Backspace' },
    { label: 'Delete Next', op: 'font.delete', props: { type: 'NEXT_OR_SELECTION' }, shortcut: 'Delete' },
  ];
}

const prevEdit = modeMenus.EDIT;
modeMenus.EDIT = {
  ...prevEdit,
  header: () => (inTextEdit() ? [['Text', textMenu]] : prevEdit?.header?.() ?? []),
  select: () => (inTextEdit() ? [{ label: 'All', op: 'font.select_all', shortcut: 'Ctrl A' }] : prevEdit?.select?.() ?? []),
  add: () => (inTextEdit() ? [] : prevEdit?.add?.() ?? []),
  context: () => (inTextEdit() ? textMenu() : prevEdit?.context?.() ?? []),
  headerExtra: () => (inTextEdit() ? null : prevEdit?.headerExtra?.() ?? null),
};
