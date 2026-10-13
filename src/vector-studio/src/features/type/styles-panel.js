/**
 * Character Styles and Paragraph Styles panels, the Style Options dialog and
 * the app-level style operations they share: apply to the current text,
 * create from the selection, clear overrides, redefine, duplicate, delete.
 *
 * "The current text" follows type-ops.js: selected characters (or the
 * paragraphs they touch) while editing, the insertion point, the selected
 * type objects, or the defaults for new type when nothing is selected.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { iconButton } from '../../ui/widgets.js';
import { registerIcons } from '../../ui/icons.js';
import { formatLength, parseLength, parseNumber } from '../../lib/units.js';
import { paragraphIndexAt, paragraphRanges, rangeStyle, rangeParaStyle, styleAt, paraAt, MIXED } from '../../model/text-runs.js';
import { session, currentTextNodes, typeDefaults, applyCharStyle } from './type-ops.js';
import { allFamilies, familyFaces, styleName } from './fonts.js';
import {
  NORMAL,
  CHAR_STYLE_KEYS,
  PARA_STYLE_KEYS,
  FACTORY_PARA_STYLE,
  styleLists,
  rootPatch,
  findStyle,
  chainOf,
  wouldCycle,
  resolveChar,
  resolvePara,
  inheritedAttrs,
  expectedChar,
  expectedPara,
  restyleNode,
  restyleDocument,
  charStyleState,
  paraStyleState,
  usedStyles,
  uniqueName,
  nextStyleName,
  newStyleId,
  diffAttrs,
  eq,
} from './text-styles.js';

const KINDS = {
  char: { title: 'Character Styles', one: 'Character Style', root: 'charStyles', listKey: 'char' },
  para: { title: 'Paragraph Styles', one: 'Paragraph Style', root: 'paraStyles', listKey: 'para' },
};

// ---- the current text ----

/**
 * What a style command acts on: { mode: 'session' | 'objects' | 'defaults',
 * node, a, b, nodes }.
 */
function target(app) {
  const s = session(app);
  if (s) {
    const node = s.node();
    if (node) {
      const [a, b] = s.range();
      return { mode: 'session', s, node, a, b, nodes: [node] };
    }
  }
  const nodes = currentTextNodes(app).filter((n) => !n.threadPrev);
  if (nodes.length) return { mode: 'objects', nodes };
  return { mode: 'defaults', nodes: [] };
}

/** Active style of the current text for a kind: { id (or MIXED), override, mode }. */
export function currentStyleState(app, kind) {
  const ed = app.editor;
  if (!ed) return { id: null, override: false, mode: 'none' };
  const lists = styleLists(ed.doc);
  const t = target(app);
  if (t.mode === 'defaults') {
    const d = typeDefaults(app);
    const id = kind === 'char' ? d.char.charStyle : d.para.paraStyle;
    return { id: id && findStyle(lists[kind], id) ? id : NORMAL, override: false, mode: t.mode };
  }
  if (t.mode === 'session') {
    const { node, a, b, s } = t;
    if (kind === 'char') {
      const st = charStyleState(lists, node, a, b);
      if (a === b && s.pending && 'charStyle' in s.pending) return { id: s.pending.charStyle || NORMAL, override: false, mode: t.mode };
      return { ...st, mode: t.mode };
    }
    return { ...paraStyleState(lists, node, paragraphIndexAt(node.text, a), paragraphIndexAt(node.text, b)), mode: t.mode };
  }
  let id;
  let override = false;
  for (const n of t.nodes) {
    const st = kind === 'char' ? charStyleState(lists, n, 0, n.text.length || 0) : paraStyleState(lists, n, 0, paragraphRanges(n.text).length - 1);
    if (id === undefined) id = st.id;
    else if (id !== st.id) id = MIXED;
    override ||= st.override;
  }
  return { id, override, mode: t.mode };
}

/** Restyle the current text inside the open transaction (targets choose ids per segment). */
function restyleTarget(app, t, lists, { paraTarget = null, charTarget = null }) {
  const doc = app.editor.doc;
  if (t.mode === 'session') {
    const { node, a, b } = t;
    const p0 = paragraphIndexAt(node.text, a);
    const p1 = paragraphIndexAt(node.text, b);
    const patch = restyleNode(node, {
      oldLists: lists,
      paraTarget: paraTarget ? (pi, cur) => (pi >= p0 && pi <= p1 ? paraTarget(pi, cur) : null) : null,
      charTarget: charTarget ? (s, e, cur, pi) => (s >= a && e <= b ? charTarget(s, e, cur, pi) : null) : null,
      cuts: [a, b],
    });
    if (patch) doc.update(node.id, patch);
    return;
  }
  for (const n0 of t.nodes) {
    const n = doc.get(n0.id);
    const patch = restyleNode(n, { oldLists: lists, paraTarget, charTarget });
    if (patch) doc.update(n.id, patch);
  }
}

/** Apply a style to the current text. `clear` also removes local overrides. */
export function applyStyle(app, kind, id, { clear = false } = {}) {
  const ed = app.editor;
  if (!ed) return;
  const doc = ed.doc;
  const lists = styleLists(doc);
  if (!findStyle(lists[kind], id)) return;
  const sid = id === NORMAL ? null : id;
  const t = target(app);
  if (t.mode === 'defaults') {
    const d = typeDefaults(app);
    if (kind === 'char') {
      const E = pickDefined(expectedChar(lists, d.para.paraStyle, sid));
      const { fill, stroke, strokeWidth, ...charPart } = E;
      d.char = { ...d.char, ...charPart, charStyle: sid };
      if (fill !== undefined) d.fill = fill;
      if (stroke !== undefined) d.stroke = stroke;
      if (strokeWidth !== undefined) d.strokeWidth = strokeWidth;
    }
    else {
      const all = resolvePara(lists.para, sid);
      d.para = { ...d.para, ...pickKeys(all, PARA_STYLE_KEYS), paraStyle: sid };
      const { fill, stroke, strokeWidth, ...own } = pickDefined(resolveChar(lists.char, d.char.charStyle)); // eslint-disable-line no-unused-vars
      d.char = { ...d.char, ...pickKeys(all, CHAR_STYLE_KEYS.filter((k) => k !== 'fill' && k !== 'stroke' && k !== 'strokeWidth')), ...own };
      d.fill = all.fill;
      d.stroke = all.stroke;
      d.strokeWidth = all.strokeWidth;
    }
    app.dock?.update();
    return;
  }
  const name = findStyle(lists[kind], id).name;
  if (t.mode === 'session' && kind === 'char' && t.a === t.b) {
    // Insertion point: the next typed characters take the style.
    const pi = paragraphIndexAt(t.node.text, t.a);
    const E = expectedChar(lists, paraAt(t.node, pi).paraStyle, sid);
    applyCharStyle(app, { ...E, charStyle: sid }, { label: `Apply ${name}` });
    return;
  }
  doc.transact(`Apply ${name}`, () => {
    if (kind === 'char') restyleTarget(app, t, lists, { charTarget: () => ({ id: sid, clear }) });
    else restyleTarget(app, t, lists, { paraTarget: () => ({ id: sid, clear }) });
  });
  t.s?.changed();
}

