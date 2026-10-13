/**
 * Type menu commands, type shortcuts, the Font and Size submenus and the
 * clipboard and Select All behavior while editing type.
 */
import { layoutText } from '../../model/text-layout.js';
import { replaceRange, paragraphRanges, paragraphIndexAt, applyRunStyle } from '../../model/text-runs.js';
import { createOutlines, selectedTextNodes } from './outlines.js';
import { session, applyCharStyle, applyParaStyle, applyCase, currentCharStyle, currentTextNodes, MIXED } from './type-ops.js';
import { allFamilies, familyFaces } from './fonts.js';
import { fillPlaceholder, loremWords } from './lorem.js';

export const SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 14, 18, 21, 24, 36, 48, 60, 72];

const hasText = (app) => Boolean(session(app)) || (app.editor ? selectedTextNodes(app.editor).length > 0 : false);

/** Choose a family, keeping the weight and style when the family has them. */
export function setFontFamily(app, family) {
  const cur = currentCharStyle(app) || {};
  const faces = familyFaces(family);
  const w = cur.fontWeight === MIXED ? 400 : cur.fontWeight || 400;
  const st = cur.fontStyle === MIXED ? 'normal' : cur.fontStyle || 'normal';
  let face = faces.find((f) => f.weight === w && f.style === st) || faces.find((f) => f.weight === 400 && f.style === 'normal') || faces[0];
  if (!face) face = { weight: 400, style: 'normal' };
  applyCharStyle(app, { fontFamily: family, fontWeight: face.weight, fontStyle: face.style }, { label: 'Font' });
  app.emit?.('font-applied', family);
}

function stepSize(app, dir, mult) {
  const cur = currentCharStyle(app);
  const size = cur?.fontSize === MIXED || cur?.fontSize == null ? 12 : cur.fontSize;
  applyCharStyle(app, { fontSize: Math.max(0.1, Math.min(1296, size + dir * (app.prefs.get('typeSizeIncrement') || 2) * mult)) }, { label: 'Font Size', coalesce: 'type-size' });
}

/** Point type -> area type with the same lines. */
function convertToArea(app) {
  const ed = app.editor;
  const nodes = selectedTextNodes(ed).filter((n) => n.kind === 'point');
  if (!nodes.length) return;
  ed.doc.transact('Convert to Area Type', () => {
    for (const n of nodes) {
      const lay = layoutText(n);
      const b = lay.bounds;
      ed.doc.update(n.id, { kind: 'area', x: b.x, y: b.y, width: Math.max(1, b.w + 1), height: Math.max(1, b.h + 1) });
    }
  });
}

/** Area type -> point type: soft line breaks become paragraph breaks and overset text is dropped. */
export function areaToPointPatch(node) {
  const lay = layoutText(node);
  let cur = { ...node };
  let patch = {};
  if (lay.visibleEnd < cur.text.length) {
    patch = replaceRange(cur, lay.visibleEnd, cur.text.length, '');
    cur = { ...cur, ...patch };
  }
  const breaks = [];
  for (let i = 1; i < lay.lines.length; i++) {
    const l = lay.lines[i];
    const prev = lay.lines[i - 1];
    if (l.start > lay.visibleEnd) break;
    if (node.text[l.start - 1] !== '\n') breaks.push({ at: prev.contentEnd, end: l.start });
  }
  for (let i = breaks.length - 1; i >= 0; i--) {
    const { at, end } = breaks[i];
    patch = { ...patch, ...replaceRange(cur, at, end, '\n') };
    cur = { ...cur, ...patch };
  }
  const first = lay.lines[0];
  const align = node.para?.align || 'left';
  let x = node.x;
  if (align === 'center' || align === 'justify-center') x = node.x + node.width / 2;
  else if (align === 'right' || align === 'justify-right') x = node.x + node.width;
  const y = first ? first.y : node.y + lay.ascent;
  return { ...patch, kind: 'point', x, y, width: 0, height: 0, areaPath: undefined, areaOptions: undefined };
}

function convertToPoint(app) {
  const ed = app.editor;
  const nodes = selectedTextNodes(ed).filter((n) => n.kind === 'area' && !n.vertical);
  if (!nodes.length) return;
  ed.doc.transact('Convert to Point Type', () => {
    for (const n of nodes) ed.doc.update(n.id, areaToPointPatch(n));
  });
}

