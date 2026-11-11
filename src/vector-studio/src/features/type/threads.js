/**
 * Threaded text: Type > Threaded Text commands, the in and out ports of
 * area type (clicking an out port with a selection tool loads the cursor
 * with the overflow; the next click or drag makes a linked frame, or a
 * click on area type or a closed path threads into it), thread lines
 * (View > Show Text Threads) and the layout hook that finds a frame's
 * thread in its document.
 */
import { Tool, tol } from '../../tools/tool.js';
import { hitTest } from '../../render/hit.js';
import { createText } from '../../model/nodes.js';
import { layoutText, textHooks } from '../../model/text-layout.js';
import { pathBounds } from '../../model/bezier.js';
import { multiply } from '../../lib/matrix.js';
import { isThreaded, threadFrames, headOf, linkFrames, insertFrame, releaseFrames, removeThreading, prepareFrameRemoval, copiedThreads, relinkPasted } from './thread-model.js';
import { clipboardHooks } from '../../ops/clipboard.js';
import { session } from './type-ops.js';

const PORT = 8;

const svgCursor = (body, hx, hy, fallback) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
};
const line = (d) => `<path d="${d}" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#000" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"/>`;
/** Loaded-text cursor: a pointer carrying a few lines of text. */
const LOADED = svgCursor(`${line('M4 3 v14 l4 -4 h6 z')}${line('M15 15 h9 M15 19 h9 M15 23 h6')}`, 4, 3, 'copy');
/** Over a port: a pointer with a small chain link. */
const OVER_PORT = svgCursor(`${line('M4 3 v14 l4 -4 h6 z')}${line('M15 20 a3 3 0 0 1 3 -3 h2 a3 3 0 0 1 0 6 M24 20 a3 3 0 0 1 -3 3 h-2 a3 3 0 0 1 0 -6')}`, 4, 3, 'pointer');

/** The document holding a node (the active one first; an exact object match wins). */
export function docForNode(app, node) {
  if (!node) return null;
  for (const ed of app.editors || []) if (ed.doc.nodes.get(node.id) === node) return ed.doc;
  if (app.editor?.doc.has(node.id)) return app.editor.doc;
  for (const ed of app.editors || []) if (ed.doc.has(node.id)) return ed.doc;
  return null;
}

/** Screen-space in/out port centers of an area type frame. */
export function framePorts(editor, node) {
  const lay = layoutText(node);
  if (lay.kind !== 'area') return null;
  const b = lay.bounds;
  const m = multiply(editor.view.matrix, node.transform);
  const sc = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  if (lay.vertical) return { lay, inPort: sc(b.x + b.w, b.y), outPort: sc(b.x, b.y + b.h) };
  return { lay, inPort: sc(b.x, b.y), outPort: sc(b.x + b.w, b.y + b.h) };
}

/** A port of a selected area type frame under a screen point: { node, side }. */
export function portAt(editor, sx, sy) {
  if (!editor || !editor.viewOptions.edges) return null;
  for (const id of editor.selection) {
    const n = editor.doc.get(id);
    if (!n || n.type !== 'text' || n.kind !== 'area' || editor.doc.isLocked(id) || editor.doc.isHidden(id)) continue;
    const p = framePorts(editor, n);
    if (!p) continue;
    if (Math.abs(p.outPort.x - sx) <= PORT / 2 + 2 && Math.abs(p.outPort.y - sy) <= PORT / 2 + 2) return { node: n, side: 'out' };
    if (Math.abs(p.inPort.x - sx) <= PORT / 2 + 2 && Math.abs(p.inPort.y - sy) <= PORT / 2 + 2) return { node: n, side: 'in' };
  }
  return null;
}

/** Turn a closed path into an empty area type frame styled like `like` (in its place); returns the new id. */
function frameFromPath(doc, path, like) {
  const b = pathBounds(path.anchors, true);
  const rect = path.anchors.length === 4 && path.anchors.every((p) => p.ix === p.x && p.iy === p.y && p.ox === p.x && p.oy === p.y) && new Set(path.anchors.map((p) => Math.round(p.x * 1000))).size === 2;
  const n = createText('', b.x, b.y, {
    kind: 'area',
    width: b.w,
    height: b.h,
    char: { ...(like?.char || {}) },
    para: { ...(like?.para || {}) },
    fill: like?.fill ?? { type: 'solid', color: '#000000' },
    stroke: like?.stroke ?? null,
    strokeWidth: like?.strokeWidth ?? 1,
    vertical: like?.vertical || undefined,
    ...(rect || like?.vertical ? {} : { areaPath: path.anchors }),
  });
  const parent = doc.get(path.parent);
  doc.insert(n, parent.id, parent.children.indexOf(path.id) + 1);
  doc.remove(path.id);
  return n.id;
}