/** Remove local overrides from the current text (keeping each part's style). */
export function clearOverrides(app, kind) {
  const ed = app.editor;
  if (!ed) return;
  const t = target(app);
  if (t.mode === 'defaults') return;
  const lists = styleLists(ed.doc);
  ed.doc.transact('Clear Overrides', () => {
    if (kind === 'char') restyleTarget(app, t, lists, { charTarget: (s, e, cur) => ({ id: cur, clear: true }) });
    else restyleTarget(app, t, lists, { paraTarget: (pi, cur) => ({ id: cur, clear: true }) });
  });
  t.s?.changed();
}

function pickKeys(obj, keys) {
  const out = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

function pickDefined(obj) {
  const out = {};
  for (const k in obj) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Attributes of the current text: { char: values (MIXED allowed), para, paraId, charId }. */
function currentAttrs(app) {
  const t = target(app);
  const d = typeDefaults(app);
  if (t.mode === 'defaults') return { char: { ...d.char, fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth }, para: { ...d.para }, paraId: d.para.paraStyle || null };
  if (t.mode === 'session') {
    const { node, a, b } = t;
    const p0 = paragraphIndexAt(node.text, a);
    const char = b > a ? rangeStyle(node, a, b) : { ...styleAt(node, a > 0 ? a - 1 : 0), ...(t.s.pending || {}) };
    return { char, para: rangeParaStyle(node, p0, paragraphIndexAt(node.text, b)), paraId: paraAt(node, p0).paraStyle || null };
  }
  const n = t.nodes[0];
  return { char: rangeStyle(n, 0, Math.max(1, n.text.length)), para: rangeParaStyle(n, 0, paragraphRanges(n.text).length - 1), paraId: paraAt(n, 0).paraStyle || null };
}

/** Attributes a new style of `kind` captures from the current text. */
export function attrsFromSelection(app, kind, lists, basedOn = null) {
  const cur = currentAttrs(app);
  if (kind === 'char') {
    // What differs from the paragraph's style, plus the font so the style is meaningful on its own.
    const base = expectedChar(lists, cur.paraId, null);
    const attrs = diffAttrs(cur.char, { ...base, ...resolveChar(lists.char, basedOn) }, CHAR_STYLE_KEYS);
    for (const k of ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize']) if (!(k in attrs) && cur.char[k] !== MIXED && !basedOn) attrs[k] = cur.char[k];
    return attrs;
  }
  const base = resolvePara(lists.para, basedOn || NORMAL);
  return { ...diffAttrs(cur.char, base, CHAR_STYLE_KEYS), ...diffAttrs(cur.para, base, PARA_STYLE_KEYS) };
}

function setLists(doc, lists) {
  doc.updateRoot(rootPatch(lists));
}

/** New style from the current text, applied to it. Returns the new id. */
export function newStyle(app, kind, { name, apply = true } = {}) {
  const ed = app.editor;
  if (!ed) return null;
  const doc = ed.doc;
  const lists = styleLists(doc);
  const style = { id: newStyleId(kind), name: name ? uniqueName(lists[kind], name) : nextStyleName(lists[kind], kind), basedOn: null, attrs: attrsFromSelection(app, kind, lists) };
  doc.transact(`New ${KINDS[kind].one}`, () => {
    setLists(doc, { ...lists, [kind]: [...lists[kind], style] });
    if (apply && target(app).mode !== 'defaults') applyInTx(app, kind, style.id);
  });
  if (apply && target(app).mode === 'defaults') applyStyle(app, kind, style.id);
  session(app)?.changed();
  return style.id;
}

function applyInTx(app, kind, id) {
  const lists = styleLists(app.editor.doc);
  const t = target(app);
  if (t.mode === 'defaults') return;
  if (t.mode === 'session' && kind === 'char' && t.a === t.b) {
    t.s.setPending({ ...(t.s.pending || {}), ...expectedChar(lists, paraAt(t.node, paragraphIndexAt(t.node.text, t.a)).paraStyle, id), charStyle: id });
    return;
  }
  if (kind === 'char') restyleTarget(app, t, lists, { charTarget: () => ({ id, clear: false }) });
  else restyleTarget(app, t, lists, { paraTarget: () => ({ id, clear: false }) });
}

/** Redefine a style from the current text; every text using it follows, keeping its overrides. */
export function redefineStyle(app, kind, id = currentStyleState(app, kind).id) {
  const ed = app.editor;
  if (!ed || !id || id === MIXED) return false;
  const doc = ed.doc;
  const lists = styleLists(doc);
  const style = findStyle(lists[kind], id);
  if (!style) return false;
  const cur = currentAttrs(app);
  let diffs;
  if (kind === 'char') {
    const E = expectedChar(lists, cur.paraId, id);
    diffs = diffAttrs(cur.char, E, CHAR_STYLE_KEYS);
  } else {
    const E = { ...pickKeys(resolvePara(lists.para, id), CHAR_STYLE_KEYS), ...expectedPara(lists, id) };
    // Character attributes of characters that have their own character style belong to that style.
    const charVals = cur.char.charStyle && cur.char.charStyle !== MIXED ? {} : cur.char;
    diffs = { ...diffAttrs(charVals, E, CHAR_STYLE_KEYS), ...diffAttrs(cur.para, E, PARA_STYLE_KEYS) };
  }
  if (!Object.keys(diffs).length) return false;
  const next = { ...lists, [kind]: lists[kind].map((s) => (s.id === id ? { ...s, attrs: { ...s.attrs, ...diffs } } : s)) };
  doc.transact(`Redefine ${style.name}`, () => {
    setLists(doc, next);
    restyleDocument(doc, lists, next);
  });
  syncDefaults(app, kind, id, next);
  session(app)?.changed();
  return true;
}

/** Editing a Normal style updates the defaults new type is created with. */
function syncDefaults(app, kind, id, lists) {
  if (id !== NORMAL) return;
  const d = typeDefaults(app);
  if (kind === 'para' && !d.para.paraStyle) {
    const all = resolvePara(lists.para, NORMAL);
    d.para = { ...d.para, ...pickKeys(all, PARA_STYLE_KEYS) };
    if (!d.char.charStyle) d.char = { ...d.char, ...pickKeys(all, CHAR_STYLE_KEYS.filter((k) => !['fill', 'stroke', 'strokeWidth'].includes(k))) };
    d.fill = all.fill;
    d.stroke = all.stroke;
    d.strokeWidth = all.strokeWidth;
  } else if (kind === 'char' && !d.char.charStyle) {
    d.char = { ...d.char, ...pickDefined(resolveChar(lists.char, NORMAL)) };
  }
}

export function duplicateStyle(app, kind, id) {
  const doc = app.editor?.doc;
  if (!doc) return null;
  const lists = styleLists(doc);
  const src = findStyle(lists[kind], id);
  if (!src) return null;
  const attrs = id === NORMAL && kind === 'para' ? { ...FACTORY_PARA_STYLE, ...src.attrs } : { ...src.attrs };
  const copy = { id: newStyleId(kind), name: uniqueName(lists[kind], `${src.name} copy`), basedOn: id === NORMAL ? null : src.basedOn, attrs };
  const i = lists[kind].indexOf(src);
  const list = [...lists[kind]];
  list.splice(i + 1, 0, copy);
  doc.transact(`Duplicate ${KINDS[kind].one}`, () => setLists(doc, { ...lists, [kind]: list }));
  return copy.id;
}

/**
 * Delete styles. Text using them keeps its attributes and drops the
 * reference (replaceWith = null), or takes `replaceWith` (keeping overrides).
 * Styles based on a deleted style are rebased so they look the same.
 */
export function deleteStyles(app, kind, ids, { replaceWith = null } = {}) {
  const doc = app.editor?.doc;
  if (!doc) return 0;
  const lists = styleLists(doc);
  const gone = new Set(ids.filter((id) => id !== NORMAL && findStyle(lists[kind], id)));
  if (!gone.size) return 0;
  const byId = new Map(lists[kind].map((s) => [s.id, s]));
  const kept = lists[kind]
    .filter((s) => !gone.has(s.id))
    .map((s) => {
      let basedOn = s.basedOn;
      let attrs = s.attrs;
      const seen = new Set();
      while (basedOn && gone.has(basedOn) && !seen.has(basedOn)) {
        seen.add(basedOn);
        const parent = byId.get(basedOn);
        attrs = { ...parent.attrs, ...attrs };
        basedOn = parent.basedOn;
      }
      return basedOn === s.basedOn ? s : { ...s, basedOn, attrs };
    });
  const next = { ...lists, [kind]: kept };
  const rep = replaceWith && !gone.has(replaceWith) ? replaceWith : null;
  doc.transact(gone.size > 1 ? `Delete ${KINDS[kind].title}` : `Delete ${KINDS[kind].one}`, () => {
    // Re-point references against the old lists first, then store the new lists.
    const opts =
      kind === 'char'
        ? { charTarget: (s, e, cur) => (gone.has(cur) ? (rep ? { id: rep === NORMAL ? null : rep } : { id: null, keep: true }) : null) }
        : {
            paraTarget: (pi, cur) => (gone.has(cur) ? { id: rep === NORMAL ? null : rep } : null),
          };
    if (kind === 'para' && !rep) {
      // Paragraphs keep their look: their attributes become overrides of the Normal style.
      for (const n of doc.leaves()) {
        if (n.type !== 'text' || n.threadPrev) continue;
        const count = paragraphRanges(n.text).length;
        let touched = false;
        for (let pi = 0; pi < count; pi++) if (gone.has(paraAt(n, pi).paraStyle)) touched = true;
        if (!touched) continue;
        const fixed = paraRefsDropped(n, gone);
        doc.update(n.id, fixed);
      }
    } else {
      restyleDocument(doc, lists, { ...lists, [kind]: [...kept, ...lists[kind].filter((s) => gone.has(s.id))] }, opts);
    }
    setLists(doc, next);
  });
  return gone.size;
}

/** Patch that removes paragraph style references (attributes unchanged). */
function paraRefsDropped(n, gone) {
  const count = paragraphRanges(n.text).length;
  const fix = (p) => (p && gone.has(p.paraStyle) ? { ...p, paraStyle: null } : p);
  return { para: fix(n.para), paras: n.paras ? n.paras.slice(0, count).map((p) => (p ? fix(p) : p)) : n.paras };
}

/** Rename, rebase or re-attribute a style (the document restyles). */
export function updateStyle(app, kind, id, { name, basedOn, attrs }) {
  const doc = app.editor?.doc;
  if (!doc) return;
  const lists = styleLists(doc);
  const next = { ...lists, [kind]: lists[kind].map((s) => (s.id === id ? { ...s, name: name ?? s.name, basedOn: basedOn === undefined ? s.basedOn : basedOn, attrs: attrs ?? s.attrs } : s)) };
  doc.transact(`${KINDS[kind].one} Options`, () => {
    setLists(doc, next);
    restyleDocument(doc, lists, next);
  });
  syncDefaults(app, kind, id, next);
}

export function sortStyles(app, kind) {
  const doc = app.editor?.doc;
  if (!doc) return;
  const lists = styleLists(doc);
  const [normal, ...rest] = lists[kind];
  rest.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  doc.transact('Sort by Name', () => setLists(doc, { ...lists, [kind]: [normal, ...rest] }));
}

/**
 * Load styles from other lists (another document's): styles whose names
 * match take the loaded definitions (text using them follows), the others
 * are added. "Based on" links follow the names. Returns { added, replaced }.
 */
export function loadStyles(app, kind, source) {
  const doc = app.editor?.doc;
  if (!doc) return null;
  const lists = styleLists(doc);
  const incoming = source[kind].filter((s) => s.id !== NORMAL);
  if (!incoming.length) return { added: 0, replaced: 0 };
  const byName = new Map(lists[kind].map((s) => [s.name.toLowerCase(), s]));
  const ids = new Map(incoming.map((s) => [s.id, byName.get(s.name.toLowerCase())?.id || newStyleId(kind)]));
  const mapped = incoming.map((s) => ({ id: ids.get(s.id), name: byName.get(s.name.toLowerCase())?.name || s.name, basedOn: s.basedOn ? (s.basedOn === NORMAL ? NORMAL : ids.get(s.basedOn) || null) : null, attrs: { ...s.attrs } }));
  const replacing = new Map(mapped.filter((s) => lists[kind].some((x) => x.id === s.id)).map((s) => [s.id, s]));
  let list = [...lists[kind].map((s) => replacing.get(s.id) || s), ...mapped.filter((s) => !replacing.has(s.id))];
  // Links that would loop through the document's own styles are dropped.
  list = list.map((s) => (s.basedOn && wouldCycle(list, s.id, s.basedOn, kind === 'para') ? { ...s, basedOn: null } : s));
  const next = { ...lists, [kind]: list };
  doc.transact(`Load ${KINDS[kind].title}`, () => {
    setLists(doc, next);
    restyleDocument(doc, lists, next);
  });
  return { added: mapped.length - replacing.size, replaced: replacing.size };
}

/** CSS for previewing a style's type in a list row (sizes kept to the row). */
function previewCss(a) {
  const css = [];
  if (a.fontFamily) css.push(`font-family: ${JSON.stringify(a.fontFamily)}, var(--font-ui)`);
  if (a.fontWeight) css.push(`font-weight: ${a.fontWeight}`);
  if (a.fontStyle === 'italic') css.push('font-style: italic');
  if (a.fontSize) css.push(`font-size: ${Math.max(11, Math.min(20, a.fontSize))}px`);
  if (a.caps === 'all') css.push('text-transform: uppercase');
  else if (a.caps === 'small') css.push('font-variant: small-caps');
  const deco = [a.underline && 'underline', a.strike && 'line-through'].filter(Boolean);
  if (deco.length) css.push(`text-decoration: ${deco.join(' ')}`);
  return css.join('; ');
}

export function unusedStyles(doc, kind) {
  const used = usedStyles(doc)[kind];
  return styleLists(doc)[kind].filter((s) => s.id !== NORMAL && !used.has(s.id)).map((s) => s.id);
}

// ---- Style Options dialog ----

const ONOFF = [
  { value: true, label: 'On' },
  { value: false, label: 'Off' },
];

/** Field definitions by section. `para` marks paragraph-only sections. */
const SECTIONS = [
  { id: 'general', label: 'General' },
  {
    id: 'basic',
    label: 'Basic Character Formats',
    fields: [
      { key: 'fontFamily', label: 'Font Family', type: 'family' },
      { key: 'face', label: 'Font Style', type: 'face' },
      { key: 'fontSize', label: 'Size', type: 'pt', min: 0.1, max: 1296 },
      { key: 'leading', label: 'Leading', type: 'pt', auto: true, min: 0, max: 5000 },
      { key: 'kernMode', label: 'Automatic Kerning', type: 'select', options: [{ value: 'metrics', label: 'Auto' }, { value: 'optical', label: 'Optical' }, { value: 'none', label: 'None' }] },
      { key: 'kerning', label: 'Kerning', type: 'number', min: -1000, max: 10000 },
      { key: 'tracking', label: 'Tracking', type: 'number', min: -1000, max: 10000 },
      { key: 'caps', label: 'Case', type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'all', label: 'All Caps' }, { value: 'small', label: 'Small Caps' }] },
      { key: 'position', label: 'Position', type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'super', label: 'Superscript' }, { value: 'sub', label: 'Subscript' }] },
      { key: 'underline', label: 'Underline', type: 'select', options: ONOFF },
      { key: 'strike', label: 'Strikethrough', type: 'select', options: ONOFF },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced Character Formats',
    fields: [
      { key: 'horizontalScale', label: 'Horizontal Scale', type: 'percent', min: 1, max: 10000 },
      { key: 'verticalScale', label: 'Vertical Scale', type: 'percent', min: 1, max: 10000 },
      { key: 'baselineShift', label: 'Baseline Shift', type: 'pt', min: -5000, max: 5000 },
      { key: 'rotation', label: 'Character Rotation', type: 'angle', min: -360, max: 360 },
      { key: 'noBreak', label: 'No Break', type: 'select', options: ONOFF },
      { key: 'fractionalWidths', label: 'Fractional Widths', type: 'select', options: ONOFF },
    ],
  },
  {
    id: 'color',
    label: 'Character Color',
    fields: [
      { key: 'fill', label: 'Fill', type: 'paint' },
      { key: 'stroke', label: 'Stroke', type: 'paint' },
      { key: 'strokeWidth', label: 'Stroke Weight', type: 'pt', min: 0, max: 1000 },
    ],
  },
  {
    id: 'opentype',
    label: 'OpenType Features',
    fields: [
      { key: 'ligatures', label: 'Standard Ligatures', type: 'select', options: ONOFF },
      { key: 'contextual', label: 'Contextual Alternates', type: 'select', options: ONOFF },
      { key: 'discretionary', label: 'Discretionary Ligatures', type: 'select', options: ONOFF },
      { key: 'swash', label: 'Swash', type: 'select', options: ONOFF },
      { key: 'stylistic', label: 'Stylistic Alternates', type: 'select', options: ONOFF },
      { key: 'titling', label: 'Titling Alternates', type: 'select', options: ONOFF },
      { key: 'ordinals', label: 'Ordinals', type: 'select', options: ONOFF },
      { key: 'fractions', label: 'Fractions', type: 'select', options: ONOFF },
      {
        key: 'figures',
        label: 'Figure Style',
        type: 'select',
        options: [
          { value: 'default', label: 'Default Figure' },
          { value: 'tabular-lining', label: 'Tabular Lining' },
          { value: 'proportional-lining', label: 'Proportional Lining' },
          { value: 'proportional-oldstyle', label: 'Proportional Oldstyle' },
          { value: 'tabular-oldstyle', label: 'Tabular Oldstyle' },
        ],
      },
      {
        key: 'otPosition',
        label: 'Glyph Position',
        type: 'select',
        options: [
          { value: 'default', label: 'Default Position' },
          { value: 'sups', label: 'Superior' },
          { value: 'subs', label: 'Inferior' },
          { value: 'numr', label: 'Numerator' },
          { value: 'dnom', label: 'Denominator' },
        ],
      },
    ],
  },
  {
    id: 'indents',
    label: 'Indents and Spacing',
    para: true,
    fields: [
      {
        key: 'align',
        label: 'Alignment',
        type: 'select',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Center' },
          { value: 'right', label: 'Right' },
          { value: 'justify', label: 'Justify, Last Line Left' },
          { value: 'justify-center', label: 'Justify, Last Line Center' },
          { value: 'justify-right', label: 'Justify, Last Line Right' },
          { value: 'justify-all', label: 'Justify All Lines' },
        ],
      },
      { key: 'indentLeft', label: 'Left Indent', type: 'pt', min: -5000, max: 5000 },
      { key: 'indentFirst', label: 'First Line Indent', type: 'pt', min: -5000, max: 5000 },
      { key: 'indentRight', label: 'Right Indent', type: 'pt', min: -5000, max: 5000 },
      { key: 'spaceBefore', label: 'Space Before', type: 'pt', min: 0, max: 5000 },
      { key: 'spaceAfter', label: 'Space After', type: 'pt', min: 0, max: 5000 },
      { key: 'opticalMargin', label: 'Optical Margin Alignment', type: 'select', options: ONOFF },
    ],
  },
  {
    id: 'composition',
    label: 'Composition and Hyphenation',
    para: true,
    fields: [
      { key: 'composer', label: 'Composer', type: 'select', options: [{ value: 'single', label: 'Single-line' }, { value: 'every', label: 'Every-line' }] },
      { key: 'hyphenate', label: 'Hyphenate', type: 'select', options: ONOFF },
      { key: 'hangingPunctuation', label: 'Hanging Punctuation', type: 'select', options: ONOFF },
    ],
  },
  { id: 'tabs', label: 'Tabs', para: true, fields: [{ key: 'tabs', label: 'Tab Stops', type: 'tabs' }] },
  {
    id: 'lists',
    label: 'Bullets and Numbering',
    para: true,
    fields: [{ key: 'list', label: 'List', type: 'list' }],
  },
];

