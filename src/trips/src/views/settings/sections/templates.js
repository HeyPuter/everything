import { el } from '../../../ui/dom.js';
import { button, iconButton, emptyState, skeleton } from '../../../ui/bits.js';
import { field, segmented } from '../../../ui/fields.js';
import { openModal, confirmDialog, promptDialog } from '../../../ui/modal.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import {
  createTemplateStore, validateTemplate, parseItems, itemsText, templateFile, templateFileName, parseTemplateFile, TEMPLATE_LIMITS,
} from '../data/templates.js';
import { icon } from '../icons.js';
import { alertRegion, busy, errorText, pickFile, plural, withIcon, listFocus } from '../ui.js';
import { saveBlob } from '../../../lib/download.js';

const CODES = {
  template_name_required: 'settings.templateNameRequired', list_name_required: 'settings.listNameRequired',
  template_too_large: 'settings.templateTooLarge', invalid_template_file: 'settings.templateFileInvalid',
  template_file_too_large: 'settings.templateFileTooLarge', invalid_template: 'settings.templateInvalid', gone: 'settings.templateGone',
};
const message = (error) => (Object.hasOwn(CODES, error?.code) ? t(CODES[error.code]) : errorText(error));
const count = (n) => plural(n, 'settings.itemsOne', 'settings.itemsOther');