const threadable = (n) => n && n.type === 'text' && n.kind === 'area';
const closedPath = (n) => n && n.type === 'path' && n.closed && n.anchors.length > 2;

/** Type > Threaded Text > Create: thread the selected area type and closed paths, back to front. */
function createThread(app) {
  const ed = app.editor;
  const { doc } = ed;
  const nodes = ed.topSelection().map((id) => doc.get(id)).filter((n) => threadable(n) || closedPath(n));
  const like = nodes.find(threadable);
  if (!like || nodes.length < 2) {
    app.notify('Select area type and at least one more area type object or closed path.');
    return;
  }
  doc.transact('Thread Text', () => {
    const ids = nodes.map((n) => (closedPath(n) ? frameFromPath(doc, n, headOf(doc, like)) : n.id));
    linkFrames(doc, ids.map((id) => doc.get(id)));
    ed.select(ids);
  });
}

function selectedThreaded(app) {
  const ed = app.editor;
  return ed ? ed.topSelection().map((id) => ed.doc.get(id)).filter(isThreaded) : [];
}

/** The tool a port click switches to: the cursor carries the story until the next click. */
export class ThreadTool extends Tool {
  static id = 'thread-link';
  static label = 'Thread Text';
  static icon = 'tool-area-type';
  static hint = 'Click or drag to make a linked frame | Click area type or a closed path to thread into it | Esc to cancel';

  constructor(app) {
    super(app);
    this.load = null;
    this.drag = null;
    this.pointer = null;
  }

  /** Start threading from a frame's port. */
  start(node, side, prevTool) {
    this.load = { id: node.id, side, prevTool: prevTool || 'selection' };
  }

  activate() {
    this.setCursor(LOADED);
    this.status();
  }

  deactivate() {
    this.drag = null;
    this.pointer = null;
  }

  cancel() {
    this.drag = null;
    this.overlay();
  }

  finish(selectId = null) {
    const prev = this.load?.prevTool || 'selection';
    const id = selectId;
    this.load = null;
    this.drag = null;
    this.app.setTool(prev);
    if (id && this.editor?.doc.has(id)) this.editor.select([id]);
  }

  source() {
    const n = this.load && this.editor?.doc.get(this.load.id);
    return n && n.type === 'text' ? n : null;
  }

  targetAt(e) {
    const ed = this.editor;
    const src = this.source();
    const frames = src ? new Set(threadFrames(ed.doc, src).map((f) => f.id)) : new Set();
    const hit = hitTest(ed.doc, e.x, e.y, tol(ed, 3), { filter: (n) => !frames.has(n.id) && (threadable(n) || closedPath(n)) });
    return hit && !frames.has(hit.id) && (threadable(hit) || closedPath(hit)) ? hit : null;
  }

  onHover(e) {
    this.pointer = e;
    this.setCursor(this.targetAt(e) ? OVER_PORT : LOADED);
    this.overlay();
  }

  onPointerDown(e) {
    const src = this.source();
    if (!src) return this.finish();
    const port = portAt(this.editor, e.sx, e.sy);
    if (port && port.node.id === src.id) {
      // Clicking the loaded port again puts the text back.
      this.finish(src.id);
      return;
    }
    this.drag = { x0: e.x, y0: e.y, x: e.x, y: e.y, sx0: e.sx, sy0: e.sy, moved: false, target: this.targetAt(e) };
  }

  onDoubleClick(e) {
    // Double-clicking a linked port breaks the thread there.
    const src = this.source();
    const port = portAt(this.editor, e.sx, e.sy);
    if (src && port && port.node.id === src.id) {
      const { doc } = this.editor;
      const frames = threadFrames(doc, src);
      const at = frames.findIndex((f) => f.id === src.id);
      const cut = port.side === 'out' ? at + 1 : at;
      if (cut > 0 && cut < frames.length) {
        doc.transact('Break Thread', () => {
          removeThreading(doc, [src.id]);
          const a = frames.slice(0, cut).map((f) => doc.get(f.id));
          const b = frames.slice(cut).map((f) => doc.get(f.id));
          if (a.length > 1) linkFrames(doc, a);
          if (b.length > 1) linkFrames(doc, b);
        });
      }
      this.finish(src.id);
      return;
    }
    this.onPointerDown(e);
  }

  onPointerMove(e) {
    this.pointer = e;
    const d = this.drag;
    if (!d) return;
    d.x = e.x;
    d.y = e.y;
    if (Math.hypot(e.sx - d.sx0, e.sy - d.sy0) > 4) d.moved = true;
    this.overlay();
  }