const fmtPt = (v) => formatLength(v, 'pt');

/** Human text for a value in the summary and placeholders. */
function describe(f, v) {
  if (v === undefined) return '';
  switch (f.type) {
    case 'pt':
      return v == null ? 'Auto' : fmtPt(v);
    case 'percent':
      return `${v}%`;
    case 'angle':
      return `${v}°`;
    case 'paint':
      return v == null ? 'None' : v.type === 'solid' ? v.color : 'Gradient';
    case 'select': {
      const o = f.options.find((x) => x.value === v);
      return o ? o.label : String(v);
    }
    case 'tabs':
      return describeTabs(v);
    case 'list':
      return describeList(v);
    default:
      return String(v);
  }
}

function describeTabs(tabs) {
  if (!tabs || !tabs.length) return 'Default stops';
  return tabs.map((t) => `${t.align || 'left'} ${fmtPt(t.pos)}${t.leader ? ` (${t.leader})` : ''}`).join(', ');
}

function describeList(list) {
  if (!list) return 'None';
  if (list.kind === 'bullet') return `Bullet ${list.bullet || '•'}`;
  return `Numbers ${list.format || '1'}${list.suffix ?? '.'}`;
}

/** Summary lines for the General section. */
function summaryOf(kind, attrs) {
  const out = [];
  const face = attrs.fontWeight != null || attrs.fontStyle != null ? styleName(attrs.fontWeight ?? 400, attrs.fontStyle ?? 'normal') : null;
  for (const sec of SECTIONS) {
    if (!sec.fields || (sec.para && kind !== 'para')) continue;
    const parts = [];
    for (const f of sec.fields) {
      if (f.type === 'face') {
        if (face) parts.push(face);
        continue;
      }
      if (f.key in attrs) parts.push(`${f.label}: ${describe(f, attrs[f.key])}`);
    }
    if (parts.length) out.push({ label: sec.label, text: parts.join('; ') });
  }
  return out;
}

