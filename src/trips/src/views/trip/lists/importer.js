import { el } from '../../../ui/dom.js';
import { button, skeleton } from '../../../ui/bits.js';
import { field, checkbox, choiceGroup, segmented } from '../../../ui/fields.js';
import { tabs } from '../../../ui/tabs.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { validateTemplate, parseTemplateFile, templateFile, templateFileName, itemCount, TEMPLATE_LIMITS } from '../../settings/data/templates.js';
import { normName, parseImport, rowsFromTemplate, templateFromGroups } from './model.js';
import { btn, errorText, pickFile, plural } from './common.js';
import { saveBlob } from '../../../lib/download.js';
import { formDialog } from './dialogs.js';
import { starters } from './starters.js';

const FILE_BYTES = 1024 * 1024;

/** Rows from another trip's packing list (shared items and this member's private ones); checks are not copied. */
async function tripRows(entry, { session, puter }) {
  let own = null;
  try { own = (await session.deployer?.current?.())?.name ?? null; } catch { own = null; }
  const { openSpace } = await import('../../../lib/store/index.js');
  const other = await openSpace({ ref: entry.ref, db: session.db, api: session.api, puter, personal: session.personal, handles: entry.handles ?? null,
    role: entry.role, ownWorker: own, view: 'lists', autoStart: false, open: false });
  try {
    if (!other.state.rev) await other.start();
    const bags = new Map(other.select.bag.all().map((bag) => [bag.id, bag.name]));
    return other.query('pack', { includePrivate: true }).map((item) => ({ list: item.list ?? '', name: item.name, qty: item.qty, grams: item.grams, bag: bags.get(item.bagId) }));
  } finally { other.close(); }
}

/**
 * Import into a list kind: a starter or personal template (or a template file), pasted or CSV/TXT text, or another
 * trip. `onImport(rows, {asPrivate})` resolves truthy when the rows were added.
 */
