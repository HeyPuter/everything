/**
 * Index and table of authorities on the References tab: Mark Entry and Mark Citation (modeless
 * panels, so text can be selected while they stay open), Insert Index and Insert Table of
 * Authorities (with a live preview), and Update for each. Page numbers come from the current
 * layout and settle over a few passes, since a generated table can move the text it lists.
 */
import { el } from '../ui/dom.js';
import { check, field, number, openDialog, openPanel, select, tablePreview, text } from './references-ui.js';

const LEADERS = [['dot', 'Dots ......'], ['hyphen', 'Dashes ------'], ['underscore', 'Line ______'], ['none', '(none)']];

export function createIndexCommands(ctx) {
  const { editor, ready, runBody, error, pageOf } = ctx;
  const selectedText = () => {
    const engine = editor(); if (!engine || engine.session.path !== null) return '';
    const [start, end] = engine.model.range;
    return engine.model.text.slice(start, end).replace(/[\n\t\f\v￼]+/g, ' ').trim().slice(0, 200);
  };

  /** Run `write(body, module, pages)` until the pages it lists stop moving (at most four passes). */
  function settle(write, read) {
    return (body, module) => {
      let previous = null, result;
      for (let pass = 0; pass < 4; pass++) {
        result = write(body, module, pageOf(body), result);
        const now = read(body, module, result);
        if (now === previous) break;
        previous = now;
      }
      return result;
    };
  }
  const resultText = (body, range) => body.text.slice(range.start, range.end);

  /* ---- Mark Entry ---- */
  function markEntryPanel() {
    const engine = ready(); if (!engine) return;
    const main = text('Main entry', selectedText(), { required: true });
    const sub = text('Subentry', '');
    const cross = text('Cross-reference', 'See ');
    const bookmarkSelect = select('Bookmark', (engine.model.bookmarks || []).filter(b => !b.name.startsWith('_')).map(b => [b.name, b.name]));
    const choice = value => el('input', { type: 'radio', name: 'ref-entry-kind', value, checked: value === 'page', onchange: sync });
    const crossRadio = choice('cross'), pageRadio = choice('page'), rangeRadio = choice('range');
    const bold = check('Bold', false), italic = check('Italic', false);
    const status = el('p.field-hint', { 'aria-live': 'polite' });
    let edited = false;
    main.addEventListener('input', () => { edited = true; });
    function sync() { cross.disabled = !crossRadio.checked; bookmarkSelect.disabled = !rangeRadio.checked || !bookmarkSelect.options.length; rangeRadio.disabled = !bookmarkSelect.options.length; }
    sync();
    const options = () => ({ main: main.value, sub: sub.value, bold: bold.box.checked, italic: italic.box.checked,
      crossReference: crossRadio.checked ? cross.value.trim() : null, bookmark: rangeRadio.checked ? bookmarkSelect.value : null });
    const mark = async all => {
      if (!main.value.trim()) { status.textContent = 'Type the main entry first.'; main.focus(); return; }
      const selection = selectedText();
      let count = 0;
      await runBody((body, idx) => { if (all) count = idx.markAllEntries(body, selection, options()); else { idx.markEntry(body, options()); count = 1; } return true; }, { modules: ['index'], refresh: false, keepFocus: true });
      status.textContent = all ? `${count} ${count === 1 ? 'entry' : 'entries'} marked.` : 'Entry marked.';
      edited = false;
      ctx.showFieldCodes?.();
    };
    const markAll = el('button.btn.btn-outline', { type: 'button', onclick: () => mark(true) }, 'Mark All');
    const panel = openPanel({ title: 'Mark Index Entry', className: 'ref-mark-panel', body: [
      field('Main entry', main), field('Subentry', sub),
      el('fieldset.ref-section', {}, el('legend', {}, 'Options'),
        el('label.ed-check', {}, crossRadio, 'Cross-reference:'), cross,
        el('label.ed-check', {}, pageRadio, 'Current page'),
        el('label.ed-check', {}, rangeRadio, 'Page range bookmark:'), bookmarkSelect),
      el('fieldset.ref-section', {}, el('legend', {}, 'Page number format'), el('div.row', {}, bold, italic)),
      el('p.field-hint', {}, 'The panel stays open: select other text, then Mark again. Entries show as { XE } codes while formatting marks are shown.'),
      status,
    ], actions: [markAll, el('button.btn.btn-primary', { type: 'button', onclick: () => mark(false) }, 'Mark')] });
    // Coming back to the panel picks up a new selection.
    panel.node.addEventListener('focusin', e => { if (!panel.node.contains(e.relatedTarget) && !edited) { const t = selectedText(); if (t) { main.value = t; sub.value = ''; } markAll.disabled = !selectedText(); } });
    markAll.disabled = !selectedText();
    main.select();
  }

  /* ---- Insert / update index ---- */
  const indexFor = (idx, body) => { const all = idx.indexFields(body.paragraphs), at = body.range[0]; return all.find(r => r.start <= at && at <= r.end) || all[0] || null; };
  async function insertIndexDialog() {
    const engine = ready(); if (!engine) return;
    const idx = await import('../engine/index-entries.js');
    const existing = indexFor(idx, engine.session.body);
    const o = existing ? idx.parseIndexInstruction(existing.field.instruction) : { runIn: false, columns: 2, rightAlign: false, headings: null };
    const leaderNow = existing ? engine.session.body.paragraphs[existing.first]?.format?.tabs?.find(t => t.alignment === 'right')?.leader || 'dot' : 'dot';
    const type = select('Type', [['indented', 'Indented'], ['runin', 'Run-in']], o.runIn ? 'runin' : 'indented', sync);
    const columns = number('Columns', o.columns || 1, { min: 1, max: 4, oninput: sync });
    const rightAlign = check('Right align page numbers', o.rightAlign, sync);
    const leader = select('Tab leader', LEADERS, leaderNow, sync);
    const format = select('Formats', [['plain', 'Plain'], ['letters', 'Letter headings'], ['spaced', 'Spaced letter headings']], o.headings ? (o.headings.trim() === 'A' && o.headings !== 'A' ? 'spaced' : 'letters') : 'plain', sync);
    const language = select('Language', [['1033', 'English (United States)'], ['2057', 'English (United Kingdom)'], ['1036', 'French'], ['1031', 'German'], ['3082', 'Spanish']], o.lcid || '1033');
    const preview = el('div.ref-preview-frame', { role: 'img', 'aria-label': 'Preview' });
    function sync() {
      leader.disabled = !rightAlign.box.checked;
      const runIn = type.value === 'runin', headings = format.value !== 'plain';
      const rows = [...(headings ? [{ text: 'A', level: 1, bold: true }] : []), { text: 'Atmosphere', page: 1, level: 1 }, ...(runIn ? [] : [{ text: 'Earth', page: 4, level: 2 }]), { text: runIn ? 'Atmosphere: Earth 4; Mars 7' : 'Mars', page: runIn ? undefined : 7, level: runIn ? 1 : 2 }, ...(headings ? [{ text: 'B', level: 1, bold: true }] : []), { text: 'Boiling point', page: 12, level: 1 }];
      preview.replaceChildren(tablePreview(rows, { leader: leader.value, rightAlign: rightAlign.box.checked }));
      preview.style.columnCount = String(Math.max(1, Math.min(4, Number(columns.value) || 1)));
    }
    sync();
    openDialog({ title: 'Index', wide: true, className: 'ref-toc-dialog', submitLabel: existing ? 'Replace' : 'Insert', body: [
      el('div.ref-two-column', {},
        el('div.ref-column', {}, el('span.field-label', {}, 'Print preview'), preview, rightAlign, field('Tab leader', leader)),
        el('div.ref-column', {}, field('Type', type), field('Columns', columns, 'Columns are kept in the field; the page shows one column until section columns are added.'), field('Formats', format), field('Language', language))),
    ], onSubmit: () => {
      const options = { ...idx.parseIndexInstruction(existing?.field.instruction || ' INDEX '), runIn: type.value === 'runin', columns: Math.max(1, Math.min(4, Number(columns.value) || 1)), rightAlign: rightAlign.box.checked,
        entrySeparator: rightAlign.box.checked ? '\t' : ', ', headings: format.value === 'letters' ? 'A' : format.value === 'spaced' ? ' A ' : null, lcid: language.value };
      return runBody(settle((body, m, pages, last) => m.writeIndex(body, { existing: last ? m.indexFields(body.paragraphs).find(r => r.field.id === last.field.id) : indexFor(m, body), options, pageOf: pages, leader: leader.value }),
        (body, m, range) => resultText(body, m.indexFields(body.paragraphs).find(r => r.field.id === range.field.id))), { modules: ['index'], refresh: false });
    } });
  }
  async function updateIndex() {
    const engine = ready(); if (!engine) return;
    const idx = await import('../engine/index-entries.js');
    if (!indexFor(idx, engine.session.body)) { error(new Error('This document has no index yet. Use Insert Index first.')); return; }
    await runBody(settle((body, m, pages, last) => {
      const target = last ? m.indexFields(body.paragraphs).find(r => r.field.id === last.field.id) : indexFor(m, body);
      const leader = body.paragraphs[target.first]?.format?.tabs?.find(t => t.alignment === 'right')?.leader || 'dot';
      return m.writeIndex(body, { existing: target, pageOf: pages, leader });
    }, (body, m, range) => resultText(body, m.indexFields(body.paragraphs).find(r => r.field.id === range.field.id))), { modules: ['index'], refresh: false });
  }

  /* ---- Mark Citation (table of authorities) ---- */
  async function markCitationPanel() {
    const engine = ready(); if (!engine) return;
    const toa = await import('../engine/authorities.js');
    const selected = selectedText();
    const long = el('textarea.input.ref-long-citation', { 'aria-label': 'Long citation', rows: 3 }, selected);
    const short = text('Short citation', selected);
    const category = select('Category', toa.TOA_CATEGORIES.map((name, i) => [String(i + 1), name]), '1');
    const existingList = el('select.input', { 'aria-label': 'Long citations already marked', size: 4, onchange: () => {
      const picked = toa.authorities(editor().session.body.paragraphs).find(a => a.long === existingList.value);
      if (picked) { long.value = picked.long; short.value = picked.short; category.value = String(picked.category); }
    } });
    const status = el('p.field-hint', { 'aria-live': 'polite' });
    const fillExisting = () => existingList.replaceChildren(...toa.authorities(editor()?.session.body.paragraphs || []).map(a => el('option', { value: a.long }, a.long)));
    fillExisting();
    const options = () => ({ long: long.value.trim().replace(/\s*\n\s*/g, ' '), short: short.value.trim() || long.value.trim(), category: Number(category.value) });
    const mark = async all => {
      if (!long.value.trim()) { status.textContent = 'Type the long citation first.'; long.focus(); return; }
      let count = 0;
      await runBody((body, m) => { if (all) count = m.markAllAuthorities(body, options()); else { m.markAuthority(body, options()); count = 1; } return true; }, { modules: ['authorities'], refresh: false, keepFocus: true });
      status.textContent = `${count} ${count === 1 ? 'citation' : 'citations'} marked.`;
      fillExisting();
      ctx.showFieldCodes?.();
    };
    /** Find the next likely citation after the selection: "v.", "§", "U.S.C.", "Id.", "supra". */
    const next = () => {
      const engine2 = editor(); if (!engine2) return;
      const body = engine2.session.body, from = body.range[1];
      const pattern = /[A-Z][\w.'&-]*(?: [\w.'&-]+){0,6} v\. [A-Z][\w.'&-]*(?: [\w.'&-]+){0,6}|\d+ U\.S\.C\. § ?\d+\w*|§+ ?\d[\w.()-]*|\bId\.|\bsupra\b/g;
      pattern.lastIndex = from;
      const match = pattern.exec(body.text) || (pattern.lastIndex = 0, pattern.exec(body.text));
      if (!match) { status.textContent = 'No more citations found.'; return; }
      body.select(match.index, match.index + match[0].length); engine2.revealCaret?.(); engine2.paint?.(); ctx.onChange();
      long.value = match[0]; short.value = match[0]; status.textContent = '';
    };
    const markAll = el('button.btn.btn-outline', { type: 'button', onclick: () => mark(true) }, 'Mark All');
    const panel = openPanel({ title: 'Mark Citation', className: 'ref-mark-panel', body: [
      field('Selected text (long citation)', long), field('Category', category), field('Short citation', short),
      field('Long citations already marked', existingList),
      status,
    ], actions: [el('button.btn.btn-ghost', { type: 'button', onclick: next }, 'Next Citation'), markAll, el('button.btn.btn-primary', { type: 'button', onclick: () => mark(false) }, 'Mark')] });
    panel.node.addEventListener('focusin', e => { if (!panel.node.contains(e.relatedTarget)) { const t = selectedText(); if (t && t !== long.value) { long.value = t; short.value = t; } fillExisting(); } });
    long.focus();
  }

  /* ---- Insert / update table of authorities ---- */
  async function insertAuthoritiesDialog() {
    const engine = ready(); if (!engine) return;
    const toa = await import('../engine/authorities.js');
    const body = engine.session.body;
    const existing = toa.tableFields(body.paragraphs)[0];
    const o = existing ? toa.parseTableInstruction(existing.field.instruction) : { category: 0, passim: true, keepFormatting: true };
    const category = select('Category', [['0', 'All'], ...toa.TOA_CATEGORIES.map((name, i) => [String(i + 1), name])], existing ? String(o.category) : '0', sync);
    const passim = check('Use passim (five or more pages)', o.passim, sync);
    const keep = check('Keep original formatting', o.keepFormatting);
    const leader = select('Tab leader', LEADERS, 'dot', sync);
    const preview = el('div.ref-preview-frame', { role: 'img', 'aria-label': 'Preview' });
    function sync() {
      const heading = category.value === '0' ? 'Cases' : toa.TOA_CATEGORIES[Number(category.value) - 1];
      preview.replaceChildren(tablePreview([{ text: 'Example v. Sample, 123 U.S. 45 (1990)', page: 3, level: 1 }, { text: 'Other v. Party, 67 F.3d 89 (2001)', page: passim.box.checked ? 'passim' : '2, 4, 6, 8, 9', level: 1 }], { title: heading, leader: leader.value }));
    }
    sync();
    openDialog({ title: 'Table of Authorities', wide: true, className: 'ref-toc-dialog', submitLabel: existing ? 'Replace' : 'Insert', body: [
      el('div.ref-two-column', {},
        el('div.ref-column', {}, el('span.field-label', {}, 'Print preview'), preview, field('Tab leader', leader)),
        el('div.ref-column', {}, field('Category', category), passim, keep)),
    ], onSubmit: () => runBody(settle((doc, m, pages) => {
      const base = { passim: passim.box.checked, keepFormatting: keep.box.checked, headings: true, entrySeparator: '\t', pageSeparator: ', ', extra: [] };
      const present = new Set(m.authorities(doc.paragraphs).map(a => a.category));
      const categories = category.value === '0' ? [...present].sort((a, b) => a - b) : [Number(category.value)];
      if (!categories.length) categories.push(1);
      const tables = m.tableFields(doc.paragraphs);
      if (tables.length) {
        // Replace the existing tables: rebuild in place, from the last so positions stay valid.
        for (let i = tables.length - 1; i >= 0; i--) {
          const current = m.tableFields(doc.paragraphs)[i];
          const parsed = m.parseTableInstruction(current.field.instruction);
          m.writeTableOfAuthorities(doc, { existing: current, options: { ...parsed, ...base, category: category.value === '0' ? parsed.category : Number(category.value) }, pageOf: pages, leader: leader.value });
        }
        return true;
      }
      for (const c of categories) m.writeTableOfAuthorities(doc, { options: { ...base, category: c }, pageOf: pages, leader: leader.value });
      return true;
    }, (doc, m) => m.tableFields(doc.paragraphs).map(r => resultText(doc, r)).join('\n')), { modules: ['authorities'], refresh: false }) });
  }
  async function updateAuthorities() {
    const engine = ready(); if (!engine) return;
    const toa = await import('../engine/authorities.js');
    if (!toa.tableFields(engine.session.body.paragraphs).length) { error(new Error('This document has no table of authorities yet.')); return; }
    await runBody(settle((doc, m, pages) => {
      const count = m.tableFields(doc.paragraphs).length;
      for (let i = count - 1; i >= 0; i--) {
        const current = m.tableFields(doc.paragraphs)[i];
        const leader = doc.paragraphs[current.first]?.format?.tabs?.find(t => t.alignment === 'right')?.leader || 'dot';
        m.writeTableOfAuthorities(doc, { existing: current, pageOf: pages, leader });
      }
      return true;
    }, (doc, m) => m.tableFields(doc.paragraphs).map(r => resultText(doc, r)).join('\n')), { modules: ['authorities'], refresh: false });
  }

  return { markEntryPanel, insertIndexDialog, updateIndex, markCitationPanel, insertAuthoritiesDialog, updateAuthorities };
}
