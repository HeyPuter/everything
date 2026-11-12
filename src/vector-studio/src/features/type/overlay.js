/**
 * Type overlays drawn for every tool: in and out ports (a red plus for
 * overset text, an arrow where frames are threaded), thread lines,
 * path-type start brackets, and hidden characters (Type > Show Hidden
 * Characters).
 */
import { layoutText } from '../../model/text-layout.js';
import { multiply } from '../../lib/matrix.js';
import { layerColor } from '../../render/overlay.js';
import { threadOverlay, drawThreadPort } from './threads.js';
import { threadFrames } from './thread-model.js';
import { wrapOverlay } from './wrap.js';

const PORT = 8;

function toScreen(editor, node, x, y) {
  const m = multiply(editor.view.matrix, node.transform);
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function drawPort(ctx, p, color, overflow) {
  const x = Math.round(p.x - PORT / 2) + 0.5;
  const y = Math.round(p.y - PORT / 2) + 0.5;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = overflow ? '#e5242a' : color;
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, PORT, PORT);
  ctx.strokeRect(x, y, PORT, PORT);
  if (overflow) {
    ctx.beginPath();
    ctx.moveTo(x + 2, y + PORT / 2);
    ctx.lineTo(x + PORT - 2, y + PORT / 2);
    ctx.moveTo(x + PORT / 2, y + 2);
    ctx.lineTo(x + PORT / 2, y + PORT - 2);
    ctx.stroke();
  }
}

function portsFor(editor, node) {
  const lay = layoutText(node);
  if (lay.kind === 'area') {
    const b = lay.bounds;
    if (lay.vertical) return { lay, inPort: toScreen(editor, node, b.x + b.w, b.y), outPort: toScreen(editor, node, b.x, b.y + b.h) };
    return { lay, inPort: toScreen(editor, node, b.x, b.y), outPort: toScreen(editor, node, b.x + b.w, b.y + b.h) };
  }
  if (lay.kind === 'path' && lay.path) {
    const start = node.pathOptions?.start || 0;
    const a = lay.path.at(start);
    // A closed path's text ends where it started, one loop on.
    const z = lay.path.at(lay.path.closed ? start + lay.path.length : lay.path.length);
    return { lay, inPort: toScreen(editor, node, a.x, a.y), outPort: toScreen(editor, node, z.x, z.y), path: true };
  }
  return { lay, inPort: null, outPort: null };
}

function drawHidden(ctx, editor, node) {
  const lay = layoutText(node);
  if (lay.vertical || lay.kind === 'path') return;
  const m = multiply(editor.view.matrix, node.transform);
  const dpr = editor.view.dpr;
  ctx.save();
  ctx.setTransform(dpr * m[0], dpr * m[1], dpr * m[2], dpr * m[3], dpr * m[4], dpr * m[5]);
  ctx.fillStyle = '#4f80ff';
  ctx.textBaseline = 'alphabetic';
  const text = lay.text;
  for (let li = 0; li < lay.lines.length; li++) {
    const l = lay.lines[li];
    const size = Math.max(4, l.asc * 0.8);
    ctx.font = `${size}px Inter, system-ui, sans-serif`;
    for (let i = l.start; i < l.end; i++) {
      const x = l.xs[i - l.start];
      const w = l.xs[i - l.start + 1] - x;
      if (text[i] === ' ') ctx.fillRect(x + w / 2 - size * 0.06, l.y - size * 0.3, size * 0.12, size * 0.12);
      else if (text[i] === '\t') ctx.fillText('\u00bb', x + 1, l.y);
      else if (text[i] === '\u2028') ctx.fillText('\u00ac', x + 1, l.y);
      else if (text[i] === '\u00ad') ctx.fillText('-', x - size * 0.15, l.y - size * 0.1);
      else if (text[i] === '\u00a0') ctx.fillText('\u02da', x + w / 2 - size * 0.15, l.y);
    }
    const endX = l.xs[l.end - l.start];
    if (text[l.end] === '\n') ctx.fillText('\u00b6', endX + 1, l.y);
    else if (l.end >= text.length) ctx.fillText('#', endX + 1, l.y);
  }
  ctx.restore();
}

export function typeOverlay() {
  return (ctx, editor) => {
    const { doc } = editor;
    const ids = new Set(editor.selection);
    if (editor.textEdit) for (const f of threadFrames(doc, doc.get(editor.textEdit.id))) ids.add(f.id);
    if (editor.viewOptions.showHidden) {
      for (const n of doc.leaves()) if (n.type === 'text' && !doc.isHidden(n.id)) drawHidden(ctx, editor, n);
    }
    if (!editor.viewOptions.edges) return;
    wrapOverlay(ctx, editor);
    threadOverlay(ctx, editor);
    for (const id of ids) {
      const n = doc.get(id);
      if (!n || n.type !== 'text' || doc.isHidden(id)) continue;
      const { lay, inPort, outPort, path } = portsFor(editor, n);
      const color = layerColor(editor, id);
      if (!path && inPort) {
        drawThreadPort(ctx, inPort, color, n.threadPrev && doc.get(n.threadPrev)?.threadNext === n.id ? 'linked' : 'empty');
        drawThreadPort(ctx, outPort, color, n.threadNext && doc.get(n.threadNext)?.threadPrev === n.id ? 'linked' : lay.overflow ? 'overflow' : 'empty');
        continue;
      }
      if (inPort) {
        if (path) {
          // Start bracket: a short tick across the path.
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(inPort.x, inPort.y, 3, 0, Math.PI * 2);
          ctx.stroke();
        } else drawPort(ctx, inPort, color, false);
      }
      if (outPort) drawPort(ctx, outPort, color, lay.overflow);
    }
  };
}
