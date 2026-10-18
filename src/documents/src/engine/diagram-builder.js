// Insert → Diagram: list, process, cycle, hierarchy, relationship, matrix, pyramid and timeline
// diagrams generated from a text outline as one group of ordinary DrawingML shapes (ECMA-376 Part 1
// §20.4 wpg:wgp with wps:wsp children, preset geometry §20.1.9.18, shape text in wps:txbx).
//
// This is an original approach, not a diagram-definition (dgm) part: every consumer draws the
// result exactly as saved, without a layout engine. The outline that generated the diagram is kept
// as the drawing's alternative text (wp:docPr descr), which also describes it to screen readers; a
// first line names the layout and color set. Editing reads that text back and generates the group again.
import { drawingFrame, xmlEscape, EMU_PER_INCH } from './inserted-drawings.js';

export const DIAGRAM_LAYOUTS = Object.freeze([
  { id: 'blockList', name: 'Block List', category: 'List', hint: 'Items as a grid of blocks' },
  { id: 'verticalList', name: 'Vertical List', category: 'List', hint: 'Stacked bars with their details' },
  { id: 'basicProcess', name: 'Basic Process', category: 'Process', hint: 'Steps joined by arrows' },
  { id: 'chevronProcess', name: 'Chevron Process', category: 'Process', hint: 'Steps as a row of chevrons' },
  { id: 'timeline', name: 'Timeline', category: 'Process', hint: 'Milestones along a line' },
  { id: 'basicCycle', name: 'Basic Cycle', category: 'Cycle', hint: 'Stages around a circle' },
  { id: 'orgChart', name: 'Organization Chart', category: 'Hierarchy', hint: 'A top item with the items under it' },
  { id: 'venn', name: 'Basic Venn', category: 'Relationship', hint: 'Overlapping circles' },
  { id: 'balance', name: 'Radial', category: 'Relationship', hint: 'A center idea with ideas around it' },
  { id: 'matrix', name: 'Basic Matrix', category: 'Matrix', hint: 'Four quadrants' },
  { id: 'pyramid', name: 'Basic Pyramid', category: 'Pyramid', hint: 'Levels from the base up' },
]);
export const DIAGRAM_COLORS = Object.freeze([
  { id: 'blue', name: 'Blue', fills: ['2F5597'], text: 'FFFFFF', light: 'DEEAF6', lightText: '1F3864', line: 'FFFFFF' },
  { id: 'teal', name: 'Teal', fills: ['1E6E6A'], text: 'FFFFFF', light: 'D9F0EF', lightText: '0F3735', line: 'FFFFFF' },
  { id: 'orange', name: 'Orange', fills: ['C55A11'], text: 'FFFFFF', light: 'FBE4D5', lightText: '833C0B', line: 'FFFFFF' },
  { id: 'gray', name: 'Gray', fills: ['595959'], text: 'FFFFFF', light: 'EDEDED', lightText: '262626', line: 'FFFFFF' },
  { id: 'colorful', name: 'Colorful', fills: ['2F5597', 'C55A11', '548235', '7030A0', 'BF9000', '1E6E6A'], text: 'FFFFFF', light: 'F2F2F2', lightText: '262626', line: 'FFFFFF' },
]);
export const DEFAULT_OUTLINE = 'Plan\n  Goals\n  Budget\nBuild\n  Prototype\nReview\nLaunch';

/** An outline in text: one item per line, indented (spaces, tabs or leading - * •) for sub-items. */
export function parseOutline(text) {
  const root = { text: '', children: [] }, stack = [{ depth: -1, node: root }];
  // A pasted line break (vertical tab) or form feed also starts a new item.
  for (const raw of String(text || '').split(/\r\n|[\n\r\v\f]/)) {
    if (!raw.trim()) continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length;
    // A typed bullet is "•", or "-" or "*" followed by a space: "-5% churn" is text, not a bullet.
    const bullet = raw.trim().match(/^(?:•\s*|[-*]\s+)/)?.[0].length || 0;
    const depth = Math.floor(indent / 2) + (bullet && !indent ? 0 : 0);
    const node = { text: raw.trim().slice(bullet).trim(), children: [] };
    if (!node.text) continue;
    while (stack.at(-1).depth >= depth) stack.pop();
    stack.at(-1).node.children.push(node);
    stack.push({ depth, node });
  }
  return root.children;
}
/** The outline text for items (two spaces per level). */
export function outlineText(items, depth = 0) {
  return items.map(item => `${'  '.repeat(depth)}${item.text}${item.children.length ? `\n${outlineText(item.children, depth + 1)}` : ''}`).join('\n');
}

