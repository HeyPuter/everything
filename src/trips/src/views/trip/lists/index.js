import './lists.css';
import { el } from '../../../ui/dom.js';
import { emptyState } from '../../../ui/bits.js';
import { tabs } from '../../../ui/tabs.js';
import { toast } from '../../../ui/toast.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t } from '../../../lib/i18n/index.js';
import { createTemplateStore } from '../../settings/data/templates.js';
import { dueReminders, listAssignees, localToday } from './model.js';
import { btn, plural, readState, writeState } from './common.js';
import { mountPacking } from './packing.js';
import { mountTodos } from './todos.js';

const TYPES = new Set(['pack', 'bag', 'todo', 'listMeta']);
// Presence (who is online) is not shown here, so its frequent events do not redraw the lists.
const WATCH = new Set([...TYPES, 'meta', 'member', 'guest']);
const DEFAULTS = Object.freeze({ tab: 'pack', packView: 'shared', packFilter: 'all', packBag: null, todoFilter: 'all', todoList: '', todoSort: 'manual' });
const FIELDS = Object.freeze({
  name: 'lists.fieldName', qty: 'lists.fieldQty', list: 'lists.fieldList', order: 'lists.fieldOrder', done: 'lists.fieldDone', grams: 'lists.fieldWeight',
  bagId: 'lists.fieldBag', vis: 'lists.fieldVisibility', for: 'lists.fieldFor', limitGrams: 'lists.fieldLimit', people: 'lists.fieldPeople', color: 'lists.fieldColor',
  due: 'lists.fieldDue', desc: 'lists.fieldNotes', who: 'lists.fieldAssignee', prio: 'lists.fieldPriority', assignees: 'lists.fieldAssignees',
});

/** Open, due-today or overdue to-dos for this member, for an in-app reminder when the trip opens. */
export function dueTodos(space, uid, today = localToday()) {
  return dueReminders(space.select.todo.all(), { uid, today, assignees: listAssignees(space.select.listMeta.all(), 'todo') });
}

/** Trip tab entry (see "Adding a module" in src/lib/README.md). */
export function mount(container, context) {
  const { space, signal } = context;
  const uid = context.account?.uuid ?? context.session?.account?.uuid;
  if (!space || !uid) {
    container.replaceChildren(emptyState({ title: t('lists.unavailableTitle'), body: t('lists.unavailableBody'), icon: 'backpack' }));
    return undefined;
  }
  const personal = context.personal ?? context.session?.personal ?? null;
  const puter = context.puter ?? null;
  const stateKey = `trips:lists:${space.ref.s}`;
  const state = readState(stateKey, DEFAULTS);
  const ctx = {
    space, uid, personal, puter, session: context.session ?? null, state, save: () => writeState(stateKey, state),
    templates: personal && puter?.kv ? createTemplateStore({ personal, puter }) : null,
  };

  const packHost = el('div');
  const todoHost = el('div');
  const packing = mountPacking(packHost, ctx);
  const todos = mountTodos(todoHost, ctx);
  const sections = tabs({ label: t('lists.sections'), value: state.tab, onChange: (id) => { state.tab = id; ctx.save(); },
    items: [{ id: 'pack', label: t('lists.packing'), icon: 'backpack', content: packHost }, { id: 'todo', label: t('lists.todos'), icon: 'check', content: todoHost }] });
  const todoTab = sections.element.querySelectorAll('[role=tab]')[1];
  const badge = el('span.lists-badge', { hidden: true });
  todoTab?.append(badge);
  const banner = el('div.lists-banner', { role: 'status', hidden: true });
  container.replaceChildren(el('div.lists-view', {}, banner, sections.element));

  let canEdit = space.can('lists.edit');
  function updateBadge() {
    const due = dueTodos(space, uid).length;
    badge.hidden = !due;
    badge.textContent = due ? String(due) : '';
    badge.setAttribute('aria-label', due ? plural(due, 'lists.dueBadgeOne', 'lists.dueBadgeOther') : '');
  }
  function updateBanner() {
    const conflicts = space.conflicts().filter((conflict) => TYPES.has(conflict.op.t) || (conflict.op.do ?? '').startsWith('pack.'));
    banner.hidden = !conflicts.length;
    if (!conflicts.length) { banner.replaceChildren(); return; }
    banner.replaceChildren(el('span', {}, plural(conflicts.length, 'lists.conflictsOne', 'lists.conflictsOther')),
      btn(t('lists.review'), { size: 'sm', variant: 'outline', onclick: () => review(conflicts[0]) }));
  }
  function review(conflict) {
    openConflictDialog({ conflict, typeLabel: (type) => t(`lists.type_${TYPES.has(type) ? type : 'pack'}`), fieldLabel: (_type, name) => (Object.hasOwn(FIELDS, name) ? t(FIELDS[name]) : name),
      onResolve: (choice) => space.resolveConflict(conflict.op.opId, choice) });
  }
  function remind() {
    const due = dueTodos(space, uid);
    if (!due.length) return;
    const key = `trips:lists:reminded:${space.ref.s}`;
    const today = localToday();
    try { if (globalThis.localStorage?.getItem(key) === today) return; globalThis.localStorage?.setItem(key, today); } catch { /* remind every time */ }
    toast(plural(due.length, 'lists.reminderOne', 'lists.reminderOther'), { duration: 10_000, action: { label: t('lists.reminderShow'), onClick: () => { sections.select('todo'); todos.showDue(); } } });
  }

  const offData = space.subscribe((event) => {
    if (![...event.types].some((type) => WATCH.has(type))) return;
    packing.refresh();
    if (event.types.has('todo') || event.types.has('listMeta') || event.types.has('member') || event.types.has('guest') || event.types.has('meta')) { todos.refresh(); updateBadge(); }
  });
  // The reminder waits for the first sync to settle, so to-dos that arrive after the trip meta still count.
  const loaded = () => Boolean(space.get('meta', 'meta') || space.state.rev) && !['idle', 'syncing'].includes(space.state.sync);
  let reminded = false;
  const offState = space.onState(() => {
    const next = space.can('lists.edit');
    if (next !== canEdit) { canEdit = next; packing.refresh(); todos.refresh(); }
    updateBanner();
    if (!reminded && loaded()) { reminded = true; remind(); }
  });
  updateBadge();
  updateBanner();
  if (loaded()) { reminded = true; remind(); }

  let done = false;
  const cleanup = () => { if (done) return; done = true; offData(); offState(); packing.destroy(); todos.destroy(); };
  signal?.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
