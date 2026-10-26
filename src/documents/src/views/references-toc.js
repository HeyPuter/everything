/**
 * Tables of contents and tables of figures on the References tab: the design gallery, the custom
 * table dialog with a live preview, Add Text (a paragraph's level in the table), Update Table
 * (page numbers only or the entire table), Remove, and Insert Table of Figures.
 */
import { el } from '../ui/dom.js';
import { check, field, galleryItem, number, openDialog, section, select, tablePreview, text } from './references-ui.js';

const LEADER_OPTIONS = [['dot', 'Dots ......'], ['hyphen', 'Dashes ------'], ['underscore', 'Line ______'], ['middleDot', 'Middle dots ····'], ['none', '(none)']];
const SAMPLE = [{ text: 'Introduction', page: 1, level: 1 }, { text: 'Background', page: 2, level: 2 }, { text: 'Prior work', page: 3, level: 3 }, { text: 'Method', page: 5, level: 1 }];

export function createTocCommands(ctx) {
  const { editor, ready, runBody, error } = ctx;
  const engineToc = () => import('../engine/toc.js');
  const bodyParagraphs = () => editor()?.session.body.paragraphs || [];
  let tocModule = null;
  engineToc().then(m => { tocModule = m; }).catch(() => {});
  const tables = () => { try { return tocModule ? tocModule.tocFields(bodyParagraphs()) : []; } catch { return []; } };
  const hasTable = (figures = false) => tables().some(t => t.figures === figures);
  /** The table at the caret, else the first of its kind. */
  const tableFor = (toc, body, figures) => {
    const all = toc.tocFields(body.paragraphs).filter(t => t.figures === figures);
    const at = body.range[0];
    return all.find(t => t.start <= at && at <= t.end) || all[0] || null;
  };

  function insertDesign(design) {
    return runBody((body, toc) => {
      const existing = tableFor(toc, body, false);
      if (existing) return toc.insertTableOfContents(body, { existing, options: toc.contentsOptions({ levels: design.levels, pageNumbers: design.pageNumbers !== false, rightAlign: design.rightAlign !== false }), leader: design.leader, rightAlign: design.rightAlign !== false, boldTop: !!design.boldTop });
      return toc.insertTableOfContents(body, { title: design.title, options: toc.contentsOptions({ levels: design.levels, pageNumbers: design.pageNumbers !== false, rightAlign: design.rightAlign !== false }), leader: design.leader, rightAlign: design.rightAlign !== false, boldTop: !!design.boldTop });
    }, { modules: ['toc'], track: true });
  }

  function galleryItems(focusEditor) {
    const designs = tocModule?.TOC_DESIGNS || [];
    return [
      { header: 'Automatic tables' },
      ...designs.map(design => galleryItem({ label: design.name, description: design.description, disabled: !ready(), focusEditor, onSelect: () => insertDesign(design),
        preview: tablePreview(SAMPLE.filter(r => r.level <= design.levels).map(r => ({ ...r, bold: design.boldTop && r.level === 1 })), { title: design.title, leader: design.leader, rightAlign: design.rightAlign !== false, pageNumbers: design.pageNumbers !== false }) })),
    ];
  }

  function tocItems(focusEditor) {
    const has = hasTable(false);
    return [
      ...galleryItems(focusEditor),
      { separator: true },
      { label: 'Custom Table of Contents…', icon: 'toc', disabled: !ready(), onSelect: () => customDialog() },
      { label: 'Update Table…', icon: 'updateTable', disabled: !ready() || !has, onSelect: () => updateDialog(false) },
      { label: 'Remove Table of Contents', icon: 'delete', disabled: !ready() || !has, onSelect: () => runBody((body, toc) => toc.removeTableOfContents(body, tableFor(toc, body, false)), { modules: ['toc'] }) },
    ];
  }

  /* ---- Custom table of contents ---- */
  async function customDialog() {
    const engine = ready(); if (!engine) return;
    const toc = await engineToc();
    const body = engine.session.body;
    const existing = tableFor(toc, body, false);
    const options = existing ? existing.options : toc.parseTocInstruction(toc.TOC_INSTRUCTION);
    const look = existing ? toc.tocAppearance(body, existing) : { leader: 'dot', rightAlign: true, boldTop: false };
    const levelsHigh = options.headingRange?.[1] ?? Math.max(3, ...options.styles.map(s => s.level));
    const pageNumbers = check('Show page numbers', !options.omitPageNumbers, sync);
    const rightAlign = check('Right align page numbers', look.rightAlign, sync);
    const leader = select('Tab leader', LEADER_OPTIONS, look.leader, sync);
    const links = check('Use hyperlinks instead of page numbers on screen', options.hyperlinks, sync);
    const levels = number('Show levels', levelsHigh, { min: 1, max: 9, oninput: sync });
    const headings = check('Heading styles', !!options.headingRange || !existing, sync);
    const outline = check('Outline levels', options.outline || !existing, sync);
    const title = text('Title', existing ? '' : 'Contents', { placeholder: 'No title' });
    // Custom styles: each paragraph style can map to a level (the \t switch).
    const styles = Object.values(body.styles?.definitions || {}).filter(s => s.type === 'paragraph' && !/^(toc|heading) \d$/i.test(s.name || '') && s.name);
    const mapped = new Map(options.styles.map(s => [s.name.toLowerCase(), s.level]));
    const styleRows = styles.map(style => {
      const input = el('input.input.ref-level-input', { type: 'number', min: 1, max: 9, step: 1, value: mapped.get(style.name.toLowerCase()) ?? '', 'aria-label': `TOC level for ${style.name}`, oninput: sync });
      return { style, input, row: el('div.ref-style-row', {}, el('span.ref-style-name', {}, style.name), input) };
    });
    const preview = el('div.ref-preview-frame', { 'aria-label': 'Preview', role: 'img' });
    const styleList = el('div.ref-style-list', {}, ...styleRows.map(r => r.row));
    function sync() {
      rightAlign.box.disabled = !pageNumbers.box.checked;
      leader.disabled = !pageNumbers.box.checked || !rightAlign.box.checked;
      const high = Math.min(9, Math.max(1, Number(levels.value) || 3));
      preview.replaceChildren(tablePreview(SAMPLE.filter(r => r.level <= high), { leader: leader.value, rightAlign: rightAlign.box.checked, pageNumbers: pageNumbers.box.checked }));
    }
    sync();
    openDialog({ title: 'Table of Contents', wide: true, className: 'ref-toc-dialog', submitLabel: existing ? 'Replace' : 'Insert', body: [
      el('div.ref-two-column', {},
        el('div.ref-column', {},
          el('span.field-label', {}, 'Print preview'), preview,
          pageNumbers, rightAlign, field('Tab leader', leader),
          !existing && field('Title', title)),
        el('div.ref-column', {},
          links,
          field('Show levels', levels),
          section('Build table from', headings, outline,
            styleRows.length ? el('details.ref-details', {}, el('summary', {}, 'Other styles…'), el('p.field-hint', {}, 'Give a style a level from 1 to 9 to list its paragraphs.'), styleList) : null))),
    ], onSubmit: async () => {
      const high = Math.min(9, Math.max(1, Number(levels.value) || 3));
      const custom = styleRows.filter(r => r.input.value).map(r => ({ name: r.style.name, level: Math.min(9, Math.max(1, Number(r.input.value))) }));
      if (!headings.box.checked && !outline.box.checked && !custom.length) throw new Error('Choose at least one source for the table: heading styles, outline levels or another style.');
      // Outline levels alone still honour the level limit, so either source keeps the \o range.
      const next = toc.contentsOptions({ levels: high, hyperlinks: links.box.checked, pageNumbers: pageNumbers.box.checked, rightAlign: rightAlign.box.checked,
        headingStyles: headings.box.checked || outline.box.checked, outline: outline.box.checked, styles: custom });
      await runBody((doc, t) => {
        const target = tableFor(t, doc, false);
        return t.insertTableOfContents(doc, { existing: target, title: target ? null : title.value.trim(), options: next, leader: leader.value, rightAlign: rightAlign.box.checked, boldTop: target ? null : false });
      }, { modules: ['toc'], track: true });
    } });
  }

  /* ---- Update Table ---- */
  async function updateDialog(figures = false) {
    const engine = ready(); if (!engine) return;
    const toc = await engineToc();
    const target = tableFor(toc, engine.session.body, figures);
    if (!target) { error(new Error(figures ? 'This document has no table of figures yet.' : 'This document has no table of contents yet.')); return; }
    const pages = el('input', { type: 'radio', name: 'ref-update-mode', value: 'pages', checked: true });
    const entire = el('input', { type: 'radio', name: 'ref-update-mode', value: 'entire' });
    openDialog({ title: figures ? 'Update Table of Figures' : 'Update Table of Contents', submitLabel: 'Update', body: [
      el('p.field-hint', {}, 'Choose what to bring up to date.'),
      el('div.ref-radio-group', { role: 'radiogroup', 'aria-label': 'Update' },
        el('label.ed-check', {}, pages, 'Update page numbers only'),
        el('label.ed-check', {}, entire, 'Update entire table (new entries and text)')),
    ], onSubmit: () => updateTable(figures, entire.checked ? 'entire' : 'pages') });
  }

  async function updateTable(figures = false, mode = 'entire') {
    if (mode === 'pages') {
      return runBody((body, toc) => {
        const target = tableFor(toc, body, figures);
        if (!target) return false;
        return { only: toc.tocPageReferences(body, target) };
      }, { modules: ['toc'], scopedRefresh: true });
    }
    return runBody((body, toc) => {
      const target = tableFor(toc, body, figures);
      if (!target) return false;
      if (!target.whole) return { only: toc.tocPageReferences(body, target) };
      return toc.insertTableOfContents(body, { existing: target });
    }, { modules: ['toc'] });
  }

  /* ---- Add Text: a paragraph's level in the table ---- */
  function currentLevel() {
    const engine = editor();
    if (!engine || engine.session.path !== null) return null;
    const level = engine.model.paragraphFormatting?.outlineLevel;
    return level === null || level === undefined ? null : level;
  }
  function addTextItems() {
    const toc = tables().find(t => !t.figures), shown = Math.max(3, toc?.options.headingRange?.[1] ?? 3);
    const level = currentLevel(), disabled = !ready() || editor()?.session.path !== null;
    return [
      { label: 'Do Not Show in Table of Contents', checked: level === 9, radio: true, disabled, onSelect: () => setLevel(0) },
      ...Array.from({ length: shown }, (_, i) => ({ label: `Level ${i + 1}`, checked: level === i, radio: true, disabled, onSelect: () => setLevel(i + 1) })),
    ];
  }
  function setLevel(level) {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    if (engine.session.path !== null) { error(new Error('Add Text applies to paragraphs in the document body.')); return; }
    const model = engine.model, styles = model.styles?.definitions || {};
    const named = name => Object.values(styles).find(s => s.type === 'paragraph' && s.name?.toLowerCase() === name)?.id;
    engine.execute(() => {
      const heading = level ? named(`heading ${level}`) : null;
      if (heading) return model.setParagraphStyle(heading);
      // Built-in heading styles fix their level: return to the default paragraph style first.
      if (!model.canSetOutlineLevel) model.setParagraphStyle(model.styles.defaultParagraph || null);
      const now = model.paragraphFormatting?.outlineLevel;
      if (level) return model.setOutlineLevel(level - 1) || true;
      if (now !== 9) model.setOutlineLevel(9);
      return true;
    });
    engine.focus(); ctx.onChange();
  }

  /* ---- Table of figures ---- */
  async function figuresDialog() {
    const engine = ready(); if (!engine) return;
    const [toc, captions] = await Promise.all([engineToc(), import('../engine/captions.js')]);
    const body = engine.session.body;
    const existing = tableFor(toc, body, true);
    const labels = captions.captionLabels(body);
    const options = existing?.options;
    const look = existing ? toc.tocAppearance(body, existing) : { leader: 'dot', rightAlign: true };
    // A table of figures names its captions' SEQ identifier ("My_Chart"); show the label it stands for.
    const current = options?.caption || options?.captionNoLabel;
    const label = select('Caption label', labels.map(l => [l, l]), (current && labels.find(l => captions.sequenceId(l).toLowerCase() === captions.sequenceId(current).toLowerCase())) || current || labels[0], sync);
    const includeLabel = check('Include label and number', !options?.captionNoLabel, sync);
    const pageNumbers = check('Show page numbers', !options?.omitPageNumbers, sync);
    const rightAlign = check('Right align page numbers', look.rightAlign, sync);
    const leader = select('Tab leader', LEADER_OPTIONS, look.leader, sync);
    const links = check('Use hyperlinks instead of page numbers on screen', options ? options.hyperlinks : true);
    const preview = el('div.ref-preview-frame', { role: 'img', 'aria-label': 'Preview' });
    function sync() {
      rightAlign.box.disabled = !pageNumbers.box.checked;
      leader.disabled = !pageNumbers.box.checked || !rightAlign.box.checked;
      const name = label.value || 'Figure', prefix = n => includeLabel.box.checked ? `${name} ${n}: ` : '';
      preview.replaceChildren(tablePreview([{ text: `${prefix(1)}Sample one`, page: 1, level: 1 }, { text: `${prefix(2)}Sample two`, page: 3, level: 1 }, { text: `${prefix(3)}Sample three`, page: 5, level: 1 }],
        { leader: leader.value, rightAlign: rightAlign.box.checked, pageNumbers: pageNumbers.box.checked }));
    }
    sync();
    openDialog({ title: 'Table of Figures', wide: true, className: 'ref-toc-dialog', submitLabel: existing ? 'Replace' : 'Insert', body: [
      el('div.ref-two-column', {},
        el('div.ref-column', {}, el('span.field-label', {}, 'Print preview'), preview, pageNumbers, rightAlign, field('Tab leader', leader)),
        el('div.ref-column', {}, field('Caption label', label), includeLabel, links)),
    ], onSubmit: () => runBody((doc, t) => {
      const target = tableFor(t, doc, true);
      const next = t.figuresOptions({ label: label.value || 'Figure', includeLabel: includeLabel.box.checked, hyperlinks: links.box.checked, pageNumbers: pageNumbers.box.checked, rightAlign: rightAlign.box.checked });
      return t.insertTableOfContents(doc, { existing: target, title: null, options: next, leader: leader.value, rightAlign: rightAlign.box.checked, boldTop: false });
    }, { modules: ['toc'], track: true }) });
  }

  return {
    tocItems, addTextItems, customDialog, updateDialog, updateTable, figuresDialog, setLevel,
    hasToc: () => hasTable(false), hasFigures: () => hasTable(true),
  };
}
