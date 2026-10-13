/**
 * Font management for a document: Type > Find/Replace Font (list the fonts the
 * document uses, find them, change them, select the objects using them),
 * Type > Resolve Missing Fonts, Type > Recent Fonts and a notice when a
 * document uses fonts that are not available.
 */
import { h } from '../../lib/dom.js';
import { styledRuns, baseStyle, normalizeRuns, RUN_KEYS } from '../../model/text-runs.js';
import { allFamilies, familyInfo, familyFaces, styleName, nearestFace } from './fonts.js';
import { setFontFamily } from './commands.js';
import { currentCharStyle } from './type-ops.js';

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji']);

/** A font as used by type: family plus face. */
export const fontKey = (st) => `${st.fontFamily}|${st.fontWeight || 400}|${st.fontStyle || 'normal'}`;

export function fontLabel(f) {
  return `${f.family} ${styleName(f.weight, f.style)}`;
}

/** True when a family can be drawn and outlined here (bundled, local or a generic family). */
export function isFontAvailable(family) {
  return Boolean(familyInfo(family)) || GENERIC.has(String(family || '').toLowerCase());
}

/**
 * Fonts used by the document's type: [{ key, family, weight, style, chars,
 * objects: Set(id), missing }], sorted by family and face.
 */
export function documentFonts(doc) {
  const map = new Map();
  for (const n of doc.leaves()) {
    if (n.type !== 'text') continue;
    const runs = n.text ? styledRuns(n) : [{ start: 0, end: 0, style: baseStyle(n) }];
    for (const r of runs) {
      if (n.text && r.end <= r.start) continue;
      const st = r.style;
      const key = fontKey(st);
      let f = map.get(key);
      if (!f) {
        f = { key, family: st.fontFamily, weight: st.fontWeight || 400, style: st.fontStyle || 'normal', chars: 0, objects: new Set(), missing: !isFontAvailable(st.fontFamily) };
        map.set(key, f);
      }
      f.chars += r.end - r.start;
      f.objects.add(n.id);
    }
  }
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || (a.style === 'italic') - (b.style === 'italic'));
}

/**
 * Patch that changes every use of font `from` (a key) in a text node to
 * `to` ({ fontFamily, fontWeight, fontStyle }), within [a, b) when given.
 * Returns null when the node does not use it there.
 */
export function replaceFontPatch(node, from, to, a = 0, b = Infinity) {
  const base = baseStyle(node);
  const len = String(node.text ?? '').length;
  const whole = a <= 0 && b >= len;
  let char = node.char;
  if (whole && fontKey(base) === from) char = { ...(node.char || {}), ...to };
  const nextNode = { ...node, char };
  let changed = char !== node.char;
  const segs = [];
  for (const r of styledRuns(node)) {
    const cuts = [r.start, Math.max(r.start, Math.min(r.end, a)), Math.max(r.start, Math.min(r.end, b)), r.end];
    for (let k = 0; k < 3; k++) {
      const s = cuts[k];
      const e = cuts[k + 1];
      if (e <= s) continue;
      const inRange = k === 1;
      const seg = { len: e - s };
      for (const key of RUN_KEYS) seg[key] = r.style[key];
      if (inRange && fontKey(r.style) === from) {
        Object.assign(seg, to);
        changed = true;
      }
      segs.push(seg);
    }
  }
  if (!changed) return null;
  return { char, runs: len ? normalizeRuns(segs, nextNode) : node.runs };
}

/** Change font `from` to `to` in the given text objects (all type when ids is null). Returns the objects changed. */
export function changeFont(doc, from, to, ids = null, label = 'Change Font') {
  let count = 0;
  doc.transact(label, () => {
    const nodes = ids ? ids.map((id) => doc.get(id)).filter(Boolean) : doc.leaves().filter((n) => n.type === 'text');
    for (const n of nodes) {
      if (n.type !== 'text') continue;
      const patch = replaceFontPatch(n, from, to);
      if (patch) {
        doc.update(n.id, patch);
        count++;
      }
    }
  });
  return count;
}

/** The face of `family` closest to the face of the font being replaced. */
export function targetFace(family, weight = 400, style = 'normal') {
  const info = familyInfo(family);
  const face = info ? nearestFace(info, weight, style) : null;
  return { fontFamily: family, fontWeight: face?.weight ?? weight, fontStyle: face?.style ?? style };
}

