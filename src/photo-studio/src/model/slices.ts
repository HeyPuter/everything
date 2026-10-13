import { isDocumentId } from './ids';
import { findLayer, type PhotoDocument, type Rect } from './document';
import { layerBounds } from './artboard';

// Slices divide the canvas into separately exported images. User slices are
// drawn rectangles; layer-based slices follow a layer's bounds; automatic
// slices fill the remaining area. Overlapping user slices are stacked: a
// later slice is on top, and a covered slice keeps only its visible parts.
export type SliceFormat = 'png' | 'jpeg' | 'webp' | 'gif';
export type Slice = {
  id: string;
  name?: string;
  rect: Rect;
  // Layer-based slice: `rect` is recomputed from the layer's bounds.
  layerId?: string;
  format?: SliceFormat;
  // 1-100 for JPEG and WebP; colors (2-256) for GIF.
  quality?: number;
};
export type SliceKind = 'user' | 'layer' | 'auto';
/** One rectangle of the final partition; `slice` is the user or layer slice
 * it belongs to (undefined for automatic slices). */
export type SlicePiece = { rect: Rect; kind: SliceKind; slice?: Slice; number: number };

/** Whole-pixel rectangle clipped to the canvas, or undefined when empty. */
export function clipRect(r: Rect, width: number, height: number): Rect | undefined {
  const x0 = Math.max(0, Math.round(r.x)),
    y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(width, Math.round(r.x + r.width)),
    y1 = Math.min(height, Math.round(r.y + r.height));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

/** Current rectangle of a slice (layer-based slices follow their layer). */
export function sliceRect(doc: Pick<PhotoDocument, 'layers' | 'width' | 'height'>, s: Slice): Rect | undefined {
  if (s.layerId) {
    const l = findLayer(doc.layers, s.layerId);
    const b = l ? layerBounds(l) : undefined;
    if (!b) return;
    return clipRect({ x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.x + b.width) - Math.floor(b.x), height: Math.ceil(b.y + b.height) - Math.floor(b.y) }, doc.width, doc.height);
  }
  return clipRect(s.rect, doc.width, doc.height);
}

/** Partition the canvas into slice pieces in reading order (top to bottom,
 * then left to right). Cut lines run along every slice edge; each grid cell
 * belongs to the topmost slice covering it. Horizontal runs of one owner are
 * merged, then identical runs on consecutive rows, which yields full-width
 * bands above and below a slice like a hand-made table layout. */
export function partitionSlices(doc: Pick<PhotoDocument, 'layers' | 'width' | 'height'>, slices: Slice[] = (doc as PhotoDocument).slices ?? []): SlicePiece[] {
  const W = doc.width,
    H = doc.height;
  const live = slices.map((s) => ({ s, r: sliceRect(doc, s) })).filter((x): x is { s: Slice; r: Rect } => !!x.r);
  const xs = [...new Set([0, W, ...live.flatMap(({ r }) => [r.x, r.x + r.width])])].sort((a, b) => a - b);
  const ys = [...new Set([0, H, ...live.flatMap(({ r }) => [r.y, r.y + r.height])])].sort((a, b) => a - b);
  const cols = xs.length - 1,
    rows = ys.length - 1;
  // Owner of each cell: index into `live`, or -1 for automatic.
  const owner = new Int32Array(cols * rows).fill(-1);
  live.forEach(({ r }, k) => {
    const i0 = xs.indexOf(r.x),
      i1 = xs.indexOf(r.x + r.width);
    const j0 = ys.indexOf(r.y),
      j1 = ys.indexOf(r.y + r.height);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) owner[j * cols + i] = k;
  });
  type Run = { i0: number; i1: number; j0: number; j1: number; owner: number };
  const done: Run[] = [];
  let open: Run[] = [];
  for (let j = 0; j < rows; j++) {
    const runs: Run[] = [];
    for (let i = 0; i < cols; ) {
      const o = owner[j * cols + i];
      let k = i + 1;
      while (k < cols && owner[j * cols + k] === o) k++;
      runs.push({ i0: i, i1: k, j0: j, j1: j + 1, owner: o });
      i = k;
    }
    const next: Run[] = [];
    for (const r of runs) {
      const above = open.find((o) => o.i0 === r.i0 && o.i1 === r.i1 && o.owner === r.owner);
      if (above) {
        above.j1 = j + 1;
        next.push(above);
      } else next.push(r);
    }
    for (const o of open) if (!next.includes(o)) done.push(o);
    open = next;
  }
  done.push(...open);
  const pieces: SlicePiece[] = done.map((r) => {
    const own = r.owner >= 0 ? live[r.owner].s : undefined;
    return {
      rect: { x: xs[r.i0], y: ys[r.j0], width: xs[r.i1] - xs[r.i0], height: ys[r.j1] - ys[r.j0] },
      kind: own ? (own.layerId ? 'layer' : 'user') : 'auto',
      slice: own,
      number: 0,
    };
  });
  pieces.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  pieces.forEach((p, i) => (p.number = i + 1));
  return pieces;
}

