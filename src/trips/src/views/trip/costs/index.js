import './costs.css';
import '../../../lib/costs/adapters.js';
import { el, append, clear } from '../../../ui/dom.js';
import { button, iconButton, spinner } from '../../../ui/bits.js';
import { tabs } from '../../../ui/tabs.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { openConflictDialog } from '../../../ui/conflict.js';
import { t } from '../../../lib/i18n/index.js';
import { saveBlob } from '../../../lib/download.js';
import { displayLocale, onPrefs } from '../../../lib/prefs.js';
import { summary } from '../../../lib/costs/ledger.js';
import { localToday, resolvePending } from '../../../lib/costs/fx.js';
import { costsRows, csvFileName, toCsv } from '../../../lib/costs/csv.js';
import { COST_TYPES, attempt, categoryLabel, createDisplay, createPeople, dialogTracker, money, readModel } from './shared.js';
import { openExpenseForm } from './form.js';
import { expenseFields, openExpenseDetail } from './detail.js';
import { createLedger } from './ledger.js';
import { createSettle, setSplitCosts } from './settle.js';
import { createOverview, openCategoryOrder } from './overview.js';
import { icon } from './icons.js';
import { canScan, scanReceipt } from './receipt/index.js';
import { openPresetManager } from './presets/index.js';
import { openAcrossDialog } from './extras/index.js';

const TAB_KEY = 'trips:costs:tab';
const WATCHED = new Set(['exp', 'settle', 'member', 'guest', 'meta', 'costCat', 'budget', 'file', 'res', 'place', 'visit', 'cat']);

