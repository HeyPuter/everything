import { el, uid as domId } from '../../../ui/dom.js';
import { avatarStack } from '../../../ui/avatar.js';
import { emptyState, skeleton, iconButton } from '../../../ui/bits.js';
import { segmented } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog, promptDialog } from '../../../ui/modal.js';
import { makeSortable } from '../../../ui/dnd.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatWeight } from '../../../lib/format.js';
import { newId } from '../../../shared/ids.js';
import * as model from './model.js';
import { attempt, btn, colorDot, colorName, iconBtn, keepFocus, people, personOf, plural, privateFields, scheduler } from './common.js';
import { icon } from './icons.js';
import { renderBags } from './bags.js';
import { openAssigneesDialog, openBagDialog, openItemDialog } from './dialogs.js';
import { openImportDialog, openSaveTemplateDialog } from './importer.js';

const SERVER = new Set(['id', 'v', 'rev', 'upd', 'by', 'cr', 't', 'private']);

/** The Packing pane: lists with items, per-person checks, pledges, bags, private items, import and templates. */
export function mountPacking(container, ctx) {
  const { space, uid, state, save } = ctx;
  const composers = new Map();
  const dialogs = new Set();
  let sortables = [];
  let data = null;

  const track = (dialog) => { if (dialog) { dialogs.add(dialog); void dialog.closed?.then(() => dialogs.delete(dialog)); } return dialog; };
  const priv = () => space.privateItems('pack');
  const write = (ops, label) => (ops.length ? attempt(() => space.apply(ops, label ? { history: label } : {})) : Promise.resolve(true));

  const viewControl = segmented({ label: t('lists.packView'), value: state.packView, onChange: (value) => { state.packView = value; save(); render.request(); },
    items: [{ value: 'shared', label: t('lists.viewShared') }, { value: 'mine', label: t('lists.viewMine') }] });
  const filterControl = segmented({ label: t('lists.filter'), value: state.packFilter, onChange: (value) => { state.packFilter = value; save(); render.request(); },
    items: [{ value: 'all', label: t('lists.filterAll') }, { value: 'open', label: t('lists.filterOpen') }, { value: 'done', label: t('lists.filterDone') }] });
  const addListButton = btn(t('lists.addList'), { icon: 'addList', size: 'sm', variant: 'outline', onclick: () => addList() });
  const importButton = btn(t('lists.import'), { icon: 'upload', size: 'sm', variant: 'outline', onclick: () => openImport() });
  const moreButton = iconButton('more', t('lists.packMore'), { onclick: () => moreMenu() });
  const toolbar = el('div.lists-toolbar', {},
    el('div.lists-controls', {}, viewControl.element, filterControl.element),
    el('div.lists-actions', {}, addListButton, importButton, moreButton));
  const body = el('div.lists-body');
  const headingId = domId('lists-pack');
  container.replaceChildren(el('section.lists-pane', { 'aria-labelledby': headingId }, el('h2.sr-only', { id: headingId }, t('lists.packing')), toolbar, body));
  const render = scheduler(() => keepFocus(body, draw));

  function snapshot() {
    const meta = space.get('meta', 'meta');
    const settings = meta?.settings ?? {};
    let privateList = [];
    let canPrivate = true;
    try { privateList = priv().list(); } catch { canPrivate = false; }
    const shared = space.select.pack.all();
    const metas = space.select.listMeta.all();
    const assignees = model.listAssignees(metas, 'pack');
    return {
      meta, perPerson: Boolean(settings.perPersonPacking), bagTracking: settings.bagTracking !== false,
      canEdit: space.can('lists.edit'), canTrip: space.can('trip.edit'), canPrivate,
      shared, private: privateList, metas, bags: space.select.bag.all(), people: people(space), assignees,
      loading: !meta && !space.state.rev,
    };
  }
  const stateOf = (item) => model.packState(item, { uid, perPerson: data.perPerson });
  const allIn = (key) => [...data.shared, ...data.private].filter((item) => model.normName(item.list) === key);
  const canPatch = (item) => (item.private ? data.canPrivate : data.canEdit);

  function draw() {
    for (const sortable of sortables) sortable.destroy();
    sortables = [];
    data = snapshot();
    viewControl.setValue(state.packView);
    filterControl.setValue(state.packFilter);
    addListButton.hidden = !data.canEdit;
    importButton.hidden = !data.canEdit && !data.canPrivate;
    if (data.loading) { body.replaceChildren(el('div.lists-loading', { 'aria-busy': 'true' }, skeleton(), skeleton('80%'), skeleton('60%'))); return; }
    const mine = state.packView === 'mine';
    const viewItems = mine ? [...data.shared.filter((item) => model.inMyList(item, uid, data.assignees)), ...data.private] : data.shared;
    const groups = model.groupLists(data.metas, viewItems, 'pack');
    const bagFilter = data.bagTracking ? state.packBag ?? null : null;
    const bagIds = new Set(data.bags.map((bag) => bag.id));
    const bagMatch = (item) => !bagFilter || (bagFilter === 'none' ? !item.bagId || !bagIds.has(item.bagId) : item.bagId === bagFilter);
    const filtered = state.packFilter !== 'all' || Boolean(bagFilter);
    const reorder = !filtered;

    const totals = model.progress(viewItems, { uid, perPerson: data.perPerson });
    const nodes = viewItems.length ? [progressBar(totals, viewItems)] : [];
    if (bagFilter) nodes.push(bagFilterChip(bagFilter));
    if (!viewItems.length && !data.metas.some((meta) => meta.kind === 'pack')) nodes.push(emptyView(mine));
    else if (mine && !viewItems.length) nodes.push(el('p.lists-hint', {}, t('lists.mineEmpty')));
    const named = el('div.lists-groups');
    const loose = el('div.lists-groups');
    for (const group of groups) {
      const visible = group.items.filter((item) => model.matchesFilter(stateOf(item), state.packFilter) && bagMatch(item));
      if (filtered && !visible.length) continue;
      (group.meta ? named : loose).append(groupNode(group, visible, { reorder, mine }));
    }
    if (!groups.length && !filtered) {
      const composer = composerFor({ key: '', name: '', meta: null, dupes: [], items: [] }, mine);
      if (composer) loose.append(composer);
    }
    const main = el('div.lists-main', {}, named, loose);
    const layout = el('div.lists-layout', {}, main);
    if (data.bagTracking) layout.append(renderBags({ items: viewItems, bags: data.bags, people: data.people, canEdit: data.canEdit, selected: bagFilter, reorder: !filtered,
      onSelect: (id) => { state.packBag = state.packBag === id ? null : id; save(); render.request(); },
      onAdd: () => editBag(null), onEdit: (bag) => editBag(bag), onDelete: (bag) => deleteBag(bag), onMove: moveBag, sortables }));
    nodes.push(layout);
    body.replaceChildren(...nodes);
    if (reorder && data.canEdit) {
      const metaGroups = groups.filter((group) => group.meta);
      sortables.push(makeSortable(named, { itemSelector: '.list-group[data-sortable-item]', handleSelector: '.list-group-grip',
        onMove: ({ from, to }) => moveList(metaGroups, from, to) }));
    }
  }

  function progressBar(totals, items) {
    const grams = data.bagTracking ? items.reduce((sum, item) => sum + model.itemGrams(item), 0) : 0;
    return el('div.lists-progress', {},
      el('div.lists-progress-text', {}, el('span', {}, t(data.perPerson ? 'lists.progressMine' : 'lists.progress', { done: totals.done, total: totals.total })),
        grams > 0 && el('span.lists-muted', {}, t('lists.totalWeight', { weight: formatWeight(grams) }))),
      el('progress.meter', { max: Math.max(1, totals.total), value: totals.done, 'aria-label': t('lists.progressLabel') }));
  }

  function bagFilterChip(id) {
    const bag = data.bags.find((entry) => entry.id === id);
    const label = id === 'none' ? t('lists.unbagged') : bag?.name ?? t('lists.unknownBag');
    return el('div.lists-filter-chip', {}, el('span.chip', {}, icon('luggage', 14), t('lists.showingBag', { name: label }),
      iconButton('close', t('lists.clearBagFilter'), { onclick: () => { state.packBag = null; save(); render.request(); } })));
  }

  function emptyView(mine) {
    const actions = el('div.lists-empty-actions', {},
      data.canEdit && btn(t('lists.addList'), { icon: 'addList', variant: 'primary', onclick: () => addList() }),
      (data.canEdit || data.canPrivate) && btn(t('lists.applyTemplate'), { icon: 'template', variant: 'outline', onclick: () => openImport('template') }));
    const node = emptyState({ title: t(mine ? 'lists.mineEmptyTitle' : 'lists.packEmptyTitle'), body: t(mine ? 'lists.mineEmpty' : data.canEdit ? 'lists.packEmptyBody' : 'lists.packEmptyViewer'), icon: 'backpack', action: actions });
    return node;
  }

  function groupNode(group, visible, { reorder, mine }) {
    const label = group.name || t('lists.noList');
    const headingId = `lists-pack-${encodeURIComponent(group.key || '-')}`.replace(/%/g, '_');
    const counted = model.progress(group.items, { uid, perPerson: data.perPerson });
    const assignees = (group.meta?.assignees ?? []).map((id) => personOf(data.people, id));
    const privateOnly = group.items.length > 0 && group.items.every((item) => item.private) && !group.meta;
    const manage = data.canEdit || privateOnly;
    const head = el('div.list-group-head', {},
      reorder && data.canEdit && (group.meta ? el('button.icon-btn.icon-btn-sm.sortable-grip.list-group-grip', { type: 'button', 'data-sortable-handle': '', dataset: { focus: `lgrip:${group.key}` } }, icon('grip', 16)) : el('span.lists-grip-space')),
      colorDot(group.meta?.color),
      el('h3.list-group-title', { id: headingId }, label),
      el('span.list-group-count', { 'aria-label': t('lists.countLabel', { done: counted.done, total: counted.total }) }, `${counted.done}/${counted.total}`),
      assignees.length > 0 && el('span.list-group-people', { title: t('lists.assignedTo', { names: assignees.map((person) => person.name).join(', ') }) },
        avatarStack(assignees.map((person) => ({ id: person.id, name: person.name, photo: person.avatar })), { size: 22 })),
      groupActions(null, group, { manage, privateOnly, mine }).length > 0 && iconBtn('more', t('lists.listActions', { name: label }), { dataset: { focus: `lmenu:${group.key}` },
        onclick: (event) => openMenu(event.currentTarget, groupActions(event.currentTarget, group, { manage, privateOnly, mine })) }));
    const rows = el('div.lists-rows');
    const gripColumn = reorder && (data.canEdit || (mine && data.canPrivate));
    for (const item of visible) rows.append(itemNode(item, { reorder, gripColumn }));
    const section = el('section.list-group', { 'aria-labelledby': headingId, dataset: group.meta ? { sortableItem: '', label } : {} }, head);
    if (visible.length) section.append(el('div.card', {}, rows));
    const composer = composerFor(group, mine);
    if (composer) section.append(composer);
    if (reorder) {
      const full = allIn(group.key);
      sortables.push(makeSortable(rows, { onMove: ({ from, to }) => moveItem(full, visible, from, to) }));
    }
    return section;
  }

  function composerFor(group, mine) {
    const shared = !mine;
    if (shared ? !data.canEdit : !data.canPrivate) return null;
    const key = `${mine ? 'm' : 's'}:${group.key}`;
    let entry = composers.get(key);
    if (!entry) {
      const input = el('input.input.lists-composer-input', { type: 'text', autocomplete: 'off', maxLength: 600, dataset: { focus: `compose:${key}` } });
      const form = el('form.lists-composer', { onsubmit: (event) => {
        event.preventDefault();
        const value = input.value;
        if (!value.trim()) return;
        input.value = '';
        void addItems(group.key, [value], entry.mine);
      } }, input, iconBtn('plus', t('lists.add'), { type: 'submit' }));
      input.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text') ?? '';
        if (!/\n/.test(text.trim())) return;
        event.preventDefault();
        void addItems(group.key, text.split(/\r?\n/), entry.mine);
      });
      entry = { form, input, mine };
      composers.set(key, entry);
    }
    const label = group.name || t('lists.noList');
    entry.input.placeholder = t(mine ? 'lists.addPrivateItem' : 'lists.addItem');
    entry.input.setAttribute('aria-label', t(mine ? 'lists.addPrivateItemTo' : 'lists.addItemTo', { list: label }));
    return entry.form;
  }

  function itemNode(item, { reorder, gripColumn }) {
    const st = stateOf(item);
    const editable = canPatch(item);
    const checkable = item.private ? data.canPrivate : data.perPerson ? st.relevant : data.canEdit;
    const check = el('input.lists-check', { type: 'checkbox', checked: st.done, disabled: !checkable, dataset: { focus: `check:${item.id}` },
      'aria-label': t('lists.packedLabel', { name: item.name }), onchange: (event) => toggle(item, event.target.checked) });
    const name = editable
      ? el('button.lists-name', { type: 'button', dataset: { focus: `name:${item.id}` }, onclick: () => editItem(item) }, item.name)
      : el('span.lists-name', {}, item.name);
    const meta = el('div.lists-meta');
    if (item.private) meta.append(el('span.lists-chip', {}, icon('lock', 14), t('lists.private')));
    if (item.vis === 'people' && item.for?.length) meta.append(el('span.lists-chip', {}, icon('people', 14), t('lists.forPeople', { names: item.for.map((id) => personOf(data.people, id).name).join(', ') })));
    if (data.perPerson && !item.private) {
      const targets = item.vis === 'people' ? item.for ?? [] : [...data.people.values()].filter((person) => person.kind === 'member').map((person) => person.id);
      const packed = targets.filter((id) => item.doneBy?.[id] === true);
      if (targets.length > 1) meta.append(el('span.lists-chip', { title: packed.map((id) => personOf(data.people, id).name).join(', ') || null }, t('lists.packedBy', { done: packed.length, total: targets.length })));
    }
    if (data.bagTracking && item.grams > 0) meta.append(el('span.lists-chip', {}, icon('weight', 14), formatWeight(model.itemGrams(item))));
    const bag = data.bagTracking && item.bagId ? data.bags.find((entry) => entry.id === item.bagId) : null;
    if (bag) meta.append(el('span.lists-chip', {}, colorDot(bag.color), bag.name));
    const pledges = Object.entries(item.bring ?? {}).filter(([, value]) => value === 'yes' || value === 'maybe');
    if (pledges.length) {
      const text = pledges.map(([id, value]) => t(value === 'yes' ? 'lists.bringsYes' : 'lists.bringsMaybe', { name: personOf(data.people, id).name })).join(', ');
      meta.append(el('span.lists-chip.lists-pledge', { title: text }, icon('bring', 14), el('span', {}, text)));
    }
    const more = iconBtn('more', t('lists.itemActions', { name: item.name }), { dataset: { focus: `imenu:${item.id}` }, onclick: (event) => itemMenu(event.currentTarget, item) });
    return el(`div.list-row.lists-row${st.done ? '.is-done' : ''}`, { dataset: { sortableItem: '', label: item.name } },
      reorder && editable ? el('button.icon-btn.icon-btn-sm.sortable-grip', { type: 'button', 'data-sortable-handle': '', dataset: { focus: `grip:${item.id}` } }, icon('grip', 16)) : gripColumn && el('span.lists-grip-space'),
      check,
      el('div.lists-item-main', {}, el('div.lists-item-title', {}, name, item.qty > 1 && el('span.lists-qty', {}, t('lists.qty', { count: item.qty }))), meta.childNodes.length ? meta : null),
      more);
  }

  // Writes

  async function toggle(item, value) {
    if (item.private) {
      const fields = privateFields(item);
      if (value) fields.done = true; else delete fields.done;
      return attempt(() => priv().put(fields, item.id));
    }
    if (data.perPerson) {
      const path = `doneBy.${uid}`;
      return write([value ? space.ops.patch('pack', item.id, { set: { [path]: true } }) : space.ops.patch('pack', item.id, { unset: [path] })]);
    }
    return write([space.ops.patch('pack', item.id, { set: { done: value } })]);
  }

  function pledge(item, value) {
    const path = `bring.${uid}`;
    return write([value ? space.ops.patch('pack', item.id, { set: { [path]: value } }) : space.ops.patch('pack', item.id, { unset: [path] })]);
  }

  /** Item fields that can be created again by this member (others' checks and pledges are theirs to set). */
  function recreatable(item) {
    const fields = Object.fromEntries(Object.entries(item).filter(([key]) => !SERVER.has(key)));
    fields.owner = uid;
    if (fields.doneBy) fields.doneBy = fields.doneBy[uid] ? { [uid]: true } : undefined;
    if (fields.bring) fields.bring = fields.bring[uid] ? { [uid]: fields.bring[uid] } : undefined;
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  }
  function toPrivate(item, order = item.order) {
    const fields = { name: item.name, order };
    for (const key of ['qty', 'list', 'grams', 'bagId']) if (item[key] !== undefined && item[key] !== null) fields[key] = item[key];
    if (stateOf(item).done) fields.done = true;
    return fields;
  }

  async function addItems(key, lines, mine) {
    const entries = lines.map(model.parseQuantity).filter((entry) => entry.name);
    if (!entries.length) return;
    const group = model.groupLists(data.metas, allIn(key), 'pack').find((entry) => entry.key === key);
    const listName = group?.name ?? '';
    const { keys, moves } = model.appendOrders(allIn(key), entries.length);
    await applyMoves(moves);
    const fields = entries.map((entry, index) => ({ name: entry.name, order: keys[index], ...(entry.qty ? { qty: entry.qty } : {}), ...(listName ? { list: listName } : {}),
      ...(data.bagTracking && state.packBag && state.packBag !== 'none' ? { bagId: state.packBag } : {}) }));
    if (mine) {
      await attempt(async () => { for (const value of fields) await priv().put(value); });
      return;
    }
    await write(fields.map((value) => space.ops.create('pack', { ...value, owner: uid })), t('lists.historyAdd'));
  }

  /** Order fixes from a rebalance: shared items through the outbox, private ones in personal storage. */
  async function applyMoves(moves) {
    if (!moves.length) return true;
    const ops = data.canEdit ? moves.filter((move) => !move.item.private).map((move) => space.ops.patch(move.type ?? 'pack', move.item.id, { set: { order: move.order } })) : [];
    const ok = await write(ops);
    for (const move of moves.filter((entry) => entry.item.private)) await attempt(() => priv().put({ ...privateFields(move.item), order: move.order }, move.item.id));
    return ok;
  }

  function moveItem(full, visible, from, to) {
    const moves = model.moveOrders(full, visible, from, to).filter((move) => canPatch(move.item));
    void applyMoves(moves).then(() => render.request());
  }
  function moveList(metaGroups, from, to) {
    const metas = data.metas.filter((meta) => meta.kind === 'pack');
    const moves = model.moveOrders(metas, metaGroups.map((group) => group.meta), from, to);
    void write(moves.map((move) => space.ops.patch('listMeta', move.item.id, { set: { order: move.order } }))).then(() => render.request());
  }
  function moveBag(from, to) {
    const moves = model.moveOrders(data.bags, data.bags, from, to);
    void write(moves.map((move) => space.ops.patch('bag', move.item.id, { set: { order: move.order } }))).then(() => render.request());
  }

  async function copyToMine(item) {
    const { keys } = model.appendOrders(allIn(model.normName(item.list)), 1);
    const fields = toPrivate(item, keys[0]);
    delete fields.done;
    if (await attempt(() => priv().put(fields))) toast(t('lists.copiedToMine', { name: item.name }));
  }

  async function makePrivate(item) {
    const confirmed = await confirmDialog({ title: t('lists.makePrivateTitle', { name: item.name }), body: t('lists.makePrivateBody'), confirmLabel: t('lists.makePrivate') });
    if (!confirmed) return;
    if (await attempt(() => priv().put(toPrivate(item)))) await write([space.ops.remove('pack', item.id)]);
  }

  async function shareItem(item) {
    const fields = privateFields(item);
    const create = space.ops.create('pack', { ...fields, owner: uid, ...(data.perPerson && fields.done ? { doneBy: { [uid]: true } } : {}) });
    if (data.perPerson) delete create.put.done;
    if (await write([create], t('lists.historyAdd'))) await attempt(() => priv().remove(item.id));
  }

  async function removeItem(item) {
    if (item.private) {
      const fields = privateFields(item);
      if (await attempt(() => priv().remove(item.id))) toast(t('lists.deleted', { name: item.name }), { action: { label: t('lists.undo'), onClick: () => attempt(() => priv().put(fields)) } });
      return;
    }
    const fields = recreatable(item);
    if (await write([space.ops.remove('pack', item.id)])) {
      toast(t('lists.deleted', { name: item.name }), { action: { label: t('lists.undo'), onClick: () => write([space.ops.create('pack', fields)]) } });
    }
  }

  function moveToBag(item, bagId) {
    if (item.private) {
      const fields = privateFields(item);
      if (bagId) fields.bagId = bagId; else delete fields.bagId;
      return attempt(() => priv().put(fields, item.id));
    }
    return write([bagId ? space.ops.patch('pack', item.id, { set: { bagId } }) : space.ops.patch('pack', item.id, { unset: ['bagId'] })]);
  }

  async function ensureList(name) {
    const key = model.normName(name);
    if (!key || !data.canEdit || data.metas.some((meta) => meta.kind === 'pack' && model.normName(meta.name) === key)) return [];
    const metas = data.metas.filter((meta) => meta.kind === 'pack');
    const { keys } = model.appendOrders(metas, 1);
    return [space.ops.create('listMeta', { kind: 'pack', name: model.cleanName(name), color: model.nextColor(metas.map((meta) => meta.color)), order: keys[0] })];
  }

  function editItem(item) {
    const lists = model.groupLists(data.metas, [...data.shared, ...data.private], 'pack').map((group) => group.name).filter(Boolean);
    const openBase = item.private ? undefined : space.store?.serverVersion?.('pack', item.id);
    track(openItemDialog({ item, lists, bags: data.bagTracking ? data.bags : null, people: data.people, canEdit: data.canEdit, canPrivate: data.canPrivate,
      onSave: (values) => saveItem(item, values, openBase) }));
  }

  async function saveItem(item, values, openBase) {
    const listOps = values.vis !== 'private' ? await ensureList(values.list) : [];
    const sameList = model.normName(values.list) === model.normName(item.list);
    const order = sameList ? item.order : model.appendOrders(allIn(model.normName(values.list)), 1).keys[0];
    const base = { name: values.name, order, ...(values.qty > 1 ? { qty: values.qty } : {}), ...(values.list ? { list: values.list } : {}),
      ...(values.grams > 0 ? { grams: values.grams } : {}), ...(values.bagId ? { bagId: values.bagId } : {}) };
    if (item.private && values.vis === 'private') return attempt(() => priv().put({ ...base, ...(item.done ? { done: true } : {}) }, item.id));
    if (item.private) {
      const fields = { ...base, owner: uid, ...(values.vis === 'people' ? { vis: 'people', for: values.for } : {}) };
      if (item.done) Object.assign(fields, data.perPerson ? { doneBy: { [uid]: true } } : { done: true });
      if (await write([...listOps, space.ops.create('pack', fields)], t('lists.historyEdit'))) await attempt(() => priv().remove(item.id));
      return true;
    }
    if (values.vis === 'private') {
      if (await attempt(() => priv().put({ ...base, ...(stateOf(item).done ? { done: true } : {}) }))) await write([space.ops.remove('pack', item.id)]);
      return true;
    }
    const set = {};
    const unset = [];
    const assign = (field, value) => {
      const empty = value === undefined || value === null || value === '';
      if (empty) { if (item[field] !== undefined) unset.push(field); } else if (JSON.stringify(item[field]) !== JSON.stringify(value)) set[field] = value;
    };
    assign('name', values.name);
    assign('qty', values.qty > 1 ? values.qty : undefined);
    assign('list', values.list || undefined);
    assign('order', order);
    assign('grams', values.grams > 0 ? values.grams : undefined);
    if (data.bagTracking) assign('bagId', values.bagId || undefined);
    assign('vis', values.vis === 'people' ? 'people' : undefined);
    assign('for', values.vis === 'people' ? values.for : undefined);
    if (!Object.keys(set).length && !unset.length && !listOps.length) return true;
    const ops = [...listOps];
    if (Object.keys(set).length || unset.length) {
      const op = space.ops.patch('pack', item.id, { set, unset }, { base: true });
      // Fields someone else changed since the dialog opened get a conflict instead of a silent overwrite.
      const current = space.get('pack', item.id);
      if (openBase && current && [...Object.keys(set), ...unset].some((field) => JSON.stringify(current[field]) !== JSON.stringify(item[field]))) op.base = openBase;
      ops.push(op);
    }
    return write(ops, t('lists.historyEdit'));
  }

  // Lists

  async function addList() {
    const value = await promptDialog({ title: t('lists.addListTitle'), label: t('lists.listName'), confirmLabel: t('lists.add') });
    const name = model.cleanName(value);
    if (!name) return;
    if (data.metas.some((meta) => meta.kind === 'pack' && model.normName(meta.name) === model.normName(name))) { toast(t('lists.listExists', { name })); return; }
    await write(await ensureList(name), t('lists.historyAddList'));
  }

  /** Menu items for a list header; empty when the member can do nothing with it. */
  function groupActions(anchor, group, { manage, privateOnly, mine }) {
    const inView = group.items;
    const checkable = inView.filter((item) => (item.private ? data.canPrivate : data.perPerson ? stateOf(item).relevant : data.canEdit));
    const items = [];
    if (group.key && manage) items.push({ label: t('lists.rename'), icon: 'pencil', onSelect: () => renameList(group) });
    if (group.key && data.canEdit) {
      items.push({ label: t('lists.color'), onSelect: () => colorMenu(anchor, group) });
      items.push({ label: t('lists.assignees'), icon: 'users', onSelect: () => editAssignees(group) });
    }
    if (checkable.length) {
      if (items.length) items.push({ separator: true });
      items.push({ label: t('lists.checkAll'), icon: 'check', onSelect: () => checkAll(checkable, true) });
      items.push({ label: t('lists.uncheckAll'), onSelect: () => checkAll(checkable, false) });
    }
    const deletable = (!mine && data.canEdit && (group.meta || group.items.some((item) => !item.private))) || (mine && privateOnly);
    if (deletable) items.push({ separator: true }, { label: t('lists.deleteList'), icon: 'trash', danger: true, onSelect: () => deleteList(group, { mine }) });
    return items[0]?.separator ? items.slice(1) : items;
  }

  function colorMenu(anchor, group) {
    const current = group.meta?.color;
    openMenu(anchor, model.COLORS.map((color) => ({ label: colorName(color), checked: current === color, onSelect: async () => {
      if (group.meta) await write([space.ops.patch('listMeta', group.meta.id, { set: { color } })], t('lists.historyEdit'));
      else {
        const [create] = await ensureList(group.name);
        if (create) { create.put.color = color; await write([create], t('lists.historyEdit')); }
      }
    } })));
  }

  function editAssignees(group) {
    track(openAssigneesDialog({ title: t('lists.assigneesTitle', { name: group.name }), people: data.people, selected: group.meta?.assignees ?? [], onSave: async (ids) => {
      if (group.meta) return write([ids.length ? space.ops.patch('listMeta', group.meta.id, { set: { assignees: ids } }) : space.ops.patch('listMeta', group.meta.id, { unset: ['assignees'] })], t('lists.historyEdit'));
      const [create] = await ensureList(group.name);
      if (create && ids.length) create.put.assignees = ids;
      return write(create ? [create] : [], t('lists.historyEdit'));
    } }));
  }

  async function renameList(group) {
    const value = await promptDialog({ title: t('lists.renameTitle', { name: group.name }), label: t('lists.listName'), value: group.name, confirmLabel: t('lists.rename') });
    const name = model.cleanName(value);
    if (!name || name === group.name) return;
    const target = data.metas.find((meta) => meta.kind === 'pack' && model.normName(meta.name) === model.normName(name) && meta.id !== group.meta?.id);
    const finalName = target ? model.cleanName(target.name) : name;
    const ops = [];
    if (data.canEdit) {
      for (const item of data.shared.filter((entry) => model.normName(entry.list) === group.key)) ops.push(space.ops.patch('pack', item.id, { set: { list: finalName } }));
      for (const meta of [group.meta, ...group.dupes].filter(Boolean)) {
        ops.push(target || meta !== group.meta ? space.ops.remove('listMeta', meta.id) : space.ops.patch('listMeta', meta.id, { set: { name: finalName } }));
      }
    }
    await write(ops, t('lists.historyRename'));
    const own = data.private.filter((entry) => model.normName(entry.list) === group.key);
    if (own.length) await attempt(async () => { for (const item of own) await priv().put({ ...privateFields(item), list: finalName }, item.id); });
  }

  async function checkAll(items, value) {
    const ops = [];
    const own = [];
    for (const item of items) {
      if (stateOf(item).done === value) continue;
      if (item.private) own.push(item);
      else if (data.perPerson) ops.push(value ? space.ops.patch('pack', item.id, { set: { [`doneBy.${uid}`]: true } }) : space.ops.patch('pack', item.id, { unset: [`doneBy.${uid}`] }));
      else ops.push(space.ops.patch('pack', item.id, { set: { done: value } }));
    }
    await write(ops, t(value ? 'lists.historyCheckAll' : 'lists.historyUncheckAll'));
    if (own.length) await attempt(async () => {
      for (const item of own) {
        const fields = privateFields(item);
        if (value) fields.done = true; else delete fields.done;
        await priv().put(fields, item.id);
      }
    });
  }

  async function deleteList(group, { mine }) {
    const shared = mine ? [] : data.shared.filter((item) => model.normName(item.list) === group.key);
    const own = mine ? group.items.filter((item) => item.private) : [];
    const count = shared.length + own.length;
    const confirmed = await confirmDialog({ title: t('lists.deleteListTitle', { name: group.name || t('lists.noList') }),
      body: count ? plural(count, 'lists.deleteListBodyOne', 'lists.deleteListBodyOther') : t('lists.deleteListEmpty'), confirmLabel: t('lists.delete'), danger: true });
    if (!confirmed) return;
    const ops = [...[group.meta, ...group.dupes].filter(Boolean).map((meta) => space.ops.remove('listMeta', meta.id)), ...shared.map((item) => space.ops.remove('pack', item.id))];
    await write(ops);
    if (own.length) await attempt(async () => { for (const item of own) await priv().remove(item.id); });
  }

  // Bags

  function editBag(bag) {
    track(openBagDialog({ bag, people: data.people, onSave: async (values) => {
      if (bag) {
        const set = {}; const unset = [];
        for (const [field, value] of Object.entries(values)) {
          const empty = value === undefined || value === null || (Array.isArray(value) && !value.length);
          if (empty) { if (bag[field] !== undefined) unset.push(field); } else if (JSON.stringify(bag[field]) !== JSON.stringify(value)) set[field] = value;
        }
        return write(Object.keys(set).length || unset.length ? [space.ops.patch('bag', bag.id, { set, unset })] : [], t('lists.historyEdit'));
      }
      const { keys } = model.appendOrders(data.bags, 1);
      const fields = { name: values.name, order: keys[0], color: values.color ?? model.nextColor(data.bags.map((entry) => entry.color)) };
      if (values.limitGrams > 0) fields.limitGrams = values.limitGrams;
      if (values.people?.length) fields.people = values.people;
      return write([space.ops.create('bag', fields)], t('lists.historyAddBag'));
    } }));
  }

  async function deleteBag(bag) {
    const inside = data.shared.filter((item) => item.bagId === bag.id);
    const own = data.private.filter((item) => item.bagId === bag.id);
    const confirmed = await confirmDialog({ title: t('lists.deleteBagTitle', { name: bag.name }), body: t('lists.deleteBagBody'), confirmLabel: t('lists.delete'), danger: true });
    if (!confirmed) return;
    if (state.packBag === bag.id) { state.packBag = null; save(); }
    await write([space.ops.remove('bag', bag.id), ...inside.map((item) => space.ops.patch('pack', item.id, { unset: ['bagId'] }))]);
    if (own.length) await attempt(async () => { for (const item of own) { const fields = privateFields(item); delete fields.bagId; await priv().put(fields, item.id); } });
  }

  // Menus and dialogs

  function itemMenu(anchor, item) {
    const editable = canPatch(item);
    const items = [];
    if (editable) items.push({ label: t('lists.edit'), icon: 'pencil', onSelect: () => editItem(item) });
    if (!item.private) {
      const mine = item.bring?.[uid];
      items.push({ label: t('lists.bringYes'), checked: mine === 'yes', onSelect: () => pledge(item, mine === 'yes' ? null : 'yes') });
      items.push({ label: t('lists.bringMaybe'), checked: mine === 'maybe', onSelect: () => pledge(item, mine === 'maybe' ? null : 'maybe') });
      if (data.canPrivate) items.push({ label: t('lists.copyToMine'), icon: 'copy', onSelect: () => copyToMine(item) });
    }
    if (data.bagTracking && editable && data.bags.length) {
      items.push({ separator: true });
      for (const bag of data.bags) items.push({ label: t('lists.inBag', { name: bag.name }), checked: item.bagId === bag.id, onSelect: () => moveToBag(item, item.bagId === bag.id ? null : bag.id) });
    }
    if (item.private && data.canEdit) items.push({ separator: true }, { label: t('lists.shareItem'), icon: 'users', onSelect: () => shareItem(item) });
    if (!item.private && data.canEdit && data.canPrivate) items.push({ separator: true }, { label: t('lists.makePrivate'), onSelect: () => makePrivate(item) });
    if (editable) items.push({ separator: true }, { label: t('lists.delete'), icon: 'trash', danger: true, onSelect: () => removeItem(item) });
    openMenu(anchor, items);
  }

  function moreMenu() {
    const items = [
      { label: t('lists.saveTemplate'), icon: 'file', onSelect: () => saveTemplate() },
    ];
    if (data?.canTrip) {
      items.push({ separator: true });
      items.push({ label: t('lists.perPerson'), checked: data.perPerson, onSelect: (value) => setSetting('perPersonPacking', value) });
      items.push({ label: t('lists.bagTracking'), checked: data.bagTracking, onSelect: (value) => setSetting('bagTracking', value) });
    }
    openMenu(moreButton, items);
  }

  function setSetting(key, value) {
    return write([space.ops.patch('meta', 'meta', { set: { [`settings.${key}`]: value } })], t('lists.historySettings'));
  }

  function openImport(section) {
    track(openImportDialog({ kind: 'pack', section, ctx, canEdit: data.canEdit, canPrivate: data.canPrivate, bagTracking: data.bagTracking, onImport: importRows }));
  }

  async function importRows(rows, { asPrivate }) {
    const items = [...data.shared, ...data.private];
    const plan = model.planImport(rows, { kind: 'pack', metas: data.metas, items, bags: data.bags, makeId: newId, withBags: data.bagTracking, createBags: !asPrivate && data.canEdit });
    if (!plan.items.length) return false;
    await applyMoves(plan.moves);
    if (asPrivate) {
      const ok = await attempt(async () => { for (const fields of plan.items) await priv().put(fields); });
      if (ok) toast(plural(plan.items.length, 'lists.importedOne', 'lists.importedOther'));
      return ok;
    }
    const ops = [
      ...plan.lists.map((list) => space.ops.create('listMeta', list)),
      ...plan.bags.map(({ id, ...bag }) => space.ops.create('bag', bag, { id })),
      ...plan.items.map((fields) => {
        const value = { ...fields, owner: uid };
        if (data.perPerson && value.done) { delete value.done; value.doneBy = { [uid]: true }; }
        return space.ops.create('pack', value);
      }),
    ];
    const ok = await write(ops, t('lists.historyImport'));
    if (ok) toast(plural(plan.items.length, 'lists.importedOne', 'lists.importedOther'));
    return ok;
  }

  function saveTemplate() {
    const mine = state.packView === 'mine';
    const scope = (value) => {
      const items = value === 'mine' ? [...data.shared.filter((item) => model.inMyList(item, uid, data.assignees)), ...data.private] : data.shared;
      return model.groupLists(data.metas, items, 'pack');
    };
    track(openSaveTemplateDialog({ kind: 'pack', ctx, scopes: [{ value: 'shared', label: t('lists.viewShared') }, { value: 'mine', label: t('lists.viewMine') }],
      scope: mine ? 'mine' : 'shared', groupsFor: scope, defaultName: t('lists.templateDefaultPack', { trip: data.meta?.title ?? '' }).trim() }));
  }

  render.request();
  return {
    refresh: () => render.request(),
    openImport,
    destroy() {
      render.stop();
      for (const sortable of sortables) sortable.destroy();
      for (const dialog of [...dialogs]) dialog.close?.('navigation');
    },
  };
}
