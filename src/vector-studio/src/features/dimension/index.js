/**
 * Dimension feature: the Dimension tool, dimensions as live artwork (see
 * dimension-model.js), their handles (Dimension and Direct Selection
 * tools), the Properties panel section, Dimension Options and the paint
 * hooks that recolor a dimension's lines (stroke) and label (fill).
 */
import { registerLive, virtualId } from '../../model/live.js';
import { DEFAULT_CHAR, DEFAULT_PARA, DEFAULT_STYLE } from '../../model/nodes.js';
import { overlayHooks } from '../../render/overlay.js';
import { selectionDoubleClickHooks } from '../../tools/selection.js';
import { directSelectionHooks } from '../../tools/direct-selection.js';
import { paintHooks } from '../../ops/paint-ops.js';
import { registerIcons } from '../../ui/icons.js';
import { PropertiesPanel } from '../../ui/panels/properties.js';
import { isDimension, dimOptions, layoutIn, attachedNodes, transformDimension, arcAnchors, endMark, isAttached, KIND_LABELS } from './dimension-model.js';
import { DimensionTool, selectedDimensions, drawDimensionHandles, dimensionHandleHook } from './dimension-tool.js';
import { dimensionOptionsDialog, dimensionSection, dimensionToolSection } from './dimension-ui.js';
import './styles.css';

registerIcons({
  'tool-dimension': [
    ['path', { d: 'M3.5 5v14M20.5 5v14' }],
    ['path', { d: 'M3.5 15h17' }],
    ['path', { d: 'M7 12.5 3.5 15 7 17.5M17 12.5l3.5 2.5-3.5 2.5', 'stroke-linejoin': 'round' }],
    ['path', { d: 'M9 9.5h6' }],
  ],
});

/** The drawn points of the last generated artwork per node (transforms detach from them). */
const effectiveCache = new WeakMap();

const solid = (color) => ({ type: 'solid', color });
const pt = (p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });

function pathNode(base, anchors, closed, style) {
  return { id: virtualId(base), type: 'path', name: '', anchors, closed, hidden: false, locked: false, ...DEFAULT_STYLE, ...style };
}

/** The artwork of a dimension: extension and dimension lines, end marks and the label. */
export function dimensionArtwork(node, lay) {
  const o = dimOptions(node.dim);
  const items = [];
  const line = { fill: null, stroke: solid(o.lineColor), strokeWidth: o.lineWidth, strokeCap: 'butt', strokeJoin: 'miter' };
  for (const [a, b] of lay.segments) items.push(pathNode(node.id, [pt(a), pt(b)], false, line));
  for (const arc of lay.arcs) if (Math.abs(arc.sweep) > 1e-6) items.push(pathNode(node.id, arcAnchors(arc.cx, arc.cy, arc.r, arc.a0, arc.sweep), false, line));
  for (const end of lay.ends) {
    for (const m of endMark(end, o)) {
      const style = m.filled ? { fill: solid(o.lineColor), stroke: null, strokeWidth: 0 } : { ...line, strokeWidth: m.heavy ? Math.max(o.lineWidth * 1.6, o.lineWidth + 0.5) : o.lineWidth, strokeJoin: 'round', strokeCap: m.heavy ? 'butt' : 'round' };
      items.push(pathNode(node.id, m.anchors, m.closed, style));
    }
  }
  const L = lay.label;
  if (L && lay.text) {
    const c = Math.cos(L.angle);
    const s = Math.sin(L.angle);
    items.push({
      id: virtualId(node.id),
      type: 'text',
      name: '',
      kind: 'point',
      text: lay.text,
      // Centered on the label point: the baseline sits a little below it.
      x: 0,
      y: o.fontSize * 0.35,
      width: 0,
      height: 0,
      transform: [c, s, -s, c, L.x, L.y],
      char: { ...DEFAULT_CHAR, fontFamily: o.fontFamily, fontSize: o.fontSize },
      para: { ...DEFAULT_PARA, align: 'center' },
      hidden: false,
      locked: false,
      ...DEFAULT_STYLE,
      fill: solid(o.textColor),
      stroke: null,
      strokeWidth: 0,
    });
  }
  return items;
}

registerLive('dimension', {
  label: (n) => `<${KIND_LABELS[n.kind] || ''} Dimension>`.replace('< ', '<'),
  test: isDimension,
  deps: (doc, node) => attachedNodes(doc, node),
  generate(doc, node) {
    const lay = layoutIn(doc, node);
    effectiveCache.set(node, lay.effective);
    return { items: dimensionArtwork(node, lay) };
  },
  transformParams: (node, m, opts) => transformDimension(node, m, isAttached(node) ? effectiveCache.get(node) : null, opts),
});

