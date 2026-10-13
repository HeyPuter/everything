/**
 * Type menu commands for paragraph layout and type geometry: Bullets and
 * Numbering, Optical Margin Alignment, Type Orientation, the Type on a Path
 * effects and options, the vertical type tools and View > Snap to Letterforms.
 */
import { layoutText, listLabels, glyphMetrics } from '../../model/text-layout.js';
import { paragraphRanges, paraStylePatch, replaceRange, overridesAt, paraAt } from '../../model/text-runs.js';
import { registerIcons } from '../../ui/icons.js';
import { snapHooks } from '../../tools/snap.js';
import { selectedTextNodes } from './outlines.js';
import { session, applyParaStyle, currentParaStyle, currentTextNodes, MIXED } from './type-ops.js';
import { VerticalAreaTypeTool, VerticalTypeOnPathTool } from './tools.js';
import { threadFrames, headOf } from './thread-model.js';

export const BULLETS = [
  ['•', 'Bullet'],
  ['◦', 'White Bullet'],
  ['▪', 'Small Square'],
  ['–', 'En Dash'],
  ['—', 'Em Dash'],
  ['→', 'Arrow'],
  ['✓', 'Check Mark'],
  ['★', 'Star'],
  ['◆', 'Diamond'],
];

export const NUMBER_FORMATS = [
  ['1', '1, 2, 3'],
  ['01', '01, 02, 03'],
  ['a', 'a, b, c'],
  ['A', 'A, B, C'],
  ['i', 'i, ii, iii'],
  ['I', 'I, II, III'],
];

const HANG = 18;

const hasText = (app) => Boolean(session(app)) || (app.editor ? selectedTextNodes(app.editor).length > 0 : false);

/** The list setting of the current paragraphs: a list object, null, or MIXED. */
function currentList(app) {
  const p = currentParaStyle(app);
  return p ? p.list : null;
}

/** Turn bullets or numbers on (with a hanging indent when the paragraphs have none) or off. */
export function toggleList(app, kind) {
  const cur = currentList(app);
  const on = cur && cur !== MIXED && cur.kind === kind;
  if (on) {
    applyParaStyle(app, { list: null }, { label: kind === 'bullet' ? 'Remove Bullets' : 'Remove Numbers' });
    return;
  }
  const p = currentParaStyle(app) || {};
  const prev = cur && cur !== MIXED ? cur : null;
  const list = kind === 'bullet' ? { kind, bullet: prev?.bullet || '•' } : { kind, format: prev?.format || '1', suffix: prev?.suffix ?? '.' };
  const patch = { list };
  if (!p.indentLeft && !p.indentFirst) {
    patch.indentLeft = HANG;
    patch.indentFirst = -HANG;
  }
  applyParaStyle(app, patch, { label: kind === 'bullet' ? 'Apply Bullets' : 'Apply Numbers' });
}

/** Bullets and Numbering options: kind, bullet character, number format, start and indents. */
async function listOptions(app) {
  const cur = currentList(app);
  const p = currentParaStyle(app) || {};
  const L = cur && cur !== MIXED ? cur : { kind: 'bullet', bullet: '•' };
  const num = (v, d) => (v === MIXED || v == null ? d : v);
  const v = await app.dialogs.form({
    title: 'Bullets and Numbering',
    fields: [
      {
        key: 'kind',
        type: 'radio',
        label: 'List',
        value: L.kind,
        options: [
          { value: 'bullet', label: 'Bullets' },
          { value: 'number', label: 'Numbers' },
          { value: 'none', label: 'None' },
        ],
      },
      { key: 'bullet', type: 'select', label: 'Bullet', value: BULLETS.some(([c]) => c === L.bullet) ? L.bullet : '•', options: BULLETS.map(([c, name]) => ({ value: c, label: `${c}  ${name}` })) },
      { key: 'format', type: 'select', label: 'Number Style', value: L.format || '1', options: NUMBER_FORMATS.map(([value, label]) => ({ value, label })) },
      { key: 'suffix', type: 'text', label: 'After Number', value: L.suffix ?? '.' },
      { key: 'start', type: 'number', label: 'Start At', value: Number.isFinite(L.start) ? L.start : 1, min: 0, max: 9999 },
      { type: 'heading', label: 'Position' },
      { key: 'indentLeft', type: 'length', label: 'Text Indent', value: num(p.indentLeft, HANG) || HANG, min: 0, max: 5000 },
      { key: 'markerAt', type: 'length', label: 'Marker Indent', value: num(p.indentLeft, HANG) + num(p.indentFirst, -HANG), min: -5000, max: 5000, help: 'Where the bullet or number starts, from the frame edge.' },
    ],
  });
  if (!v) return;
  if (v.kind === 'none') {
    applyParaStyle(app, { list: null }, { label: 'Bullets and Numbering' });
    return;
  }
  const list = v.kind === 'bullet' ? { kind: 'bullet', bullet: v.bullet } : { kind: 'number', format: v.format, suffix: v.suffix, ...(Math.round(v.start) !== 1 ? { start: Math.round(v.start) } : {}) };
  applyParaStyle(app, { list, indentLeft: v.indentLeft, indentFirst: v.markerAt - v.indentLeft }, { label: 'Bullets and Numbering' });
}