export function render(container, { personal, puter, signal }) {
  const store = createTemplateStore({ personal, puter });
  const alert = alertRegion();
  const listNode = el('div.template-list', { 'aria-busy': 'true' }, skeleton(), skeleton('70%'));
  const focus = listFocus(listNode, () => create);
  let dialog = null;
  let opening = false;

  async function refresh({ fresh = false } = {}) {
    try {
      const items = await store.list({ fresh });
      if (!signal.aborted) draw(items);
    } catch (error) {
      if (signal.aborted) return;
      focus.redraw(() => listNode.replaceChildren(el('div.settings-error', {}, el('p', {}, errorText(error)),
        button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: () => refresh({ fresh: true }) }))));
    } finally { listNode.removeAttribute('aria-busy'); }
  }
  function draw(items) {
    focus.redraw(() => {
      if (!items.length) {
        listNode.replaceChildren(emptyState({ title: t('settings.templatesEmpty'), body: t('settings.templatesEmptyBody'), icon: 'backpack' }));
        return;
      }
      listNode.replaceChildren(el('div.card', {}, items.map((entry) => {
        const more = iconButton('more', t('settings.templateActions', { name: entry.name }), { dataset: { focus: 'more' }, onclick: () => openMenu(more, [
          { label: t('settings.templateEdit'), icon: 'pencil', onSelect: () => openEditor(entry.id, null, more) },
          { label: t('settings.templateRename'), onSelect: () => rename(entry, more) },
          { label: t('settings.templateExport'), icon: 'file', onSelect: () => exportFile(entry, more) },
          { separator: true },
          { label: t('settings.templateDelete'), icon: 'trash', danger: true, onSelect: () => remove(entry, more) },
        ]) });
        return el('div.list-row.template-row', { dataset: { id: entry.id } },
          el('span.row-icon', {}, icon(entry.kind === 'pack' ? 'backpack' : 'list')),
          el('span.row-text', {}, el('span.pref-label', {}, entry.name),
            el('span.pref-hint', {}, t(entry.kind === 'pack' ? 'settings.templateMetaPack' : 'settings.templateMetaTodo', { items: count(entry.items) }))),
          more);
      })));
    });
  }

  async function openEditor(id, initial, control) {
    if (dialog || opening) return;
    focus.hold(control);
    let template = initial;
    if (!template) {
      opening = true;
      try { template = await busy(control, alert, () => store.get(id), message); } finally { opening = false; }
      if (signal.aborted || template === undefined) { focus.release(); return; }
      if (template === null) { alert.show(t('settings.templateGone')); void store.forget(id).then(() => refresh()).catch(() => {}); return; }
    }
    const creating = !id;
    let saved = false;
    let kind = template.kind;
    const dialogAlert = alertRegion();
    const name = field({ label: t('settings.templateName'), value: template.name, maxLength: TEMPLATE_LIMITS.name, autocomplete: 'off' });
    const kindControl = creating && segmented({ label: t('settings.templateKind'), value: kind, onChange: (value) => { kind = value; hints(); },
      items: [{ value: 'pack', label: t('settings.kindPack') }, { value: 'todo', label: t('settings.kindTodo') }] });
    const lists = el('div.template-lists');
    const editors = [];
    function hints() {
      for (const editor of editors) editor.hint.textContent = t(kind === 'pack' ? 'settings.listItemsHintPack' : 'settings.listItemsHint');
    }
    function renumber() {
      editors.forEach((editor, index) => {
        editor.node.setAttribute('aria-label', t('settings.listNumber', { n: index + 1 }));
        editor.remove.hidden = editors.length === 1;
      });
    }
    function addList(list = { name: '', items: [] }, focus = false) {
      if (editors.length >= TEMPLATE_LIMITS.lists) { dialogAlert.show(t('settings.templateTooLarge')); return; }
      const listName = field({ label: t('settings.listName'), value: list.name, maxLength: TEMPLATE_LIMITS.listName, autocomplete: 'off' });
      const items = field({ label: t('settings.listItems'), type: 'textarea', value: itemsText(list.items), rows: 5, hint: ' ' });
      const editor = { list, listName, items, hint: items.element.querySelector('.field-hint') };
      editor.remove = button(t('settings.listRemove'), { size: 'sm', variant: 'ghost', icon: 'trash', onclick: () => {
        const index = editors.indexOf(editor); editors.splice(index, 1); editor.node.remove(); renumber();
        (editors[Math.max(0, index - 1)]?.listName.input ?? addButton).focus();
      } });
      editor.node = el('div.template-list-editor', { role: 'group' }, listName.element, items.element, el('div.settings-actions', {}, editor.remove));
      editors.push(editor); lists.append(editor.node); renumber(); hints();
      if (focus) listName.input.focus();
    }
    template.lists.forEach((list) => addList(list));
    const addButton = button(t('settings.listAdd'), { icon: 'plus', size: 'sm', variant: 'outline', onclick: () => addList({ name: '', items: [] }, true) });
    const save = button(t(creating ? 'settings.templateCreate' : 'settings.templateSave'), { type: 'submit', variant: 'primary' });
    const form = el('form.template-editor', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault();
      name.setError(''); editors.forEach((editor) => editor.listName.setError('')); dialogAlert.clear();
      let clean;
      try {
        clean = validateTemplate({ kind, name: name.input.value, lists: editors.map((editor) => ({ name: editor.listName.input.value, items: parseItems(editor.items.input.value, editor.list.items) })) });
      } catch (error) {
        if (error.code === 'template_name_required') { name.setError(message(error)); name.input.focus(); return; }
        const empty = editors.find((editor) => !editor.listName.input.value.trim());
        if (error.code === 'list_name_required' && empty) { empty.listName.setError(message(error)); empty.listName.input.focus(); return; }
        dialogAlert.show(message(error)); return;
      }
      const done = await busy(save, dialogAlert, async () => {
        if (creating) await store.create(clean); else await store.save(id, clean);
        return true;
      }, message);
      if (!done) return;
      saved = true;
      dialog?.close('saved'); toast(t(creating ? 'settings.templateCreated' : 'settings.templateSaved', { name: clean.name }));
      void refresh();
    } }, dialogAlert.node, name.element, kindControl && el('div.field', {}, el('span.field-label', {}, t('settings.templateKind')), kindControl.element),
    lists, el('div.settings-actions', {}, addButton),
    el('div.modal-actions', {}, button(t('settings.cancel'), { onclick: () => dialog?.close('cancel') }), save));
    dialog = openModal({ title: t(creating ? 'settings.templateNewTitle' : 'settings.templateEditTitle'), content: form, wide: true, dismissOnBackdrop: false,
      initialFocus: name.input, onClose: () => { dialog = null; if (!saved) focus.release(); } });
  }
  async function rename(entry, control) {
    focus.hold(control);
    const value = await promptDialog({ title: t('settings.templateRenameTitle'), label: t('settings.templateName'), value: entry.name, confirmLabel: t('settings.templateRename') });
    if (value == null || value.trim() === entry.name) { focus.release(); return; }
    const done = await busy(control, alert, async () => { await store.rename(entry.id, value); return true; }, message);
    if (done) { toast(t('settings.templateRenamed', { name: value.trim() })); void refresh(); } else focus.release();
  }
  async function exportFile(entry, control) {
    const template = await busy(control, alert, () => store.get(entry.id), message);
    if (signal.aborted || template === undefined) return;
    if (template === null) { alert.show(t('settings.templateGone')); return; }
    saveBlob(templateFile(template), templateFileName(template.name));
  }
  async function remove(entry, control) {
    focus.hold(control);
    const confirmed = await confirmDialog({ title: t('settings.templateDeleteTitle', { name: entry.name }), body: t('settings.templateDeleteBody'),
      confirmLabel: t('settings.templateDelete'), danger: true });
    if (!confirmed) { focus.release(); return; }
    const done = await busy(control, alert, async () => { await store.remove(entry.id); return true; }, message);
    if (done) { toast(t('settings.templateDeleted', { name: entry.name })); void refresh(); } else focus.release();
  }
  async function importFile(control) {
    const file = await pickFile('.json,application/json');
    if (!file || signal.aborted) return;
    alert.clear();
    if (file.size > TEMPLATE_LIMITS.fileBytes) { alert.show(t('settings.templateFileTooLarge')); return; }
    let template;
    try { template = parseTemplateFile(await file.text()); } catch (error) { alert.show(message(error)); return; }
    const done = await busy(control, alert, async () => { await store.create(template); return true; }, message);
    if (done) { toast(t('settings.templateImported', { name: template.name })); void refresh(); }
  }

  const create = button(t('settings.templateNew'), { icon: 'plus', variant: 'primary', onclick: () => openEditor(null, {
    kind: 'pack', name: '', lists: [{ name: t('settings.defaultList'), items: [] }] }) });
  const importButton = withIcon(button(t('settings.templateImport'), { variant: 'outline', onclick: (event) => importFile(event.currentTarget) }), 'upload');
  const off = store.subscribe(() => { void refresh(); });
  signal?.addEventListener('abort', () => { off(); dialog?.close('navigation'); }, { once: true });
  container.replaceChildren(el('div.settings-stack', {},
    el('div.pref-group', {}, el('p.pref-hint', {}, t('settings.templatesHint')), el('div.settings-actions', {}, create, importButton), alert.node, listNode)));
  void refresh();
}
