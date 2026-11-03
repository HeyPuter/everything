import { el, uid as nextUid } from '../../../ui/dom.js';
import { button } from '../../../ui/bits.js';
import { field, checkbox, segmented } from '../../../ui/fields.js';
import { dateField } from '../../../ui/dates.js';
import { openDrawer } from '../../../ui/sheet.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { isDate } from '../../../shared/dates.js';
import { cleanName } from './model.js';

/** The to-do detail pane. Each field saves on change; remote edits refresh fields that are not being edited. */
export function openTodoDetail({ space, id, canEdit, lists, people, ensureList, write, onDelete }) {
  let todo = space.get('todo', id);
  if (!todo) return null;
  const disabled = !canEdit;
  const patch = (set = {}, unset = [], extra = []) => write([...extra, space.ops.patch('todo', id, { ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) })], t('lists.historyEdit'));

  const name = field({ label: t('lists.todoName'), value: todo.name, maxLength: 500, disabled, autocomplete: 'off' });
  name.input.addEventListener('change', () => {
    const value = cleanName(name.input.value);
    name.setError('');
    if (!value) { name.setError(t('lists.nameRequired')); return; }
    if (value !== todo.name) void patch({ name: value });
  });
  const doneBox = checkbox(t('lists.markDone'), { checked: Boolean(todo.done), disabled, onChange: (value) => patch({ done: value }) });
  const listId = nextUid('lists-todo-lists');
  const list = field({ label: t('lists.list'), value: todo.list ?? '', maxLength: 500, list: listId, disabled, autocomplete: 'off' });
  const datalist = el('datalist', { id: listId }, lists().map((value) => el('option', { value })));
  list.input.addEventListener('change', () => {
    const value = cleanName(list.input.value);
    if (value === (todo.list ?? '')) return;
    void (value ? patch({ list: value }, [], ensureList(value)) : patch({}, ['list']));
  });
  const due = dateField({ label: t('lists.dueDate'), value: todo.due ?? '', disabled });
  due.input.addEventListener('change', () => {
    const value = due.input.value;
    if (value && !isDate(value)) return;
    if (value === (todo.due ?? '')) return;
    void (value ? patch({ due: value }) : patch({}, ['due']));
  });
  const prioItems = [{ value: 0, label: t('lists.prioNone') }, ...[1, 2, 3].map((value) => ({ value, label: t(`lists.prio${value}`) }))].map((item) => ({ ...item, disabled }));
  const prio = canEdit ? segmented({ label: t('lists.priority'), value: todo.prio ?? 0, items: prioItems, onChange: (value) => (value ? patch({ prio: value }) : patch({}, ['prio'])) }) : null;
  const prioText = el('p.lists-detail-value');
  const whoOptions = () => {
    const map = people();
    const options = [{ value: '', label: t('lists.unassigned') }, ...[...map.values()].filter((person) => person.kind !== 'unknown').map((person) => ({ value: person.id, label: person.kind === 'guest' ? `${person.name} · ${t('lists.guest')}` : person.name }))];
    if (todo.who && !map.has(todo.who)) options.push({ value: todo.who, label: t('lists.unknownPerson') });
    return options;
  };
  const who = field({ label: t('lists.assignee'), type: 'select', options: whoOptions(), value: todo.who ?? '', disabled });
  who.input.addEventListener('change', () => { const value = who.input.value; void (value ? patch({ who: value }) : patch({}, ['who'])); });

  const desc = field({ label: t('lists.notes'), type: 'textarea', rows: 6, value: todo.desc ?? '', maxLength: 100_000, hint: t('lists.notesHint') });
  desc.element.querySelector('.field-label').classList.add('sr-only');
  desc.input.addEventListener('change', () => {
    const value = desc.input.value;
    if (value === (todo.desc ?? '')) return;
    void (value.trim() ? patch({ desc: value }) : patch({}, ['desc']));
  });
  const previewNode = el('div.lists-notes-preview');
  let mode = canEdit ? 'write' : 'preview';
  const modeControl = canEdit ? segmented({ label: t('lists.notesMode'), value: mode, items: [{ value: 'write', label: t('lists.notesWrite') }, { value: 'preview', label: t('lists.notesPreview') }],
    onChange: (value) => { mode = value; syncNotes(); } }) : null;
  function syncNotes() {
    const text = mode === 'write' ? desc.input.value : todo.desc ?? '';
    desc.element.hidden = mode !== 'write';
    previewNode.hidden = mode !== 'preview';
    if (mode === 'preview') previewNode.replaceChildren(text.trim() ? markdown(canEdit ? desc.input.value : text) : el('p.lists-muted', {}, t('lists.noNotes')));
  }

  function refresh() {
    const active = document.activeElement;
    if (active !== name.input) name.input.value = todo.name;
    doneBox.querySelector('input').checked = Boolean(todo.done);
    if (active !== list.input) list.input.value = todo.list ?? '';
    if (active !== due.input) due.input.value = todo.due ?? '';
    prio?.setValue(todo.prio ?? 0);
    prioText.textContent = [1, 2, 3].includes(todo.prio) ? t(`lists.prioLong${todo.prio}`) : t('lists.prioNone');
    if (active !== who.input) { who.input.replaceChildren(...whoOptions().map((option) => el('option', { value: option.value }, option.label))); who.input.value = todo.who ?? ''; }
    if (active !== desc.input && desc.input.value !== (todo.desc ?? '')) desc.input.value = todo.desc ?? '';
    syncNotes();
  }
  refresh();

  const content = el('div.lists-detail', {},
    name.element, doneBox, list.element, datalist,
    el('div.field-row', {}, due.element, who.element),
    el('div.field', {}, el('span.field-label', {}, t('lists.priority')), prio ? prio.element : prioText),
    el('div.lists-notes', {}, el('div.lists-notes-head', {}, el('span.field-label', {}, t('lists.notes')), modeControl?.element), desc.element, previewNode));
  if (!canEdit) desc.element.hidden = true;
  const actions = [button(t('lists.close'), { onclick: () => dialog.close('close') })];
  if (canEdit) actions.unshift(button(t('lists.delete'), { variant: 'danger', onclick: () => { dialog.close('delete'); void onDelete(todo); } }));
  const off = space.subscribe({ type: 'todo', id }, () => {
    const next = space.get('todo', id);
    if (!next) { dialog.close('gone'); toast(t('lists.todoGone')); return; }
    todo = next;
    refresh();
  });
  const dialog = openDrawer({ title: t('lists.todoDetails'), content, actions, onClose: () => off(), initialFocus: canEdit ? name.input : undefined });
  dialog.panel.classList.add('lists-detail-panel');
  return dialog;
}
