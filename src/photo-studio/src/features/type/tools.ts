// The four type tools: horizontal/vertical type and type masks. Click for
// point text, drag for a paragraph frame, click existing text to edit it.

import type { Editor } from '../../editor';
import { registerCommand, registerTool, type Tool } from '../../app/registry';
import type { CanvasPointer } from '../../app/pointer';
import { isMac } from '../../app/shortcuts';
import { textLength, type TextLayerData } from '../../imaging/text/model';
import {
  applyChar,
  applyParagraph,
  backspace,
  cancel,
  cancelPendingStart,
  commit,
  currentSession,
  focusInput,
  forwardDelete,
  indexAt,
  insert,
  insideSession,
  move,
  moveBy,
  ordered,
  selectParagraphAt,
  selectWordAt,
  session,
  sessionLayer,
  sessionLayout,
  setKeyHandler,
  setSelection,
  startEdit,
  startNew,
  styleContext,
  undoEdit,
  updateData,
} from './session';
import { layerMatrix, localScale, textLayerAt, toLocal, warpLocal, warpedRect } from './text-utils';
import { typeOptions, bindTypeOptions, syncTypeOptions } from './options';
import { wordAt, paragraphAt, plainText } from '../../imaging/text/model';
import { AREA_TYPE_CURSOR, newTypePath, PATH_TYPE_CURSOR, pathTextMarkup, typePathAt } from './path-type';
import { isIdentityWarp } from '../../imaging/text/warp';

type Gesture =
  | { kind: 'select'; anchor: [number, number]; unit: 'char' | 'word' | 'paragraph' }
  | { kind: 'box'; handle: string; start: [number, number]; data: TextLayerData; snap: boolean; id: string }
  | { kind: 'move'; start: [number, number]; id: string }
  | { kind: 'create'; start: [number, number]; current: [number, number] };
let gesture: Gesture | undefined;
const clicks = { count: 0, time: 0, x: 0, y: 0 };

export const typeToolIds = ['type', 'type-vertical', 'type-mask', 'type-mask-vertical'];
export const isTypeTool = (id: string) => typeToolIds.includes(id);

const HANDLES: Record<string, [number, number]> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

function boxRect(d: TextLayerData) {
  return d.mode === 'paragraph' && d.box && !d.path ? { x: d.origin.x, y: d.origin.y, width: d.box.width, height: d.box.height } : undefined;
}
function handleAt(e: Editor, p: CanvasPointer): string | undefined {
  const s = session;
  const l = sessionLayer();
  if (!s || !l) return;
  const box = boxRect(s.data);
  if (!box) return;
  const [lx, ly] = toLocal(l, p.x, p.y);
  const k = e.zoom * localScale(l);
  for (const [h, [u, v]] of Object.entries(HANDLES)) {
    const hx = box.x + u * box.width,
      hy = box.y + v * box.height;
    if (Math.hypot(lx - hx, ly - hy) * k < 7) return h;
  }
}

async function pointerDown(e: Editor, p: CanvasPointer, vertical: boolean, mask: boolean) {
  // Event time, not handling time: a busy main thread must not split a double-click.
  const now = p.event.timeStamp;
  const near = Math.hypot(p.clientX - clicks.x, p.clientY - clicks.y) < 5;
  clicks.count = now - clicks.time < 450 && near ? clicks.count + 1 : 1;
  clicks.time = now;
  clicks.x = p.clientX;
  clicks.y = p.clientY;
  gesture = undefined;
  if (session) {
    const h = handleAt(e, p);
    if (h) {
      gesture = { kind: 'box', handle: h, start: toLocal(sessionLayer()!, p.x, p.y), data: session.data, snap: true, id: crypto.randomUUID() };
      return;
    }
    if (p.mod && !session.mask) {
      gesture = { kind: 'move', start: [p.x, p.y], id: crypto.randomUUID() };
      return;
    }
    if (insideSession(e, p.x, p.y)) {
      selectAtClick(e, p);
      focusInput(e);
      return;
    }
    await commit(e);
    return;
  }
  const hit = mask ? undefined : textLayerAt(e, p.x, p.y);
  if (hit) {
    await startEdit(e, hit.id, { x: p.x, y: p.y });
    const s = currentSession();
    if (s) {
      if (clicks.count > 1) selectAtClick(e, p);
      else gesture = { kind: 'select', anchor: [s.focus, s.focus], unit: 'char' };
    }
    return;
  }
  // On a path: type along it; inside a closed path: area type.
  const onPath = typePathAt(e, p.x, p.y);
  if (onPath) {
    await startNew(e, { x: p.x, y: p.y, vertical: false, mask, path: newTypePath(onPath) });
    e.overlay();
    return;
  }
  void vertical;
  gesture = { kind: 'create', start: [p.x, p.y], current: [p.x, p.y] };
}

