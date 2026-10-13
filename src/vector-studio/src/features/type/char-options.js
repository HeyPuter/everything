/**
 * More character and paragraph options: underline and strikethrough
 * options (weight, offset, color, dashes) with a live preview, standard
 * vertical Roman alignment, tate-chu-yoko, anti-aliasing of type objects in
 * raster export, the font height reference of the size field, and the East
 * Asian options (tsume, aki, kinsoku, mojikumi, burasagari).
 */
import { decorationOf } from '../../model/text-layout.js';
import { session, applyCharStyle, applyParaStyle, currentCharStyle, currentParaStyle, currentTextNodes, typeDefaults, MIXED } from './type-ops.js';
import { headOf } from './thread-model.js';

const hasDoc = (app) => Boolean(app.editor);

export const ANTIALIAS = [
  ['none', 'None'],
  ['sharp', 'Sharp'],
  ['crisp', 'Crisp'],
  ['strong', 'Strong'],
];

export const KINSOKU_MODES = [
  ['none', 'None'],
  ['soft', 'Soft (basic set)'],
  ['hard', 'Hard (full set)'],
];

export const MOJIKUMI_MODES = [
  ['none', 'None'],
  ['basic', 'Basic Spacing'],
];

export const BURASAGARI_MODES = [
  ['none', 'None'],
  ['standard', 'Standard'],
  ['forced', 'Forced'],
];

/** Aki (space before or after a character) presets, as fractions of an em. */
export const AKI_PRESETS = [
  [0, 'None'],
  [1 / 8, '1/8 em'],
  [1 / 4, '1/4 em'],
  [1 / 3, '1/3 em'],
  [1 / 2, '1/2 em'],
  [3 / 4, '3/4 em'],
  [1, '1 em'],
];

/** Font height references of the size field: the em box, or a height the font measures. */
export const SIZE_REFERENCES = [
  ['em', 'Em Box'],
  ['cap', 'Cap Height'],
  ['x', 'x Height'],
  ['icf', 'Ideographic Face (ICF)'],
];

/**
 * Live preview of a character patch: previews go into one undo step that
 * Cancel takes back (an insertion point keeps its pending style instead;
 * new-type defaults are restored).
 */
export function charPreview(app, label) {
  const doc = app.editor?.doc;
  const s = session(app);
  const caret = s && s.range()[0] === s.range()[1];
  const pending0 = caret ? s.pending : null;
  const defaults0 = { ...typeDefaults(app).char };
  const top0 = doc?.undoStack[doc.undoStack.length - 1];
  const key = `${label}-${Math.random().toString(36).slice(2, 8)}`;
  let applied = false;
  const apply = (patch) => {
    applyCharStyle(app, patch, { label, coalesce: key });
    applied = true;
  };
  return {
    preview: apply,
    commit: (patch) => apply(patch),
    cancel() {
      if (!applied) return;
      if (caret) s.setPending(pending0);
      else if (doc && doc.undoStack[doc.undoStack.length - 1] !== top0) {
        doc.undo();
        session(app)?.changed();
      }
      typeDefaults(app).char = defaults0;
      app.dock?.update();
    },
  };
}

const known = (v) => v !== MIXED && v !== undefined;

/**
 * Underline Options / Strikethrough Options: on or off, weight and offset
 * (automatic or set), color (the text's or its own) and dashes.
 */