// ---- paint: stroke recolors the lines, fill the label ----

function installDimensionPaint() {
  const prevApply = paintHooks.applyStyle;
  const prevCommon = paintHooks.commonStyle;
  paintHooks.applyStyle = (editor, patch, label, coalesce) => {
    if (prevApply?.(editor, patch, label, coalesce)) return true;
    const dims = selectedDimensions(editor);
    if (!dims.length) return false;
    const change = {};
    if (patch.stroke?.type === 'solid') change.lineColor = patch.stroke.color;
    if (patch.fill?.type === 'solid') change.textColor = patch.fill.color;
    if (Number.isFinite(patch.strokeWidth) && patch.strokeWidth > 0) change.lineWidth = patch.strokeWidth;
    if (!Object.keys(change).length) return false;
    editor.doc.transact('Dimension Appearance', () => dims.forEach((d) => editor.doc.update(d.id, { dim: { ...dimOptions(d.dim), ...change } })), { coalesce });
    if (dims.length < editor.topSelection().length) return false;
    editor.setStyle(patch);
    return true;
  };
  paintHooks.commonStyle = (editor, key) => {
    const v = prevCommon?.(editor, key);
    if (v !== undefined) return v;
    const field = { fill: 'textColor', stroke: 'lineColor', strokeWidth: 'lineWidth' }[key];
    if (!field) return undefined;
    const dims = selectedDimensions(editor);
    if (!dims.length || dims.length !== editor.selection.size) return undefined;
    const vals = dims.map((d) => dimOptions(d.dim)[field]);
    if (vals.some((x) => x !== vals[0])) return 'mixed';
    return key === 'strokeWidth' ? vals[0] : solid(vals[0]);
  };
}

function editOnDoubleClick(tool, target) {
  if (!isDimension(target) || tool.editor.doc.isLocked(target.id)) return false;
  tool.editor.select([target.id]);
  dimensionOptionsDialog(tool.app, { nodes: [target] });
  return true;
}

export function install(app) {
  app.registerTool(DimensionTool);
  installDimensionPaint();
  overlayHooks.add(drawDimensionHandles);
  if (!selectionDoubleClickHooks.includes(editOnDoubleClick)) selectionDoubleClickHooks.push(editOnDoubleClick);
  if (!directSelectionHooks.includes(dimensionHandleHook)) directSelectionHooks.push(dimensionHandleHook);
  if (!PropertiesPanel.extraSections.some((s) => s.id === 'dimension')) PropertiesPanel.extraSections.push(dimensionSection(), dimensionToolSection());
  const some = (a) => Boolean(a.editor && selectedDimensions(a.editor).length);
  app.commands.register([
    {
      id: 'dimension.options',
      label: 'Dimension Options...',
      enabled: (a) => Boolean(a.editor),
      run: (a) => dimensionOptionsDialog(a, { nodes: selectedDimensions(a.editor) }),
    },
    { id: 'dimension.toolOptions', label: 'Dimension Tool Options...', enabled: (a) => Boolean(a.editor), run: (a) => dimensionOptionsDialog(a, { nodes: selectedDimensions(a.editor), tool: true }) },
    // The context menu's entry: only with dimensions selected.
    { id: 'dimension.edit', label: 'Dimension Options...', enabled: some, run: (a) => dimensionOptionsDialog(a, { nodes: selectedDimensions(a.editor) }) },
    {
      id: 'dimension.detach',
      label: 'Detach from Objects',
      enabled: (a) => Boolean(a.editor && selectedDimensions(a.editor).some(isAttached)),
      run: (a) => detachDimensions(a.editor),
    },
    {
      id: 'dimension.flipLabel',
      label: 'Flip Label Side',
      enabled: some,
      run: (a) => {
        const doc = a.editor.doc;
        doc.transact('Flip Label Side', () =>
          selectedDimensions(a.editor).forEach((d) => {
            const o = dimOptions(d.dim);
            const next = { above: 'below', below: 'above', center: 'center' }[o.labelPosition];
            doc.update(d.id, { dim: { ...o, labelPosition: next } });
          }),
        );
      },
    },
  ]);
}

/** Bake attached points into the dimensions so they stop following their objects. */
export function detachDimensions(editor) {
  const doc = editor.doc;
  const dims = selectedDimensions(editor).filter(isAttached);
  doc.transact('Detach Dimensions', () =>
    dims.forEach((d) => {
      const e = layoutIn(doc, d).effective;
      doc.update(d.id, { p1: e.p1, p2: e.p2, ...(d.kind === 'angular' ? { vertex: e.vertex } : {}), at: e.at, attach: null });
    }),
  );
  return dims.length;
}