/** Paragraph ranges a list command acts on for a story node: the selection's while editing, else all. */
function targetParas(app, node) {
  const s = session(app);
  const n = paragraphRanges(node.text).length;
  if (s && s.node()?.id === node.id) {
    const [a, b] = s.range();
    const text = node.text;
    let p0 = 0;
    for (let i = 0; i < a; i++) if (text[i] === '\n') p0++;
    let p1 = p0;
    for (let i = a; i < b; i++) if (text[i] === '\n') p1++;
    return [p0, p1];
  }
  return [0, n - 1];
}

/** Turn list markers into real text: the marker and a tab start each paragraph, with a tab stop at the text indent. */
export function listToTextPatch(node, p0 = 0, p1 = Infinity) {
  const labels = listLabels(node);
  const ranges = paragraphRanges(node.text);
  let cur = { ...node };
  for (let pi = Math.min(p1, ranges.length - 1); pi >= p0; pi--) {
    if (labels[pi] == null) continue;
    const para = paraAt(cur, pi);
    const start = ranges[pi].start;
    const ins = `${labels[pi]}\t`;
    cur = { ...cur, ...replaceRange(cur, start, start, ins, overridesAt(cur, start)) };
    const tabs = [...(para.tabs || []).filter((t) => Math.abs(t.pos - (para.indentLeft || 0)) > 0.01), ...(para.indentLeft > 0 ? [{ pos: para.indentLeft, align: 'left' }] : [])];
    cur = { ...cur, ...paraStylePatch(cur, pi, pi, { list: null, tabs: tabs.length ? tabs.sort((a, b) => a.pos - b.pos) : null }) };
  }
  return { text: cur.text, runs: cur.runs, paras: cur.paras, para: cur.para };
}

function listToText(app) {
  const ed = app.editor;
  const nodes = session(app) ? [session(app).node()] : [...new Map(selectedTextNodes(ed).map((n) => [headOf(ed.doc, n).id, headOf(ed.doc, n)])).values()];
  ed.doc.transact('Convert Bullets and Numbering to Text', () => {
    for (const n of nodes) {
      const [p0, p1] = targetParas(app, n);
      ed.doc.update(n.id, listToTextPatch(ed.doc.get(n.id), p0, p1));
    }
  });
  session(app)?.changed();
}

/** Type nodes the orientation and margin commands act on (whole threads). */
function storyFramesSelected(app) {
  const ed = app.editor;
  const out = new Map();
  for (const n of currentTextNodes(app)) for (const f of threadFrames(ed.doc, n)) out.set(f.id, f);
  return [...out.values()];
}

function setOrientation(app, vertical) {
  const ed = app.editor;
  const nodes = storyFramesSelected(app).filter((n) => Boolean(n.vertical) !== vertical);
  if (!nodes.length) return;
  ed.doc.transact(vertical ? 'Vertical Type' : 'Horizontal Type', () => {
    for (const n of nodes) {
      const patch = { vertical: vertical || undefined };
      // Shaped areas are horizontal only: vertical type flows in their box.
      if (vertical && n.areaPath) patch.areaPath = undefined;
      ed.doc.update(n.id, patch);
    }
  });
  session(app)?.changed();
}

const orientationOf = (app) => {
  const nodes = currentTextNodes(app);
  if (!nodes.length) return null;
  const v = nodes.map((n) => Boolean(n.vertical));
  return v.every(Boolean) ? 'vertical' : v.every((x) => !x) ? 'horizontal' : MIXED;
};

// ---- type on a path ----

export const PATH_EFFECTS = [
  ['rainbow', 'Rainbow', 'rainbow'],
  ['skew', 'Skew', 'skew'],
  ['ribbon', '3D Ribbon', 'ribbon'],
  ['stairStep', 'Stair Step', 'stair'],
  ['gravity', 'Gravity', 'gravity'],
];

const pathNodes = (app) => (app.editor ? selectedTextNodes(app.editor).filter((n) => n.kind === 'path') : []);

function setPathOptions(app, patch, label) {
  const ed = app.editor;
  const nodes = pathNodes(app);
  if (!nodes.length) return;
  ed.doc.transact(label, () => {
    for (const n of nodes) ed.doc.update(n.id, { pathOptions: { ...(n.pathOptions || {}), ...patch } });
  });
}