const toEmu = inches => Math.round(inches * EMU_PER_INCH);
/** Font size (pt) that lets `text` fit a box w×h (EMU) on a few lines. */
function fitSize(text, w, h, max = 18, min = 8) {
  const longest = Math.max(4, ...String(text).split(/\s+/).map(word => word.length)), chars = Math.max(4, String(text).length);
  const width = w / EMU_PER_INCH * 72, height = h / EMU_PER_INCH * 72;
  let size = max;
  while (size > min) {
    const perLine = Math.max(1, Math.floor((width - 10) / (size * 0.55)));
    const lines = Math.ceil(chars / perLine);
    if (longest * size * 0.55 <= width - 10 && lines * size * 1.25 <= height - 6) break;
    size -= 1;
  }
  return size;
}

/** Shape boxes for a layout: [{ x, y, w, h, preset, role: 'node'|'accent'|'connector', text, level, index, rotation, adj }]. */
export function diagramShapes(layoutId, items, { width = toEmu(6), height = toEmu(3.5) } = {}) {
  const top = items.length ? items : [{ text: ' ', children: [] }];
  const n = top.length, shapes = [], gap = toEmu(0.12);
  const node = (x, y, w, h, preset, text, extra = {}) => shapes.push({ x, y, w, h, preset, role: 'node', text, level: 0, ...extra });
  const label = item => item.children.length ? `${item.text}\n${item.children.map(c => `• ${c.text}`).join('\n')}` : item.text;
  switch (layoutId) {
    case 'verticalList': {
      const h = (height - gap * (n - 1)) / n;
      top.forEach((item, i) => {
        node(0, i * (h + gap), width * 0.32, h, 'roundRect', item.text, { index: i });
        if (item.children.length) shapes.push({ x: width * 0.32 + gap, y: i * (h + gap) + h * 0.08, w: width * 0.68 - gap, h: h * 0.84, preset: 'rect', role: 'detail', text: item.children.map(c => `• ${c.text}`).join('\n'), index: i });
      });
      break;
    }
    case 'basicProcess': {
      const arrow = Math.min(toEmu(0.45), width / (n * 4)), w = (width - arrow * (n - 1) - gap * 2 * (n - 1)) / n, h = Math.min(height, w * 0.75), y = (height - h) / 2;
      top.forEach((item, i) => {
        const x = i * (w + arrow + gap * 2);
        node(x, y, w, h, 'roundRect', label(item), { index: i });
        if (i < n - 1) shapes.push({ x: x + w + gap, y: height / 2 - arrow * 0.6, w: arrow, h: arrow * 1.2, preset: 'rightArrow', role: 'accent', index: i });
      });
      break;
    }
    case 'chevronProcess': {
      const overlap = Math.min(height * 0.18, width / n * 0.18), w = (width + overlap * (n - 1)) / n, h = Math.min(height * 0.5, w * 0.55), y = (height - h) / 2;
      top.forEach((item, i) => node(i * (w - overlap) + (i ? gap / 2 : 0), y, w - (i ? gap / 2 : 0), h, i ? 'chevron' : 'homePlate', item.text, { index: i }));
      top.forEach((item, i) => { if (item.children.length) shapes.push({ x: i * (w - overlap), y: y + h + gap, w: w - overlap, h: height - y - h - gap, preset: 'rect', role: 'detail', text: item.children.map(c => `• ${c.text}`).join('\n'), index: i }); });
      break;
    }
    case 'timeline': {
      const line = toEmu(0.06), mid = height / 2, step = width / n, dot = Math.min(toEmu(0.28), step * 0.4);
      shapes.push({ x: 0, y: mid - line / 2, w: width, h: line, preset: 'rect', role: 'accent', index: 0 });
      top.forEach((item, i) => {
        const cx = step * (i + 0.5);
        shapes.push({ x: cx - dot / 2, y: mid - dot / 2, w: dot, h: dot, preset: 'ellipse', role: 'node', index: i, text: '' });
        const boxH = mid - dot / 2 - gap * 2, above = i % 2 === 0;
        shapes.push({ x: cx - step * 0.48, y: above ? 0 : mid + dot / 2 + gap * 2, w: step * 0.96, h: boxH, preset: 'rect', role: 'detail', text: label(item), index: i, align: above ? 'b' : 't' });
      });
      break;
    }
    case 'basicCycle': {
      const size = Math.min(width, height), r = size * 0.34, d = Math.min(size * 0.28, 2 * Math.PI * r / n * 0.62), cx = width / 2, cy = height / 2;
      top.forEach((item, i) => {
        const a = -Math.PI / 2 + i * 2 * Math.PI / n;
        node(cx + r * Math.cos(a) - d / 2, cy + r * Math.sin(a) - d / 2, d, d, 'ellipse', item.text, { index: i });
        // A small arrow halfway to the next stage, turned along the circle.
        const b = a + Math.PI / n, s = Math.min(d * 0.45, toEmu(0.4));
        if (n > 1) shapes.push({ x: cx + r * Math.cos(b) - s / 2, y: cy + r * Math.sin(b) - s * 0.35, w: s, h: s * 0.7, preset: 'rightArrow', role: 'accent', rotation: Math.round(((b + Math.PI / 2) * 180 / Math.PI % 360 + 360) % 360 * 60000), index: i });
      });
      break;
    }
    case 'orgChart': {
      const root = top[0], kids = [...root.children, ...top.slice(1).map(item => ({ ...item }))], levels = kids.some(k => k.children.length) ? 3 : 2;
      const rowH = (height - gap * 2 * (levels - 1)) / levels, bar = toEmu(0.03), boxH = rowH * 0.8;
      const rootW = Math.min(width * 0.32, toEmu(2));
      node((width - rootW) / 2, 0, rootW, boxH, 'roundRect', root.text, { index: 0 });
      if (!kids.length) break;
      const colW = width / kids.length, kidW = Math.min(colW - gap * 2, toEmu(1.8)), y1 = rowH + gap * 2;
      const busY = boxH + (y1 - boxH) / 2;
      shapes.push({ x: width / 2 - bar / 2, y: boxH, w: bar, h: busY - boxH, preset: 'rect', role: 'connector' });
      if (kids.length > 1) shapes.push({ x: colW / 2, y: busY - bar / 2, w: width - colW, h: bar, preset: 'rect', role: 'connector' });
      kids.forEach((kid, i) => {
        const cx = colW * (i + 0.5);
        shapes.push({ x: cx - bar / 2, y: busY, w: bar, h: y1 - busY, preset: 'rect', role: 'connector' });
        node(cx - kidW / 2, y1, kidW, boxH, 'roundRect', kid.text, { index: i + 1, level: 1 });
        if (levels === 3 && kid.children.length) {
          const y2 = y1 + rowH + gap * 2, m = kid.children.length, subH = Math.min(boxH, (height - y2 - gap * (m - 1)) / m);
          shapes.push({ x: cx - kidW / 2 + toEmu(0.1), y: y1 + boxH, w: bar, h: y2 - y1 - boxH + subH * (m - 0.5) + gap * (m - 1), preset: 'rect', role: 'connector' });
          kid.children.forEach((sub, j) => {
            const y = y2 + j * (subH + gap);
            shapes.push({ x: cx - kidW / 2 + toEmu(0.1), y: y + subH / 2 - bar / 2, w: toEmu(0.15), h: bar, preset: 'rect', role: 'connector' });
            shapes.push({ x: cx - kidW / 2 + toEmu(0.25), y, w: kidW - toEmu(0.25), h: subH, preset: 'rect', role: 'detail', text: sub.text, index: i + 1, level: 2 });
          });
        }
      });
      break;
    }
    case 'venn': {
      const count = Math.min(n, 4), d = Math.min(height * 0.78, width / (1 + 0.62 * (count - 1)));
      const total = d * (1 + 0.62 * (count - 1)), x0 = (width - total) / 2;
      top.slice(0, count).forEach((item, i) => node(x0 + i * d * 0.62, (height - d) / 2 + (count > 2 && i % 2 ? d * 0.12 : 0), d, d, 'ellipse', item.text, { index: i, alpha: 0.62 }));
      break;
    }
    case 'balance': {
      const size = Math.min(width, height), center = size * 0.3, cx = width / 2, cy = height / 2, outer = Math.min(size * 0.26, toEmu(1.3)), r = size * 0.37;
      const [hub, ...spokes] = top.length > 1 ? top : [top[0], ...top[0].children];
      node(cx - center / 2, cy - center / 2, center, center, 'ellipse', hub.text, { index: 0 });
      spokes.forEach((item, i) => {
        const a = -Math.PI / 2 + i * 2 * Math.PI / spokes.length;
        node(cx + r * Math.cos(a) - outer / 2, cy + r * Math.sin(a) - outer / 2, outer, outer, 'ellipse', item.text, { index: i + 1, level: 1 });
      });
      break;
    }
    case 'matrix': {
      const size = Math.min(width, height), cell = (size - gap) / 2, x0 = (width - size) / 2;
      top.slice(0, 4).forEach((item, i) => node(x0 + (i % 2) * (cell + gap), Math.floor(i / 2) * (cell + gap), cell, cell, i % 3 ? 'roundRect' : 'rect', label(item), { index: i }));
      break;
    }
    case 'pyramid': {
      const h = (height - gap * (n - 1)) / n, base = Math.min(width, height * 1.4), slope = base / 2 / height;
      top.forEach((item, i) => {
        // Each level is a band of the same triangle: its bottom width grows with its depth.
        const y = i * (h + gap), w = 2 * (y + h) * slope, x = (width - w) / 2;
        if (i === 0) node(x, y, w, h, 'triangle', item.text, { index: i });
        else node(x, y, w, h, 'trapezoid', item.text, { index: i, adj: Math.round(h * slope / Math.min(w, h) * 100000) });
      });
      break;
    }
    default: { // blockList
      const columns = Math.min(n, n <= 4 ? n : Math.ceil(Math.sqrt(n * width / height))), rowsCount = Math.ceil(n / columns);
      const w = (width - gap * (columns - 1)) / columns, h = Math.min((height - gap * (rowsCount - 1)) / rowsCount, w * 0.7);
      const y0 = (height - (h * rowsCount + gap * (rowsCount - 1))) / 2;
      top.forEach((item, i) => node((i % columns) * (w + gap), y0 + Math.floor(i / columns) * (h + gap), w, h, 'roundRect', label(item), { index: i }));
    }
  }
  return shapes.map(s => ({ ...s, x: Math.round(s.x), y: Math.round(s.y), w: Math.max(1, Math.round(s.w)), h: Math.max(1, Math.round(s.h)) }));
}