/**
 * Open Style Options for an existing style, or for a new one (`draft`
 * given). Changes preview live on every text using the style; Cancel rolls
 * them back. Resolves true when committed.
 */
export async function openStyleOptions(app, kind, id, { draft = null, applyNew = false } = {}) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const lists = styleLists(doc);
  const orig = draft || findStyle(lists[kind], id);
  if (!orig) return false;
  const isNew = Boolean(draft);
  const isNormal = orig.id === NORMAL;
  let name = orig.name;
  let basedOn = orig.basedOn || null;
  const attrs = { ...orig.attrs };
  const k = KINDS[kind];
  const tx = doc.begin(isNew ? `New ${k.one}` : `${k.one} Options`);
  const originals = new Map();
  for (const n of doc.leaves()) if (n.type === 'text') originals.set(n.id, n);
  const origRoot = { charStyles: doc.root.charStyles, paraStyles: doc.root.paraStyles };
  let previewOn = true;

  const listsWith = () => {
    const style = { ...orig, name, basedOn, attrs: { ...attrs } };
    const list = isNew ? [...lists[kind], style] : lists[kind].map((s) => (s.id === orig.id ? style : s));
    return { ...lists, [kind]: list };
  };
  const preview = (force = false) => {
    if (!previewOn && !force) {
      doc.updateRoot(origRoot);
      for (const [nid, n] of originals) if (doc.get(nid) !== n && doc.has(nid)) doc.update(nid, styleFields(n));
      return;
    }
    const next = listsWith();
    doc.updateRoot(rootPatch(next));
    for (const [nid, n] of originals) {
      if (!doc.has(nid) || n.threadPrev) continue;
      const patch = restyleNode(n, { oldLists: lists, newLists: next });
      if (patch) doc.update(nid, patch);
      else if (doc.get(nid) !== n) doc.update(nid, styleFields(n));
    }
  };

  // ---- form ----
  const inherited = () => inheritedAttrs(listsWith(), kind, { ...orig, basedOn });
  const controls = [];
  let fid = 0;
  const nameIn = h('input', { type: 'text', id: 'so-name', value: name, autocomplete: 'off', spellcheck: false });
  nameIn.addEventListener('input', () => {
    name = nameIn.value;
  });
  const basedSel = h('select', { id: 'so-based' });
  const fillBased = () => {
    const list = listsWith()[kind];
    const opts = [h('option', { value: '' }, kind === 'para' ? (isNormal ? 'No style' : 'Normal Paragraph Style') : 'No style')];
    for (const s of list) {
      if (s.id === orig.id || s.id === NORMAL) continue;
      const bad = wouldCycle(list, orig.id, s.id, kind === 'para');
      opts.push(h('option', { value: s.id, disabled: bad }, s.name + (bad ? ' (based on this style)' : '')));
    }
    basedSel.replaceChildren(...opts);
    basedSel.value = basedOn || '';
  };
  fillBased();
  basedSel.disabled = isNormal;
  basedSel.addEventListener('change', () => {
    basedOn = basedSel.value || null;
    refreshAll();
    preview();
  });
  const summary = h('dl.so-summary');
  const resetBtn = h('button.btn.small', { type: 'button' }, 'Reset to Base');
  resetBtn.addEventListener('click', () => {
    for (const key of Object.keys(attrs)) delete attrs[key];
    refreshAll();
    preview();
  });

  const fieldControl = (f) => {
    const cid = `so-${++fid}`;
    const inh = () => inherited();
    let el;
    let refresh;
    const changed = () => {
      refreshSummary();
      preview();
    };
    if (f.type === 'pt' || f.type === 'number' || f.type === 'percent' || f.type === 'angle') {
      const input = h('input', { type: 'text', id: cid, inputmode: 'decimal', autocomplete: 'off', spellcheck: false });
      const fmt = (v) => (f.type === 'pt' ? describe(f, v) : f.type === 'percent' ? `${v}%` : f.type === 'angle' ? `${v}°` : String(v));
      refresh = () => {
        input.value = f.key in attrs ? fmt(attrs[f.key]) : '';
        const iv = inh()[f.key];
        input.placeholder = iv === undefined ? 'Not set' : fmt(iv);
      };
      input.addEventListener('change', () => {
        const t = input.value.trim();
        if (!t) delete attrs[f.key];
        else if (f.auto && /^auto$/i.test(t)) attrs[f.key] = null;
        else {
          const v = f.type === 'pt' ? parseLength(t, 'pt') : parseNumber(t.replace(/[%°]/g, ''));
          if (Number.isFinite(v)) attrs[f.key] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v));
        }
        refresh();
        changed();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const base = typeof attrs[f.key] === 'number' ? attrs[f.key] : typeof inh()[f.key] === 'number' ? inh()[f.key] : 0;
        const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1) * (f.type === 'number' ? 10 : 1);
        attrs[f.key] = Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, base + step));
        refresh();
        changed();
      });
      el = input;
    } else if (f.type === 'select' || f.type === 'family' || f.type === 'face') {
      const sel = h('select', { id: cid });
      const options = () => {
        if (f.type === 'family') return allFamilies().map((fam) => ({ value: fam.family, label: fam.family }));
        if (f.type === 'face') {
          const fam = attrs.fontFamily ?? inh().fontFamily;
          return (fam ? familyFaces(fam) : [{ weight: 400, style: 'normal' }]).map((fc) => ({ value: `${fc.weight}|${fc.style}`, label: styleName(fc.weight, fc.style) }));
        }
        return f.options;
      };
      const ownValue = () => (f.type === 'face' ? (attrs.fontWeight != null || attrs.fontStyle != null ? `${attrs.fontWeight ?? inh().fontWeight ?? 400}|${attrs.fontStyle ?? inh().fontStyle ?? 'normal'}` : undefined) : attrs[f.key]);
      const inhLabel = () => {
        const iv = f.type === 'face' ? (inh().fontWeight != null || inh().fontStyle != null ? styleName(inh().fontWeight ?? 400, inh().fontStyle ?? 'normal') : undefined) : inh()[f.key];
        if (iv === undefined) return 'Not set';
        if (f.type === 'face' || f.type === 'family') return `Inherit (${iv})`;
        return `Inherit (${describe(f, iv)})`;
      };
      refresh = () => {
        const opts = options();
        const own = ownValue();
        const enc = (v) => JSON.stringify(v);
        const list = [h('option', { value: '' }, inhLabel()), ...opts.map((o) => h('option', { value: enc(o.value) }, o.label))];
        if (own !== undefined && !opts.some((o) => eq(o.value, own))) list.push(h('option', { value: enc(own) }, String(own)));
        sel.replaceChildren(...list);
        sel.value = own === undefined ? '' : enc(own);
      };
      sel.addEventListener('change', () => {
        if (!sel.value) {
          if (f.type === 'face') {
            delete attrs.fontWeight;
            delete attrs.fontStyle;
          } else delete attrs[f.key];
        } else {
          const v = JSON.parse(sel.value);
          if (f.type === 'face') {
            const [w, s] = v.split('|');
            attrs.fontWeight = Number(w);
            attrs.fontStyle = s;
          } else attrs[f.key] = v;
        }
        if (f.type === 'family') controls.forEach((c) => c.f.type === 'face' && c.refresh());
        changed();
      });
      el = sel;
    } else if (f.type === 'paint') {
      const mode = h('select', { id: cid, 'aria-label': `${f.label} paint` });
      const color = h('input', { type: 'color', 'aria-label': `${f.label} color` });
      refresh = () => {
        const own = attrs[f.key];
        const iv = inh()[f.key];
        mode.replaceChildren(h('option', { value: '' }, iv === undefined ? 'Not set' : `Inherit (${describe(f, iv)})`), h('option', { value: 'none' }, 'None'), h('option', { value: 'color' }, 'Color'), ...(own && own.type !== 'solid' ? [h('option', { value: 'keep' }, 'Gradient')] : []));
        mode.value = own === undefined ? '' : own === null ? 'none' : own.type === 'solid' ? 'color' : 'keep';
        const shown = own?.type === 'solid' ? own.color : iv?.type === 'solid' ? iv.color : '#000000';
        color.value = /^#[0-9a-f]{6}$/i.test(shown) ? shown : '#000000';
        color.disabled = mode.value !== 'color';
      };
      mode.addEventListener('change', () => {
        if (!mode.value) delete attrs[f.key];
        else if (mode.value === 'none') attrs[f.key] = null;
        else if (mode.value === 'color') attrs[f.key] = { type: 'solid', color: color.value };
        refresh();
        changed();
      });
      color.addEventListener('input', () => {
        attrs[f.key] = { type: 'solid', color: color.value };
        mode.value = 'color';
        changed();
      });
      el = h('div.so-paint', mode, color);
    } else if (f.type === 'tabs') {
      const info = h('p.so-note', { id: cid });
      const useBtn = h('button.btn.small', { type: 'button' }, 'Use Selection’s Tabs');
      const clearBtn = h('button.btn.small', { type: 'button' }, 'No Tab Stops');
      const inheritBtn = h('button.btn.small', { type: 'button' }, 'Inherit');
      refresh = () => {
        info.textContent = f.key in attrs ? describeTabs(attrs[f.key]) : `Inherit (${describeTabs(inh()[f.key])})`;
      };
      useBtn.addEventListener('click', () => {
        const p = currentAttrs(app).para;
        attrs.tabs = p.tabs === MIXED ? null : p.tabs ?? null;
        refresh();
        changed();
      });
      clearBtn.addEventListener('click', () => {
        attrs.tabs = null;
        refresh();
        changed();
      });
      inheritBtn.addEventListener('click', () => {
        delete attrs.tabs;
        refresh();
        changed();
      });
      el = h('div.so-tabs', info, h('div.so-btns', useBtn, clearBtn, inheritBtn));
    } else if (f.type === 'list') {
      const kindSel = h('select', { id: cid });
      const bullet = h('input', { type: 'text', 'aria-label': 'Bullet character', maxlength: 2, size: 2, autocomplete: 'off', spellcheck: false });
      const format = h('select', { 'aria-label': 'Number format' }, [['1', '1, 2, 3'], ['a', 'a, b, c'], ['A', 'A, B, C'], ['i', 'i, ii, iii'], ['I', 'I, II, III']].map(([v, l]) => h('option', { value: v }, l)));
      const start = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Start at', size: 3, autocomplete: 'off' });
      const bulletRow = h('label.so-inline', 'Bullet ', bullet);
      const numRow = h('div.so-inline', h('label', 'Format ', format), h('label', 'Start at ', start));
      refresh = () => {
        const own = attrs.list;
        kindSel.replaceChildren(h('option', { value: '' }, `Inherit (${describeList(inh().list)})`), h('option', { value: 'none' }, 'None'), h('option', { value: 'bullet' }, 'Bullets'), h('option', { value: 'number' }, 'Numbers'));
        kindSel.value = own === undefined ? '' : own === null ? 'none' : own.kind;
        const shown = own || inh().list || {};
        bullet.value = shown.bullet || '•';
        format.value = shown.format || '1';
        start.value = String(shown.start ?? 1);
        bulletRow.hidden = kindSel.value !== 'bullet';
        numRow.hidden = kindSel.value !== 'number';
      };
      const write = () => {
        const v = kindSel.value;
        if (!v) delete attrs.list;
        else if (v === 'none') attrs.list = null;
        else if (v === 'bullet') attrs.list = { kind: 'bullet', bullet: bullet.value || '•' };
        else attrs.list = { kind: 'number', format: format.value, suffix: '.', start: Math.max(0, Math.round(parseNumber(start.value) || 1)) };
        refresh();
        changed();
      };
      kindSel.addEventListener('change', write);
      bullet.addEventListener('change', write);
      format.addEventListener('change', write);
      start.addEventListener('change', write);
      el = h('div.so-list', kindSel, bulletRow, numRow);
    }
    const row = h('div.form-row', h('label', { for: cid }, f.label), el);
    const c = { f, refresh, row };
    controls.push(c);
    return row;
  };

  const refreshSummary = () => {
    const rows = summaryOf(kind, attrs);
    summary.replaceChildren(...(rows.length ? rows.flatMap((r) => [h('dt', r.label), h('dd', r.text)]) : [h('dd.so-empty', isNormal ? 'Factory defaults.' : basedOn ? 'Same as the style it is based on.' : kind === 'char' ? 'Sets no attributes.' : 'Same as the Normal Paragraph Style.')]));
  };
  const refreshAll = () => {
    fillBased();
    for (const c of controls) c.refresh();
    refreshSummary();
  };

  const sections = SECTIONS.filter((s) => !s.para || kind === 'para');
  const nav = h('div.so-nav', { role: 'tablist', 'aria-label': 'Style option sections', 'aria-orientation': 'vertical' });
  const pages = h('div.so-pages');
  const tabs = [];
  sections.forEach((sec, i) => {
    const pageId = `so-page-${sec.id}`;
    const tab = h('button.so-tab', { type: 'button', role: 'tab', id: `so-tab-${sec.id}`, 'aria-controls': pageId, 'aria-selected': String(i === 0), tabindex: i === 0 ? '0' : '-1' }, sec.label);
    const content =
      sec.id === 'general'
        ? [
            h('div.form-row', h('label', { for: 'so-name' }, 'Style Name'), nameIn),
            h('div.form-row', h('label', { for: 'so-based' }, 'Based On'), basedSel),
            h('h3.form-heading', 'Settings'),
            summary,
            h('div.so-btns', resetBtn),
          ]
        : sec.fields.map(fieldControl);
    const page = h('div.so-page', { role: 'tabpanel', id: pageId, 'aria-labelledby': `so-tab-${sec.id}`, hidden: i !== 0 }, h('h3.form-heading.so-page-title', sec.label), ...content);
    const select = () => {
      tabs.forEach((t, j) => {
        t.tab.setAttribute('aria-selected', String(j === i));
        t.tab.tabIndex = j === i ? 0 : -1;
        t.page.hidden = j !== i;
      });
    };
    tab.addEventListener('click', select);
    tab.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const j = (i + d + tabs.length) % tabs.length;
      tabs[j].tab.focus();
      tabs[j].tab.click();
    });
    tabs.push({ tab, page });
    nav.append(tab);
    pages.append(page);
  });
  const previewBox = h('input', { type: 'checkbox', id: 'so-preview', checked: true });
  previewBox.addEventListener('change', () => {
    previewOn = previewBox.checked;
    preview();
  });
  const note = h('p.form-help', 'Blank fields inherit from the style this one is based on.');
  const body = h('div.style-options', h('div.so-main', nav, pages), note, h('div.form-row.check', previewBox, h('label', { for: 'so-preview' }, 'Preview')));
  refreshAll();

  let ok = false;
  try {
    ok = await app.dialogs.open({
      title: `${k.one} Options`,
      className: 'wide style-options-dialog',
      body,
      buttons: [
        { label: 'Cancel', value: false },
        {
          label: 'OK',
          primary: true,
          value: true,
          validate: () => {
            if (!name.trim()) {
              tabs[0].tab.click();
              nameIn.focus();
              return false;
            }
            return true;
          },
        },
      ],
      initialFocus: () => nameIn,
    });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!ok) {
    tx.cancel();
    return false;
  }
  name = uniqueName(
    listsWith()[kind].filter((s) => s.id !== orig.id),
    name.trim(),
  );
  previewOn = true;
  preview(true);
  if (isNew && applyNew) applyInTx(app, kind, orig.id);
  tx.commit();
  syncDefaults(app, kind, orig.id, styleLists(doc));
  session(app)?.changed();
  return true;
}

