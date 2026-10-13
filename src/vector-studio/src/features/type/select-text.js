/**
 * Select > Same text attributes (font family, family and style, family,
 * style and size, size, text fill, text stroke, fill and stroke, all of
 * them) and Select > Object
 * > Point Type Objects / Area Type Objects.
 *
 * A type object can mix styles, so each object contributes the set of
 * attribute combinations its characters use; objects that share any
 * combination with the first selected type object are selected.
 */
import { UserError } from '../../lib/errors.js';
import { styledRuns, baseStyle } from '../../model/text-runs.js';
import { selectedTextNodes } from './outlines.js';
import { headOf } from './thread-model.js';

const paintKey = (p) => (p ? JSON.stringify(p.type === 'solid' ? { t: 'solid', c: String(p.color).toLowerCase() } : { t: p.type, s: p.stops }) : 'none');

export const SAME_TEXT = {
  text: { label: 'Text', key: (s) => [s.fontFamily, s.fontWeight, s.fontStyle, s.fontSize, paintKey(s.fill), paintKey(s.stroke)].join('|') },
  fontFamily: { label: 'Font Family', key: (s) => s.fontFamily },
  fontStyle: { label: 'Font Family and Style', key: (s) => [s.fontFamily, s.fontWeight, s.fontStyle].join('|') },
  fontSize: { label: 'Font Family, Style and Size', key: (s) => [s.fontFamily, s.fontWeight, s.fontStyle, s.fontSize].join('|') },
  size: { label: 'Font Size', key: (s) => String(s.fontSize) },
  textFill: { label: 'Text Fill Color', key: (s) => paintKey(s.fill) },
  textStroke: { label: 'Text Stroke Color', key: (s) => paintKey(s.stroke) },
  textFillStroke: { label: 'Text Fill & Stroke Color', key: (s) => `${paintKey(s.fill)}|${paintKey(s.stroke)}` },
};

/** Attribute combinations a text object's characters use. */
export function textKeys(node, key) {
  const out = new Set();
  if (!node.text) out.add(key(baseStyle(node)));
  else for (const r of styledRuns(node)) if (r.end > r.start) out.add(key(r.style));
  return out;
}

function textLeaves(doc) {
  const out = [];
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type === 'text') out.push(n);
    return true;
  });
  return out;
}

export function selectSameText(editor, what) {
  const def = SAME_TEXT[what];
  const first = selectedTextNodes(editor)[0];
  if (!first) throw new UserError('Select a type object to match.');
  // Threaded frames match on their story's styles.
  const want = textKeys(headOf(editor.doc, first), def.key);
  const ids = textLeaves(editor.doc)
    .filter((n) => {
      for (const k of textKeys(headOf(editor.doc, n), def.key)) if (want.has(k)) return true;
      return false;
    })
    .map((n) => n.id);
  editor.select(ids);
}

/** Select > Object > Point Type Objects ('point') or Area Type Objects ('area'). */
export function selectTypeKind(editor, kind) {
  editor.select(textLeaves(editor.doc).filter((n) => (n.kind || 'point') === kind).map((n) => n.id));
}

export function installSelectText(app) {
  const hasType = (a) => Boolean(a.editor) && selectedTextNodes(a.editor).length > 0;
  const endEditing = (a) => a.typeSession && !a.typeSession.ended && a.tool?.endEditing?.({ select: true });
  app.commands.register([
    ...Object.entries(SAME_TEXT).map(([what, def]) => ({
      id: `select.same.${what}`,
      label: def.label,
      enabled: hasType,
      run: (a) => {
        endEditing(a);
        selectSameText(a.editor, what);
      },
    })),
    { id: 'select.object.pointType', label: 'Point Type Objects', enabled: (a) => Boolean(a.editor), run: (a) => (endEditing(a), selectTypeKind(a.editor, 'point')) },
    { id: 'select.object.areaType', label: 'Area Type Objects', enabled: (a) => Boolean(a.editor), run: (a) => (endEditing(a), selectTypeKind(a.editor, 'area')) },
  ]);
}