function selectAtClick(e: Editor, p: CanvasPointer) {
  const s = session!;
  const i = indexAt(e, p.x, p.y);
  if (clicks.count === 2) {
    selectWordAt(e, i);
    gesture = { kind: 'select', anchor: ordered(s), unit: 'word' };
  } else if (clicks.count >= 3) {
    selectParagraphAt(e, i);
    gesture = { kind: 'select', anchor: ordered(s), unit: 'paragraph' };
  } else {
    if (p.shift) setSelection(e, s.anchor, i);
    else setSelection(e, i, i);
    gesture = { kind: 'select', anchor: p.shift ? [s.anchor, s.anchor] : [i, i], unit: 'char' };
  }
}

function pointerMove(e: Editor, p: CanvasPointer) {
  const g = gesture;
  if (!g) return;
  if (g.kind === 'create') {
    g.current = [p.x, p.y];
    e.overlay();
    return;
  }
  const s = session;
  if (!s) return;
  if (g.kind === 'select') {
    const i = indexAt(e, p.x, p.y);
    const [a0, a1] = g.anchor;
    let lo = i,
      hi = i;
    if (g.unit === 'word') {
      const w = wordAt(plainText(s.data.content), i);
      lo = w.start;
      hi = w.end;
    } else if (g.unit === 'paragraph') {
      const r = paragraphAt(s.data.content, i);
      lo = r.start;
      hi = r.end;
    }
    if (i < a0) setSelection(e, a1, lo);
    else setSelection(e, a0, Math.max(hi, a1));
    return;
  }
  if (g.kind === 'move') {
    const dx = p.x - g.start[0],
      dy = p.y - g.start[1];
    g.start = [p.x, p.y];
    moveBy(e, dx, dy, `move:${g.id}`);
    return;
  }
  if (g.kind === 'box') {
    const l = sessionLayer()!;
    const [lx, ly] = toLocal(l, p.x, p.y);
    const dx = lx - g.start[0],
      dy = ly - g.start[1];
    const b0 = boxRect(g.data)!;
    let { x, y, width, height } = b0;
    if (g.handle.includes('e')) width = b0.width + dx;
    if (g.handle.includes('w')) {
      x = b0.x + dx;
      width = b0.width - dx;
    }
    if (g.handle.includes('s')) height = b0.height + dy;
    if (g.handle.startsWith('n')) {
      y = b0.y + dy;
      height = b0.height - dy;
    }
    const min = 8;
    if (width < min) {
      if (g.handle.includes('w')) x -= min - width;
      width = min;
    }
    if (height < min) {
      if (g.handle.startsWith('n')) y -= min - height;
      height = min;
    }
    // Each drag is one undo step.
    updateData(e, (d) => ({ ...d, origin: { x, y }, box: { width, height } }), `box:${g.id}`);
  }
}

async function pointerUp(e: Editor, p: CanvasPointer, vertical: boolean, mask: boolean) {
  const g = gesture;
  gesture = undefined;
  if (g?.kind !== 'create') return;
  const [x0, y0] = g.start;
  const dragged = Math.max(Math.abs(p.x - x0), Math.abs(p.y - y0)) * e.zoom > 4;
  if (dragged) {
    const x = Math.min(x0, p.x),
      y = Math.min(y0, p.y);
    const box = { x, y, width: Math.max(8, Math.abs(p.x - x0)), height: Math.max(8, Math.abs(p.y - y0)) };
    await startNew(e, { x, y, box, vertical, mask });
  } else await startNew(e, { x: x0, y: y0, vertical, mask });
  e.overlay();
}

// ------------------------------------------------------------ keyboard

function toggle(key: 'fauxBold' | 'fauxItalic' | 'underline' | 'allCaps' | 'strikethrough' | 'smallCaps', e: Editor) {
  const c = styleContext(e).char;
  void applyChar(e, { [key]: !c[key] });
}