/** Type on a Path Options with a live preview on the selected path type. */
async function pathOptionsDialog(app) {
  const ed = app.editor;
  const nodes = pathNodes(app);
  if (!nodes.length) return;
  const o = nodes[0].pathOptions || {};
  const doc = ed.doc;
  const originals = new Map(nodes.map((n) => [n.id, n.pathOptions]));
  const tx = doc.begin('Type on a Path Options');
  const apply = (v) => {
    for (const [id, orig] of originals) {
      doc.update(id, { pathOptions: v ? { ...(orig || {}), effect: v.effect, flip: v.flip, align: v.align, spacing: v.spacing, start: v.start } : orig });
    }
  };
  let v = null;
  try {
    v = await app.dialogs.form({
      title: 'Type on a Path Options',
      fields: [
        { key: 'effect', type: 'select', label: 'Effect', value: o.effect || 'rainbow', options: PATH_EFFECTS.map(([, label, value]) => ({ value, label })) },
        { key: 'flip', type: 'checkbox', label: 'Flip to the Other Side of the Path', value: Boolean(o.flip) },
        {
          key: 'align',
          type: 'select',
          label: 'Align to Path',
          value: o.align || 'baseline',
          options: [
            { value: 'baseline', label: 'Baseline' },
            { value: 'ascender', label: 'Ascender' },
            { value: 'descender', label: 'Descender' },
            { value: 'center', label: 'Center' },
          ],
        },
        { key: 'spacing', type: 'length', label: 'Spacing', value: o.spacing || 0, min: -1000, max: 1000, help: 'Evens out the gaps between characters where the path bends.' },
        { key: 'start', type: 'length', label: 'Start Offset', value: o.start || 0, min: 0 },
        { key: 'preview', type: 'checkbox', label: 'Preview', value: true },
      ],
      previewToggle: true,
      onChange: (vals) => apply(vals.preview ? vals : null),
    });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!v) {
    tx.cancel();
    return;
  }
  apply(v);
  tx.commit();
}

/** Type > Type on a Path > Update: complete the options of path type made elsewhere and keep the start on the path. */
function updatePathType(app) {
  const ed = app.editor;
  const nodes = pathNodes(app);
  ed.doc.transact('Update Type on a Path', () => {
    for (const n of nodes) {
      const lay = layoutText(n);
      const o = n.pathOptions || {};
      const len = lay.path?.length || 0;
      ed.doc.update(n.id, { pathOptions: { effect: o.effect || 'rainbow', align: o.align || 'baseline', flip: Boolean(o.flip), spacing: Number.isFinite(o.spacing) ? o.spacing : 0, start: Math.max(0, Math.min(Math.max(0, len - 1), o.start || 0)) } });
    }
  });
}

// ---- snap to letterforms ----

const GLYPH_GUIDES = [
  ['baseline', (l) => l.y],
  ['x-height', (l, g) => l.y - g.xHeight],
  ['cap height', (l, g) => l.y - g.capHeight],
  ['ascender', (l, g) => l.y - g.ascent],
  ['descender', (l, g) => l.y + g.descent],
];

/** Snap points on the baseline, x-height, cap height, ascender and descender of visible horizontal type, at its glyph edges. */
export function glyphSnapPoints(editor, points, { exclude, visible }) {
  if (editor.viewOptions.snapGlyph === false || !editor.viewOptions.alignmentGuides) return;
  const { doc } = editor;
  let budget = 4000;
  for (const n of doc.leaves()) {
    if (budget <= 0) break;
    if (n.type !== 'text' || exclude.has(n.id) || doc.isHidden(n.id)) continue;
    const lay = layoutText(n);
    if (lay.kind === 'path' || lay.vertical) continue;
    const m = n.transform;
    const b = lay.bounds;
    const corners = [[b.x, b.y], [b.x + b.w, b.y + b.h]].map(([x, y]) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }));
    if (Math.max(corners[0].x, corners[1].x) < visible.x || Math.min(corners[0].x, corners[1].x) > visible.x + visible.w) continue;
    if (Math.max(corners[0].y, corners[1].y) < visible.y || Math.min(corners[0].y, corners[1].y) > visible.y + visible.h) continue;
    for (const l of lay.lines) {
      if (l.contentEnd <= l.start) continue;
      const st = lay.chars.sty[l.start];
      const g = glyphMetrics(st);
      const xs = [l.xs[0], l.xs[l.contentEnd - l.start]];
      // Glyph edges where words start, for proximity guides along the line.
      for (let i = l.start + 1; i < l.contentEnd && xs.length < 40; i++) if (lay.text[i - 1] === ' ' && lay.text[i] !== ' ') xs.push(l.xs[i - l.start]);
      for (const [label, yOf] of GLYPH_GUIDES) {
        const y = yOf(l, g);
        for (const x of xs) {
          points.push({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5], kind: 'glyph', label });
          budget--;
        }
      }
    }
  }
}