const paragraphs = (text, color, size, align = 'center') => String(text || '').split('\n').map(line => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="${line.startsWith('•') ? 'left' : align}"/></w:pPr>${line ? `<w:r><w:rPr><w:color w:val="${color}"/><w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>` : ''}</w:p>`).join('');

/** The group XML (`a:graphic`) of a diagram. */
export function diagramGraphic(layoutId, items, { width, height, colors = 'blue' } = {}) {
  const palette = DIAGRAM_COLORS.find(c => c.id === colors) || DIAGRAM_COLORS[0];
  const shapes = diagramShapes(layoutId, items, { width, height });
  const body = shapes.map((s, i) => {
    const fill = s.role === 'connector' ? '7F7F7F' : s.role === 'detail' ? palette.light : s.role === 'accent' ? (palette.fills.length > 1 ? 'A6A6A6' : palette.light) : palette.fills[(s.index || 0) % palette.fills.length];
    const textColor = s.role === 'detail' ? palette.lightText : palette.text;
    const alpha = s.alpha ? `<a:alpha val="${Math.round(s.alpha * 100000)}"/>` : '';
    const line = s.role === 'node' && s.preset !== 'ellipse' || s.alpha ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${palette.line}"/></a:solidFill></a:ln>` : '<a:ln><a:noFill/></a:ln>';
    const xfrm = `<a:xfrm${s.rotation ? ` rot="${s.rotation}"` : ''}${s.flipV ? ' flipV="1"' : ''}><a:off x="${s.x}" y="${s.y}"/><a:ext cx="${s.w}" cy="${s.h}"/></a:xfrm>`;
    const geometry = `<a:prstGeom prst="${s.preset}"><a:avLst>${s.adj !== undefined ? `<a:gd name="adj" fmla="val ${s.adj}"/>` : ''}</a:avLst></a:prstGeom>`;
    const text = s.text && s.text.trim() ? paragraphs(s.text, textColor, fitSize(s.text, s.w * (s.preset === 'ellipse' ? 0.72 : s.preset === 'triangle' ? 0.5 : 1), s.h * (s.preset === 'triangle' ? 0.5 : 1), s.role === 'detail' ? 12 : 18)) : '';
    const anchor = s.align || (s.role === 'detail' && s.text?.includes('•') ? 't' : 'ctr');
    const bodyPr = `<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="45720" tIns="45720" rIns="45720" bIns="45720" anchor="${s.preset === 'triangle' ? 'b' : anchor}" anchorCtr="0"><a:noAutofit/></wps:bodyPr>`;
    return `<wps:wsp><wps:cNvPr id="${i + 1}" name="${s.role} ${i + 1}"/><wps:cNvSpPr/><wps:spPr>${xfrm}${geometry}<a:solidFill><a:srgbClr val="${fill}">${alpha}</a:srgbClr></a:solidFill>${line}</wps:spPr>`
      + `${text ? `<wps:txbx><w:txbxContent>${text}</w:txbxContent></wps:txbx>` : ''}${text ? bodyPr : '<wps:bodyPr/>'}</wps:wsp>`;
  }).join('');
  return `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/><a:chOff x="0" y="0"/><a:chExt cx="${width}" cy="${height}"/></a:xfrm></wpg:grpSpPr>${body}</wpg:wgp></a:graphicData></a:graphic>`;
}