export function handleKey(e: Editor, ev: KeyboardEvent, fromInput = true): boolean {
  const s = session;
  if (!s) return false;
  const mod = isMac ? ev.metaKey : ev.ctrlKey;
  const alt = ev.altKey,
    shift = ev.shiftKey;
  const vertical = s.data.orientation === 'vertical';
  switch (ev.key) {
    case 'Escape':
      void commit(e);
      return true;
    case 'Enter':
      if (mod || ev.code === 'NumpadEnter') void commit(e);
      else insert(e, '\n', 'newline');
      return true;
    // Words: Option on the Mac, Ctrl elsewhere; Cmd+Backspace deletes to the line start.
    case 'Backspace':
      backspace(e, alt || (mod && !isMac), mod && isMac);
      return true;
    case 'Delete':
      forwardDelete(e, alt || (mod && !isMac));
      return true;
    case 'Tab':
      insert(e, '\t');
      return true;
    case 'Home':
    case 'End':
      move(e, ev.key === 'Home' ? -1 : 1, mod ? 'doc' : 'line', shift);
      return true;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const along = vertical ? ev.key === 'ArrowUp' || ev.key === 'ArrowDown' : ev.key === 'ArrowLeft' || ev.key === 'ArrowRight';
      const forward = ev.key === 'ArrowRight' || ev.key === 'ArrowDown';
      if (along) {
        const dir = forward ? 1 : -1;
        if (mod && isMac) move(e, dir, 'line', shift);
        else move(e, dir, alt || (mod && !isMac) ? 'word' : 'char', shift, !vertical);
      } else {
        // Across lines; vertical columns advance to the left.
        const dir = vertical ? (ev.key === 'ArrowLeft' ? 1 : -1) : forward ? 1 : -1;
        if (mod) move(e, dir as 1 | -1, 'doc', shift);
        else move(e, dir as 1 | -1, 'vline', shift);
      }
      return true;
    }
  }
  if (mod) {
    const k = ev.key.toLowerCase();
    if (k === 'a' && !shift) {
      setSelection(e, 0, textLength(s.data.content));
      return true;
    }
    if (k === 'z') {
      undoEdit(e, shift);
      return true;
    }
    if (k === 'y' && !isMac) {
      undoEdit(e, true);
      return true;
    }
    if (shift) {
      const c = ev.code;
      if (c === 'KeyB') return toggle('fauxBold', e), true;
      if (c === 'KeyI') return toggle('fauxItalic', e), true;
      if (c === 'KeyU') return toggle('underline', e), true;
      if (c === 'KeyK') return toggle('allCaps', e), true;
      if (c === 'KeyH') return toggle('smallCaps', e), true;
      if (c === 'Slash') return toggle('strikethrough', e), true;
      if (c === 'KeyL') return void applyParagraph(e, { align: 'left' }), true;
      if (c === 'KeyC') return void applyParagraph(e, { align: 'center' }), true;
      if (c === 'KeyR') return void applyParagraph(e, { align: 'right' }), true;
      if (c === 'KeyJ') return void applyParagraph(e, { align: 'justify-left' }), true;
      if (c === 'KeyF') return void applyParagraph(e, { align: 'justify-all' }), true;
      if (c === 'Period' || c === 'Comma') {
        const size = styleContext(e).char.size ?? 24;
        void applyChar(e, { size: Math.max(0.5, Math.round((size + (c === 'Period' ? 2 : -2)) * 100) / 100) });
        return true;
      }
    }
    // Clipboard shortcuts go to the input's native copy/cut/paste events.
    return false;
  }
  if (!fromInput && ev.key.length === 1 && !alt) {
    insert(e, ev.key);
    return true;
  }
  return false;
}

// ------------------------------------------------------------ overlay