/** Trip tab entry (src/lib/README.md "Adding a module"). */
export async function mount(container, context) {
  const { space, session, signal } = context;
  const me = context.account.uuid;
  const track = dialogTracker(signal);
  const people = createPeople({ space, me });
  let cached = null;
  const getModel = () => (cached ??= readModel(space, me));
  let active = 'expenses';
  try { active = ['expenses', 'balances', 'overview'].includes(globalThis.localStorage?.getItem(TAB_KEY)) ? globalThis.localStorage.getItem(TAB_KEY) : 'expenses'; } catch { active = 'expenses'; }
  let failedPrivate = [];

  const openForm = (extra = {}) => openExpenseForm({ space, model: getModel(), people, session, track, ...extra });
  const openDetail = (entity) => openExpenseDetail({ space, model: getModel, people, track, id: entity.id, priv: Boolean(entity.private),
    onEdit: (expense) => openForm({ expense }), onCopy: (copy) => openForm({ copy }),
    openAcross: session?.api ? (expense) => openAcrossDialog({ space, session, personal: session.personal ?? context.personal, puter: context.puter, people, track, id: expense.id }) : null });

  const ledger = createLedger({ space, getModel, people, onOpen: openDetail, onAdd: () => openForm() });
  const settle = createSettle({ space, getModel, people, session, track });
  const display = createDisplay({ session, signal, onReady: () => { if (!signal?.aborted) { renderStats(); if (active === 'overview') overview.render(); } } });
  const overview = createOverview({ space, getModel, people, track, display });
  const banners = el('div.costs-banners');
  const stats = el('div.costs-stats', { role: 'group', 'aria-label': t('costs.summary') });
  const addButton = button(t('costs.addExpense'), { variant: 'primary', icon: 'plus', dataset: { focus: 'add' }, onclick: () => openForm() });
  const moreButton = iconButton('more', t('costs.more'), { dataset: { focus: 'more' }, onclick: () => openMore(moreButton) });
  const scanButton = canScan(context.puter) ? button(t('receipt.scan'), { variant: 'outline', dataset: { focus: 'scan' },
    onclick: () => scanReceipt({ space, getModel, people, session, puter: context.puter, track, openForm }) }) : null;
  scanButton?.prepend(icon('receipt'));
  const tabset = tabs({ label: t('costs.sections'), value: active, items: [
    { id: 'expenses', label: t('costs.tabExpenses'), icon: 'file', content: ledger.element },
    { id: 'balances', label: t('costs.tabBalances'), icon: 'users', content: settle.element },
    { id: 'overview', label: t('costs.tabOverview'), icon: 'wallet', content: overview.element },
  ], onChange: (id) => {
    active = id;
    try { globalThis.localStorage?.setItem(TAB_KEY, id); } catch { /* Per-device preference. */ }
    renderActive();
  } });
  container.replaceChildren(el('div.costs', {}, banners, stats, el('div.costs-toolbar', {}, addButton, scanButton, moreButton), tabset.element));

  let refreshing = null;
  function refreshRates({ quiet = false } = {}) {
    refreshing ??= (async () => {
      const model = getModel();
      const fx = session?.services?.fx;
      const waiting = (entity) => entity.currency !== model.tripCurrency && typeof entity.rate !== 'string';
      const candidates = [
        ...(model.canEdit ? model.shared.filter(waiting).map((entity) => ({ type: 'exp', entity })) : []),
        ...(model.canEdit ? model.settlements.filter(waiting).map((entity) => ({ type: 'settle', entity })) : []),
        ...model.privates.filter(waiting).map((entity) => ({ type: 'private', entity })),
      ];
      if (!candidates.length) { if (!quiet) toast(t('costs.noPendingRates')); return; }
      const resolved = await resolvePending({ fx, tripCurrency: model.tripCurrency, signal,
        entities: candidates.map((candidate) => ({ currency: candidate.entity.currency, rate: candidate.entity.rate, date: candidate.entity.date, candidate })) });
      if (signal?.aborted) return;
      const ops = resolved.filter(({ entity }) => entity.candidate.type !== 'private')
        .map(({ entity, rate }) => space.ops.patch(entity.candidate.type, entity.candidate.entity.id, { set: { rate } }));
      const ok = await attempt(async () => {
        if (ops.length) await space.apply(ops);
        for (const { entity, rate } of resolved.filter((item) => item.entity.candidate.type === 'private')) {
          await space.privateItems('exp').put({ ...expenseFields(entity.candidate.entity), rate }, entity.candidate.entity.id);
        }
        return true;
      });
      if (!ok) return;
      if (resolved.length < candidates.length) { if (!quiet) toast(t('costs.ratesMissing', { count: candidates.length - resolved.length })); }
      else if (resolved.length) toast(t('costs.ratesFixed', { count: resolved.length }));
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  function exportCsv() {
    const model = getModel();
    const ids = [...new Set([...people.list.map((person) => person.id), ...model.balances.people.keys()])];
    const rows = costsRows({ expenses: model.shared, privateExpenses: model.privates, settlements: model.settlements, tripCurrency: model.tripCurrency,
      people: ids, name: (who) => people.name(who, { you: false }), category: (id) => categoryLabel(id, space), label: (key) => t(`costs.csv.${key}`), locale: displayLocale() });
    saveBlob(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), csvFileName(model.meta.title, localToday()));
  }

  function openMore(anchor) {
    const model = getModel();
    const pending = model.balances.pending.expenses.length + model.balances.pending.settlements.length + model.personal.pending.length;
    openMenu(anchor, [
      { label: t('costs.exportCsv'), icon: 'file', onSelect: exportCsv },
      { label: t('costs.refreshRates'), icon: 'clock', disabled: !pending, onSelect: () => refreshRates() },
      ...(model.canEdit ? [{ label: t('costs.reorderCategories'), icon: 'menu', onSelect: () => openCategoryOrder({ space, model, track }) }] : []),
      ...(model.canEdit ? [{ label: t('presets.menu'), icon: 'users', onSelect: () => openPresetManager({ space, people, track }) }] : []),
      ...(model.canTrip ? [{ separator: true }, { label: t('costs.splitSwitch'), checked: model.splitCosts, onSelect: (value) => setSplitCosts(space, value) }] : []),
    ]);
  }

  function costConflicts() {
    return space.conflicts().filter((conflict) => COST_TYPES.has(conflict.op.t) || conflict.op.do === 'costs.settleAll');
  }
  function reviewConflict() {
    const [conflict] = costConflicts();
    if (!conflict) return;
    track(openConflictDialog({ conflict,
      typeLabel: (type) => t(type === 'settle' ? 'costs.typeSettle' : type === 'costCat' ? 'costs.typeCategory' : 'costs.typeExpense'),
      fieldLabel: (_type, field) => t(`costs.field.${field}`) === `costs.field.${field}` ? field : t(`costs.field.${field}`),
      onResolve: (choice) => space.resolveConflict(conflict.op.opId, choice) }));
  }

  function banner(kind, message, action) {
    return el(`div.costs-banner.is-${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'info' ? 'lock' : 'warning', 16), el('span', {}, message), action);
  }
  function renderBanners() {
    const model = getModel();
    const state = space.state ?? {};
    const pending = model.balances.pending.expenses.length + model.balances.pending.settlements.length + model.personal.pending.length;
    const conflicts = costConflicts().length;
    const loading = state.rev === 0 && ['idle', 'syncing'].includes(state.sync) && !model.shared.length && !model.settlements.length;
    append(clear(banners), [
      loading ? el('div.costs-banner', { role: 'status' }, spinner(), el('span', {}, t('costs.loading'))) : null,
      state.sync === 'offline' ? banner('warn', t('costs.bannerOffline')) : null,
      state.sync === 'credit' || state.issue === 'credit' ? banner('error', t('costs.bannerCredit')) : null,
      state.sync === 'forbidden' ? banner('error', t('costs.bannerForbidden')) : null,
      conflicts ? banner('error', t('costs.bannerConflicts', { count: conflicts }), button(t('costs.review'), { size: 'sm', variant: 'outline', onclick: reviewConflict })) : null,
      failedPrivate.length ? banner('error', t('costs.bannerPrivateFailed', { count: failedPrivate.length }), button(t('costs.dismiss'), { size: 'sm', variant: 'outline', onclick: async () => {
        for (const item of failedPrivate) await attempt(() => context.personal?.dismissFailed(item.qid));
        void loadFailed();
      } })) : null,
      pending ? banner('warn', t('costs.bannerPending', { count: pending }), button(t('costs.refreshRates'), { size: 'sm', variant: 'outline', dataset: { focus: 'rates' }, onclick: () => refreshRates() })) : null,
      !model.canEdit ? banner('info', t('costs.bannerViewer')) : null]);
  }
  async function loadFailed() {
    try {
      const key = `me:priv:${space.ref.s}:exp`;
      const list = ((await context.personal?.failedWrites?.()) ?? []).filter((item) => item.key === key);
      if (signal?.aborted || list.length === failedPrivate.length) return;
      failedPrivate = list;
      renderBanners();
    } catch { /* Failed-write list is advisory. */ }
  }

  function renderStats() {
    const model = getModel();
    const { tripCurrency } = model;
    display.sync(tripCurrency);
    const tile = (label, amount, hint) => el('div.stat', {}, el('span', {}, label), el('strong.num', {}, money(amount, tripCurrency)), amount ? display.approx(amount) : null, hint ? el('span.field-hint', {}, hint) : null);
    const totals = summary(model.balances, me);
    const privateHint = model.personal.total ? t('costs.plusPrivate', { amount: money(model.personal.total, tripCurrency) }) : null;
    stats.replaceChildren(...(model.splitCosts
      ? [tile(t('costs.youOwe'), totals.owe), tile(t('costs.youAreOwed'), totals.owed), tile(t('costs.outstanding'), totals.outstanding), tile(t('costs.totalSpend'), totals.spend, privateHint)]
      : [tile(t('costs.totalSpend'), totals.spend, privateHint)]));
  }

  function renderActive() {
    if (active === 'expenses') ledger.render();
    else if (active === 'balances') settle.render();
    else overview.render();
  }

  function render() {
    cached = null;
    people.refresh();
    const focused = container.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
    const model = getModel();
    addButton.replaceChildren(icon('plus'), model.canEdit ? t('costs.addExpense') : t('costs.addPrivate'));
    renderBanners();
    renderStats();
    renderActive();
    if (focused && !container.contains(document.activeElement)) container.querySelector(`[data-focus="${focused}"]`)?.focus();
    void loadFailed();
  }

  let scheduled = false;
  const schedule = () => {
    cached = null;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!signal?.aborted) render(); });
  };
  const offData = space.subscribe((event) => { if ([...event.types].some((type) => WATCHED.has(type))) schedule(); });
  const offState = space.onState?.(() => { if (!signal?.aborted) renderBanners(); }) ?? (() => {});
  const offPrefs = onPrefs(() => schedule());
  const online = () => { void refreshRates({ quiet: true }); };
  globalThis.addEventListener?.('online', online);

  render();
  if (globalThis.navigator?.onLine !== false) void refreshRates({ quiet: true });

  return () => {
    offData(); offState(); offPrefs();
    globalThis.removeEventListener?.('online', online);
    ledger.destroy();
  };
}