/** A likely replacement family for a missing one, from words in its name. */
export function suggestReplacement(family) {
  const f = String(family).toLowerCase();
  if (/mono|code|courier|consol|menlo/.test(f)) return 'Roboto Mono';
  if (/script|hand|brush|marker|comic/.test(f)) return 'Dancing Script';
  if (/serif/.test(f) && !/sans/.test(f)) return 'Source Serif 4';
  if (/times|georgia|garamond|baskerville|book|roman|caslon|bodoni|minion|palatino|cambria/.test(f)) return 'Source Serif 4';
  if (/condensed|narrow|impact|oswald|league/.test(f)) return 'Oswald';
  if (/display|black|poster/.test(f)) return 'Bebas Neue';
  return 'Inter';
}

// ---- Find Font dialog ----

export function openFindFont(app) {
  const ed = app.editor;
  if (!ed) return;
  const doc = ed.doc;
  const status = h('p.ff-status', { role: 'status', 'aria-live': 'polite' });
  const usedList = h('div.ff-list', { role: 'listbox', 'aria-label': 'Fonts in the document', tabindex: '0' });
  const usedHead = h('h3.ff-head', { id: 'ff-used' });
  const sourceSel = h('select#ff-source', h('option', { value: 'all' }, 'All Available Fonts'), h('option', { value: 'doc' }, 'Fonts in Document'), h('option', { value: 'recent' }, 'Recent Fonts'));
  const famSel = h('select#ff-family');
  const faceSel = h('select#ff-face');
  let fonts = [];
  let sel = null; // key of the selected document font
  let found = null; // { id, start, end } of the last Find

  const renderUsed = () => {
    fonts = documentFonts(doc);
    if (!fonts.some((f) => f.key === sel)) sel = fonts[0]?.key || null;
    const missing = fonts.filter((f) => f.missing).length;
    usedHead.textContent = `Fonts in Document (${fonts.length})${missing ? ` \u2014 ${missing} missing` : ''}`;
    usedList.replaceChildren(
      ...(fonts.length
        ? fonts.map((f) =>
            h(
              'div.ff-item',
              { role: 'option', tabindex: '-1', 'aria-selected': String(f.key === sel), 'data-key': f.key, title: f.missing ? 'Not available: shown with a substitute font' : '' },
              h('span.ff-name', { style: f.missing ? null : { fontFamily: `"${f.family}", var(--font-ui)`, fontWeight: String(f.weight), fontStyle: f.style } }, fontLabel(f)),
              f.missing ? h('span.ff-missing', 'Missing') : null,
              h('span.ff-count', `${f.objects.size} ${f.objects.size === 1 ? 'object' : 'objects'}`),
            ),
          )
        : [h('p.panel-empty', 'This document has no type.')]),
    );
    for (const b of [bFind, bChange, bChangeAll, bSelect]) b.disabled = !sel;
    bSave.disabled = !fonts.length;
  };

  const renderFamilies = () => {
    let fams;
    if (sourceSel.value === 'doc') fams = [...new Set(fonts.map((f) => f.family))].filter(isFontAvailable);
    else if (sourceSel.value === 'recent') fams = recentFonts(app);
    else fams = allFamilies().map((f) => f.family);
    const cur = famSel.value;
    famSel.replaceChildren(...(fams.length ? fams.map((f) => h('option', { value: f }, f)) : [h('option', { value: '', disabled: true }, 'None')]));
    if (fams.includes(cur)) famSel.value = cur;
    renderFaces();
  };

  const renderFaces = () => {
    const faces = famSel.value ? familyFaces(famSel.value) : [];
    faceSel.replaceChildren(h('option', { value: 'keep' }, 'Closest to the original'), ...faces.map((f) => h('option', { value: `${f.weight}|${f.style}` }, styleName(f.weight, f.style))));
  };

  const target = () => {
    const f = fonts.find((x) => x.key === sel);
    if (!famSel.value || !f) return null;
    if (faceSel.value === 'keep') return targetFace(famSel.value, f.weight, f.style);
    const [w, s] = faceSel.value.split('|');
    return { fontFamily: famSel.value, fontWeight: Number(w), fontStyle: s };
  };

  /** Next character range using the selected font after the last find. */
  const findNextUse = () => {
    const nodes = doc.leaves().filter((n) => n.type === 'text' && n.text && !doc.isLocked(n.id) && !doc.isHidden(n.id));
    const startIdx = Math.max(0, nodes.findIndex((n) => n.id === found?.id));
    for (let k = 0; k <= nodes.length; k++) {
      const n = nodes[(startIdx + k) % nodes.length];
      const ranges = [];
      for (const r of styledRuns(n)) {
        if (fontKey(r.style) !== sel || r.end <= r.start) continue;
        const last = ranges[ranges.length - 1];
        if (last && last.end === r.start) last.end = r.end;
        else ranges.push({ start: r.start, end: r.end });
      }
      const after = ranges.filter((r) => (k === 0 && found?.id === n.id ? r.start >= found.end : k < nodes.length || !found || r.end <= found.start));
      if (after.length) return { id: n.id, ...after[0] };
    }
    return null;
  };

  const show = (m) => {
    found = m;
    const tool = app.getTool('type');
    if (app.toolId !== 'type') app.setTool('type');
    tool.editText(m.id, null)?.setSelection(m.start, m.end);
  };

  const bFind = h('button.btn', { type: 'button', onclick: () => {
    const m = findNextUse();
    if (m) {
      show(m);
      status.textContent = '';
    } else status.textContent = 'No text uses this font.';
  } }, 'Find');
  const bChange = h('button.btn', { type: 'button', onclick: () => {
    const to = target();
    if (!to) return;
    if (!found) {
      bFind.click();
      if (!found) return;
    }
    const n = doc.get(found.id);
    const patch = n && replaceFontPatch(n, sel, to, found.start, found.end);
    if (patch) doc.transact('Change Font', () => doc.update(n.id, patch));
    app.emit('font-applied', to.fontFamily);
    status.textContent = `Changed to ${to.fontFamily}.`;
    const prev = found;
    renderUsed();
    found = prev;
    const m = fonts.some((f) => f.key === sel) ? findNextUse() : null;
    if (m) show(m);
  } }, 'Change');
  const bChangeAll = h('button.btn', { type: 'button', onclick: () => {
    const to = target();
    if (!to) return;
    const was = fonts.find((f) => f.key === sel);
    app.getTool('type')?.endEditing?.({ select: false });
    const count = changeFont(doc, sel, to, null, 'Change Font');
    app.emit('font-applied', to.fontFamily);
    status.textContent = `Changed ${was ? fontLabel(was) : 'the font'} in ${count} ${count === 1 ? 'object' : 'objects'}.`;
    found = null;
    renderUsed();
  } }, 'Change All');
  const bSelect = h('button.btn', { type: 'button', onclick: () => {
    const f = fonts.find((x) => x.key === sel);
    if (!f) return;
    app.getTool('type')?.endEditing?.({ select: false });
    if (app.toolId !== 'selection' && app.toolId !== 'direct-selection') app.setTool(app.lastSelectionTool || 'selection');
    const ids = [...f.objects].filter((id) => doc.has(id) && !doc.isLocked(id) && !doc.isHidden(id));
    ed.select(ids);
    status.textContent = `Selected ${ids.length} ${ids.length === 1 ? 'object' : 'objects'}.`;
  } }, 'Select Objects');

  // The list as text: one font per line with its use.
  const bSave = h('button.btn', { type: 'button', onclick: async () => {
    const lines = fonts.map((f) => `${fontLabel(f)}\t${f.objects.size} ${f.objects.size === 1 ? 'object' : 'objects'}\t${f.chars} ${f.chars === 1 ? 'character' : 'characters'}${f.missing ? '\tmissing' : ''}`);
    const { downloadBlob } = await import('../io/deliver.js');
    const base = (ed.name || doc.root.name || 'Document').replace(/\.[^.]+$/, '');
    downloadBlob(new Blob([`Fonts in ${base}\n\n${lines.join('\n')}\n`], { type: 'text/plain' }), `${base} fonts.txt`);
    status.textContent = 'Saved the font list.';
  } }, 'Save List');
  usedList.addEventListener('click', (e) => {
    const el = e.target.closest('[data-key]');
    if (!el) return;
    sel = el.dataset.key;
    found = null;
    renderUsed();
  });
  usedList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = fonts.findIndex((f) => f.key === sel);
    const next = fonts[Math.max(0, Math.min(fonts.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      sel = next.key;
      found = null;
      renderUsed();
    }
  });
  sourceSel.addEventListener('change', renderFamilies);
  famSel.addEventListener('change', renderFaces);

  const body = h(
    'div.find-font',
    h('div.ff-col', usedHead, usedList, h('div.ff-actions', bSave)),
    h(
      'div.ff-col',
      h('h3.ff-head', 'Replace With'),
      h('div.form-row', h('label', { for: 'ff-source' }, 'From'), sourceSel),
      h('div.form-row', h('label', { for: 'ff-family' }, 'Font'), famSel),
      h('div.form-row', h('label', { for: 'ff-face' }, 'Style'), faceSel),
      h('div.ff-actions', bFind, bChange, bChangeAll, bSelect),
      status,
    ),
  );
  usedList.setAttribute('aria-labelledby', 'ff-used');
  renderUsed();
  renderFamilies();
  if (fonts.find((f) => f.key === sel)?.missing) famSel.value = suggestReplacement(fonts.find((f) => f.key === sel).family);
  return app.dialogs.open({ title: 'Find/Replace Font', body, className: 'find-font-dialog wide', buttons: [{ label: 'Done', value: true, primary: true }] });
}