export function openImportDialog({ kind, section, ctx, canEdit, canPrivate, onImport }) {
  const pack = kind === 'pack';
  let active = section ?? 'template';
  let choice = null;
  let fileTemplate = null;
  let loadedRows = null;
  let personalTemplates = [];

  // Templates
  const templateHost = el('div.lists-template-list', { 'aria-busy': 'true' }, skeleton(), skeleton('70%'));
  const builtIn = starters(kind);
  function drawTemplates(error) {
    templateHost.removeAttribute('aria-busy');
    const items = [
      ...(fileTemplate ? [{ value: 'file:', label: fileTemplate.name, hint: t('lists.templateFromFile', { items: plural(itemCount(fileTemplate), 'lists.itemsOne', 'lists.itemsOther') }) }] : []),
      ...personalTemplates.map((entry) => ({ value: `tpl:${entry.id}`, label: entry.name, hint: plural(entry.items, 'lists.itemsOne', 'lists.itemsOther') })),
      ...builtIn.map((entry) => ({ value: `starter:${entry.id}`, label: entry.name, hint: t('lists.templateBuiltIn', { items: plural(itemCount(entry), 'lists.itemsOne', 'lists.itemsOther') }) })),
    ];
    if (!items.some((item) => item.value === choice)) choice = items[0]?.value ?? null;
    const control = choiceGroup({ label: t('lists.chooseTemplate'), value: choice, items, onChange: (value) => { choice = value; } });
    templateHost.replaceChildren(control.element, el('p.field-hint', {}, t(error ? 'lists.templatesUnavailable' : personalTemplates.length ? 'lists.templatesManage' : 'lists.templatesNone')));
  }
  const fileTemplateButton = btn(t('lists.templateFile'), { icon: 'upload', size: 'sm', variant: 'outline', onclick: async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    dialog.alert.clear();
    try {
      if (file.size > TEMPLATE_LIMITS.fileBytes) throw Object.assign(new Error('too large'), { code: 'template_file_too_large' });
      const template = parseTemplateFile(await file.text());
      if (template.kind !== kind) { dialog.alert.show(t(pack ? 'lists.templateWrongKindPack' : 'lists.templateWrongKindTodo')); return; }
      fileTemplate = template;
      choice = 'file:';
      drawTemplates();
    } catch (error) { dialog.alert.show(errorText(error)); }
  } });
  if (ctx.templates) {
    void ctx.templates.list().then((entries) => { personalTemplates = entries.filter((entry) => entry.kind === kind); drawTemplates(); }).catch(() => drawTemplates(true));
  } else drawTemplates(true);

  // Paste or file
  const area = field({ label: t('lists.pasteLabel'), type: 'textarea', rows: 7, hint: t('lists.pasteHint'), spellcheck: false });
  const preview = el('p.lists-preview', { role: 'status' });
  function updatePreview() {
    const { rows, skipped, truncated } = parseImport(area.input.value);
    if (!rows.length) { preview.textContent = t('lists.previewEmpty'); return; }
    const lists = new Set(rows.map((row) => normName(row.list)).filter(Boolean)).size;
    const bags = new Set(rows.map((row) => normName(row.bag)).filter(Boolean)).size;
    preview.textContent = [plural(rows.length, 'lists.itemsOne', 'lists.itemsOther'), lists && plural(lists, 'lists.listsOne', 'lists.listsOther'), bags && plural(bags, 'lists.bagsOne', 'lists.bagsOther'),
      skipped && plural(skipped, 'lists.skippedOne', 'lists.skippedOther'), truncated && t('lists.truncated')].filter(Boolean).join(' · ');
  }
  area.input.addEventListener('input', updatePreview);
  updatePreview();
  const pasteFile = btn(t('lists.chooseFile'), { icon: 'upload', size: 'sm', variant: 'outline', onclick: async () => {
    const file = await pickFile('.csv,.tsv,.txt,text/csv,text/plain,.json,application/json');
    if (!file) return;
    dialog.alert.clear();
    if (file.size > FILE_BYTES) { dialog.alert.show(t('lists.fileTooLarge')); return; }
    const text = await file.text();
    if (/\.json$/i.test(file.name) || text.trimStart().startsWith('{')) {
      try {
        const template = parseTemplateFile(text);
        if (template.kind !== kind) { dialog.alert.show(t('lists.templateWrongKindPack')); return; }
        fileTemplate = template; choice = 'file:'; drawTemplates(); sections.select('template');
      } catch (error) { dialog.alert.show(errorText(error)); }
      return;
    }
    area.input.value = text;
    updatePreview();
  } });

  // Another trip
  const tripNote = el('p.lists-preview', { role: 'status' });
  const tripSelect = field({ label: t('lists.fromTrip'), type: 'select', options: [{ value: '', label: t('lists.chooseTrip') }] });
  let tripEntries = [];
  let loading = 0;
  const tripsAvailable = Boolean(ctx.session?.db && ctx.session?.api && ctx.personal?.spaces);
  if (pack && tripsAvailable) {
    void ctx.personal.spaces.list().then((entries) => {
      tripEntries = entries.filter((entry) => entry.ref.k === 'trip' && entry.ref.s !== ctx.space.ref.s).sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
      for (const entry of tripEntries) tripSelect.input.append(el('option', { value: entry.ref.s }, entry.title || t('lists.untitledTrip')));
      if (!tripEntries.length) tripNote.textContent = t('lists.noOtherTrips');
    }).catch(() => { tripNote.textContent = t('lists.tripsUnavailable'); });
    tripSelect.input.addEventListener('change', async () => {
      loadedRows = null;
      const entry = tripEntries.find((item) => item.ref.s === tripSelect.input.value);
      if (!entry) { tripNote.textContent = ''; return; }
      const run = ++loading;
      tripNote.textContent = t('lists.tripLoading');
      try {
        const rows = await tripRows(entry, ctx);
        if (run !== loading) return;
        loadedRows = rows;
        tripNote.textContent = rows.length ? plural(rows.length, 'lists.itemsOne', 'lists.itemsOther') : t('lists.tripEmpty');
      } catch (error) {
        if (run === loading) tripNote.textContent = errorText(error);
      }
    });
  }

  const items = [{ id: 'template', label: t('lists.importTemplate'), content: el('div.lists-import-section', {}, templateHost, el('div.lists-inline-actions', {}, fileTemplateButton)) }];
  if (pack) {
    items.push({ id: 'paste', label: t('lists.importPaste'), content: el('div.lists-import-section', {}, area.element, el('div.lists-inline-actions', {}, pasteFile), preview) });
    items.push({ id: 'trip', label: t('lists.importTrip'), content: el('div.lists-import-section', {}, tripsAvailable ? [tripSelect.element, tripNote] : el('p.field-hint', {}, t('lists.tripsUnavailable'))) });
  }
  const sections = tabs({ label: t('lists.importFrom'), items, value: active, onChange: (id) => { active = id; } });
  const privateBox = pack && checkbox(t('lists.importPrivate'), { checked: !canEdit, disabled: !canEdit || !canPrivate });
  const content = el('div.lists-form-body', {}, sections.element, privateBox && el('div.lists-import-private', {}, privateBox, el('p.field-hint', {}, t('lists.importPrivateHint'))));

  async function templateRows() {
    if (!choice) return [];
    if (choice === 'file:') return fileTemplate ? rowsFromTemplate(fileTemplate) : [];
    if (choice.startsWith('starter:')) return rowsFromTemplate(builtIn.find((entry) => `starter:${entry.id}` === choice));
    const template = await ctx.templates.get(choice.slice(4));
    if (!template) throw Object.assign(new Error('gone'), { code: 'template_gone' });
    return rowsFromTemplate(template);
  }

  const dialog = formDialog({ title: t(pack ? 'lists.importPackTitle' : 'lists.importTodoTitle'), content, wide: true, submitLabel: t('lists.importAction'), onSubmit: async (box) => {
    let rows = [];
    try {
      if (active === 'template') rows = await templateRows();
      else if (active === 'paste') rows = parseImport(area.input.value).rows;
      else rows = loadedRows ?? [];
    } catch (error) { box.show(error.code === 'template_gone' ? t('lists.templateGone') : errorText(error)); return false; }
    if (!rows.length) { box.show(t(active === 'trip' && !loadedRows ? 'lists.chooseTripFirst' : 'lists.importNothing')); return false; }
    const asPrivate = privateBox ? privateBox.querySelector('input').checked : false;
    return onImport(rows, { asPrivate });
  } });
  return dialog;
}

