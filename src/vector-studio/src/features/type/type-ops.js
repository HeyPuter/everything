/**
 * Type operations shared by the panels, menus and shortcuts: read and apply
 * character and paragraph styles to "the current text", which is the
 * selected characters while editing, the insertion point (a pending style
 * for the next typed characters), the selected text objects, or, with
 * nothing selected, the defaults for new type.
 */
import { DEFAULT_CHAR, DEFAULT_PARA, NEW_PARA } from '../../model/nodes.js';
import {
  rangeStyle,
  applyRunStyle,
  wholeStylePatch,
  paraStylePatch,
  rangeParaStyle,
  paragraphIndexAt,
  paragraphRanges,
  replaceRange,
  RUN_KEYS,
  PARA_KEYS,
  MIXED,
  changeCase,
} from '../../model/text-runs.js';
import { selectedTextNodes } from './outlines.js';
import { headOf } from './thread-model.js';

/** Selected text objects as stories: a threaded frame stands for its thread's first frame, which holds the text. */
function storyNodes(ed) {
  const out = [];
  const seen = new Set();
  for (const n of selectedTextNodes(ed)) {
    const h = headOf(ed.doc, n);
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
}

export { MIXED };

/** The active editing session (or null). */
export function session(app) {
  const s = app.typeSession;
  return s && s.editor === app.editor && app.editor?.textEdit ? s : null;
}

export function typeDefaults(app) {
  if (!app.typeDefaults) {
    app.typeDefaults = {
      char: { ...DEFAULT_CHAR },
      para: { ...NEW_PARA },
      fill: { type: 'solid', color: '#000000' },
      stroke: null,
      strokeWidth: 1,
    };
  }
  return app.typeDefaults;
}

function mergeCommon(acc, s, keys) {
  if (!acc) return { ...s };
  for (const k of keys) if (acc[k] !== MIXED && JSON.stringify(acc[k] ?? null) !== JSON.stringify(s[k] ?? null)) acc[k] = MIXED;
  return acc;
}

/** Character style (plus fill/stroke) of the current text; values may be MIXED. */
export function currentCharStyle(app) {
  const s = session(app);
  if (s) {
    const node = s.node();
    if (!node) return null;
    const [a, b] = s.range();
    const st = rangeStyle(node, a, b);
    return a === b && s.pending ? { ...st, ...s.pending } : st;
  }
  const ed = app.editor;
  const nodes = ed ? storyNodes(ed) : [];
  if (nodes.length) {
    let acc = null;
    for (const n of nodes) acc = mergeCommon(acc, rangeStyle(n, 0, Math.max(1, n.text.length)), RUN_KEYS);
    return acc;
  }
  const d = typeDefaults(app);
  return { ...d.char, fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth };
}

/** Paragraph style of the current text; values may be MIXED. */
export function currentParaStyle(app) {
  const s = session(app);
  if (s) {
    const node = s.node();
    if (!node) return null;
    const [a, b] = s.range();
    return rangeParaStyle(node, paragraphIndexAt(node.text, a), paragraphIndexAt(node.text, b));
  }
  const ed = app.editor;
  const nodes = ed ? storyNodes(ed) : [];
  if (nodes.length) {
    let acc = null;
    for (const n of nodes) acc = mergeCommon(acc, rangeParaStyle(n, 0, paragraphRanges(n.text).length - 1), PARA_KEYS);
    return acc;
  }
  return { ...typeDefaults(app).para };
}

/** The text objects the current text lives in. */
export function currentTextNodes(app) {
  const s = session(app);
  if (s) return s.node() ? [s.node()] : [];
  return app.editor ? selectedTextNodes(app.editor) : [];
}

/**
 * Apply a character (or paint) patch to the current text. `coalesce` merges
 * repeated changes (scrubbing, arrow steps) into one undo step.
 */
export function applyCharStyle(app, patch, { label = 'Character', coalesce = null } = {}) {
  const s = session(app);
  const ed = app.editor;
  if (s) {
    const node = s.node();
    if (!node) return;
    const [a, b] = s.range();
    if (a === b) {
      s.setPending({ ...(s.pending || {}), ...patch });
      if (!node.text.length) {
        ed.doc.transact(label, () => ed.doc.update(node.id, wholeStylePatch(node, patch)), { coalesce });
      }
      return;
    }
    ed.doc.transact(label, () => ed.doc.update(node.id, { runs: applyRunStyle(node, a, b, patch) }), { coalesce });
    s.changed();
    return;
  }
  const nodes = ed ? storyNodes(ed) : [];
  if (nodes.length) {
    ed.doc.transact(
      label,
      () => {
        for (const n of nodes) ed.doc.update(n.id, wholeStylePatch(ed.doc.get(n.id), patch));
      },
      { coalesce },
    );
    return;
  }
  const d = typeDefaults(app);
  for (const k in patch) {
    if (k === 'fill' || k === 'stroke' || k === 'strokeWidth') d[k] = patch[k];
    else d.char = { ...d.char, [k]: patch[k] };
  }
  app.dock?.update();
}

/** Apply a paragraph patch to the paragraphs of the current text. */
export function applyParaStyle(app, patch, { label = 'Paragraph', coalesce = null } = {}) {
  const s = session(app);
  const ed = app.editor;
  if (s) {
    const node = s.node();
    if (!node) return;
    const [a, b] = s.range();
    const p0 = paragraphIndexAt(node.text, a);
    const p1 = paragraphIndexAt(node.text, b);
    ed.doc.transact(label, () => ed.doc.update(node.id, paraStylePatch(node, p0, p1, patch)), { coalesce });
    s.changed();
    return;
  }
  const nodes = ed ? storyNodes(ed) : [];
  if (nodes.length) {
    ed.doc.transact(
      label,
      () => {
        for (const n of nodes) {
          const cur = ed.doc.get(n.id);
          ed.doc.update(n.id, paraStylePatch(cur, 0, paragraphRanges(cur.text).length - 1, patch));
        }
      },
      { coalesce },
    );
    return;
  }
  const d = typeDefaults(app);
  d.para = { ...d.para, ...patch };
  app.dock?.update();
}

/** Type > Change Case for the selected characters or text objects. */
export function applyCase(app, mode) {
  const s = session(app);
  const ed = app.editor;
  const labels = { upper: 'UPPERCASE', lower: 'lowercase', title: 'Title Case', sentence: 'Sentence case' };
  const label = `Change Case to ${labels[mode] || mode}`;
  if (s) {
    const node = s.node();
    let [a, b] = s.range();
    if (a === b) {
      a = 0;
      b = node.text.length;
    }
    const seg = changeCase(node.text.slice(a, b), mode);
    ed.doc.transact(label, () => ed.doc.update(node.id, { text: node.text.slice(0, a) + seg + node.text.slice(b) }));
    s.changed();
    return;
  }
  const nodes = ed ? storyNodes(ed) : [];
  if (!nodes.length) return;
  ed.doc.transact(label, () => {
    for (const n of nodes) ed.doc.update(n.id, { text: changeCase(n.text, mode) });
  });
}

/** Replace a range of a text node (keeps runs and paragraph styles in step). */
export function replaceIn(doc, node, a, b, text, label = 'Replace', opts = {}) {
  doc.transact(label, () => doc.update(node.id, replaceRange(node, a, b, text, opts.overrides || null)), { coalesce: opts.coalesce || null });
}