function overlay(e: Editor): string {
  let out = '';
  const g = gesture;
  if (g?.kind === 'create') {
    const [x0, y0] = g.start,
      [x1, y1] = g.current;
    if (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * e.zoom > 4)
      out += `<rect class="type-frame" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" stroke-width="${1 / e.zoom}" stroke-dasharray="${4 / e.zoom} ${3 / e.zoom}"/>`;
  }
  const s = session;
  const l = sessionLayer();
  const layout = sessionLayout(e);
  if (!s || !l || !layout) return out;
  const m = layerMatrix(l);
  const k = 1 / (e.zoom * localScale(l));
  const poly = (pts: [number, number][]) => pts.map((p) => `${p[0]},${p[1]}`).join(' ');
  out += `<g class="type-overlay" transform="matrix(${m.join(' ')})">`;
  const box = boxRect(s.data);
  if (s.data.path) out += pathTextMarkup(s.data, layout, k, true);
  else if (box) {
    out += `<rect class="type-frame" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" stroke-width="${k}"/>`;
    for (const [u, v] of Object.values(HANDLES)) {
      const hs = 7 * k;
      out += `<rect class="type-handle" x="${box.x + u * box.width - hs / 2}" y="${box.y + v * box.height - hs / 2}" width="${hs}" height="${hs}" stroke-width="${k}"/>`;
    }
    if (layout.overflow) {
      const hs = 9 * k;
      // Overflow marker: a boxed plus at the frame's lower right.
      const ox = box.x + box.width - hs * 1.4,
        oy = box.y + box.height - hs * 1.4;
      out += `<rect class="type-overflow" x="${ox}" y="${oy}" width="${hs}" height="${hs}" stroke-width="${k}"/><path class="type-overflow" d="M${ox + hs / 2} ${oy + 2 * k}V${oy + hs - 2 * k}M${ox + 2 * k} ${oy + hs / 2}H${ox + hs - 2 * k}" stroke-width="${k}"/>`;
    }
  } else {
    const b = layout.bounds;
    if (b.width > 0) out += `<polygon class="type-bounds" points="${poly(warpedRect(s.data, layout, b))}" stroke-width="${k}" stroke-dasharray="${3 * k} ${3 * k}"/>`;
  }
  const [a, b] = ordered(s);
  if (a !== b) for (const r of layout.selectionRects(a, b)) out += `<polygon class="type-selection" points="${poly(warpedRect(s.data, layout, r, 4))}"/>`;
  else {
    const r = layout.caretRect(s.focus);
    const p0 = warpLocal(s.data, layout, r.x, r.y);
    const p1 = warpLocal(s.data, layout, r.x + r.width, r.y + r.height);
    out += `<line class="type-caret" x1="${p0[0]}" y1="${p0[1]}" x2="${p1[0]}" y2="${p1[1]}" stroke-width="${Math.max(1.5 * k, 0.5)}"/>`;
  }
  // The IME's composition underline: under horizontal text, beside vertical
  // columns (on their right), following warps and paths like the selection.
  if (s.composing && s.composing.length)
    for (const r of layout.selectionRects(s.composing.start, s.composing.start + s.composing.length)) {
      const [x0, y0, x1, y1] = layout.vertical ? [r.x + r.width, r.y, r.x + r.width, r.y + r.height] : [r.x, r.y + r.height, r.x + r.width, r.y + r.height];
      const steps = layout.map ? Math.max(8, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4)) : isIdentityWarp(s.data.warp) ? 1 : 8;
      const pts: [number, number][] = [];
      for (let i = 0; i <= steps; i++) pts.push(warpLocal(s.data, layout, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps));
      out += `<polyline class="type-composition" points="${poly(pts)}" fill="none" stroke-width="${2 * k}"/>`;
    }
  return out + '</g>';
}

// Path or area type cursor over a path that a click would type on.
function pathCursor(e: Editor, p: CanvasPointer): string | undefined {
  if (session && insideSession(e, p.x, p.y)) return;
  if (!session && textLayerAt(e, p.x, p.y)) return;
  const hit = typePathAt(e, p.x, p.y);
  return hit ? (hit.kind === 'path' ? PATH_TYPE_CURSOR : AREA_TYPE_CURSOR) : undefined;
}

// ------------------------------------------------------------ registration

export function installTypeTools(e: Editor) {
  setKeyHandler((e, ev) => handleKey(e, ev, true));
  const make = (id: string, label: string, icon: string, vertical: boolean, mask: boolean): Tool => ({
    id,
    label,
    key: 'T',
    icon,
    group: 'type',
    cursor: () => (vertical ? 'vertical-text' : 'text'),
    options: (e) => typeOptions(e),
    bindOptions: (ctx) => bindTypeOptions(ctx),
    updateOptions: ({ e }) => syncTypeOptions(e),
    deactivate: (e) => {
      cancelPendingStart();
      gesture = undefined;
      if (session) return commit(e);
    },
    pointerDown: (e, p) => pointerDown(e, p, vertical, mask),
    pointerMove: (e, p) => pointerMove(e, p),
    pointerUp: (e, p) => pointerUp(e, p, vertical, mask),
    hover: (e, p) => {
      const vp = e.el('#viewport');
      const h = session ? handleAt(e, p) : undefined;
      vp.style.cursor = h
        ? ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' } as Record<string, string>)[h]
        : session && p.mod
          ? 'move'
          : session && insideSession(e, p.x, p.y)
            ? session.data.orientation === 'vertical' ? 'vertical-text' : 'text'
            : pathCursor(e, p) ?? (vertical ? 'vertical-text' : 'text');
    },
    keyDown: (e, ev) => {
      if (!session) return false;
      const used = handleKey(e, ev, false);
      const mod = isMac ? ev.metaKey : ev.ctrlKey;
      focusInput(e);
      // Bare keys never reach tool shortcuts while editing.
      return used || (!mod && !ev.altKey);
    },
    overlay,
  });
  registerTool(
    make('type', 'Horizontal Type Tool', 'type', false, false),
    make('type-vertical', 'Vertical Type Tool', 'type-vertical', true, false),
    make('type-mask', 'Horizontal Type Mask Tool', 'type-mask', false, true),
    make('type-mask-vertical', 'Vertical Type Mask Tool', 'type-mask-vertical', true, true),
  );
  registerCommand(
    { id: 'type.commit', label: 'Commit Text', hidden: true, recordable: false, run: (e) => commit(e) },
    { id: 'type.cancel', label: 'Cancel Text Editing', hidden: true, recordable: false, run: (e) => cancel(e) },
  );
  void e;
}