/** Save the current lists as a personal template, or download them as a shareable template file. */
export function openSaveTemplateDialog({ kind, ctx, scopes, scope, groupsFor, defaultName }) {
  let current = scope;
  const name = field({ label: t('lists.templateName'), value: defaultName.slice(0, TEMPLATE_LIMITS.name), maxLength: TEMPLATE_LIMITS.name, autocomplete: 'off' });
  const summary = el('p.lists-preview', { role: 'status' });
  const build = () => templateFromGroups(groupsFor(current), { kind, name: name.input.value, fallbackList: t('lists.noList') });
  const update = () => {
    const groups = groupsFor(current).filter((group) => group.items.length);
    const count = groups.reduce((sum, group) => sum + group.items.length, 0);
    summary.textContent = count ? `${plural(count, 'lists.itemsOne', 'lists.itemsOther')} · ${plural(groups.length, 'lists.listsOne', 'lists.listsOther')}` : t('lists.templateEmpty');
  };
  const scopeControl = scopes ? segmented({ label: t('lists.templateScope'), value: current, items: scopes, onChange: (value) => { current = value; update(); } }) : null;
  update();
  let dialog;
  const validated = (box) => {
    name.setError('');
    try { return validateTemplate(build()); } catch (error) {
      if (error.code === 'template_name_required') { name.setError(t('lists.nameRequired')); name.input.focus(); }
      else box.show(error.code === 'template_too_large' ? t('lists.errorTemplateLarge') : t('lists.templateEmpty'));
      return null;
    }
  };
  const fileButton = button(t('lists.downloadTemplate'), { variant: 'outline', onclick: () => {
    dialog.alert.clear();
    const template = validated(dialog.alert);
    if (template) saveBlob(templateFile(template), templateFileName(template.name));
  } });
  const content = el('div.lists-form-body', {}, name.element,
    scopeControl && el('div.field', {}, el('span.field-label', {}, t('lists.templateScope')), scopeControl.element),
    summary, !ctx.templates && el('p.field-hint', {}, t('lists.templatesUnavailable')), el('div.lists-inline-actions', {}, fileButton));
  dialog = formDialog({ title: t('lists.saveTemplate'), content, submitLabel: t('lists.saveTemplateAction'), initialFocus: name.input, onSubmit: async (box) => {
    const template = validated(box);
    if (!template) return false;
    if (!ctx.templates) { box.show(t('lists.templatesUnavailable')); return false; }
    try { await ctx.templates.create(template); } catch (error) { box.show(errorText(error)); return false; }
    toast(t('lists.templateSaved', { name: template.name }));
    return true;
  } });
  return dialog;
}

