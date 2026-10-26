/**
 * The References tab and page furniture: tables of contents and figures, footnotes and endnotes,
 * citations and bibliography, captions and cross-references, index, table of authorities, Smart
 * Lookup, plus headers and footers that do not exist yet and page numbers (Insert tab). Each area
 * lives in its own module; this one wires them to the ribbon, menus and keyboard. Engine code loads
 * on demand, like the rest of the editor's engine.
 */
import { openMenu } from '../ui/menu.js';
import { el, MOD_KEY, shortcutCode, typesCharacter } from '../ui/dom.js';
import { createTocCommands } from './references-toc.js';
import { createNoteCommands } from './references-notes.js';
import { createCitationCommands } from './references-citations.js';
import { createIndexCommands } from './references-index.js';
import { createSmartLookup } from './smart-lookup.js';
import { check, field, openDialog, select, text } from './references-ui.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** A page field record for header/footer stories, as the DOCX reader produces one. */
async function pageField(type) {
  const { pageFieldSegments } = await import('../engine/docx-page-fields.js');
  const root = new DOMParser().parseFromString(`<w:p xmlns:w="${W}"><w:fldSimple w:instr=" ${type} "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>`, 'application/xml').documentElement;
  const [segment] = pageFieldSegments(root);
  return { ...segment.field, cachedText: '1' };
}