// ---- Resolve Missing Fonts ----

export function missingFonts(doc) {
  return documentFonts(doc).filter((f) => f.missing);
}

export async function openResolveFonts(app) {
  const ed = app.editor;
  if (!ed) return;
  const doc = ed.doc;
  const missing = missingFonts(doc);
  if (!missing.length) {
    await app.dialogs.open({ title: 'Resolve Missing Fonts', body: h('p.dialog-message', 'Every font in this document is available.'), buttons: [{ label: 'OK', value: true, primary: true }] });
    return;
  }
  const families = allFamilies().map((f) => f.family);
  const rows = missing.map((f, i) => {
    const sel = h(
      'select',
      { id: `rf-${i}`, 'aria-label': `Replacement for ${fontLabel(f)}` },
      h('option', { value: '' }, 'Keep (do not replace)'),
      families.map((fam) => h('option', { value: fam }, fam)),
    );
    sel.value = suggestReplacement(f.family);
    return { f, sel, row: h('tr', h('td', h('label', { for: `rf-${i}` }, fontLabel(f))), h('td.num', String(f.objects.size)), h('td', sel)) };
  });
  const body = h(
    'div.resolve-fonts',
    h('p.dialog-message', 'These fonts are not available, so their type is shown with a substitute and cannot be converted to outlines. Choose a replacement for each.'),
    h('table.rf-table', h('thead', h('tr', h('th', 'Missing Font'), h('th', 'Objects'), h('th', 'Replace With'))), h('tbody', rows.map((r) => r.row))),
  );
  const ok = await app.dialogs.open({ title: 'Resolve Missing Fonts', body, className: 'wide', buttons: [{ label: 'Cancel', value: false }, { label: 'Replace Fonts', value: true, primary: true }] });
  if (!ok) return;
  app.getTool('type')?.endEditing?.({ select: false });
  doc.transact('Resolve Missing Fonts', () => {
    for (const { f, sel } of rows) if (sel.value) changeFont(doc, f.key, targetFace(sel.value, f.weight, f.style));
  });
}

