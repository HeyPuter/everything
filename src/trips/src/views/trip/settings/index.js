// The trip "settings" tab: details, cover, dates, tags, reminders, add-ons and the trip's lifecycle actions.
import './settings.css';
import { el } from '../../../ui/dom.js';
import { button, chip, skeleton } from '../../../ui/bits.js';
import { switchField } from '../../../ui/fields.js';
import { confirmDialog } from '../../../ui/modal.js';
import { markdown } from '../../../ui/md.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { routeHash } from '../../../lib/router.js';
import { coverURL } from './cover.js';
import { confirmDelete, confirmLeave, openCopyDialog, openTripForm } from './dialogs.js';
import { deleteTrip, errorKey, leaveTrip, patchMeta } from './actions.js';
import { countText, currencyName, dayTotal, isDated, reminderLabel, tripDates } from './meta.js';
import './redate.js';
import { openTripExport, openTripImport } from '../../io/entry.js';

export function mount(container, context) {
  const { space, session, puter, app, signal } = context;
  const ref = space.ref;
  let drawn = '';
  const root = el('div.trip-settings');
  container.replaceChildren(root);

  async function run(control, action, { success } = {}) {
    control?.setAttribute('aria-busy', 'true');
    try { await action(); if (success) toast(t(success)); }
    catch (error) { toast(t(errorKey(error))); }
    finally { control?.setAttribute('aria-busy', 'false'); }
  }
  function detail(label, value) { return value ? el('div.trip-detail', {}, el('dt', {}, label), el('dd', {}, value)) : null; }
  /** Road trip mode: the same switch as the road view's own on/off. */
  function addons(meta, canEdit) {
    const on = meta.settings?.addons?.roadtrip === true;
    const hintId = `trip-addon-road-${ref.s}`;
    const row = switchField(t('trip.addonRoadtrip'), { checked: on, disabled: !canEdit, onChange: (next) => void setRoadTrip(next, control) });
    const control = row.querySelector('[role=switch]');
    control.setAttribute('aria-describedby', hintId);
    return el('section.trip-settings-section', {}, el('h3', {}, t('trip.addons')),
      el('div.trip-addons', {}, row, el('p.field-hint', { id: hintId }, t('trip.addonRoadtripHint'))));
  }
  async function setRoadTrip(on, control) {
    const revert = () => control.setAttribute('aria-checked', String(!on));
    if (!on && !(await confirmDialog({ title: t('road.mode.offTitle'), body: t('road.mode.offBody'), confirmLabel: t('road.mode.off') }))) { revert(); return; }
    control.setAttribute('aria-busy', 'true');
    try {
      const { createRoadOps } = await import('../road/ops.js');
      await createRoadOps(space).setMode(on);
    } catch (error) { revert(); toast(t(errorKey(error))); }
    finally { control.setAttribute('aria-busy', 'false'); }
  }
  async function coverNode(meta) {
    const src = await coverURL(meta.cover, { session, puter, ref, space });
    return src ? el('figure.trip-settings-cover', {}, el('img', { src, alt: '', referrerPolicy: 'no-referrer' }),
      meta.cover?.credit ? el('figcaption', {}, t('trip.coverCredit', { credit: meta.cover.credit })) : null) : null;
  }

  async function draw() {
    const meta = space.get('meta', 'meta');
    const signature = JSON.stringify([meta, space.role, space.state.sync === 'forbidden']);
    if (signature === drawn) return;
    drawn = signature;
    if (!meta) {
      root.replaceChildren(el('div.trip-settings-loading', { 'aria-busy': 'true' }, skeleton('60%'), skeleton('40%'), skeleton('80%')));
      return;
    }
    const canEdit = space.can('trip.edit');
    const owner = space.role === 'owner';
    const header = el('header.trip-settings-head', {},
      el('div', {}, el('h2', {}, meta.title), el('p.trip-settings-dates', {}, isDated(meta) ? `${tripDates(meta)} · ${countText('trip.dayTotal', dayTotal(meta))}` : tripDates(meta))),
      canEdit ? button(t('trip.edit'), { icon: 'pencil', onclick: () => openTripForm({ session, puter, space }) }) : null);
    const details = el('dl.trip-details', {},
      detail(t('trip.currency'), currencyName(meta.currency)),
      detail(t('trip.tags'), meta.tags?.length ? el('div.tag-list', {}, meta.tags.map((tag) => chip(tag))) : null),
      detail(t('trip.reminders'), meta.reminderDays?.length ? meta.reminderDays.map(reminderLabel).join(', ') : null),
      detail(t('trip.status'), meta.archived ? t('trip.archived') : null));
    const description = meta.description?.trim() ? el('section.trip-settings-section', {}, el('h3', {}, t('trip.description')), markdown(meta.description)) : null;
    const actions = [];
    if (space.can('trip.archive')) {
      const archive = button(t(meta.archived ? 'trip.unarchive' : 'trip.archive'), { icon: 'file', onclick: () => run(archive, () => patchMeta(space, { archived: !meta.archived }), { success: meta.archived ? 'trip.unarchived' : 'trip.archivedDone' }) });
      actions.push(archive);
    }
    const copy = button(t('trip.copy'), { icon: 'copy', onclick: () => openCopyDialog({ session, ref, meta, onCopied: (next) => app.navigate(routeHash({ name: 'space', ref: next, tab: 'plan' })) }) });
    actions.push(copy);
    actions.push(button(t('trip.menuExport'), { onclick: () => void openTripExport(context) }));
    if (canEdit || space.can('plan.edit')) actions.push(button(t('trip.menuImport'), { onclick: () => void openTripImport(context) }));
    if (owner || meta.transfer) {
      actions.push(button(t('trip.transfer'), { icon: 'users', onclick: () => { import('../transfer/index.js').then((module) => module.openTransfer(context)).catch(() => toast(t('trip.actionFailed'))); } }));
    }
    if (!owner && space.role) {
      const leave = button(t('trip.leave'), { variant: 'danger', onclick: async () => {
        if (await confirmLeave(meta)) await run(leave, async () => { await leaveTrip(session, ref); app.navigate('#/'); });
      } });
      actions.push(leave);
    }
    if (space.can('trip.delete')) {
      const remove = button(t('trip.delete'), { icon: 'trash', variant: 'danger', onclick: async () => {
        if (await confirmDelete(meta)) await run(remove, async () => { await deleteTrip(session, ref); app.navigate('#/'); }, { success: 'trip.deleted' });
      } });
      actions.push(remove);
    }
    const cover = await coverNode(meta);
    if (space.get('meta', 'meta') !== meta) return;
    root.replaceChildren(...[
      cover,
      header,
      !canEdit ? el('p.trip-settings-note', { role: 'note' }, t(space.role === 'viewer' ? 'trip.viewerNote' : 'trip.readOnlyNote')) : null,
      details,
      description,
      addons(meta, canEdit),
      el('section.trip-settings-section', {}, el('h3', {}, t('trip.actions')), el('div.trip-settings-actions', {}, actions)),
    ].filter(Boolean));
  }
  const offs = [space.subscribe('meta', () => void draw()), space.onState(() => void draw())];
  void draw();
  signal.addEventListener('abort', () => offs.forEach((off) => off()), { once: true });
  return () => offs.forEach((off) => off());
}
