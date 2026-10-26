// `#/j/<worker>/<space>/<tab>`: one journey with its timeline, map, gallery and stats.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton, emptyState, spinner } from '../../ui/bits.js';
import { tabs } from '../../ui/tabs.js';
import { openMenu } from '../../ui/menu.js';
import { openModal, confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { openConflictDialog } from '../../ui/conflict.js';
import { t, strings } from '../../lib/i18n/index.js';
import { formatDateRange, formatNumber } from '../../lib/format.js';
import { coverUrl } from '../../lib/files/index.js';
import { openPreview } from '../../lib/files/ui.js';
import { can } from '../../shared/perms.js';
import { roleIn } from '../trip/members/logic.js';
import { presenceStack } from '../trip/members/people.js';
import { icon } from './icons.js';
import { openingDate, writtenEntries } from './model.js';
import { JOURNEY_TABS, tabFor } from './tabs.js';
import { entryCard, mountTimeline } from './timeline.js';
import { openEntryEditor } from './editor.js';
import { openCapture } from './capture.js';
import { openSharing } from './sharing.js';
import { metaPatch, openMetaForm } from './metaform.js';
import { openLinkedTrips, refreshSuggestions, tripTitle } from './trips.js';
import { deleteJourney, errorText, journeyHash, openJourney, personalOf, today, tripChoices, uidOf } from './spaces.js';

const label = (key, fallback) => (Object.hasOwn(strings, key) ? t(key) : fallback);
const storageKey = (sid) => `trips:journey:${sid}`;
const refreshed = new Set();
function readLocal(sid) {
  try { const value = JSON.parse(localStorage.getItem(storageKey(sid)) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
function writeLocal(sid, value) { try { localStorage.setItem(storageKey(sid), JSON.stringify(value)); } catch { /* storage may be off */ } }
const pendingCount = (state) => (Array.isArray(state?.pending) ? state.pending.length : Number(state?.pending) || 0);

export async function mountJourney(container, context) {
  const ref = context.route?.ref ?? context.ref;
  if (!ref || ref.k !== 'journey' || !context.session?.api) {
    container.replaceChildren(emptyState({ title: t('journey.title'), body: t('journey.unavailable'), icon: 'pin' }));
    return undefined;
  }
  container.replaceChildren(el('p.jr-loading', { role: 'status' }, spinner(), t('journey.loading')));
  let view = null;
  let opened;
  try {
    opened = await openJourney(context, ref, { onError: (error) => view?.onError(error), onFlush: (result) => view?.onFlush(result) });
  } catch (error) {
    if (context.signal?.aborted) return undefined;
    container.replaceChildren(emptyState({ title: t('journey.loadFailed'), body: errorText(error), icon: 'warning',
      action: button(t('journey.back'), { variant: 'primary', onclick: () => context.app?.navigate('#/journeys') }) }));
    return undefined;
  }
  if (context.signal?.aborted) { opened.close(); return undefined; }
  view = journeyView(container, { ...context, ref, space: opened.space, owned: opened.owned });
  return () => { view.destroy(); opened.close(); };
}

function journeyView(container, context) {
  const { space, ref, app, owned } = context;
  const me = uidOf(context);
  const personal = personalOf(context);
  const local = readLocal(ref.s);
  const ui = { query: '', hideSuggestions: local.hideSuggestions === true, showDismissed: false, newestFirst: local.newestFirst === true };
  const offs = [];
  const panes = new Map();
  let tab = tabFor(context.route?.tab);
  let choices = [];
  let frame = 0;
  let destroyed = false;
  let indexedTitle = null;
  let coverKey = null;

  const role = () => roleIn(space, me);
  const canEdit = () => can(role(), 'plan.edit');
  const canMeta = () => can(role(), 'trip.edit');
  const meta = () => space.get('meta', 'meta') ?? {};
  const name = () => meta().title || t('journey.untitled');
  const todayDate = today();

  // ---- DOM
  const titleId = uid('jr-title');
  const cover = el('img.jr-cover', { alt: '', hidden: true, decoding: 'async' });
  const heading = el('h2.jr-title', { id: titleId, tabIndex: -1 });
  const sub = el('p.jr-sub');
  const facts = el('p.jr-facts');
  const people = el('div.jr-people');
  const addButton = button(t('journey.addEntry'), { icon: 'plus', variant: 'primary', size: 'sm', onclick: () => edit(null) });
  const captureButton = button(t('journey.capture'), { variant: 'outline', size: 'sm', onclick: () => capture() });
  captureButton.prepend(icon('camera', 16));
  const shareButton = button(t('journey.share'), { variant: 'outline', size: 'sm', onclick: () => openSharing({ space, context, ref, onLeft: () => app?.navigate('#/journeys') }) });
  shareButton.prepend(icon('share', 16));
  const moreButton = iconButton('more', t('journey.moreActions'), { onclick: () => moreMenu(moreButton) });
  const issue = el('div.jr-issue', { hidden: true });
  const searchInput = el('input.input', { type: 'search', placeholder: t('journey.searchPlaceholder'), 'aria-label': t('journey.search'), autocomplete: 'off',
    oninput: () => { ui.query = searchInput.value; schedule(); } });
  const jumpId = uid('jr-jump');
  const jumpInput = el('input.input.jr-jump', { id: jumpId, type: 'date', onchange: () => { if (jumpInput.value) panes.get('timeline')?.jump(jumpInput.value); } });
  const todayButton = button(t('journey.today'), { size: 'sm', variant: 'ghost', onclick: () => panes.get('timeline')?.jump(openingDate(writtenEntries(space.select.entry.all()).map((entry) => entry.date), todayDate) ?? todayDate) });
  const viewButton = button(t('journey.viewOptions'), { size: 'sm', variant: 'outline', onclick: () => viewMenu(viewButton) });
  const toolbar = el('div.jr-toolbar', {},
    el('div.input-prefix.jr-search', {}, icon('search'), searchInput),
    el('div.jr-row', {}, el('label.sr-only', { htmlFor: jumpId }, t('journey.jumpTo')), jumpInput, todayButton), viewButton);
  const fab = el('button.jr-fab', { type: 'button', 'aria-label': t('journey.capture'), onclick: () => capture() }, icon('camera', 22));
  const live = el('div.sr-only', { 'aria-live': 'polite' });
  const items = JOURNEY_TABS.map((item) => ({ id: item.id, label: t(item.labelKey), content: el('div.jr-pane', { dataset: { pane: item.id } }) }));
  const tabSet = tabs({ label: t('journey.sections'), items, value: tab, onChange: (id) => switchTab(id) });
  [...tabSet.element.querySelectorAll('.tab')].forEach((node, index) => node.prepend(icon(JOURNEY_TABS[index].icon, 16)));
  const root = el('section.jr-view', { 'aria-labelledby': titleId },
    el('header.jr-hero', {}, cover,
      el('div.jr-hero-text', {},
        el('a.icon-btn.jr-back', { href: '#/journeys', 'aria-label': t('journey.back'), title: t('journey.back') }, icon('arrowLeft')),
        el('div.jr-title-block', {}, heading, sub, facts, people),
        el('div.jr-head-actions', {}, addButton, captureButton, shareButton, moreButton))),
    issue, toolbar, tabSet.element, fab, live);
  container.replaceChildren(root);

  // ---- header and banners
  function renderHead() {
    const data = meta();
    heading.textContent = name();
    sub.textContent = data.subtitle ?? '';
    sub.hidden = !data.subtitle;
    const written = writtenEntries(space.select.entry.all());
    const parts = [];
    if (data.status) parts.push(t(`journey.status.${data.status}`));
    if (written.length) parts.push(formatDateRange(written[0].date, written.at(-1).date), t('journey.entryCount', { count: formatNumber(written.length) }));
    if (role() && role() !== 'owner') parts.push(t(role() === 'editor' ? 'journey.roleEditor' : 'journey.roleViewer'));
    facts.textContent = parts.filter(Boolean).join(' · ');
    addButton.hidden = !canEdit();
    captureButton.hidden = !canEdit();
    fab.hidden = !canEdit();
    jumpInput.min = written[0]?.date ?? '';
    jumpInput.max = written.at(-1)?.date ?? '';
    const key = typeof data.cover === 'string' ? data.cover : data.cover?.url ?? '';
    if (key !== coverKey) {
      coverKey = key;
      cover.hidden = true;
      cover.referrerPolicy = 'no-referrer';
      if (key) void coverUrl(space, data.cover).then((src) => { if (src && !destroyed && coverKey === key) { cover.src = src; cover.hidden = false; } }).catch(() => {});
    }
    if (data.title && data.title !== indexedTitle) {
      indexedTitle = data.title;
      personal?.spaces.upsert({ ref, role: role() ?? 'viewer', title: data.title, opened: Date.now() }).catch(() => {});
    }
  }
  function renderIssue() {
    const state = space.state;
    const conflicts = space.conflicts();
    let content = null;
    if (state.issue === 'gone') {
      content = [el('span', {}, t('journey.issueGone')), button(t('journey.removeFromList'), { size: 'sm', variant: 'outline', onclick: async () => {
        await personal?.spaces.remove(ref).catch(() => {}); app?.navigate('#/journeys');
      } })];
    } else if (state.issue === 'outdated') content = [el('span', {}, t(state.skipped ? 'journey.issueReload' : 'journey.issueOutdated'))];
    else if (state.issue === 'credit') content = [el('span', {}, t('journey.issueCredit'))];
    else if (state.sync === 'offline') content = [el('span', {}, t('journey.issueOffline'))];
    else if (conflicts.length) content = [el('span', {}, t('journey.issueConflicts', { count: formatNumber(conflicts.length) })), button(t('journey.review'), { size: 'sm', variant: 'outline', onclick: () => reviewConflicts() })];
    issue.hidden = !content;
    issue.replaceChildren(...(content ? [icon('warning', 16), ...content] : []));
  }
  function reviewConflicts() {
    const conflict = space.conflicts()[0];
    if (!conflict) return;
    openConflictDialog({ conflict,
      typeLabel: (type) => label(`journey.typeLabel.${type}`, t('journey.typeLabel.other')),
      fieldLabel: (_type, field) => label(`journey.fieldLabel.${field}`, field),
      onResolve: async (choice) => { await space.resolveConflict(conflict.op.opId, choice); setTimeout(() => { if (!destroyed && space.conflicts().length) reviewConflicts(); }, 0); } });
  }

  // ---- panes
  const paneCtx = () => ({
    space, context, ui, today: todayDate, signal: context.signal,
    canEdit, onEdit: (entry) => edit(entry), onAdd: () => edit(null), onMedia: (fileId, ids) => openPreview(space, fileId, { ids }),
    onOpen: (entry) => open(entry), onEntry: (entry) => open(entry), tripTitle: (tripRef) => tripTitle(choices, tripRef),
    opening: (entries) => openingDate(entries.map((entry) => entry.date), todayDate),
  });
  async function mountPane(id) {
    if (panes.has(id) || destroyed) return;
    const node = items.find((item) => item.id === id)?.content;
    if (!node) return;
    panes.set(id, { render() {}, destroy() {} });
    const def = JOURNEY_TABS.find((item) => item.id === id);
    let pane;
    if (def?.load) {
      const module = await def.load();
      if (destroyed) return;
      const cleanup = await module.mount(node, { space, context, ref, signal: context.signal });
      pane = { render() {}, destroy: () => (typeof cleanup === 'function' ? cleanup() : undefined) };
    } else if (id === 'timeline') pane = mountTimeline(node, paneCtx());
    else if (id === 'map') pane = (await import('./map.js')).mountJourneyMap(node, paneCtx());
    else if (id === 'gallery') pane = (await import('./gallery.js')).mountGallery(node, paneCtx());
    else if (id === 'stats') pane = (await import('./stats.js')).mountStats(node, paneCtx());
    if (destroyed) { pane?.destroy(); return; }
    panes.set(id, pane);
  }
  function switchTab(id) {
    tab = tabFor(id);
    toolbar.hidden = tab !== 'timeline';
    void mountPane(tab).then(() => { panes.get(tab)?.render(); panes.get(tab)?.resize?.(); });
    // The tab lives in the address for reloads and links without remounting the page.
    try { globalThis.history?.replaceState(null, '', journeyHash(ref, tab)); } catch { /* sandboxed */ }
  }
  function schedule() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (destroyed) return;
      renderHead();
      panes.get(tab)?.render();
    });
  }

  // ---- actions
  function edit(entry) {
    if (!canEdit()) { if (entry) open(entry); return; }
    openEntryEditor({ space, context, entry, draft: entry ? {} : { date: todayDate }, onSaved: (id) => { live.textContent = t('journey.saved'); if (id && tab === 'map') panes.get('map')?.focus(id); } });
  }
  function open(entry) {
    if (canEdit() && entry.type === 'suggestion') { edit(entry); return; }
    const card = entryCard(space.get('entry', entry.id) ?? entry, { ...paneCtx(), canEdit: false });
    const actions = canEdit() ? [button(t('journey.edit'), { variant: 'primary', onclick: () => { dialog.close('edit'); edit(entry); } })] : [];
    const dialog = openModal({ title: entry.title, content: el('div.jr-entry-view', {}, card), actions, wide: true });
  }
  function capture() {
    if (!canEdit()) return;
    openCapture({ space, context, onSaved: () => { live.textContent = t('journey.saved'); } });
  }
  function viewMenu(anchor) {
    openMenu(anchor, [
      { label: t('journey.hideSuggestions'), checked: ui.hideSuggestions, onSelect: () => { ui.hideSuggestions = !ui.hideSuggestions; writeLocal(ref.s, { ...readLocal(ref.s), hideSuggestions: ui.hideSuggestions }); renderAll(); } },
      { label: t('journey.showDismissed'), checked: ui.showDismissed, onSelect: () => { ui.showDismissed = !ui.showDismissed; renderAll(); } },
      { label: t('journey.newestFirst'), checked: ui.newestFirst, onSelect: () => { ui.newestFirst = !ui.newestFirst; writeLocal(ref.s, { ...readLocal(ref.s), newestFirst: ui.newestFirst }); renderAll(); } },
    ]);
  }
  function renderAll() { for (const pane of panes.values()) pane.render(); }
  function moreMenu(anchor) {
    const owner = role() === 'owner';
    openMenu(anchor, [
      canMeta() && { label: t('journey.editJourney'), icon: 'pencil', onSelect: () => editMeta() },
      { label: t('journey.linkedTrips'), onSelect: () => openLinkedTrips({ space, context }) },
      canEdit() && (meta().trips ?? []).length > 0 && { label: t('journey.refreshSuggestions'), onSelect: () => void refreshSuggestions(context, space).catch((error) => toast(errorText(error))) },
      { label: t('journey.hideSuggestions'), checked: ui.hideSuggestions, onSelect: () => { ui.hideSuggestions = !ui.hideSuggestions; writeLocal(ref.s, { ...readLocal(ref.s), hideSuggestions: ui.hideSuggestions }); renderAll(); } },
      { separator: true },
      owner ? { label: t('journey.deleteJourney'), icon: 'trash', danger: true, onSelect: () => void remove() }
        : { label: t('journey.leave'), icon: 'trash', danger: true, onSelect: () => openSharing({ space, context, ref, onLeft: () => app?.navigate('#/journeys') }) },
    ].filter(Boolean));
  }
  function editMeta() {
    openMetaForm({ space, onSubmit: async (values) => {
      const patch = metaPatch(meta(), values);
      if (patch.set || patch.unset) await space.apply([space.ops.patch('meta', 'meta', patch)]);
    } });
  }
  async function remove() {
    const ok = await confirmDialog({ title: t('journey.deleteJourneyTitle', { name: name() }), body: t('journey.deleteJourneyBody'), confirmLabel: t('journey.deleteJourney'), danger: true });
    if (!ok || destroyed) return;
    try { await deleteJourney(context, ref); toast(t('journey.journeyDeleted', { name: name() })); app?.navigate('#/journeys'); } catch (error) { toast(errorText(error)); }
  }

  // ---- wiring
  offs.push(
    space.subscribe((event) => { if (!event.types?.has('presence')) schedule(); }),
    space.onState(() => { renderIssue(); if (owned) { const state = space.state; app?.setSyncState?.(state.sync, { pending: pendingCount(state) }); } }),
  );
  // The stack follows presence and member changes itself.
  const presence = presenceStack(space, { uid: me, puter: context.puter, max: 5, size: 26 });
  people.append(presence.element);
  offs.push(presence.destroy);
  renderHead(); renderIssue();
  toolbar.hidden = tab !== 'timeline';
  void mountPane(tab);
  if (owned) { const state = space.state; app?.setSyncState?.(state.sync, { pending: pendingCount(state) }); }
  void tripChoices(context).then((list) => { choices = list; if (!destroyed) panes.get('timeline')?.render(); }).catch(() => {});
  // Linked trips' new visits arrive as suggestions once per session.
  if (canEdit() && (meta().trips ?? []).length && !refreshed.has(ref.s) && globalThis.navigator?.onLine !== false) {
    refreshed.add(ref.s);
    void refreshSuggestions(context, space, { quiet: true }).catch(() => {});
  }

  return {
    onError() { renderIssue(); },
    onFlush(result) { if (result?.status === 'rejected') toast(t('journey.rejected')); renderIssue(); },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      for (const off of offs.splice(0)) off();
      for (const pane of panes.values()) { try { pane.destroy(); } catch { /* keep tearing down */ } }
      if (owned) app?.setSyncState?.('idle');
    },
  };
}