/** Topmost user or layer slice at a point. */
export function sliceAt(doc: Pick<PhotoDocument, 'layers' | 'width' | 'height' | 'slices'>, x: number, y: number): Slice | undefined {
  return [...(doc.slices ?? [])].reverse().find((s) => {
    const r = sliceRect(doc, s);
    return !!r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
  });
}

/** File stem for a piece: the slice name, or "<base>_<nn>". Pieces of a user
 * slice split by an overlapping slice get a suffix. */
export function pieceNames(pieces: SlicePiece[], base: string): string[] {
  const counts = new Map<Slice, number>();
  for (const p of pieces) if (p.slice) counts.set(p.slice, (counts.get(p.slice) ?? 0) + 1);
  const seen = new Map<Slice, number>();
  const width = Math.max(2, String(pieces.length).length);
  return pieces.map((p) => {
    const stem = p.slice?.name?.trim() || `${base}_${String(p.number).padStart(width, '0')}`;
    if (!p.slice || counts.get(p.slice)! < 2) return stem;
    const n = (seen.get(p.slice) ?? 0) + 1;
    seen.set(p.slice, n);
    return `${stem}_${String(n).padStart(2, '0')}`;
  });
}

/** Minimal HTML page laying the pieces out as a table with row and column
 * spans along the cut lines. `files[i]` is the image path of piece i. */
export function sliceTableHtml(pieces: SlicePiece[], files: string[], title: string, width: number, height: number): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const xs = [...new Set(pieces.flatMap((p) => [p.rect.x, p.rect.x + p.rect.width]))].sort((a, b) => a - b);
  const ys = [...new Set(pieces.flatMap((p) => [p.rect.y, p.rect.y + p.rect.height]))].sort((a, b) => a - b);
  const start = new Map<string, number>();
  pieces.forEach((p, i) => start.set(`${xs.indexOf(p.rect.x)},${ys.indexOf(p.rect.y)}`, i));
  let rows = '';
  // A spacer row fixes the column widths for every browser's table layout.
  rows += `<tr>${xs.slice(1).map((x, i) => `<td style="width:${x - xs[i]}px;height:0"></td>`).join('')}</tr>\n`;
  for (let j = 0; j < ys.length - 1; j++) {
    let cells = '';
    for (let i = 0; i < xs.length - 1; i++) {
      const k = start.get(`${i},${j}`);
      if (k === undefined) continue;
      const p = pieces[k];
      const colspan = xs.indexOf(p.rect.x + p.rect.width) - i,
        rowspan = ys.indexOf(p.rect.y + p.rect.height) - j;
      cells += `<td${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}><img src="${esc(files[k])}" width="${p.rect.width}" height="${p.rect.height}" alt=""></td>`;
    }
    rows += `<tr>${cells}</tr>\n`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>table{border-collapse:collapse;border-spacing:0}td{padding:0;line-height:0;vertical-align:top}img{display:block;border:0}</style>
</head>
<body>
<table style="width:${width}px;height:${height}px">
${rows}</table>
</body>
</html>
`;
}

export function validateSlices(slices: unknown) {
  if (slices === undefined) return;
  const bad = () => new Error('Invalid slices.');
  if (!Array.isArray(slices) || slices.length > 2000) throw bad();
  const ids = new Set<string>();
  for (const s of slices as Slice[]) {
    const r = s?.rect;
    if (
      !s ||
      !isDocumentId(s.id) ||
      ids.has(s.id) ||
      (s.name !== undefined && (typeof s.name !== 'string' || s.name.length > 256)) ||
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
      r.width < 0 ||
      r.height < 0 ||
      (s.layerId !== undefined && !isDocumentId(s.layerId)) ||
      (s.format !== undefined && !['png', 'jpeg', 'webp', 'gif'].includes(s.format)) ||
      (s.quality !== undefined && !(Number.isFinite(s.quality) && s.quality >= 1 && s.quality <= 256))
    )
      throw bad();
    ids.add(s.id);
  }
}