// ---- recent fonts ----

const RECENT_MAX = 30;

/** Recently used fonts, as many as Preferences > Type > Number of Recent Fonts (10 by default). */
export function recentFonts(app) {
  const r = app.prefs.get('recentFonts');
  const n = Number(app.prefs.get('recentFontsCount'));
  return Array.isArray(r) ? r.filter(isFontAvailable).slice(0, Number.isFinite(n) && n >= 1 ? n : 10) : [];
}

export function addRecentFont(app, family) {
  if (!family) return;
  const r = app.prefs.get('recentFonts');
  const list = [family, ...(Array.isArray(r) ? r : []).filter((f) => f !== family)].slice(0, RECENT_MAX);
  app.prefs.set('recentFonts', list);
}

export function installFontTools(app) {
  app.on('font-applied', (family) => addRecentFont(app, family));
  app.menuSources.set('recentFonts', (a) => {
    if (a.prefs.get('showRecentFonts') === false) return [];
    const cur = currentCharStyle(a)?.fontFamily;
    return recentFonts(a).map((f) => ({ type: 'cmd', label: f, enabled: Boolean(a.editor), checked: cur === f, run: (x) => setFontFamily(x, f) }));
  });
  app.commands.register([
    { id: 'type.findFont', label: 'Find/Replace Font...', enabled: (a) => Boolean(a.editor), run: openFindFont },
    { id: 'type.resolveFonts', label: 'Resolve Missing Fonts...', enabled: (a) => Boolean(a.editor) && missingFonts(a.editor.doc).length > 0, run: openResolveFonts },
  ]);
  // Say once per document when it uses fonts that are not available.
  const told = new WeakSet();
  const check = (editor) => {
    if (!editor || told.has(editor)) return;
    told.add(editor);
    const miss = missingFonts(editor.doc);
    if (!miss.length) return;
    const names = [...new Set(miss.map((f) => f.family))];
    const list = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    app.notify(`Missing fonts: ${list}. Use Type > Resolve Missing Fonts to replace them.`, { polite: true, timeout: 6000 });
  };
  app.on('active-editor', check);
}