function styleFields(n) {
  return { runs: n.runs, paras: n.paras, para: n.para, char: n.char, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth };
}

/** New style through the options dialog, prefilled from the current text. */
export function newStyleWithOptions(app, kind) {
  const doc = app.editor?.doc;
  if (!doc) return Promise.resolve(false);
  const lists = styleLists(doc);
  const draft = { id: newStyleId(kind), name: nextStyleName(lists[kind], kind), basedOn: null, attrs: attrsFromSelection(app, kind, lists) };
  return openStyleOptions(app, kind, draft.id, { draft, applyNew: target(app).mode !== 'defaults' });
}

// ---- panels ----

registerIcons({
  'clear-overrides': [['path', { d: 'M4 6h11M9.5 6v12' }], ['path', { d: 'M14 14l6 6M20 14l-6 6' }]],
  'style-new': [['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }], ['path', { d: 'M12 8v8M8 12h8' }]],
});

class StylesPanel extends Panel {
  static kind = 'char';
  static placement = 'strip';

  get kind() {
    return this.constructor.kind;
  }

  build() {
    const k = KINDS[this.kind];
    this.selected = new Set();
    this.focusId = null;
    this.list = h('div.st-list', { role: 'listbox', 'aria-label': k.title, 'aria-multiselectable': 'true', tabindex: '-1' });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    this.note = h('p.panel-note.st-note', { 'aria-live': 'polite' });
    this.clearBtn = iconButton('clear-overrides', 'Clear Overrides', () => clearOverrides(this.app, this.kind), { className: 'small' });
    this.redefineBtn = iconButton('refresh-cw', `Redefine ${k.one}`, () => this.redefine(), { className: 'small' });
    this.newBtn = iconButton('plus', `Create New Style (Alt-click for options)`, (e) => (e.altKey ? newStyleWithOptions(this.app, this.kind) : newStyle(this.app, this.kind)), { className: 'small' });
    this.delBtn = iconButton('trash', `Delete ${k.one}`, () => this.deleteSelected(), { className: 'small' });
    this.el.append(this.list, this.note, h('div.st-footer', h('span.st-spacer'), this.clearBtn, this.redefineBtn, this.newBtn, this.delBtn));
    this.syncRows();
  }

  update() {
    const ed = this.app.editor;
    this.el.classList.toggle('disabled', !ed);
    if (!ed) {
      this.list.replaceChildren(h('p.panel-empty', 'No document'));
      this.state = null;
      return;
    }
    const lists = styleLists(ed.doc);
    const state = currentStyleState(this.app, this.kind);
    const key = [ed.doc.root.charStyles, ed.doc.root.paraStyles, state.id, state.override, state.mode, [...this.selected].join()];
    if (this.renderKey && key.every((v, i) => v === this.renderKey[i]) && this.renderedFor === ed) return;
    this.renderKey = key;
    this.renderedFor = ed;
    this.state = state;
    this.render(lists[this.kind], state);
  }

  render(list, state) {
    const large = this.largeRows();
    const valid = new Set(list.map((s) => s.id));
    for (const id of [...this.selected]) if (!valid.has(id)) this.selected.delete(id);
    if (!valid.has(this.focusId)) this.focusId = state.id && state.id !== MIXED ? state.id : NORMAL;
    const items = list.map((s) => {
      const active = state.id === s.id;
      const label = s.name + (active && state.override ? ' (with overrides)' : '');
      const el = h(
        'div.st-item',
        {
          role: 'option',
          tabindex: s.id === this.focusId ? '0' : '-1',
          'aria-selected': String(this.selected.has(s.id) || (active && !this.selected.size)),
          'aria-label': label,
          'data-id': s.id,
        },
        h('span.st-name', { style: large ? previewCss(this.kind === 'char' ? resolveChar(list, s.id) : resolvePara(list, s.id)) : null }, s.id === NORMAL ? `[${s.name}]` : s.name),
        active && state.override ? h('span.st-plus', { 'aria-hidden': 'true', 'data-tip': 'The text differs from the style' }, '+') : null,
      );
      el.classList.toggle('active', active);
      el.classList.toggle('normal', s.id === NORMAL);
      el.addEventListener('click', (e) => this.onClick(s, e));
      el.addEventListener('dblclick', () => openStyleOptions(this.app, this.kind, s.id));
      el.addEventListener('focus', () => (this.focusId = s.id));
      return el;
    });
    this.list.replaceChildren(...items);
    const editing = state.mode === 'session' || state.mode === 'objects';
    this.clearBtn.disabled = !editing || !state.override;
    this.redefineBtn.disabled = !editing || !state.override || state.id === MIXED;
    const deletable = this.deletable();
    this.delBtn.disabled = !deletable.length;
    this.note.textContent = state.id === MIXED ? 'The selection uses several styles.' : state.mode === 'defaults' ? 'Choose a style for new type.' : '';
  }

  deletable() {
    const ids = this.selected.size ? [...this.selected] : this.focusId ? [this.focusId] : [];
    return ids.filter((id) => id !== NORMAL);
  }

  onClick(s, e) {
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) {
      if (e.shiftKey && this.focusId) {
        const list = styleLists(this.app.editor.doc)[this.kind].map((x) => x.id);
        const [i, j] = [list.indexOf(this.focusId), list.indexOf(s.id)].sort((a, b) => a - b);
        for (const id of list.slice(i, j + 1)) this.selected.add(id);
      } else if (this.selected.has(s.id)) this.selected.delete(s.id);
      else this.selected.add(s.id);
      this.focusId = s.id;
      this.renderKey = null;
      this.update();
      return;
    }
    this.selected = new Set([s.id]);
    this.focusId = s.id;
    applyStyle(this.app, this.kind, s.id, { clear: e.altKey });
    this.renderKey = null;
    this.update();
    this.list.querySelector(`[data-id="${CSS.escape(s.id)}"]`)?.focus();
  }

  onKey(e) {
    const items = [...this.list.querySelectorAll('.st-item')];
    if (!items.length) return;
    const i = Math.max(0, items.findIndex((el) => el.dataset.id === this.focusId));
    let j = null;
    if (e.key === 'ArrowDown') j = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j != null) {
      e.preventDefault();
      e.stopPropagation();
      items[i].tabIndex = -1;
      items[j].tabIndex = 0;
      items[j].focus();
      this.focusId = items[j].dataset.id;
      if (e.shiftKey) {
        this.selected.add(this.focusId);
        items[j].setAttribute('aria-selected', 'true');
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const s = findStyle(styleLists(this.app.editor.doc)[this.kind], this.focusId);
      if (s) this.onClick(s, { altKey: e.altKey });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      this.deleteSelected();
    } else if (e.key === 'F2' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      openStyleOptions(this.app, this.kind, this.focusId);
    }
  }

  redefine() {
    if (!redefineStyle(this.app, this.kind)) this.app.notify('The selection already matches its style.');
  }

  async deleteSelected() {
    const app = this.app;
    const ids = this.deletable();
    if (!ids.length) return;
    const doc = app.editor.doc;
    const used = usedStyles(doc)[this.kind];
    const lists = styleLists(doc);
    let replaceWith = null;
    if (ids.some((id) => used.has(id))) {
      const k = KINDS[this.kind];
      const names = ids.map((id) => findStyle(lists[this.kind], id)?.name).filter(Boolean);
      const v = await app.dialogs.form({
        title: `Delete ${ids.length > 1 ? k.title : k.one}`,
        description: `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} in use. Text using ${names.length > 1 ? 'them' : 'it'} can keep its look without a style, or take another style.`,
        okLabel: 'Delete',
        fields: [
          {
            key: 'replace',
            type: 'select',
            label: 'Text Using It',
            value: '',
            options: [{ value: '', label: 'Keep its attributes (no style)' }, ...lists[this.kind].filter((s) => !ids.includes(s.id)).map((s) => ({ value: s.id, label: `Apply ${s.name}` }))],
          },
        ],
      });
      if (!v) return;
      replaceWith = v.replace || null;
    }
    deleteStyles(app, this.kind, ids, { replaceWith });
    this.selected.clear();
    session(app)?.changed();
  }

  menu() {
    const app = this.app;
    const k = KINDS[this.kind];
    const doc = app.editor?.doc;
    if (!this.built) this.ensureBuilt();
    const focus = this.focusId || NORMAL;
    const state = doc ? currentStyleState(app, this.kind) : { mode: 'none' };
    const editing = state.mode === 'session' || state.mode === 'objects';
    const others = app.editors.filter((ed) => ed.doc !== doc);
    const large = this.largeRows();
    return [
      { label: `New ${k.one}...`, enabled: Boolean(doc), run: () => newStyleWithOptions(app, this.kind) },
      { label: `Duplicate ${k.one}`, enabled: Boolean(doc && focus), run: () => duplicateStyle(app, this.kind, focus) },
      { label: `Delete ${k.one}`, enabled: Boolean(doc) && this.deletable().length > 0, run: () => this.deleteSelected() },
      '-',
      { label: 'Redefine Style', enabled: editing && state.override && state.id !== MIXED, run: () => this.redefine() },
      { label: 'Clear Overrides', enabled: editing && state.override, run: () => clearOverrides(app, this.kind) },
      { label: `Apply ${k.one} Clearing Overrides`, enabled: editing && Boolean(focus), run: () => applyStyle(app, this.kind, focus, { clear: true }) },
      { label: `${k.one} Options...`, enabled: Boolean(doc && focus), run: () => openStyleOptions(app, this.kind, focus) },
      '-',
      {
        label: 'Select All Unused',
        enabled: Boolean(doc),
        run: () => {
          const ids = unusedStyles(app.editor.doc, this.kind);
          this.selected = new Set(ids);
          this.renderKey = null;
          this.update();
          app.notify(ids.length ? `${ids.length} unused ${ids.length === 1 ? 'style' : 'styles'} selected.` : 'Every style is in use.', { polite: true });
        },
      },
      { label: 'Sort by Name', enabled: Boolean(doc), run: () => sortStyles(app, this.kind) },
      '-',
      {
        label: `Load ${k.title}`,
        submenu: [
          ...others.map((ed) => ({ label: ed.name || ed.doc.root.name || 'Untitled', enabled: Boolean(doc), run: () => this.loadFrom(styleLists(ed.doc), ed.name || 'the document') })),
          ...(others.length ? ['-'] : []),
          { label: 'From a File...', enabled: Boolean(doc), run: () => this.loadFromFile() },
        ],
      },
      '-',
      { label: 'Small List Rows', checked: !large, run: () => this.setLargeRows(false) },
      { label: 'Large List Rows', checked: large, run: () => this.setLargeRows(true) },
    ];
  }

  largeRows() {
    return this.app.prefs.get('stylesRows') === 'large';
  }

  setLargeRows(on) {
    this.app.prefs.set('stylesRows', on ? 'large' : 'small');
    this.syncRows();
  }

  /** Large rows preview each style in its own font. */
  syncRows() {
    this.el.classList.toggle('st-large', this.largeRows());
    this.renderKey = null;
    if (this.visible) this.update();
  }

  /** Bring in the styles of another document; same-named styles take the loaded definitions. */
  loadFrom(lists, from) {
    const r = loadStyles(this.app, this.kind, lists);
    const k = KINDS[this.kind];
    if (!r) return;
    const parts = [];
    if (r.added) parts.push(`${r.added} added`);
    if (r.replaced) parts.push(`${r.replaced} redefined`);
    this.app.notify(parts.length ? `${k.title} from ${from}: ${parts.join(', ')}.` : `${from} has no ${k.title.toLowerCase()} to load.`, { polite: true });
    session(this.app)?.changed();
  }

  loadFromFile() {
    const input = h('input', { type: 'file', accept: '.vstudio,application/octet-stream,application/json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      try {
        const { parseDocument } = await import('../files/format.js');
        const { doc } = await parseDocument(new Uint8Array(await file.arrayBuffer()));
        this.loadFrom(styleLists(doc), file.name);
      } catch (err) {
        this.app.notify(err?.message || 'The file could not be read.');
      }
    });
    document.body.append(input);
    input.click();
  }
}

export class CharacterStylesPanel extends StylesPanel {
  static id = 'characterStyles';
  static title = 'Character Styles';
  static icon = 'letter-text';
  static kind = 'char';
}

export class ParagraphStylesPanel extends StylesPanel {
  static id = 'paragraphStyles';
  static title = 'Paragraph Styles';
  static icon = 'pilcrow';
  static kind = 'para';
}

export { chainOf, resolvePara, resolveChar };