async function areaOptions(app) {
  const ed = app.editor;
  const nodes = selectedTextNodes(ed).filter((n) => n.kind === 'area');
  if (!nodes.length) return;
  const n = nodes[0];
  const o = n.areaOptions || {};
  const v = await app.dialogs.form({
    title: 'Area Type Options',
    fields: [
      { key: 'width', type: 'length', label: 'Width', value: n.width, min: 1 },
      { key: 'height', type: 'length', label: 'Height', value: n.height, min: 1 },
      { type: 'heading', label: 'Rows' },
      { key: 'rows', type: 'number', label: 'Number', value: o.rows || 1, min: 1, max: 100 },
      { key: 'rowGutter', type: 'length', label: 'Gutter', value: o.rowGutter ?? 18, min: 0 },
      { type: 'heading', label: 'Columns' },
      { key: 'columns', type: 'number', label: 'Number', value: o.columns || 1, min: 1, max: 100 },
      { key: 'columnGutter', type: 'length', label: 'Gutter', value: o.columnGutter ?? 18, min: 0 },
      { type: 'heading', label: 'Offset' },
      { key: 'inset', type: 'length', label: 'Inset Spacing', value: o.inset || 0, min: 0 },
      {
        key: 'firstBaseline',
        type: 'select',
        label: 'First Baseline',
        value: o.firstBaseline || 'ascent',
        options: [
          { value: 'ascent', label: 'Ascent' },
          { value: 'capHeight', label: 'Cap Height' },
          { value: 'leading', label: 'Leading' },
          { value: 'xHeight', label: 'x Height' },
          { value: 'fixed', label: 'Fixed' },
        ],
      },
      { key: 'minBaseline', type: 'length', label: 'Min', value: o.minBaseline || 0, min: 0 },
      {
        key: 'flow',
        type: 'select',
        label: 'Text Flow',
        value: o.flow || 'rows',
        options: [
          { value: 'rows', label: 'By Rows, Left to Right' },
          { value: 'columns', label: 'By Columns, Left to Right' },
        ],
      },
    ],
  });
  if (!v) return;
  ed.doc.transact('Area Type Options', () => {
    for (const node of nodes) {
      const patch = { areaOptions: { rows: Math.round(v.rows), rowGutter: v.rowGutter, columns: Math.round(v.columns), columnGutter: v.columnGutter, inset: v.inset, firstBaseline: v.firstBaseline, minBaseline: v.minBaseline, flow: v.flow } };
      if (!node.areaPath) {
        patch.width = v.width;
        patch.height = v.height;
      }
      ed.doc.update(node.id, patch);
    }
  });
}

/** Type > Fit Headline: track a one-line paragraph out to the full width of its area. */
function fitHeadline(app) {
  const ed = app.editor;
  const s = session(app);
  const targets = [];
  if (s) {
    const n = s.node();
    if (n?.kind === 'area') targets.push({ n, pi: paragraphIndexAt(n.text, s.caret) });
  } else {
    for (const n of selectedTextNodes(ed)) if (n.kind === 'area') targets.push({ n, pi: 0 });
  }
  if (!targets.length) {
    app.notify('Fit Headline works on area type.');
    return;
  }
  ed.doc.transact('Fit Headline', () => {
    for (const { n, pi } of targets) {
      const pr = paragraphRanges(n.text)[pi];
      if (!pr || pr.end <= pr.start) continue;
      const attempt = (t) => {
        const runs = applyRunStyle(n, pr.start, pr.end, { tracking: t });
        const cand = { ...n, runs };
        const lines = layoutText(cand).lines.filter((l) => l.para === pi);
        return { cand, ok: lines.length === 1, width: lines[0]?.width ?? 0 };
      };
      let lo = -200;
      let hi = 4000;
      if (!attempt(lo).ok) continue;
      for (let k = 0; k < 30; k++) {
        const mid = (lo + hi) / 2;
        if (attempt(mid).ok) lo = mid;
        else hi = mid;
      }
      ed.doc.update(n.id, { runs: attempt(Math.floor(lo)).cand.runs });
    }
  });
  s?.changed();
}

/** Type > Fill with Placeholder Text. */
function fillLorem(app) {
  const ed = app.editor;
  const s = session(app);
  if (s) {
    const n = s.node();
    if (n.kind === 'point') s.insert(loremWords(2), 'paste');
    else {
      // Fill what is left of the area from the caret.
      const [a, b] = s.range();
      let words = 1;
      const fits = (k) => !layoutText({ ...n, ...replaceRange(n, a, b, ` ${loremWords(k)}`.slice(a ? 0 : 1)) }).overflow;
      while (words < 4000 && fits(words * 2)) words *= 2;
      let lo = words;
      let hi = words * 2;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      s.insert(` ${loremWords(lo)}`.slice(a ? 0 : 1), 'paste');
    }
    return;
  }
  const nodes = selectedTextNodes(ed);
  if (!nodes.length) return;
  ed.doc.transact('Fill with Placeholder Text', () => {
    for (const n of nodes) ed.doc.update(n.id, { ...replaceRange(n, 0, n.text.length, fillPlaceholder(n)) });
  });
}