export async function decorationDialog(app, kind) {
  const cur = currentCharStyle(app) || {};
  const label = kind === 'underline' ? 'Underline Options' : 'Strikethrough Options';
  const key = kind === 'underline' ? 'underlineStyle' : 'strikeStyle';
  const st = known(cur[key]) ? cur[key] || {} : {};
  const size = known(cur.fontSize) ? cur.fontSize : 12;
  const auto = decorationOf({ ...cur, fontSize: size, [key]: null }, size, kind);
  const autoOffset = kind === 'underline' ? auto.offset : -auto.offset - auto.thickness;
  const color = st.color?.type === 'solid' ? st.color.color : known(cur.fill) && cur.fill?.type === 'solid' ? cur.fill.color : '#000000';
  const pv = charPreview(app, label);
  const patchOf = (v) => {
    const custom = !v.auto || v.colorMode === 'custom' || v.dashed;
    return {
      [kind]: v.on,
      [key]: custom
        ? {
            weight: v.auto ? null : Math.max(0.01, v.weight),
            offset: v.auto ? null : v.offset,
            color: v.colorMode === 'custom' ? { type: 'solid', color: v.color } : null,
            dash: v.dashed ? [Math.max(0.1, v.dash), Math.max(0.1, v.gap)] : null,
          }
        : null,
    };
  };
  let v = null;
  try {
    v = await app.dialogs.form({
      title: label,
      fields: [
        { key: 'on', type: 'checkbox', label: kind === 'underline' ? 'Underline' : 'Strikethrough', value: cur[kind] === true },
        { key: 'auto', type: 'checkbox', label: 'Automatic Weight and Offset', value: !(st.weight > 0) && !Number.isFinite(st.offset) },
        { key: 'weight', type: 'length', label: 'Weight', value: st.weight > 0 ? st.weight : auto.thickness, min: 0.01, max: 1000, step: 0.25, disabled: (x) => x.auto },
        { key: 'offset', type: 'length', label: kind === 'underline' ? 'Offset (below the baseline)' : 'Offset (above the baseline)', value: Number.isFinite(st.offset) ? st.offset : autoOffset, min: -1000, max: 1000, step: 0.25, disabled: (x) => x.auto },
        {
          key: 'colorMode',
          type: 'select',
          label: 'Color',
          value: st.color ? 'custom' : 'text',
          options: [
            { value: 'text', label: 'Text Color' },
            { value: 'custom', label: 'Custom Color' },
          ],
        },
        { key: 'color', type: 'color', label: 'Custom Color', value: color, disabled: (x) => x.colorMode !== 'custom' },
        { key: 'dashed', type: 'checkbox', label: 'Dashed Line', value: Boolean(st.dash) },
        { key: 'dash', type: 'length', label: 'Dash', value: st.dash?.[0] || 4, min: 0.1, max: 1000, disabled: (x) => !x.dashed },
        { key: 'gap', type: 'length', label: 'Gap', value: st.dash?.[1] || 2, min: 0.1, max: 1000, disabled: (x) => !x.dashed },
        { key: 'preview', type: 'checkbox', label: 'Preview', value: true },
      ],
      previewToggle: true,
      onChange: (vals) => {
        if (vals.preview) pv.preview(patchOf(vals));
        else pv.cancel();
      },
    });
  } catch (err) {
    pv.cancel();
    throw err;
  }
  if (!v) {
    pv.cancel();
    return null;
  }
  pv.commit(patchOf(v));
  return v;
}

/** The type objects whose anti-aliasing applies (whole objects: a story's first frame holds it). */
function antialiasTargets(app) {
  const doc = app.editor?.doc;
  if (!doc) return [];
  return [...new Map(currentTextNodes(app).map((n) => [n.id, n])).values()].map((n) => headOf(doc, n) || n);
}

export function antialiasOf(app) {
  const nodes = antialiasTargets(app);
  if (!nodes.length) return typeDefaults(app).antialias || 'sharp';
  const v = new Set(nodes.map((n) => n.antialias || 'sharp'));
  return v.size === 1 ? [...v][0] : MIXED;
}

export function setAntialias(app, mode) {
  const nodes = antialiasTargets(app);
  if (!nodes.length) {
    typeDefaults(app).antialias = mode;
    app.dock?.update();
    return;
  }
  const doc = app.editor.doc;
  doc.transact('Anti-aliasing', () => {
    for (const n of nodes) doc.update(n.id, { antialias: mode === 'sharp' ? undefined : mode });
  });
  app.dock?.update();
}

const charToggle = (id, label, key) => ({
  id,
  label,
  enabled: hasDoc,
  checked: (a) => currentCharStyle(a)?.[key] === true,
  run: (a) => applyCharStyle(a, { [key]: currentCharStyle(a)?.[key] !== true }, { label }),
});

const paraChoice = (prefix, key, modes, label) =>
  modes.map(([mode, text]) => ({
    id: `${prefix}.${mode}`,
    label: text,
    enabled: hasDoc,
    checked: (a) => (currentParaStyle(a)?.[key] ?? 'none') === mode,
    run: (a) => applyParaStyle(a, { [key]: mode }, { label }),
  }));

const prefToggle = (id, label, pref) => ({
  id,
  label,
  checked: (a) => a.prefs.get(pref) === true,
  run: (a) => {
    a.prefs.set(pref, a.prefs.get(pref) !== true);
    a.dock?.update();
  },
});

export function installCharOptions(app) {
  app.commands.register([
    { id: 'type.underlineOptions', label: 'Underline Options...', enabled: hasDoc, run: (a) => decorationDialog(a, 'underline') },
    { id: 'type.strikeOptions', label: 'Strikethrough Options...', enabled: hasDoc, run: (a) => decorationDialog(a, 'strike') },
    charToggle('type.verticalRoman', 'Standard Vertical Roman Alignment', 'verticalRoman'),
    charToggle('type.tcy', 'Tate-chu-yoko', 'tcy'),
    ...ANTIALIAS.map(([mode, text]) => ({ id: `type.antialias.${mode}`, label: text, enabled: hasDoc, checked: (a) => antialiasOf(a) === mode, run: (a) => setAntialias(a, mode) })),
    prefToggle('type.showFontHeight', 'Show Font Height Options', 'showFontHeightOptions'),
    prefToggle('type.showEastAsian', 'Show East Asian Options', 'showEastAsianOptions'),
    ...paraChoice('type.kinsoku', 'kinsoku', KINSOKU_MODES, 'Kinsoku'),
    ...paraChoice('type.mojikumi', 'mojikumi', MOJIKUMI_MODES, 'Mojikumi'),
    ...paraChoice('type.burasagari', 'burasagari', BURASAGARI_MODES, 'Burasagari'),
  ]);
}