export function createReferences({ editor, pkg, error, base = {}, onChange = () => {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const fail = e => { error(e); editor()?.focus(); };

  /** Which header/footer variant a page shows: first, even or default (§17.10.5). */
  function variantFor(engine, page) {
    const definition = engine.pageStories, section = engine.sectionOfPage(page);
    const firstPage = engine.layout.pageSections?.indexOf(section) ?? 0;
    if (page === firstPage && definition?.sections[section]?.firstPageDifferent) return 'first';
    return definition?.evenAndOdd && (page + 1) % 2 === 0 ? 'even' : 'default';
  }
  const currentPage = engine => engine.session.path !== null ? engine.storyPage ?? 0 : engine.caretPageIndex ?? 0;

  /** The editable header/footer story of `kind` for the current page, creating it (in the right variant) when missing. */
  async function story(kind, page = null) {
    const engine = ready(); if (!engine) return null;
    engine.finishComposition();
    page ??= currentPage(engine);
    const section = engine.sectionOfPage(page), variant = variantFor(engine, page);
    const existing = engine.pageStories?.sections[section]?.[kind]?.[variant];
    if (existing) {
      if (!engine.pageStories.stories[existing]?.editable) throw new Error(`This document's ${kind} cannot be edited yet.`);
      engine.editStory(existing, page); return existing;
    }
    const { TextDocument, paragraph } = await import('../engine/model.js');
    const body = engine.session.body;
    const styleId = Object.values(body.styles.definitions || {}).find(s => s.type === 'paragraph' && s.name?.toLowerCase() === kind)?.id;
    const draft = new TextDocument([paragraph('', styleId ? { styleId } : {})], body.pageSettings, body.numbering, body.styles, [], body.assets);
    const path = pkg().addPageStory(kind, { variant, section });
    engine.attachPageStory(path, kind, draft.paragraphs, { variant, section });
    engine.onChange();
    engine.editStory(path, page);
    return path;
  }
  async function setStoryOption(option, on) {
    try {
      const engine = ready(); if (!engine) return;
      const kind = activeStoryKind(), page = currentPage(engine), section = engine.sectionOfPage(page);
      if (option === 'first') { pkg().setTitlePage(section, on); engine.setStoryOptions({ section, firstPageDifferent: on }); }
      else { pkg().setEvenAndOdd(on); engine.setStoryOptions({ evenAndOdd: on }); }
      engine.onChange();
      if (kind === 'header' || kind === 'footer') await story(kind, page);
      onChange();
    } catch (e) { fail(e); }
  }

  async function editHeader(kind) {
    try { await story(kind); } catch (e) { fail(e); }
  }

  async function insertPageNumber(where, alignment, style = 'plain') {
    try {
      const engine = ready(); if (!engine) return;
      if (where !== 'current') await story(where === 'top' ? 'header' : 'footer');
      else if (engine.session.path === null) throw new Error('Page numbers can be inserted in a header or footer. Double-click the top or bottom of a page, or use Top of Page or Bottom of Page.');
      const [page, total] = await Promise.all([pageField('PAGE'), pageField('NUMPAGES')]);
      engine.execute(() => {
        const model = engine.model;
        if (where !== 'current') {
          if (model.text.trim()) { model.select(model.text.length); model.replace('\n'); }
          else model.select(0, model.text.length);
          model.setParagraphFormat({ alignment });
        }
        if (style === 'pageOf') { model.replace('Page '); model.insertFieldRun(page); model.replace(' of '); model.insertFieldRun(total); }
        else model.insertFieldRun(page);
        return true;
      });
      engine.focus();
    } catch (e) { fail(e); }
  }

  function pageNumberItems() {
    const placements = where => ['left', 'center', 'right'].flatMap(alignment => [
      { label: `Plain Number ${alignment === 'left' ? '1' : alignment === 'center' ? '2' : '3'} (${alignment[0].toUpperCase() + alignment.slice(1)})`, onSelect: () => insertPageNumber(where, alignment) },
    ]).concat([{ separator: true }, { label: 'Page X of Y', onSelect: () => insertPageNumber(where, 'center', 'pageOf') }]);
    return [
      { label: 'Top of Page', items: placements('top') },
      { label: 'Bottom of Page', items: placements('bottom') },
      { label: 'Current Position', disabled: editor()?.session.path === null, items: [{ label: 'Plain Number', onSelect: () => insertPageNumber('current') }, { label: 'Page X of Y', onSelect: () => insertPageNumber('current', null, 'pageOf') }] },
    ];
  }

  /* ---- Shared plumbing for the References modules ---- */
  const ENGINE = {
    toc: () => import('../engine/toc.js'),
    captions: () => import('../engine/captions.js'),
    bibliography: () => import('../engine/bibliography-fields.js'),
    index: () => import('../engine/index-entries.js'),
    authorities: () => import('../engine/authorities.js'),
    generated: () => import('../engine/generated-fields.js'),
  };
  let pageLookupModule = null;
  import('../engine/page-lookup.js').then(m => { pageLookupModule = m; }).catch(() => {});
  /** Printed pages of body positions, from a fresh layout of `body`. */
  const pageOf = body => {
    const engine = editor();
    return pageLookupModule.pageLookup(engine.layoutModel(body), engine.pageStories);
  };
  /**
   * Run `action(body, ...modules)` on the document body as one undo step, without tracking changes,
   * then refresh page references (all, or `result.only`). Returns the action's result.
   */
  async function runBody(action, { modules = ['captions'], refresh = true, keepFocus = false } = {}) {
    const engine = ready(); if (!engine) return false;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const [refreshModule, ...loaded] = await Promise.all([import('../engine/page-reference-refresh.js'), ...modules.map(name => ENGINE[name]())]);
    if (!pageLookupModule) pageLookupModule = await import('../engine/page-lookup.js');
    const body = engine.session.body, tracking = body.trackChanges;
    body.trackChanges = false;
    let result;
    try {
      engine.execute(() => {
        result = action(body, ...loaded);
        if (result === false) return false;
        if (refresh || result?.only) refreshModule.refreshPageReferences(body, model => engine.layoutModel(model), engine.pageStories, { checkpoint: false, only: result?.only || null });
        return result;
      });
    } finally { body.trackChanges = tracking; }
    if (!keepFocus) engine.focus();
    onChange();
    return result;
  }
  const ctx = { editor, pkg, error, ready, fail, runBody, pageOf, onChange: () => onChange(), showFieldCodes: () => base.showFieldCodes?.() };
  const toc = createTocCommands(ctx);
  const notes = createNoteCommands(ctx);
  const citations = createCitationCommands(ctx);
  const indexes = createIndexCommands(ctx);
  const lookup = createSmartLookup({ editor, error });
  const hasToc = () => toc.hasToc();

  /* ---- Field updates (F9) ---- */
  async function noteNumberMaps() {
    const engine = editor(), notesModule = await import('../engine/footnotes.js');
    const definition = engine?.pageStories, paragraphs = engine?.session.body.paragraphs || [];
    const maps = {};
    for (const kind of ['footnote', 'endnote']) maps[kind] = notesModule.noteNumbers(paragraphs, definition?.[`${kind}s`] || { format: kind === 'footnote' ? 'decimal' : 'lowerRoman' }, kind);
    return maps;
  }
  /** Update every field this editor can evaluate: sequences, references, citations, bibliographies and page numbers. */
  async function updateAllFields() {
    if (!ready()) return;
    const { updateSequenceFields } = await import('../engine/field-update.js');
    const issues = [], notesMaps = await noteNumberMaps();
    await runBody(body => { updateSequenceFields(body, { onIssue: issue => issues.push(issue), notes: notesMaps }); return true; });
    await citations.refreshFields();
    if (issues.length) error(new Error([...new Set(issues.map(issue => issue.message))].join(' ')));
  }

  /* ---- Captions ---- */
  const LABELS_KEY = 'documents.captions.labels';
  const customLabels = () => { try { const list = JSON.parse(localStorage.getItem(LABELS_KEY) || '[]'); return Array.isArray(list) ? list.filter(l => typeof l === 'string') : []; } catch { return []; } };
  const saveLabels = list => { try { localStorage.setItem(LABELS_KEY, JSON.stringify([...new Set(list)])); } catch { /* storage unavailable */ } };
  async function captionDialog() {
    const engine = ready(); if (!engine) return;
    if (engine.session.path !== null) engine.editStory(null);
    const captions = await import('../engine/captions.js');
    const body = engine.session.body;
    const labels = () => captions.captionLabels(body, customLabels());
    const label = select('Label', labels().map(l => [l, l]), engine.model.selectedImage ? 'Figure' : engine.model.tableContext ? 'Table' : 'Figure', () => sync());
    const caption = text('Caption text', '', { placeholder: 'Optional description' });
    const position = select('Position', [['below', 'Below selected item'], ['above', 'Above selected item']], engine.model.tableContext && !engine.model.selectedImage ? 'above' : 'below');
    const format = select('Numbering', Object.entries(captions.CAPTION_FORMATS).map(([id, name]) => [id, name]), 'ARABIC', () => sync());
    const exclude = check('Exclude label from caption', false, () => sync());
    const preview = el('p.ref-caption-preview', { 'aria-live': 'polite' });
    const sample = { ARABIC: '1', alphabetic: 'a', ALPHABETIC: 'A', roman: 'i', ROMAN: 'I' };
    function sync() {
      const used = customLabels().includes(label.value);
      deleteLabel.disabled = !used;
      const t = caption.value.trim();
      preview.textContent = `${exclude.box.checked ? '' : `${label.value} `}${sample[format.value]}${t ? `${/^[\s:.\-–—]/.test(t) ? '' : ': '}${t}` : ''}`;
    }
    const newLabel = el('button.btn.btn-outline', { type: 'button', onclick: () => {
      const input = text('New label', '', { required: true, maxLength: 40, pattern: '[A-Za-z][A-Za-z0-9 _]{0,39}' });
      openDialog({ title: 'New Label', body: [field('Label', input, 'Letters, numbers and spaces, such as Chart or Plate.')], onSubmit: () => {
        const value = input.value.trim().replace(/\s+/g, ' ');
        if (!/^[A-Za-z][A-Za-z0-9 _]{0,39}$/.test(value)) throw new Error('Start the label with a letter and use letters, numbers and spaces.');
        saveLabels([...customLabels(), value]);
        label.replaceChildren(...labels().map(l => el('option', { value: l }, l))); label.value = value; sync();
      } });
    } }, 'New Label…');
    const deleteLabel = el('button.btn.btn-outline', { type: 'button', onclick: () => {
      saveLabels(customLabels().filter(l => l !== label.value));
      label.replaceChildren(...labels().map(l => el('option', { value: l }, l))); sync();
    } }, 'Delete Label');
    caption.addEventListener('input', sync);
    sync();
    openDialog({ title: 'Caption', className: 'ref-caption-dialog', body: [
      field('Caption', caption), preview,
      el('div.ref-two-column.ref-tight', {}, field('Label', label), field('Position', position)),
      exclude, field('Numbering', format),
      el('div.row', {}, newLabel, deleteLabel),
    ], onSubmit: () => runBody((doc, c) => c.insertCaption(doc, { label: label.value, text: caption.value.trim(), above: position.value === 'above', format: format.value, excludeLabel: exclude.box.checked }), { modules: ['captions'] }) });
    caption.focus();
  }

  /* ---- Cross-references ---- */
  async function noteTargets() {
    const engine = editor(), notesModule = await import('../engine/footnotes.js'), maps = await noteNumberMaps();
    const definition = engine.pageStories, result = [];
    for (const kind of ['footnote', 'endnote']) {
      const part = definition?.[`${kind}s`]?.part;
      for (const [id, display] of maps[kind]) {
        const story = part && definition.stories[notesModule.footnoteStoryPath(part, id)];
        const textOf = story ? story.paragraphs.map(p => p.runs.filter(r => !r.noteMark).map(r => r.text).join('')).join(' ').trim().slice(0, 60) : '';
        result.push({ kind, id, display, text: textOf });
      }
    }
    return result;
  }
  async function crossReferenceDialog() {
    const engine = ready(); if (!engine) return;
    if (engine.session.path !== null) engine.editStory(null);
    const captions = await import('../engine/captions.js');
    const targets = captions.referenceTargets(engine.session.body, { notes: await noteTargets() });
    const captionKinds = [...new Set([...captions.CAPTION_LABELS.map(captions.sequenceId), ...targets.captions.map(c => c.kind)])];
    const kinds = [['heading', 'Heading', targets.headings], ['bookmark', 'Bookmark', targets.bookmarks], ['footnote', 'Footnote', targets.footnotes], ['endnote', 'Endnote', targets.endnotes],
      ...captionKinds.map(k => [k, k.replace(/_/g, ' '), targets.captions.filter(c => c.kind === k)])];
    const type = select('Reference type', kinds.map(([id, name]) => [id, name]), kinds.find(k => k[2].length)?.[0] || 'heading', () => fill());
    const show = select('Insert reference to', []);
    const list = el('select.input.ed-xref-list', { 'aria-label': 'For which item', size: 8 });
    const hyperlink = check('Insert as hyperlink', true);
    const aboveBelow = check('Include above/below', false);
    const empty = el('p.field-hint', { hidden: true }, 'There are no items of this type yet.');
    const insert = el('button.btn.btn-primary', { type: 'submit' }, 'Insert');
    function fill() {
      const kind = kinds.find(k => k[0] === type.value);
      show.replaceChildren(...captions.referenceChoices(['heading', 'bookmark', 'footnote', 'endnote'].includes(type.value) ? type.value : 'caption').map(([v, l]) => el('option', { value: v }, l)));
      list.replaceChildren(...kind[2].map((item, i) => el('option', { value: String(i) }, item.label)));
      if (kind[2].length) list.value = '0';
      empty.hidden = !!kind[2].length; insertButton.disabled = !kind[2].length;
      aboveBelow.box.disabled = show.value === 'position';
    }
    show.addEventListener('change', () => { aboveBelow.box.disabled = show.value === 'position'; });
    let insertButton;
    const dialog = openDialog({ title: 'Cross-reference', className: 'ref-xref-dialog', submitLabel: 'Insert', body: [
      el('div.ref-two-column.ref-tight', {}, field('Reference type', type), field('Insert reference to', show)),
      el('div.row', {}, hyperlink, aboveBelow),
      field('For which item', list), empty,
    ], onSubmit: async () => {
      const target = kinds.find(k => k[0] === type.value)[2][Number(list.value)];
      if (!target) throw new Error('Choose an item to refer to.');
      await runBody((body, c) => { c.insertCrossReference(body, target, { show: show.value, hyperlink: hyperlink.box.checked, aboveBelow: aboveBelow.box.checked }); return true; });
    } });
    insertButton = dialog.submit;
    list.addEventListener('dblclick', () => dialog.form.requestSubmit());
    fill(); type.focus();
  }

  /* ---- Ribbon ---- */
  const noSteal = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); };
  function extendTab(tabId, kit) {
    if (tabId !== 'references') return [];
    const { command, menuButton, rows, when, focusEditor } = kit;
    const bodyReady = () => !!ready() && editor()?.session.path === null;
    // Research
    const smart = command('Smart Lookup', 'smartLookup', () => lookup.open(), { size: 'large', text: 'Smart Lookup' });
    when(smart, () => { const group = smart.closest('.ribbon-group'); const available = lookup.available(); if (group) group.hidden = !available; return available && !!editor(); });
    // Citations & Bibliography
    const citation = menuButton('Insert Citation', 'citation', () => citations.citationItems(), { text: 'Insert Citation' });
    const manage = command('Manage Sources', 'manageSources', () => citations.manageSources(), { text: 'Manage Sources' });
    const style = citations.styleControl();
    const styleWrap = el('label.ribbon-spin.ref-style-wrap', { title: 'Citation style' }, el('span.ribbon-spin-label', {}, 'Style:'), style.control);
    const bibliography = menuButton('Bibliography', 'bibliography', () => citations.bibliographyItems(focusEditor), { size: 'small', text: 'Bibliography' });
    when(citation, () => !!ready()); when(manage, () => !!ready()); when(bibliography, () => !!ready());
    when(style.control, () => { style.sync(); return !!ready(); });
    // Captions
    const caption = command('Insert Caption', 'caption', () => captionDialog(), { size: 'large', text: 'Insert Caption' });
    const figures = command('Insert Table of Figures', 'tableOfFigures', () => toc.figuresDialog(), { text: 'Insert Table of Figures' });
    const updateFigures = command('Update Table of Figures', 'updateTable', () => toc.updateDialog(true), { text: 'Update Table' });
    const xref = command('Cross-reference', 'crossReference', () => crossReferenceDialog(), { text: 'Cross-reference' });
    when(caption, () => !!ready()); when(figures, bodyReady); when(updateFigures, () => !!ready() && toc.hasFigures()); when(xref, bodyReady);
    // Index
    const markEntry = command('Mark Entry', 'markEntry', () => indexes.markEntryPanel(), { size: 'large', text: 'Mark Entry', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+Shift+X' : 'Alt+Shift+X' });
    const insertIndex = command('Insert Index', 'index', () => indexes.insertIndexDialog(), { text: 'Insert Index' });
    const updateIndex = command('Update Index', 'updateIndex', () => indexes.updateIndex(), { text: 'Update Index' });
    when(markEntry, bodyReady); when(insertIndex, bodyReady); when(updateIndex, () => !!ready() && hasField('INDEX'));
    // Table of authorities
    const markCitation = command('Mark Citation', 'markCitation', () => indexes.markCitationPanel(), { size: 'large', text: 'Mark Citation', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+Shift+I' : 'Alt+Shift+I' });
    const insertToa = command('Insert Table of Authorities', 'tableOfAuthorities', () => indexes.insertAuthoritiesDialog(), { text: 'Insert Table' });
    const updateToa = command('Update Table of Authorities', 'updateAuthorities', () => indexes.updateAuthorities(), { text: 'Update Table' });
    when(markCitation, bodyReady); when(insertToa, bodyReady); when(updateToa, () => !!ready() && hasField('TOA'));
    noSteal(smart, manage, caption, figures, updateFigures, xref, markEntry, insertIndex, updateIndex, markCitation, insertToa, updateToa);
    return [
      { id: 'research', label: 'Research', icon: 'smartLookup', priority: 2, after: 'footnotes', items: [smart] },
      { id: 'citations', label: 'Citations & Bibliography', icon: 'citation', priority: 4, after: 'research', items: [citation, rows([manage], [styleWrap], [bibliography])] },
      { id: 'captions', label: 'Captions', icon: 'caption', priority: 4, after: 'citations', items: [caption, rows([figures], [updateFigures], [xref])] },
      { id: 'index', label: 'Index', icon: 'index', priority: 3, after: 'captions', items: [markEntry, rows([insertIndex], [updateIndex])] },
      { id: 'authorities', label: 'Table of Authorities', icon: 'tableOfAuthorities', priority: 1, after: 'index', items: [markCitation, rows([insertToa], [updateToa])] },
    ];
  }
  const hasField = type => (editor()?.session.body.paragraphs || []).some(p => p.fieldMarkers?.some(m => m.field.type === type));

  /* ---- Menu bar and context menu contributions ---- */
  function extendMenu(menuId) {
    const disabled = !ready(), body = editor()?.session.path === null;
    if (menuId === 'insert') return [
      { separator: true },
      { label: 'Bookmark…', icon: 'bookmark', disabled: disabled || !body, onSelect: () => base.openBookmarks?.() },
      { label: 'Cross-reference…', icon: 'crossReference', disabled: disabled || !body, onSelect: () => crossReferenceDialog() },
      { separator: true },
      { label: 'Footnote…', icon: 'footnote', disabled, onSelect: () => notes.notesDialog() },
      { label: 'Caption…', icon: 'caption', disabled, onSelect: () => captionDialog() },
      { label: 'Index and Tables', icon: 'toc', disabled, items: [
        { label: 'Index…', icon: 'index', onSelect: () => indexes.insertIndexDialog() },
        { label: 'Table of Contents…', icon: 'toc', onSelect: () => toc.customDialog() },
        { label: 'Table of Figures…', icon: 'tableOfFigures', onSelect: () => toc.figuresDialog() },
        { label: 'Table of Authorities…', icon: 'tableOfAuthorities', onSelect: () => indexes.insertAuthoritiesDialog() },
      ] },
    ];
    if (menuId === 'view') return [{ label: 'Footnotes', icon: 'showNotes', disabled: !editor(), onSelect: () => notes.showNotes() }];
    if (menuId === 'tools' && lookup.available()) return [{ label: 'Smart Lookup…', icon: 'smartLookup', disabled: !editor(), onSelect: () => lookup.open() }];
    return [];
  }
  let fieldsModule = null;
  import('../engine/body-fields.js').then(m => { fieldsModule = m; }).catch(() => {});
  /** Whether the caret is in a body field's result (or at an index or authority entry). */
  function fieldAtCaret() {
    const engine = editor();
    if (!engine || engine.session.path !== null || !engine.model.hasBodyFields || !fieldsModule) return false;
    const [start, end] = engine.model.range;
    try { return fieldsModule.bodyFieldRanges(engine.model.paragraphs).some(r => r.start <= start && end <= r.end && (r.start < r.end || r.start === start)); } catch { return false; }
  }
  function contextMenuItems(context) {
    const items = [];
    if (['text', 'field', 'link'].includes(context) && lookup.available() && editor()) items.push({ label: 'Smart Lookup', icon: 'smartLookup', onSelect: () => lookup.open() });
    if (context === 'field' || context === 'text') {
      items.push(...citations.contextItems());
      if (context === 'field' && ready()) items.push({ label: 'Update Field', icon: 'updateFields', shortcut: 'F9', onSelect: () => updateAllFields() });
    }
    return items;
  }

  const commands = {
    insertFootnote: () => notes.insertNote('footnote'),
    insertEndnote: () => notes.insertNote('endnote'),
    nextNoteItems: () => notes.nextNoteItems(),
    showNotes: () => notes.showNotes(),
    notesDialog: () => notes.notesDialog(),
    canInsertFootnote: () => !!ready() && editor()?.session.path === null,
    canEditHeader: () => !!ready(),
    editHeader,
    canInsertPageNumber: () => !!ready(),
    insertPageNumber(event, button) {
      const anchor = button || document.querySelector('#ribbon-panel-insert button[aria-label="Page Number"]') || document.activeElement;
      // A menu the mouse opened closes back into the document; one the keyboard opened returns to its button.
      openMenu({ anchor, label: 'Page Number', minWidth: 220, items: pageNumberItems(), pointer: !!event?.detail, onClose: event?.detail ? () => editor()?.focus() : null });
    },
    pageNumberItems,
    tocItems: focusEditor => toc.tocItems(focusEditor),
    addTextItems: () => toc.addTextItems(),
    updateTocDialog: () => toc.updateDialog(false),
    customToc: () => toc.customDialog(),
    updateAllFields,
    canUpdateFields: () => !!ready() && (hasToc() || !!base.canUpdateFields?.()),
    // Update Fields (Tools menu, the field's context menu, after inserting a field) does what F9 does:
    // sequences, references, dates, citations and page numbers, including the table of contents' pages.
    // It refreshed only page references before, so SEQ and REF results stayed stale.
    updateFields: () => updateAllFields(),
    smartLookup: () => lookup.open(),
    canSmartLookup: () => lookup.available(),
    extendMenu,
    contextMenuItems,
  };
  /* ---- Contextual Header & Footer tab, shown while a header or footer is active ---- */
  const activeStoryKind = () => { const engine = editor(); return engine?.session.path ? engine.pageStories?.stories[engine.session.path]?.kind : null; };
  function contextTabs(kit) {
    const { command, rows, when, menuButton, commandIconEl } = kit;
    const IN = 1440;
    const header = command('Header', 'header', () => editHeader('header'), { size: 'large' });
    const footer = command('Footer', 'footer', () => editHeader('footer'), { size: 'large' });
    const pageNumber = menuButton('Page Number', 'pageNumber', pageNumberItems);
    const goHeader = command('Go to Header', 'goToHeader', () => editHeader('header'), { text: 'Go to Header' });
    const goFooter = command('Go to Footer', 'goToFooter', () => editHeader('footer'), { text: 'Go to Footer' });
    const close = command('Close Header and Footer', 'close', () => { const engine = editor(); if (engine) { engine.editStory(null); engine.focus(); onChange(); } }, { size: 'large', text: 'Close Header and Footer' });
    close.classList.add('ribbon-wide'); // 'Close Header and Footer' in two lines
    for (const b of [header, footer, goHeader, goFooter, close]) b.addEventListener('mousedown', e => e.preventDefault());
    when(goHeader, () => activeStoryKind() !== 'header'); when(goFooter, () => activeStoryKind() !== 'footer');
    const distance = (key, label) => {
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', step: 0.05, min: 0, max: 22, className: 'canvas-spacing ribbon-number' });
      input.setAttribute('aria-label', `${label} (in)`);
      input.addEventListener('change', () => {
        // The arrows step by 0.05, but any distance in range is accepted, as Page Setup accepts it.
        const v = input.validity;
        const engine = ready(); if (!engine || input.value === '' || v.badInput || v.rangeOverflow || v.rangeUnderflow) { input.reportValidity(); return; }
        try { engine.finishComposition(); engine.setPageSettings({ [key]: Math.round(Number(input.value) * IN) }); } catch (e) { fail(e); }
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.dispatchEvent(new Event('change')); editor()?.focus(); } });
      when(input, () => !!ready());
      kit.states?.push?.({ control: input, enabled: () => !!ready(), value: () => Math.round((editor()?.session.body.pageSettings[key] ?? 720) / IN * 100) / 100 });
      const wrap = document.createElement('label'); wrap.className = 'ribbon-spin'; wrap.title = label;
      wrap.append(commandIconEl(key === 'header' ? 'spaceBefore' : 'spaceAfter', 16), Object.assign(document.createElement('span'), { className: 'ribbon-spin-label', textContent: label }), input, Object.assign(document.createElement('span'), { className: 'ribbon-spin-unit', textContent: 'in' }));
      input.value = String(Math.round((editor()?.session.body.pageSettings[key] ?? 720) / IN * 100) / 100);
      return { wrap, input };
    };
    const top = distance('header', 'Header from Top'), bottom = distance('footer', 'Footer from Bottom');
    const spinGroup = Object.assign(document.createElement('div'), { className: 'ribbon-spin-group' });
    spinGroup.append(top.wrap, bottom.wrap);
    const definition = () => editor()?.pageStories;
    const firstPage = kit.check('Different First Page', () => !!definition()?.sections[editor()?.sectionOfPage(currentPage(editor())) ?? 0]?.firstPageDifferent, on => setStoryOption('first', on));
    const oddEven = kit.check('Different Odd & Even Pages', () => !!definition()?.evenAndOdd, on => setStoryOption('evenOdd', on));
    const sync = () => { const p = editor()?.session.body.pageSettings; if (!p) return; for (const [d, key] of [[top, 'header'], [bottom, 'footer']]) if (document.activeElement !== d.input) d.input.value = String(Math.round(p[key] / IN * 100) / 100); };
    when(close, () => { sync(); return true; });
    return [{ id: 'headerFooter', label: 'Header & Footer', contextual: 'headerFooter', selectOnAppear: true, groups: [
      { id: 'hfHeaderFooter', label: 'Header & Footer', icon: 'header', priority: 6, items: [header, footer, pageNumber] },
      { id: 'hfNavigation', label: 'Navigation', icon: 'next', priority: 4, items: [rows([goHeader], [goFooter])] },
      { id: 'hfOptions', label: 'Options', icon: 'header', priority: 7, items: [rows([firstPage], [oddEven])] },
      { id: 'hfPosition', label: 'Position', icon: 'margins', priority: 5, items: [spinGroup] },
      { id: 'hfClose', label: 'Close', icon: 'close', priority: 9, items: [close] },
    ] }];
  }

  // Keyboard: Cmd+Option+F footnote and Cmd+Option+E endnote on a Mac (Ctrl+Alt+F and Ctrl+Alt+D
  // elsewhere), F9 updates fields, Cmd+Option+Shift+X / Alt+Shift+X marks an index entry and
  // Cmd+Option+Shift+I / Alt+Shift+I marks a citation for the table of authorities.
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.isComposing || typesCharacter(e) || !e.target?.matches?.('.canvas-input')) return;
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const chord = mac ? e.metaKey && e.altKey && !e.ctrlKey : e.ctrlKey && e.altKey && !e.metaKey;
    const mark = mac ? e.metaKey && e.altKey && e.shiftKey : e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    const code = shortcutCode(e);
    if (chord && !e.shiftKey && code === 'KeyF') { e.preventDefault(); notes.insertNote('footnote'); }
    else if (chord && !e.shiftKey && code === (mac ? 'KeyE' : 'KeyD')) { e.preventDefault(); notes.insertNote('endnote'); }
    else if (mark && code === 'KeyX') { e.preventDefault(); indexes.markEntryPanel(); }
    else if (mark && code === 'KeyI') { e.preventDefault(); indexes.markCitationPanel(); }
    else if (e.key === 'F9' && !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); updateAllFields(); }
  }, { signal: keyAbort.signal });
  return { commands, contextTabs, extendTab, extendMenu, contextMenuItems, fieldAtCaret, activeStoryKind, updateAllFields, lookupPane: lookup.pane, destroy: () => { keyAbort.abort(); lookup.close(); document.querySelectorAll('.ref-panel').forEach(p => p.closePanel?.()); } };
}