  onPointerUp() {
    const d = this.drag;
    this.drag = null;
    const src = this.source();
    if (!d || !src) return this.finish();
    const ed = this.editor;
    const { doc } = ed;
    const before = this.load.side === 'in';
    let newId = null;
    if (!d.moved && d.target) {
      doc.transact('Thread Text', () => {
        newId = closedPath(d.target) ? frameFromPath(doc, d.target, headOf(doc, src)) : d.target.id;
        insertFrame(doc, src.id, newId, { before });
      });
    } else {
      const head = headOf(doc, src);
      const b = layoutText(src).bounds;
      let x = d.x0;
      let y = d.y0;
      let w = b.w;
      let h = b.h;
      if (d.moved) {
        x = Math.min(d.x0, d.x);
        y = Math.min(d.y0, d.y);
        w = Math.abs(d.x - d.x0);
        h = Math.abs(d.y - d.y0);
        if (w < 2 || h < 2) return this.finish(src.id);
      }
      if (!ed.canDrawInTarget()) {
        this.app.notify('The target layer is locked or hidden.');
        return this.finish(src.id);
      }
      const frame = createText('', x, y, {
        kind: 'area',
        width: w,
        height: h,
        char: { ...(head.char || {}) },
        para: { ...(head.para || {}) },
        fill: head.fill,
        stroke: head.stroke,
        strokeWidth: head.strokeWidth,
        vertical: head.vertical || undefined,
        areaOptions: src.areaOptions ? { ...src.areaOptions } : undefined,
      });
      doc.transact('Thread Text', () => {
        const parent = doc.get(src.parent);
        doc.insert(frame, parent.id, parent.children.indexOf(src.id) + 1);
        insertFrame(doc, src.id, frame.id, { before });
      });
      newId = frame.id;
    }
    this.finish(newId);
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      this.finish(this.load?.id);
      return true;
    }
    return false;
  }

  drawOverlay(ctx, editor) {
    const src = this.source();
    if (!src) return;
    const ports = framePorts(editor, src);
    const d = this.drag;
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.lineWidth = 1;
    if (d?.moved) {
      const a = editor.view.toScreen(d.x0, d.y0);
      const b = editor.view.toScreen(d.x, d.y);
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(Math.round(Math.min(a.x, b.x)) + 0.5, Math.round(Math.min(a.y, b.y)) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    const p = this.pointer;
    if (ports && p) {
      const from = this.load.side === 'in' ? ports.inPort : ports.outPort;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(p.sx, p.sy);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Selection tools: a click on a port of selected area type starts threading. */
function wrapSelectionTool(app, T) {
  if (!T || T.prototype.__threadPorts) return;
  const P = T.prototype;
  P.__threadPorts = true;
  const down = P.onPointerDown;
  const hover = P.onHover;
  P.onPointerDown = function onPointerDown(e) {
    const port = !e.shift && !e.alt ? portAt(this.editor, e.sx, e.sy) : null;
    if (port) {
      const t = this.app.getTool('thread-link');
      t.start(port.node, port.side, this.app.toolId);
      this.app.setTool('thread-link');
      return;
    }
    return down.call(this, e);
  };
  P.onHover = function onHover(e) {
    if (portAt(this.editor, e.sx, e.sy)) {
      this.setCursor(OVER_PORT);
      return;
    }
    return hover.call(this, e);
  };
}

/** Draw ports (with thread arrows) and thread lines for the selected frames. */
export function threadOverlay(ctx, editor) {
  if (!editor.viewOptions.textThreads) return;
  const { doc } = editor;
  const done = new Set();
  for (const id of editor.selection) {
    const n = doc.get(id);
    if (!isThreaded(n)) continue;
    const frames = threadFrames(doc, n);
    if (done.has(frames[0].id)) continue;
    done.add(frames[0].id);
    ctx.save();
    ctx.strokeStyle = '#4f80ff';
    ctx.lineWidth = 1;
    for (let i = 0; i + 1 < frames.length; i++) {
      if (doc.isHidden(frames[i].id) || doc.isHidden(frames[i + 1].id)) continue;
      const a = framePorts(editor, frames[i]);
      const b = framePorts(editor, frames[i + 1]);
      if (!a || !b) continue;
      ctx.beginPath();
      ctx.moveTo(a.outPort.x, a.outPort.y);
      ctx.lineTo(b.inPort.x, b.inPort.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** A port marker: empty, threaded (a small arrow) or overflowing (a red plus). */
export function drawThreadPort(ctx, p, color, state) {
  const x = Math.round(p.x - PORT / 2) + 0.5;
  const y = Math.round(p.y - PORT / 2) + 0.5;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = state === 'overflow' ? '#e5242a' : color;
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, PORT, PORT);
  ctx.strokeRect(x, y, PORT, PORT);
  if (state === 'overflow') {
    ctx.beginPath();
    ctx.moveTo(x + 2, y + PORT / 2);
    ctx.lineTo(x + PORT - 2, y + PORT / 2);
    ctx.moveTo(x + PORT / 2, y + 2);
    ctx.lineTo(x + PORT / 2, y + PORT - 2);
    ctx.stroke();
  } else if (state === 'linked') {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 1.5);
    ctx.lineTo(x + PORT - 1.5, y + PORT / 2);
    ctx.lineTo(x + 2, y + PORT - 1.5);
    ctx.closePath();
    ctx.fill();
  }
}

/** Links of frames being cut, worked out before the cut unthreads them (see edit.cut below). */
let cutThreads = null;

/** Copies of threaded frames stay linked to each other: copy works out the links, paste points them at the copies. */
const threadClipboardHook = {
  copy(doc, ids, data) {
    const links = cutThreads || copiedThreads(doc, ids);
    if (!links.size) return;
    for (const item of data.items) item.nodes = item.nodes.map((n) => (links.has(n.id) ? { ...n, ...links.get(n.id) } : n));
  },
  placed: (doc, idMap) => relinkPasted(doc, idMap),
};

export function installThreads(app) {
  if (!clipboardHooks.includes(threadClipboardHook)) clipboardHooks.push(threadClipboardHook);
  textHooks.story = (node) => {
    const doc = docForNode(app, node);
    if (!doc) return null;
    const frames = threadFrames(doc, node).filter((f) => f.kind === 'area');
    if (frames.length < 2) return null;
    return frames.map((f) => (f.id === node.id ? node : f));
  };
  app.registerTool(ThreadTool);
  app.on('started', () => {
    wrapSelectionTool(app, app.toolClasses.get('selection'));
    wrapSelectionTool(app, app.toolClasses.get('direct-selection'));
  });

  const c = app.commands;
  const hasEditor = (a) => Boolean(a.editor) && !session(a);
  c.register([
    {
      id: 'type.thread.create',
      label: 'Create',
      enabled: (a) => hasEditor(a) && a.editor.topSelection().length > 1 && a.editor.topSelection().some((id) => threadable(a.editor.doc.get(id))),
      run: createThread,
    },
    {
      id: 'type.thread.release',
      label: 'Release Selection',
      enabled: (a) => hasEditor(a) && selectedThreaded(a).length > 0,
      run: (a) => {
        const ids = selectedThreaded(a).map((n) => n.id);
        a.editor.doc.transact('Release Thread', () => releaseFrames(a.editor.doc, ids));
      },
    },
    {
      id: 'type.thread.remove',
      label: 'Remove Threading',
      enabled: (a) => hasEditor(a) && selectedThreaded(a).length > 0,
      run: (a) => {
        const ids = selectedThreaded(a).map((n) => n.id);
        a.editor.doc.transact('Remove Threading', () => removeThreading(a.editor.doc, ids));
      },
    },
    {
      id: 'view.textThreads',
      label: 'Show Text Threads',
      shortcut: 'Shift+Mod+Y',
      enabled: (a) => Boolean(a.editor),
      checked: (a) => Boolean(a.editor?.viewOptions.textThreads),
      run: (a) => a.editor.setViewOption('textThreads', !a.editor.viewOptions.textThreads),
    },
  ]);

  // Deleting a frame keeps its story: a deleted head hands it to the next frame.
  for (const id of ['edit.clear', 'edit.cut']) {
    const orig = c.get(id);
    if (!orig) continue;
    c.register({
      ...orig,
      run: (a, args) => {
        const ed = a.editor;
        if (!ed || session(a)) return orig.run(a, args);
        const ids = ed.topSelection();
        const touches = ids.some((sid) => isThreaded(ed.doc.get(sid)) || ed.doc.descendants(sid).some(isThreaded));
        if (!touches) return orig.run(a, args);
        return ed.doc.transact(id === 'edit.cut' ? 'Cut' : 'Clear', () => {
          // The copy made by Cut links the cut frames as they were threaded before the removal.
          if (id === 'edit.cut') cutThreads = copiedThreads(ed.doc, ids);
          try {
            prepareFrameRemoval(ed.doc, ids);
            return orig.run(a, args);
          } finally {
            cutThreads = null;
          }
        });
      },
    });
  }
}