export function installLayoutCommands(app) {
  registerIcons({
    'tool-vertical-area-type': [['rect', { x: '3', y: '3', width: '18', height: '18', 'stroke-dasharray': '2 2' }], ['path', { d: 'M16 7.5v9M16 12H7.5M7.5 10v4' }]],
    'tool-vertical-type-on-path': [['path', { d: 'M3 20c4-8 10-11 18-12', 'stroke-dasharray': '2 2' }], ['path', { d: 'M16 3v8M16 7H8M8 5v4' }]],
    'list-bullets': [['circle', { cx: '5', cy: '7', r: '1.2' }], ['circle', { cx: '5', cy: '12', r: '1.2' }], ['circle', { cx: '5', cy: '17', r: '1.2' }], ['path', { d: 'M9 7h11M9 12h11M9 17h11' }]],
    'list-numbers': [['path', { d: 'M4 5h1.5v4M4 9h3M4 14h3l-3 4h3' }], ['path', { d: 'M10 7h10M10 12h10M10 17h10' }]],
    'optical-margin': [['path', { d: 'M8 3v18' }], ['path', { d: 'M4 6h2v2.5L4.5 10' }], ['path', { d: 'M11 7h9M11 12h9M11 17h6' }]],
  });
  app.registerTool(VerticalAreaTypeTool);
  app.registerTool(VerticalTypeOnPathTool);
  snapHooks.add(glyphSnapPoints);

  const c = app.commands;
  const listIs = (a, kind) => {
    const L = currentList(a);
    return Boolean(L && L !== MIXED && L.kind === kind);
  };
  c.register([
    { id: 'type.bullets', label: 'Apply Bullets', enabled: hasText, checked: (a) => listIs(a, 'bullet'), run: (a) => toggleList(a, 'bullet') },
    { id: 'type.numbering', label: 'Apply Numbers', enabled: hasText, checked: (a) => listIs(a, 'number'), run: (a) => toggleList(a, 'number') },
    { id: 'type.listToText', label: 'Convert to Text', enabled: (a) => hasText(a) && currentTextNodes(a).some((n) => listLabels(headOf(a.editor.doc, n)).some((l) => l != null)), run: listToText },
    { id: 'type.listOptions', label: 'Bullets and Numbering Options...', enabled: hasText, run: listOptions },
    {
      id: 'type.opticalMargin',
      label: 'Optical Margin Alignment',
      enabled: hasText,
      checked: (a) => currentParaStyle(a)?.opticalMargin === true,
      run: (a) => {
        const on = currentParaStyle(a)?.opticalMargin === true;
        // The option applies to whole stories.
        const ed = a.editor;
        const nodes = [...new Map(currentTextNodes(a).map((n) => [headOf(ed.doc, n).id, headOf(ed.doc, n)])).values()];
        ed.doc.transact('Optical Margin Alignment', () => {
          for (const n of nodes) ed.doc.update(n.id, paraStylePatch(n, 0, paragraphRanges(n.text).length - 1, { opticalMargin: !on }));
        });
        session(a)?.changed();
      },
    },
    { id: 'type.orientation.horizontal', label: 'Horizontal', enabled: hasText, checked: (a) => orientationOf(a) === 'horizontal', run: (a) => setOrientation(a, false) },
    { id: 'type.orientation.vertical', label: 'Vertical', enabled: hasText, checked: (a) => orientationOf(a) === 'vertical', run: (a) => setOrientation(a, true) },
    ...PATH_EFFECTS.map(([id, label, value]) => ({
      id: `type.path.${id}`,
      label,
      enabled: (a) => pathNodes(a).length > 0,
      checked: (a) => {
        const n = pathNodes(a);
        return n.length > 0 && n.every((x) => (x.pathOptions?.effect || 'rainbow') === value);
      },
      run: (a) => setPathOptions(a, { effect: value }, label),
    })),
    { id: 'type.pathOptions', label: 'Type on a Path Options...', enabled: (a) => pathNodes(a).length > 0, run: pathOptionsDialog },
    { id: 'type.path.update', label: 'Update Type on a Path', enabled: (a) => pathNodes(a).length > 0, run: updatePathType },
    {
      id: 'view.snapGlyph',
      label: 'Snap to Letterforms',
      enabled: (a) => Boolean(a.editor),
      checked: (a) => a.editor?.viewOptions.snapGlyph !== false,
      run: (a) => a.editor.setViewOption('snapGlyph', a.editor.viewOptions.snapGlyph === false),
    },
  ]);
}