/** The alternative text that describes a diagram and lets it be generated again. */
export function diagramDescription(layoutId, items, colors = 'blue') {
  const layout = DIAGRAM_LAYOUTS.find(l => l.id === layoutId) || DIAGRAM_LAYOUTS[0], palette = DIAGRAM_COLORS.find(c => c.id === colors) || DIAGRAM_COLORS[0];
  return `Diagram: ${layout.name} (${palette.name})\n${outlineText(items)}`;
}
/** Read a description written by diagramDescription; null for other alternative text. */
export function parseDiagramDescription(text) {
  const match = /^Diagram: (.+?) \((.+?)\)\n([\s\S]*)$/.exec(String(text || ''));
  if (!match) return null;
  const layout = DIAGRAM_LAYOUTS.find(l => l.name === match[1]), colors = DIAGRAM_COLORS.find(c => c.name === match[2]);
  return layout ? { layout: layout.id, colors: colors?.id || 'blue', items: parseOutline(match[3]), outline: match[3] } : null;
}

/** The whole `w:drawing` of a diagram, inline, at the given drawing id. Size in EMU. */
export function diagramDrawingXml({ layout, items, colors = 'blue', id, width = toEmu(6), height = toEmu(3.25), anchor = null }) {
  // The outline is kept as the diagram's alt text, which is how Edit Diagram reads it back; alt text holds 2,000 characters.
  const descr = diagramDescription(layout, items, colors);
  if (descr.length > 2000) throw new Error(`This diagram has too much text: it can hold about ${2000 - descr.length + outlineText(items).length} characters of items. Shorten or remove some items.`);
  return drawingFrame({ id, name: `Diagram ${id}`, descr, width, height, anchor, graphic: diagramGraphic(layout, items, { width, height, colors }) });
}
