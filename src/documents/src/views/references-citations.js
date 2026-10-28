/**
 * Citations and bibliography on the References tab: Insert Citation (a document source, a new
 * source or a placeholder), the source dialog with fields for each source type and a live preview,
 * Manage Sources (the account's master list beside the document's list: copy, edit, delete, search,
 * preview), the citation Style selector and the Bibliography gallery. Sources are kept in the
 * document's bibliography part, so other word processors see them too.
 */
import { el, isComposing } from '../ui/dom.js';
import { check, field, galleryItem, openDialog, select, text } from './references-ui.js';
import { loadMasterSources, rememberSources, saveMasterSources, syncMasterSources, preferredStyle, rememberStyle } from '../lib/source-library.js';

const engineModules = () => Promise.all([import('../engine/bibliography.js'), import('../engine/bibliography-fields.js'), import('../engine/citation-styles.js')]);

export function createCitationCommands(ctx) {
  const { editor, pkg, ready, runBody, error } = ctx;
  let modules = null;
  engineModules().then(m => { modules = m; }).catch(() => {});
  let pendingStyle = null;

  /** The document's sources and style: { data, style }. */
  function documentData() {
    const [bib, fields] = modules || [];
    if (!fields || !pkg()) return { data: { style: '', styleName: '', sources: [] }, style: pendingStyle || preferredStyle() };
    let part = null;
    try { part = fields.readBibliographyPart(pkg().parts); } catch { part = null; }
    const data = part?.data || { style: '', styleName: '', sources: [] };
    return { data, style: pendingStyle || (part ? fields.styleOf(data) : preferredStyle()), bib };
  }
  const currentStyle = () => documentData().style;

  /** Save the document's sources (and style) and refresh every citation and bibliography. */
  /** `renamed` ([oldTag, newTag]) points the citations of a source whose tag was changed at its new tag. */
  async function saveSources(sources, style = currentStyle(), { renamed = null } = {}) {
    if (!ready()) throw new Error('This document is open read-only.');
    const [, fields, styles] = await engineModules();
    const { data } = documentData();
    const info = styles.CITATION_STYLES[style];
    fields.writeBibliographyPart(pkg().parts, { ...data, style, styleName: `${info.name} ${info.edition}`, sources });
    pendingStyle = null;
    await refreshFields(sources, style, renamed);
    editor()?.onChange?.();
  }
  async function refreshFields(sources = documentData().data.sources, style = currentStyle(), renamed = null) {
    const engine = editor();
    const paragraphs = engine?.session.body.paragraphs || [];
    if (!paragraphs.some(p => p.fieldMarkers?.some(m => ['CITATION', 'BIBLIOGRAPHY'].includes(m.field.type)))) return;
    await runBody((body, fields) => {
      if (renamed) fields.renameCitedTag(body, ...renamed);
      fields.updateCitations(body, sources, style); fields.updateBibliographies(body, sources, style); return true;
    }, { modules: ['bibliography'], refresh: false });
  }
  /**
   * The citation and bibliography refresh as an action for runBody's bibliography module, with the document's
   * sources and style read now, so Update Fields does it in the same step as its other fields.
   */
  async function refreshAction() {
    if (!modules) modules = await engineModules();
    const { data, style } = documentData();
    return (body, fields) => {
      if (!body.paragraphs.some(p => p.fieldMarkers?.some(m => ['CITATION', 'BIBLIOGRAPHY'].includes(m.field.type)))) return;
      fields.updateCitations(body, data.sources, style); fields.updateBibliographies(body, data.sources, style);
    };
  }
  /** Save a document source edited in the source dialog; a changed tag takes its citations along. */
  const saveEditedSource = (source, draft) => saveSources(documentData().data.sources.map(s => s.tag === source.tag ? draft : s), currentStyle(),
    { renamed: draft.tag.toLowerCase() !== source.tag.toLowerCase() ? [source.tag, draft.tag] : null });

  async function setStyle(style) {
    const engine = ready(); if (!engine) return;
    rememberStyle(style);
    const { data } = documentData();
    if (data.sources.length || pkg().parts && (await engineModules())[1].readBibliographyPart(pkg().parts)) await saveSources(data.sources, style);
    else { pendingStyle = style; await refreshFields(data.sources, style); }
    ctx.onChange();
  }

  /* ---- Insert citation ---- */
  async function cite(tag, options = {}) {
    const engine = ready(); if (!engine) return;
    const { data, style } = documentData();
    await runBody((body, fields) => fields.insertCitation(body, { tags: [tag], ...options }, data.sources, style), { modules: ['bibliography'], refresh: false, track: true });
    // A newly cited source can change IEEE numbering, same-year letters and every bibliography.
    await refreshFields(data.sources, style);
  }

  const describe = source => {
    const names = Object.values(source.names || {}).find(list => list?.length) || [];
    const who = names[0] ? (names[0].corporate || names[0].last || names[0].first) : '';
    const title = source.fields?.Title || '';
    return title || who ? `${who}${who && title ? ', ' : ''}${title}${source.fields?.Year ? ` (${source.fields.Year})` : ''}` : `${source.tag} (placeholder)`;
  };

  function citationItems() {
    const { data } = documentData(), disabled = !ready();
    return [
      ...(data.sources.length ? [{ header: 'Sources in this document' }, ...data.sources.map(source => ({ label: describe(source), hint: source.tag, disabled, onSelect: () => cite(source.tag) }))] : [{ note: 'No sources in this document yet.' }]),
      { separator: true },
      { label: 'Add New Source…', icon: 'citation', disabled, onSelect: () => sourceDialog({ onSave: async source => { await saveSources([...documentData().data.sources, source]); rememberSources([source]); await cite(source.tag); } }) },
      { label: 'Add New Placeholder…', disabled, onSelect: () => placeholderDialog() },
    ];
  }

  async function placeholderDialog() {
    const [bib] = await engineModules();
    const { data } = documentData();
    const taken = data.sources.map(s => s.tag);
    let n = 1; while (taken.includes(`Placeholder${n}`)) n++;
    const name = text('Placeholder name', `Placeholder${n}`, { required: true, pattern: '[A-Za-z0-9_\\-]{1,40}' });
    openDialog({ title: 'Placeholder Name', submitLabel: 'Insert', body: [field('Type a tag name for the source', name, 'Fill in its details later from Manage Sources.')], onSubmit: async () => {
      const tag = name.value.trim();
      if (taken.some(t => t.toLowerCase() === tag.toLowerCase())) throw new Error('A source with that tag already exists in this document.');
      await saveSources([...data.sources, { tag, type: 'Misc', names: {}, fields: {}, guid: bib.newGuid() }]);
      await cite(tag);
    } });
    name.select();
  }

  /* ---- Create / edit source ---- */
  const splitNames = value => String(value || '').split(';').map(s => s.trim()).filter(Boolean).map(part => {
    if (part.includes(',')) { const [last, rest = ''] = part.split(',').map(s => s.trim()); const [first = '', ...middle] = rest.split(/\s+/).filter(Boolean); return { last, first, middle: middle.join(' ') }; }
    const words = part.split(/\s+/); if (words.length === 1) return { last: words[0], first: '', middle: '' };
    return { last: words.at(-1), first: words[0], middle: words.slice(1, -1).join(' ') };
  });
  const joinNames = list => (list || []).map(p => p.corporate || [p.last, [p.first, p.middle].filter(Boolean).join(' ')].filter(Boolean).join(', ')).join('; ');

  /** `existing()` is the list the source belongs to (the document's, or the master list `place`): tags are unique in it. */
  async function sourceDialog({ source = null, onSave, title = source ? 'Edit Source' : 'Create Source', existing = () => documentData().data.sources, place = 'this document' }) {
    const [bib, , styles] = await engineModules();
    const style = currentStyle();
    const typeOptions = bib.COMMON_SOURCE_TYPES.map(id => [id, bib.SOURCE_TYPES[id].label]).concat(Object.keys(bib.SOURCE_TYPES).filter(id => !bib.COMMON_SOURCE_TYPES.includes(id)).map(id => [id, bib.SOURCE_TYPES[id].label]));
    const type = select('Type of source', typeOptions, source?.type || 'Book', () => build());
    const corporate = check('Corporate author', !!source?.names?.Author?.[0]?.corporate, () => build());
    const showAll = check('Show all bibliography fields', false, () => build());
    const tag = text('Tag name', source?.tag || '', { required: true, pattern: '[^\\s"\\\\]{1,60}' });
    let tagEdited = !!source;
    tag.addEventListener('input', () => { tagEdited = true; });
    const values = { names: structuredClone(source?.names || {}), fields: { ...(source?.fields || {}) } };
    const inputs = new Map();
    const grid = el('div.ref-source-grid');
    const preview = el('div.ref-source-preview', { 'aria-live': 'polite' });
    function read() {
      for (const [key, input] of inputs) {
        if (key.startsWith('name:')) {
          const role = key.slice(5);
          values.names[role] = role === 'Author' && corporate.box.checked ? (input.value.trim() ? [{ corporate: input.value.trim() }] : []) : splitNames(input.value);
        } else values.fields[key] = input.value;
      }
    }
    function current() {
      read();
      const names = Object.fromEntries(Object.entries(values.names).filter(([, list]) => list?.length));
      const fields = Object.fromEntries(Object.entries(values.fields).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v));
      return { ...(source || {}), tag: tag.value.trim(), type: type.value, names, fields, edited: true };
    }
    function update() {
      const draft = current();
      if (!tagEdited) tag.value = bib.sourceTag(draft, documentData().data.sources.filter(s => s !== source).map(s => s.tag));
      const runs = styles.formatBibliography(style, [{ ...draft, tag: draft.tag || 'Preview' }])[0]?.runs || [];
      preview.replaceChildren(el('span.field-label', {}, `Preview (${styles.CITATION_STYLES[style].name})`),
        el('p.ref-source-entry', {}, ...(runs.length ? runs.map(r => r.italic ? el('i', {}, r.text) : r.text) : ['Add a title or an author to see the entry.'])));
    }
    function build() {
      read();
      const kind = bib.SOURCE_TYPES[type.value];
      const roles = showAll.box.checked ? [...new Set([...kind.names, 'Author', 'Editor', 'Translator'])] : kind.names;
      const keys = showAll.box.checked ? [...new Set([...kind.fields, ...Object.keys(bib.TEXT_FIELDS)])] : kind.fields;
      inputs.clear();
      grid.replaceChildren(...roles.map(role => {
        const corp = role === 'Author' && corporate.box.checked;
        const input = text(bib.NAME_ROLES[role] || role, corp ? values.names.Author?.[0]?.corporate || '' : joinNames(values.names[role]), { placeholder: corp ? 'Organization name' : 'Last, First; Last, First', oninput: update });
        inputs.set(`name:${role}`, input);
        return field(bib.NAME_ROLES[role] || role, input);
      }), ...keys.map(key => {
        const input = text(bib.TEXT_FIELDS[key], values.fields[key] || '', { oninput: update });
        inputs.set(key, input);
        return field(bib.TEXT_FIELDS[key], input);
      }));
      corporate.hidden = !roles.includes('Author');
      update();
    }
    build();
    openDialog({ title, wide: true, className: 'ref-source-dialog', submitLabel: 'OK', body: [
      el('div.ref-source-head', {}, field('Type of source', type), corporate),
      grid, showAll, field('Tag name', tag, 'Citations refer to the source by this name.'), preview,
    ], onSubmit: async () => {
      const draft = current();
      if (!draft.tag) throw new Error('Give the source a tag name.');
      // Editing may rename the tag too: it must not take another source's.
      const others = existing().filter(s => s.tag !== source?.tag);
      if (others.some(s => s.tag.toLowerCase() === draft.tag.toLowerCase())) throw new Error(`A source with that tag already exists in ${place}.`);
      if (!draft.guid) draft.guid = bib.newGuid();
      await onSave(draft);
    } });
    (grid.querySelector('input') || type).focus();
  }

  /* ---- Manage sources ---- */
  async function manageSources() {
    const [bib, , styles] = await engineModules();
    if (!pkg()) return;
    let master = await syncMasterSources().catch(() => loadMasterSources());
    const style = currentStyle();
    const search = text('Search sources', '', { type: 'search', placeholder: 'Search by author, title, tag or year' });
    const masterList = el('select.input.ref-source-list', { size: 10, 'aria-label': 'Master list', multiple: true });
    const docList = el('select.input.ref-source-list', { size: 10, 'aria-label': 'Current list', multiple: true });
    const preview = el('div.ref-source-preview', { 'aria-live': 'polite' });
    const status = el('p.field-hint.ref-source-status');
    const cited = async () => new Set(((await engineModules())[1].citedTags(editor()?.session.body.paragraphs || [])).map(t => t.toLowerCase()));
    let citedTags = await cited();
    const matches = source => { const q = search.value.trim().toLowerCase(); return !q || `${source.tag} ${describe(source)} ${JSON.stringify(source.fields)} ${JSON.stringify(source.names)}`.toLowerCase().includes(q); };
    const option = (source, docSide) => el('option', { value: source.tag }, `${docSide && citedTags.has(source.tag.toLowerCase()) ? '✓ ' : docSide && bib.isPlaceholder(source) ? '? ' : ''}${describe(source)}`);
    function fill() {
      const docSources = documentData().data.sources;
      const keep = [new Set([...masterList.selectedOptions].map(o => o.value)), new Set([...docList.selectedOptions].map(o => o.value))];
      masterList.replaceChildren(...master.filter(matches).map(s => option(s, false)));
      docList.replaceChildren(...docSources.filter(matches).map(s => option(s, true)));
      for (const o of masterList.options) o.selected = keep[0].has(o.value);
      for (const o of docList.options) o.selected = keep[1].has(o.value);
      status.textContent = `${docSources.length} ${docSources.length === 1 ? 'source' : 'sources'} in this document · ✓ cited · ? placeholder`;
      showPreview();
    }
    function selected(list) {
      const tags = new Set([...list.selectedOptions].map(o => o.value));
      return (list === masterList ? master : documentData().data.sources).filter(s => tags.has(s.tag));
    }
    let focused = docList;
    function showPreview() {
      const [source] = selected(focused);
      if (!source) { preview.replaceChildren(el('span.field-hint', {}, 'Select a source to preview it.')); return; }
      const context = styles.citationContext(style, [source], [source.tag]);
      const citation = styles.formatCitation(style, [{ source, tag: source.tag }], context);
      const entry = styles.formatBibliography(style, [source])[0]?.runs || [{ text: `${source.tag} is a placeholder.` }];
      const render = runs => runs.map(r => r.italic ? el('i', {}, r.text) : r.text);
      preview.replaceChildren(el('span.field-label', {}, `Preview (${styles.CITATION_STYLES[style].name})`), el('p.ref-source-entry', {}, el('b', {}, 'Citation: '), ...render(citation)), el('p.ref-source-entry', {}, el('b', {}, 'Bibliography entry: '), ...render(entry)));
    }
    masterList.addEventListener('focus', () => { focused = masterList; showPreview(); });
    docList.addEventListener('focus', () => { focused = docList; showPreview(); });
    masterList.addEventListener('change', () => { focused = masterList; showPreview(); });
    docList.addEventListener('change', () => { focused = docList; showPreview(); });
    search.addEventListener('input', fill);
    // Enter in the search field only searches: it must not close the Source Manager.
    search.addEventListener('keydown', e => { if (e.key === 'Enter' && !isComposing(e)) e.preventDefault(); });
    const toDocument = async () => {
      const picked = selected(masterList); if (!picked.length) return;
      const docSources = documentData().data.sources, tags = new Set(docSources.map(s => s.tag.toLowerCase()));
      await saveSources([...docSources, ...picked.filter(s => !tags.has(s.tag.toLowerCase())).map(s => ({ ...structuredClone(s), edited: true }))]);
      fill();
    };
    const toMaster = () => { const picked = selected(docList); if (!picked.length) return; master = rememberSources(picked); fill(); };
    const remove = async () => {
      if (focused === masterList) { const tags = new Set(selected(masterList).map(s => s.tag)); master = saveMasterSources(master.filter(s => !tags.has(s.tag))); fill(); return; }
      const picked = selected(docList);
      if (picked.some(s => citedTags.has(s.tag.toLowerCase()))) { status.textContent = 'Cited sources stay in the document. Delete their citations first.'; return; }
      const tags = new Set(picked.map(s => s.tag));
      await saveSources(documentData().data.sources.filter(s => !tags.has(s.tag))); fill();
    };
    const edit = () => {
      const [source] = selected(focused); if (!source) return;
      const inMaster = focused === masterList;
      sourceDialog({ source, ...(inMaster ? { existing: () => master, place: 'the master list' } : {}), onSave: async draft => {
        if (inMaster) { master = saveMasterSources(master.map(s => s.tag === source.tag ? draft : s)); }
        else {
          await saveEditedSource(source, draft);
          if (master.some(s => s.tag === source.tag)) master = rememberSources([draft]);
        }
        fill();
      } });
    };
    const create = () => sourceDialog({ onSave: async draft => { await saveSources([...documentData().data.sources, draft]); master = rememberSources([draft]); fill(); } });
    const button = (label, onclick, attrs = {}) => el('button.btn.btn-outline.ref-source-button', { type: 'button', onclick, ...attrs }, label);
    fill();
    openDialog({ title: 'Source Manager', wide: true, className: 'ref-manage-dialog', submitLabel: 'Done', cancelLabel: 'Cancel', body: [
      field('Search', search),
      el('div.ref-manage-lists', {},
        el('div.ref-manage-column', {}, el('span.field-label', {}, 'Master list (all your documents)'), masterList),
        el('div.ref-manage-actions', {}, button('Copy →', toDocument, { 'aria-label': 'Copy to current list' }), button('← Copy', toMaster, { 'aria-label': 'Copy to master list' }), button('Delete', remove), button('Edit…', edit), button('New…', create)),
        el('div.ref-manage-column', {}, el('span.field-label', {}, 'Current list (this document)'), docList)),
      status, preview,
    ], onSubmit: () => true });
    citedTags = await cited(); fill();
  }

  /* ---- Bibliography ---- */
  async function insertBibliography(heading = null) {
    const { data, style } = documentData();
    await runBody((body, fields) => fields.insertBibliography(body, data.sources, style, { heading }), { modules: ['bibliography'], refresh: false, track: true });
  }
  function bibliographyItems(focusEditor) {
    const disabled = !ready();
    const sample = heading => el('div.ref-preview-paper', {}, heading && el('div.ref-preview-title', {}, heading),
      el('div.ref-preview-row.ref-hanging', {}, 'Lovelace, A. (2020). ', el('i', {}, 'Notes on engines'), '. Harbor Press.'),
      el('div.ref-preview-row.ref-hanging', {}, 'Turing, A. (2018). On computable numbers. ', el('i', {}, 'Logic Review'), ', 4(2), 10–35.'));
    return [
      { header: 'Built-in' },
      ...['Bibliography', 'References', 'Works Cited'].map(heading => galleryItem({ label: heading, description: `A ${heading.toLowerCase()} list with a heading`, preview: sample(heading), disabled, focusEditor, onSelect: () => insertBibliography(heading) })),
      { separator: true },
      { label: 'Insert Bibliography', icon: 'bibliography', disabled, onSelect: () => insertBibliography(null) },
    ];
  }

  /** The style selector for the ribbon. */
  function styleControl() {
    const control = el('select.canvas-select.ref-style-select', { 'aria-label': 'Citation style', title: 'Citation style', onchange: () => setStyle(control.value) });
    const fill = () => {
      const styles = modules?.[2]?.CITATION_STYLES;
      if (!styles || control.options.length) return;
      control.replaceChildren(...Object.entries(styles).map(([id, s]) => el('option', { value: id, title: `${s.name} ${s.edition}` }, s.name)));
    };
    fill();
    engineModules().then(() => { fill(); control.value = currentStyle(); }).catch(() => {});
    return { control, sync: () => { fill(); if (document.activeElement !== control) { const value = currentStyle(); if (control.value !== value) control.value = value; } } };
  }

  /* ---- Citation at the caret: edit, convert, update ---- */
  async function citationAt() {
    if (!modules) modules = await engineModules();
    return citationAtNow();
  }
  /** The citation around the caret, once the engine modules are loaded. */
  function citationAtNow() {
    const engine = editor(); if (!engine || engine.session.path !== null || !modules) return null;
    const fields = modules[1];
    const at = engine.model.range[0];
    return fields.citationFields(engine.session.body.paragraphs).find(r => r.start <= at && at <= r.end) || null;
  }
  async function editCitation() {
    const range = await citationAt(); if (!range) { error(new Error('Place the cursor in a citation to edit it.')); return; }
    const [bib] = await engineModules();
    const c = range.citation;
    const pages = text('Pages', c.pages), prefix = text('Prefix', c.prefix), suffix = text('Suffix', c.suffix);
    const noAuthor = check('Author', c.noAuthor), noYear = check('Year', c.noYear), noTitle = check('Title', c.noTitle);
    openDialog({ title: 'Edit Citation', body: [field('Pages', pages), el('div.ref-two-column.ref-tight', {}, field('Prefix', prefix), field('Suffix', suffix)),
      el('fieldset.ref-section', {}, el('legend', {}, 'Suppress'), noAuthor, noYear, noTitle)], onSubmit: async () => {
      const instruction = bib.citationInstruction({ ...c, pages: pages.value.trim(), prefix: prefix.value.trim(), suffix: suffix.value.trim(), noAuthor: noAuthor.box.checked, noYear: noYear.box.checked, noTitle: noTitle.box.checked, lcid: c.lcid || '1033' });
      const { data, style } = documentData();
      await runBody((body, fields, generated) => {
        const target = fields.citationFields(body.paragraphs).find(r => r.field.id === range.field.id);
        if (!target) return false;
        generated.setFieldInstruction(body, target, instruction);
        fields.updateCitations(body, data.sources, style);
        return true;
      }, { modules: ['bibliography', 'generated'], refresh: false });
    } });
  }
  async function convertCitationToText() {
    const range = await citationAt(); if (!range) return;
    await runBody((body, fields) => { const target = fields.citationFields(body.paragraphs).find(r => r.field.id === range.field.id); return target ? fields.convertToText(body, target) : false; }, { modules: ['bibliography'], refresh: false });
  }
  async function editCitedSource() {
    const range = await citationAt(); if (!range) return;
    const source = documentData().data.sources.find(s => s.tag.toLowerCase() === range.citation.tags[0].toLowerCase());
    if (!source) { error(new Error(`This document has no source named ${range.citation.tags[0]}.`)); return; }
    sourceDialog({ source, onSave: async draft => { await saveEditedSource(source, draft); } });
  }
  function contextItems() {
    let range = null;
    try { range = citationAtNow(); } catch { range = null; }
    if (!range) return [];
    return [{ separator: true },
      { label: 'Edit Citation…', icon: 'citation', onSelect: () => editCitation() },
      { label: 'Edit Source…', onSelect: () => editCitedSource() },
      { label: 'Convert Citation to Static Text', onSelect: () => convertCitationToText() },
      { label: 'Update Citations and Bibliography', icon: 'updateFields', onSelect: () => refreshFields() }];
  }

  return { citationItems, bibliographyItems, manageSources, styleControl, setStyle, currentStyle, refreshFields, refreshAction, insertBibliography, cite, sourceDialog, editCitation, contextItems, citationAt, documentData };
}
