// `#/journeys`: the member's journeys, newest first, and creating one (blank or from a trip).
import { el, uid } from '../../ui/dom.js';
import { button, emptyState, skeleton } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDateRange, formatNumber } from '../../lib/format.js';
import { coverUrl } from '../../lib/files/index.js';
import { icon } from './icons.js';
import { writtenEntries } from './model.js';
import { openMetaForm } from './metaform.js';
import { INTENT_KEY, readIntent } from './command.js';
import { createFromTrip, createJourney, deployProgress, errorText, journeyHash, listSpaces, peek, personalOf, sameRef, tripChoices } from './spaces.js';

const roleKey = { editor: 'journey.roleEditor', viewer: 'journey.roleViewer' };

/** Meta and entry counts from replicas (no network), four at a time. */
async function peekAll(context, entries) {
  const out = new Map();
  const queue = entries.slice(0, 60);
  async function next() {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const info = await peek(context, entry.ref, (space) => {
        const written = writtenEntries(space.select.entry.all());
        return { meta: space.get('meta', 'meta') ?? null, count: written.length, first: written[0]?.date ?? null, last: written.at(-1)?.date ?? null };
      }).catch(() => null);
      if (info) out.set(entry.ref.s, info);
    }
  }
  await Promise.all([next(), next(), next(), next()]);
  return out;
}

export function mountJourneys(container, context) {
  const { app } = context;
  const personal = personalOf(context);
  let entries = [];
  let info = new Map();
  let status = 'loading';
  let error = null;
  let destroyed = false;

  const titleId = uid('jr-list');
  const createButton = button(t('journey.new'), { icon: 'plus', variant: 'primary', onclick: () => create() });
  const body = el('div.jr-list-body');
  const root = el('section.jr-view.jr-lists', { 'aria-labelledby': titleId },
    el('header.jr-list-head', {}, el('h2', { id: titleId }, t('journey.title')), createButton), body);
  container.replaceChildren(root);
  if (!context.session?.api || !personal) {
    createButton.hidden = true;
    body.replaceChildren(emptyState({ title: t('journey.title'), body: t('journey.unavailable'), icon: 'pin' }));
    return () => { destroyed = true; };
  }

  function card(entry) {
    const local = info.get(entry.ref.s);
    const meta = local?.meta;
    const name = meta?.title || entry.title || t('journey.untitled');
    const details = [
      local?.first ? formatDateRange(local.first, local.last) : '',
      local ? t('journey.entryCount', { count: formatNumber(local.count) }) : '',
      meta?.status ? t(`journey.status.${meta.status}`) : '',
      roleKey[entry.role] ? t(roleKey[entry.role]) : '',
    ].filter(Boolean).join(' · ');
    const image = el('img', { alt: '', hidden: true, decoding: 'async', referrerPolicy: 'no-referrer' });
    if (meta?.cover) void coverUrl(entry.ref, meta.cover, { thumb: true, api: context.session.api }).then((src) => { if (src) { image.src = src; image.hidden = false; } }).catch(() => {});
    return el('li.jr-card-item', {},
      el('a.jr-list-card', { href: journeyHash(entry.ref), dataset: { id: entry.ref.s } },
        el('span.jr-list-cover', { 'aria-hidden': 'true' }, image, icon('journey', 28)),
        el('span.jr-list-text', {}, el('span.jr-list-title', {}, name), meta?.subtitle && el('span.jr-muted', {}, meta.subtitle), details && el('span.jr-muted', {}, details))));
  }
  function render() {
    if (destroyed) return;
    if (status === 'loading') { body.replaceChildren(el('div.jr-skeletons', {}, skeleton('100%'), skeleton('100%'))); return; }
    if (status === 'error') {
      body.replaceChildren(emptyState({ title: t('journey.loadFailed'), body: errorText(error), icon: 'warning', action: button(t('journey.retry'), { variant: 'primary', onclick: () => void load() }) }));
      return;
    }
    if (!entries.length) {
      body.replaceChildren(emptyState({ title: t('journey.listEmptyTitle'), body: t('journey.listEmptyBody'), icon: 'pin', action: button(t('journey.new'), { variant: 'primary', icon: 'plus', onclick: () => create() }) }));
      return;
    }
    body.replaceChildren(el('ul.jr-list-grid', { 'aria-labelledby': titleId }, entries.map(card)));
  }
  async function load() {
    status = 'loading'; render();
    try {
      entries = (await listSpaces(context, 'journey')).sort((a, b) => (b.opened ?? 0) - (a.opened ?? 0));
      status = 'ready';
      render();
      info = await peekAll(context, entries);
      render();
    } catch (failure) { status = 'error'; error = failure; render(); }
  }

  /** The new-journey dialog: blank, or from one of the member's trips (linked, with its visits as suggestions). */
  async function create(preset = {}) {
    const trips = await tripChoices(context).catch(() => []);
    if (destroyed) return;
    if (!trips.length && !preset.trip) { blank(); return; }
    let mode = preset.trip || trips.length ? 'trip' : 'blank';
    const choice = segmented({ label: t('journey.newFrom'), value: mode, items: [{ value: 'trip', label: t('journey.fromTrip') }, { value: 'blank', label: t('journey.blank') }], onChange: (value) => { mode = value; sync(); } });
    const selectId = uid('jr-trip');
    const select = el('select.select', { id: selectId }, trips.map((entry, index) => el('option', { value: String(index), selected: preset.trip && sameRef(preset.trip, entry.ref) },
      [entry.title || t('journey.unknownTrip'), formatDateRange(entry.start, entry.end)].filter(Boolean).join(' · '))));
    const tripField = el('div.field', {}, el('label.field-label', { htmlFor: selectId }, t('journey.chooseTrip')), select, el('span.field-hint', {}, t('journey.fromTripHint')));
    const status = el('p.jr-hint', { role: 'status' });
    const go = button(t('journey.create'), { variant: 'primary', onclick: () => void submit() });
    const dialog = openModal({ title: t('journey.newTitleJourney'), content: el('div.jr-editor', {}, choice.element, tripField, status), actions: [button(t('journey.cancel'), { onclick: () => dialog.close('cancel') }), go] });
    function sync() { tripField.hidden = mode !== 'trip'; go.textContent = t(mode === 'trip' ? 'journey.create' : 'journey.next'); }
    async function submit() {
      if (mode === 'blank') { dialog.close('blank'); blank(); return; }
      const trip = trips[Number(select.value)];
      if (!trip) return;
      go.setAttribute('aria-busy', 'true');
      try {
        const ref = await createFromTrip(context, trip.ref, { onProgress: (stage) => { status.textContent = deployProgress(stage); } });
        dialog.close('created');
        toast(t('journey.created'));
        app?.navigate(journeyHash(ref));
      } catch (failure) { status.textContent = errorText(failure); } finally { go.setAttribute('aria-busy', 'false'); }
    }
    sync();
  }
  function blank() {
    openMetaForm({ title: t('journey.newTitleJourney'), submitLabel: t('journey.create'), onSubmit: async (values) => {
      const meta = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
      const ref = await createJourney(context, meta);
      toast(t('journey.created'));
      app?.navigate(journeyHash(ref));
    } });
  }

  void load().then(() => {
    // The palette's "New journey" lands here with its intent in sessionStorage.
    const intent = readIntent();
    if (intent && !destroyed) void create(intent.trip ? { trip: intent.trip } : {});
  });
  return () => { destroyed = true; };
}

export { INTENT_KEY };