export function registerTypeCommands(app) {
  const c = app.commands;
  c.register([
    { id: 'type.createOutlines', label: 'Create Outlines', shortcut: 'Shift+Mod+O', enabled: hasText, run: (a) => createOutlines(a) },
    { id: 'type.case.upper', label: 'UPPERCASE', enabled: hasText, run: (a) => applyCase(a, 'upper') },
    { id: 'type.case.lower', label: 'lowercase', enabled: hasText, run: (a) => applyCase(a, 'lower') },
    { id: 'type.case.title', label: 'Title Case', enabled: hasText, run: (a) => applyCase(a, 'title') },
    { id: 'type.case.sentence', label: 'Sentence case.', enabled: hasText, run: (a) => applyCase(a, 'sentence') },
    { id: 'type.convertToArea', label: 'Convert to Area Type', enabled: (a) => !session(a) && a.editor && selectedTextNodes(a.editor).some((n) => n.kind === 'point' && !n.vertical), run: convertToArea },
    { id: 'type.convertToPoint', label: 'Convert to Point Type', enabled: (a) => !session(a) && a.editor && selectedTextNodes(a.editor).some((n) => n.kind === 'area' && !n.vertical), run: convertToPoint },
    { id: 'type.areaOptions', label: 'Area Type Options...', enabled: (a) => a.editor && selectedTextNodes(a.editor).some((n) => n.kind === 'area'), run: areaOptions },
    { id: 'type.fitHeadline', label: 'Fit Headline', enabled: (a) => currentTextNodes(a).some((n) => n.kind === 'area'), run: fitHeadline },
    {
      id: 'type.showHidden',
      label: 'Show Hidden Characters',
      shortcut: 'Alt+Mod+I',
      enabled: (a) => Boolean(a.editor),
      checked: (a) => Boolean(a.editor?.viewOptions.showHidden),
      run: (a) => {
        a.editor.setViewOption('showHidden', !a.editor.viewOptions.showHidden);
        a.editor.emit('overlay');
      },
    },
    { id: 'type.loremIpsum', label: 'Fill with Placeholder Text', enabled: hasText, run: fillLorem },
    { id: 'edit.findReplace', label: 'Find and Replace...', enabled: (a) => Boolean(a.editor), run: async (a) => (await import('./find.js')).openFindReplace(a) },
    { id: 'type.sizeUp', label: 'Increase Font Size', shortcut: 'Shift+Mod+.', enabled: hasText, run: (a) => stepSize(a, 1, 1) },
    { id: 'type.sizeDown', label: 'Decrease Font Size', shortcut: 'Shift+Mod+,', enabled: hasText, run: (a) => stepSize(a, -1, 1) },
    { id: 'type.sizeUp5', label: 'Increase Font Size by 5 Steps', shortcut: 'Alt+Shift+Mod+.', enabled: hasText, run: (a) => stepSize(a, 1, 5) },
    { id: 'type.sizeDown5', label: 'Decrease Font Size by 5 Steps', shortcut: 'Alt+Shift+Mod+,', enabled: hasText, run: (a) => stepSize(a, -1, 5) },
    ...[
      ['left', 'Align Left', 'Shift+Mod+L'],
      ['center', 'Align Center', 'Shift+Mod+C'],
      ['right', 'Align Right', 'Shift+Mod+R'],
      ['justify', 'Justify with Last Line Aligned Left', 'Shift+Mod+J'],
      ['justify-all', 'Justify All Lines', 'Shift+Mod+F'],
    ].map(([align, label, shortcut]) => ({ id: `type.align.${align}`, label, shortcut, enabled: hasText, run: (a) => applyParaStyle(a, { align }, { label: 'Paragraph Alignment' }) })),
  ]);

  // While editing, the clipboard and Select All work on characters.
  const wrap = (id, fn) => {
    const orig = c.get(id);
    if (!orig) return;
    c.register({
      ...orig,
      enabled: (a, args) => (session(a) ? true : orig.enabled ? orig.enabled(a, args) : true),
      run: (a, args) => (session(a) ? fn(session(a)) : orig.run(a, args)),
    });
  };
  wrap('edit.copy', (s) => s.clipboardCopy(false));
  wrap('edit.cut', (s) => s.clipboardCopy(true));
  wrap('edit.paste', (s) => s.clipboardPaste());
  wrap('select.all', (s) => s.selectAll());
  wrap('edit.clear', (s) => s.deleteRange(...s.range()));

  app.fontMenuItems = () => {
    const cur = currentCharStyle(app);
    const fam = cur?.fontFamily;
    return allFamilies().map((f) => ({ type: 'cmd', label: f.family, enabled: true, checked: fam === f.family, run: (a) => setFontFamily(a, f.family) }));
  };
  app.sizeMenuItems = () => {
    const cur = currentCharStyle(app);
    const size = cur?.fontSize;
    return [
      ...SIZE_PRESETS.map((s) => ({ type: 'cmd', label: `${s} pt`, enabled: true, checked: size === s, run: (a) => applyCharStyle(a, { fontSize: s }, { label: 'Font Size' }) })),
      { type: 'sep' },
      {
        type: 'cmd',
        label: 'Other...',
        enabled: true,
        checked: null,
        run: async (a) => {
          const v = await a.dialogs.form({ title: 'Font Size', fields: [{ key: 'size', type: 'number', label: 'Size (pt)', value: typeof size === 'number' ? size : 12, min: 0.1, max: 1296 }] });
          if (v) applyCharStyle(a, { fontSize: v.size }, { label: 'Font Size' });
        },
      },
    ];
  };
}
