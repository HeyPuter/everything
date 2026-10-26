import { el, uid as domId } from '../../../ui/dom.js';
import { avatar, avatarStack } from '../../../ui/avatar.js';
import { emptyState, skeleton, iconButton } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog, promptDialog } from '../../../ui/modal.js';
import { makeSortable } from '../../../ui/dnd.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { newId } from '../../../shared/ids.js';
import * as model from './model.js';
import { attempt, btn, colorDot, colorName, iconBtn, keepFocus, people, personOf, plural, scheduler } from './common.js';
import { icon } from './icons.js';
import { openAssigneesDialog } from './dialogs.js';
import { openTodoDetail } from './detail.js';
import { openImportDialog, openSaveTemplateDialog } from './importer.js';

const SERVER = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't']);

/** The To-dos pane: lists of to-dos with assignees, due dates, priorities, filters, sorting and a detail pane. */
export function mountTodos(container, ctx) {
  const { space, uid, state, save } = ctx;
  const composers = new Map();
  const dialogs = new Set();
  let sortables = [];
  let data = null;

  const track = (dialog) => { if (dialog) { dialogs.add(dialog); void dialog.closed?.then(() => dialogs.delete(dialog)); } return dialog; };
  const write = (ops, label) => (ops.length ? attempt(() => space.apply(ops, label ? { history: label } : {})) : Promise.resolve(true));

  const filterControl = segmented({ label: t('lists.filter'), value: state.todoFilter, onChange: (value) => { state.todoFilter = value; save(); render.request(); },
    items: [{ value: 'all', label: t('lists.filterAll') }, { value: 'mine', label: t('lists.filterMine') }, { value: 'overdue', label: t('lists.filterOverdue') }, { value: 'done', label: t('lists.filterDone') }] });
  const listSelect = el('select.select.lists-select', { 'aria-label': t('lists.showList'), onchange: () => { state.todoList = listSelect.value; save(); render.request(); } });
  const sortSelect = el('select.select.lists-select', { 'aria-label': t('lists.sortBy'), onchange: () => { state.todoSort = sortSelect.value; save(); render.request(); } },
    el('option', { value: 'manual' }, t('lists.sortManual')), el('option', { value: 'prio' }, t('lists.sortPrio')), el('option', { value: 'due' }, t('lists.sortDue')));
  const addListButton = btn(t('lists.addList'), { icon: 'addList', size: 'sm', variant: 'outline', onclick: () => addList() });
  const moreButton = iconButton('more', t('lists.todoMore'), { onclick: () => moreMenu() });
  const toolbar = el('div.lists-toolbar', {},
    el('div.lists-controls', {}, filterControl.element, listSelect, sortSelect),
    el('div.lists-actions', {}, addListButton, moreButton));
  const body = el('div.lists-body');
  const headingId = domId('lists-todo');
  container.replaceChildren(el('section.lists-pane', { 'aria-labelledby': headingId }, el('h2.sr-only', { id: headingId }, t('lists.todos')), toolbar, body));
  const render = scheduler(() => keepFocus(body, draw));

  function snapshot() {
    const meta = space.get('meta', 'meta');
    const metas = space.select.listMeta.all();
    return {
      meta, metas, todos: space.select.todo.all(), people: people(space), assignees: model.listAssignees(metas, 'todo'),
      canEdit: space.can('lists.edit'), today: model.localToday(), loading: !meta && !space.state.rev,
    };
  }

  function draw() {
    for (const sortable of sortables) sortable.destroy();
    sortables = [];
    data = snapshot();
    filterControl.setValue(state.todoFilter);
    addListButton.hidden = !data.canEdit;
    const groups = model.groupLists(data.metas, data.todos, 'todo');
    listSelect.replaceChildren(el('option', { value: '' }, t('lists.allLists')), ...groups.map((group) => el('option', { value: group.key || '-' }, group.name || t('lists.noList'))));
    if (!groups.some((group) => (group.key || '-') === state.todoList)) state.todoList = '';
    listSelect.value = state.todoList;
    sortSelect.value = state.todoSort;
    if (data.loading) { body.replaceChildren(el('div.lists-loading', { 'aria-busy': 'true' }, skeleton(), skeleton('80%'))); return; }
    if (!data.todos.length && !groups.length) {
      body.replaceChildren(emptyView(), ...(data.canEdit ? [composerFor({ key: '', name: '', meta: null, dupes: [], items: [] })] : []));
      return;
    }
    const options = { uid, today: data.today, assignees: data.assignees };
    const filtered = state.todoFilter !== 'all' || Boolean(state.todoList);
    const manual = state.todoSort === 'manual';
    const named = el('div.lists-groups');
    const loose = el('div.lists-groups');
    let shown = 0;
    for (const group of groups) {
      if (state.todoList && (group.key || '-') !== state.todoList) continue;
      const visible = model.sortTodos(group.items.filter((todo) => model.matchesTodoFilter(todo, state.todoFilter, options)), state.todoSort);
      shown += visible.length;
      if (state.todoFilter !== 'all' && !visible.length) continue;
      (group.meta ? named : loose).append(groupNode(group, visible, { reorder: manual && state.todoFilter === 'all' }));
    }
    const nodes = [el('div.lists-main', {}, named, loose)];
    if (filtered && !shown) nodes.unshift(el('p.lists-hint', {}, t('lists.todoNoMatch')));
    body.replaceChildren(...nodes);
    if (manual && !filtered && data.canEdit) {
      const metaGroups = groups.filter((group) => group.meta);
      sortables.push(makeSortable(named, { itemSelector: '.list-group[data-sortable-item]', handleSelector: '.list-group-grip', onMove: ({ from, to }) => moveList(metaGroups, from, to) }));
    }
  }

  function emptyView() {
    return emptyState({ title: t('lists.todoEmptyTitle'), body: t(data.canEdit ? 'lists.todoEmptyBody' : 'lists.todoEmptyViewer'), icon: 'backpack',
      action: data.canEdit && el('div.lists-empty-actions', {}, btn(t('lists.addList'), { icon: 'addList', variant: 'primary', onclick: () => addList() }),
        btn(t('lists.applyTemplate'), { icon: 'template', variant: 'outline', onclick: () => openImport() })) });
  }

  function groupNode(group, visible, { reorder }) {
    const label = group.name || t('lists.noList');
    const headingId = `lists-todo-${encodeURIComponent(group.key || '-')}`.replace(/%/g, '_');
    const open = group.items.filter((todo) => !todo.done).length;
    const assignees = (group.meta?.assignees ?? []).map((id) => personOf(data.people, id));
    const head = el('div.list-group-head', {},
      reorder && data.canEdit && (group.meta ? el('button.icon-btn.icon-btn-sm.sortable-grip.list-group-grip', { type: 'button', 'data-sortable-handle': '', dataset: { focus: `tgrip:${group.key}` } }, icon('grip', 16)) : el('span.lists-grip-space')),
      colorDot(group.meta?.color),
      el('h3.list-group-title', { id: headingId }, label),
      el('span.list-group-count', { 'aria-label': t('lists.openCount', { count: open }) }, String(open)),
      assignees.length > 0 && el('span.list-group-people', { title: t('lists.assignedTo', { names: assignees.map((person) => person.name).join(', ') }) },
        avatarStack(assignees.map((person) => ({ id: person.id, name: person.name, photo: person.avatar })), { size: 22 })),
      data.canEdit && group.key && iconBtn('more', t('lists.listActions', { name: label }), { dataset: { focus: `tmenu:${group.key}` }, onclick: (event) => groupMenu(event.currentTarget, group) }));
    const rows = el('div.lists-rows');
    for (const todo of visible) rows.append(todoNode(todo, { reorder }));
    const section = el('section.list-group', { 'aria-labelledby': headingId, dataset: group.meta ? { sortableItem: '', label } : {} }, head);
    if (visible.length) section.append(el('div.card', {}, rows));
    if (data.canEdit && state.todoFilter !== 'done') section.append(composerFor(group));
    if (reorder && data.canEdit) sortables.push(makeSortable(rows, { onMove: ({ from, to }) => moveTodo(group.items, visible, from, to) }));
    return section;
  }

  function composerFor(group) {
    let entry = composers.get(group.key);
    if (!entry) {
      const input = el('input.input.lists-composer-input', { type: 'text', autocomplete: 'off', maxLength: 600, dataset: { focus: `tcompose:${group.key}` } });
      const form = el('form.lists-composer', { onsubmit: (event) => {
        event.preventDefault();
        const value = input.value;
        if (!value.trim()) return;
        input.value = '';
        void addTodos(group.key, [value]);
      } }, input, iconBtn('plus', t('lists.add'), { type: 'submit' }));
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') ?? '';
        if (!/\n/.test(text.trim())) return;
        event.preventDefault();
        void addTodos(group.key, text.split(/\r?\n/));
      });
      entry = { form, input };
      composers.set(group.key, entry);
    }
    entry.input.placeholder = t('lists.addTodo');
    entry.input.setAttribute('aria-label', t('lists.addTodoTo', { list: group.name || t('lists.noList') }));
    return entry.form;
  }

  function todoNode(todo, { reorder }) {
    const flags = model.todoFlags(todo, data.today);
    const check = el('input.lists-check', { type: 'checkbox', checked: Boolean(todo.done), disabled: !data.canEdit, dataset: { focus: `tcheck:${todo.id}` },
      'aria-label': t('lists.doneLabel', { name: todo.name }), onchange: (event) => write([space.ops.patch('todo', todo.id, { set: { done: event.target.checked } })]) });
    const meta = el('div.lists-meta');
    if ([1, 2, 3].includes(todo.prio)) meta.append(el(`span.lists-chip.lists-prio-${todo.prio}`, {}, icon('flag', 14), t(`lists.prio${todo.prio}`)));
    if (todo.due) {
      const date = formatDate(todo.due, { year: !todo.due.startsWith(data.today.slice(0, 4)) });
      meta.append(el(`span.lists-chip${flags.overdue ? '.lists-overdue' : flags.dueToday ? '.lists-due-today' : ''}`, {}, icon('due', 14),
        flags.overdue ? t('lists.overdueOn', { date }) : flags.dueToday ? t('lists.dueToday') : t('lists.dueOn', { date })));
    }
    if (todo.who) {
      const person = personOf(data.people, todo.who);
      meta.append(el('span.lists-chip', {}, avatar({ id: person.id, name: person.name, photo: person.avatar, size: 18 }), person.name));
    }
    if (todo.desc?.trim()) meta.append(el('span.lists-chip', { title: t('lists.hasNotes') }, icon('notes', 14), el('span.sr-only', {}, t('lists.hasNotes'))));
    const more = iconBtn('more', t('lists.itemActions', { name: todo.name }), { dataset: { focus: `tmore:${todo.id}` }, onclick: (event) => todoMenu(event.currentTarget, todo) });
    return el(`div.list-row.lists-row${todo.done ? '.is-done' : ''}`, { dataset: { sortableItem: '', label: todo.name } },
      reorder && data.canEdit && el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', 'data-sortable-handle': '', dataset: { focus: `tdgrip:${todo.id}` } }, icon('grip', 16)),
      check,
      el('div.lists-item-main', {}, el('div.lists-item-title', {}, el('button.lists-name', { type: 'button', dataset: { focus: `tname:${todo.id}` }, onclick: () => openDetail(todo.id) }, todo.name)),
        meta.childNodes.length ? meta : null),
      more);
  }

  // Writes

  async function addTodos(key, lines) {
    const names = lines.map((line) => model.cleanName(line)).filter(Boolean);
    if (!names.length) return;
    const group = model.groupLists(data.metas, data.todos, 'todo').find((entry) => entry.key === key);
    const items = data.todos.filter((todo) => model.normName(todo.list) === key);
    const { keys, moves } = model.appendOrders(items, names.length);
    const ops = moves.map((move) => space.ops.patch('todo', move.item.id, { set: { order: move.order } }));
    for (const [index, name] of names.entries()) ops.push(space.ops.create('todo', { name, order: keys[index], ...(group?.name ? { list: group.name } : {}) }));
    await write(ops, t('lists.historyAddTodo'));
  }

  function moveTodo(full, visible, from, to) {
    const moves = model.moveOrders(full, visible, from, to);
    void write(moves.map((move) => space.ops.patch('todo', move.item.id, { set: { order: move.order } }))).then(() => render.request());
  }
  function moveList(metaGroups, from, to) {
    const metas = data.metas.filter((meta) => meta.kind === 'todo');
    const moves = model.moveOrders(metas, metaGroups.map((group) => group.meta), from, to);
    void write(moves.map((move) => space.ops.patch('listMeta', move.item.id, { set: { order: move.order } }))).then(() => render.request());
  }

  function ensureList(name) {
    const key = model.normName(name);
    if (!key || !data.canEdit || data.metas.some((meta) => meta.kind === 'todo' && model.normName(meta.name) === key)) return [];
    const metas = data.metas.filter((meta) => meta.kind === 'todo');
    return [space.ops.create('listMeta', { kind: 'todo', name: model.cleanName(name), color: model.nextColor(metas.map((meta) => meta.color)), order: model.appendOrders(metas, 1).keys[0] })];
  }

  async function addList() {
    const value = await promptDialog({ title: t('lists.addListTitle'), label: t('lists.listName'), confirmLabel: t('lists.add') });
    const name = model.cleanName(value);
    if (!name) return;
    if (data.metas.some((meta) => meta.kind === 'todo' && model.normName(meta.name) === model.normName(name))) { toast(t('lists.listExists', { name })); return; }
    await write(ensureList(name), t('lists.historyAddList'));
  }

  function groupMenu(anchor, group) {
    openMenu(anchor, [
      { label: t('lists.rename'), icon: 'pencil', onSelect: () => renameList(group) },
      { label: t('lists.color'), onSelect: () => openMenu(anchor, model.COLORS.map((color) => ({ label: colorName(color), checked: group.meta?.color === color, onSelect: () => {
        if (group.meta) return write([space.ops.patch('listMeta', group.meta.id, { set: { color } })], t('lists.historyEdit'));
        const [create] = ensureList(group.name);
        if (create) create.put.color = color;
        return write(create ? [create] : [], t('lists.historyEdit'));
      } }))) },
      { label: t('lists.assignees'), icon: 'users', onSelect: () => track(openAssigneesDialog({ title: t('lists.assigneesTitle', { name: group.name }), people: data.people, selected: group.meta?.assignees ?? [],
        onSave: (ids) => {
          if (group.meta) return write([ids.length ? space.ops.patch('listMeta', group.meta.id, { set: { assignees: ids } }) : space.ops.patch('listMeta', group.meta.id, { unset: ['assignees'] })], t('lists.historyEdit'));
          const [create] = ensureList(group.name);
          if (create && ids.length) create.put.assignees = ids;
          return write(create ? [create] : [], t('lists.historyEdit'));
        } })) },
      { separator: true },
      { label: t('lists.deleteList'), icon: 'trash', danger: true, onSelect: () => deleteList(group) },
    ]);
  }

  async function renameList(group) {
    const value = await promptDialog({ title: t('lists.renameTitle', { name: group.name }), label: t('lists.listName'), value: group.name, confirmLabel: t('lists.rename') });
    const name = model.cleanName(value);
    if (!name || name === group.name) return;
    const target = data.metas.find((meta) => meta.kind === 'todo' && model.normName(meta.name) === model.normName(name) && meta.id !== group.meta?.id);
    const finalName = target ? model.cleanName(target.name) : name;
    const ops = data.todos.filter((todo) => model.normName(todo.list) === group.key).map((todo) => space.ops.patch('todo', todo.id, { set: { list: finalName } }));
    for (const meta of [group.meta, ...group.dupes].filter(Boolean)) {
      ops.push(target || meta !== group.meta ? space.ops.remove('listMeta', meta.id) : space.ops.patch('listMeta', meta.id, { set: { name: finalName } }));
    }
    await write(ops, t('lists.historyRename'));
  }

  async function deleteList(group) {
    const todos = data.todos.filter((todo) => model.normName(todo.list) === group.key);
    const confirmed = await confirmDialog({ title: t('lists.deleteListTitle', { name: group.name }),
      body: todos.length ? plural(todos.length, 'lists.deleteTodoListOne', 'lists.deleteTodoListOther') : t('lists.deleteListEmpty'), confirmLabel: t('lists.delete'), danger: true });
    if (!confirmed) return;
    await write([...[group.meta, ...group.dupes].filter(Boolean).map((meta) => space.ops.remove('listMeta', meta.id)), ...todos.map((todo) => space.ops.remove('todo', todo.id))]);
  }

  async function removeTodo(todo) {
    const fields = Object.fromEntries(Object.entries(todo).filter(([key]) => !SERVER.has(key)));
    if (await write([space.ops.remove('todo', todo.id)])) {
      toast(t('lists.deleted', { name: todo.name }), { action: { label: t('lists.undo'), onClick: () => write([space.ops.create('todo', fields)]) } });
    }
  }

  function todoMenu(anchor, todo) {
    const items = [{ label: t('lists.openDetails'), icon: 'pencil', onSelect: () => openDetail(todo.id) }];
    if (data.canEdit) {
      items.push({ separator: true });
      for (const prio of [1, 2, 3]) items.push({ label: t(`lists.prioLong${prio}`), checked: todo.prio === prio, onSelect: () => write([todo.prio === prio ? space.ops.patch('todo', todo.id, { unset: ['prio'] }) : space.ops.patch('todo', todo.id, { set: { prio } })]) });
      items.push({ separator: true }, { label: t('lists.delete'), icon: 'trash', danger: true, onSelect: () => removeTodo(todo) });
    }
    openMenu(anchor, items);
  }

  function openDetail(id) {
    track(openTodoDetail({ space, id, uid, canEdit: data.canEdit, lists: () => model.groupLists(data.metas, data.todos, 'todo').map((group) => group.name).filter(Boolean),
      people: () => data.people, ensureList, write, onDelete: removeTodo }));
  }

  function moreMenu() {
    const items = [];
    if (data?.canEdit) items.push({ label: t('lists.applyTemplate'), icon: 'plus', onSelect: () => openImport() });
    items.push({ label: t('lists.saveTemplate'), icon: 'file', onSelect: () => saveTemplate() });
    openMenu(moreButton, items);
  }

  function openImport() {
    track(openImportDialog({ kind: 'todo', ctx, canEdit: data.canEdit, canPrivate: false, onImport: importRows }));
  }

  async function importRows(rows) {
    const plan = model.planImport(rows, { kind: 'todo', metas: data.metas, items: data.todos, makeId: newId });
    if (!plan.items.length) return false;
    const ops = [
      ...plan.moves.map((move) => space.ops.patch(move.type, move.item.id, { set: { order: move.order } })),
      ...plan.lists.map((list) => space.ops.create('listMeta', list)),
      ...plan.items.map((fields) => space.ops.create('todo', fields)),
    ];
    const ok = await write(ops, t('lists.historyImport'));
    if (ok) toast(plural(plan.items.length, 'lists.importedTodosOne', 'lists.importedTodosOther'));
    return ok;
  }

  function saveTemplate() {
    track(openSaveTemplateDialog({ kind: 'todo', ctx, scope: 'all', groupsFor: () => model.groupLists(data.metas, data.todos, 'todo'),
      defaultName: t('lists.templateDefaultTodo', { trip: data.meta?.title ?? '' }).trim() }));
  }

  render.request();
  return {
    refresh: () => render.request(),
    showDue() { state.todoFilter = 'all'; state.todoSort = 'due'; state.todoList = ''; save(); render.request(); },
    destroy() {
      render.stop();
      for (const sortable of sortables) sortable.destroy();
      for (const dialog of [...dialogs]) dialog.close?.('navigation');
    },
  };
}
