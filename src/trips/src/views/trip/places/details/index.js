// Place details from public sources (description, photos, hours, facts, links) and an on-demand AI summary.
// One instance per open place; the detail view re-renders around the same `element`.
import './details.css';
import { createElement, Info, Sparkles } from 'lucide';
import { append, el, uid } from '../../../../ui/dom.js';
import { button, iconButton, skeleton } from '../../../../ui/bits.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { aiPrefs, displayLocale, prefs } from '../../../../lib/prefs.js';
import { formatDate, formatTime, weekStart, weekdays } from '../../../../lib/format.js';
import { appOnline } from '../../../../lib/offline/pwa.js';
import { localToday } from '../../../../lib/offline/policy.js';
import { stable } from '../../../../services/core.js';
import { icon } from '../icons.js';
import { categoryOf } from '../../../../lib/categories.js';
import { detailsQuery, formatFact, shapeDetails } from './shape.js';
import { hoursStatus, rangesText, statusText, weekRows, zonedClock } from './hours.js';
import { SummaryError, notesWithSummary, requestSummary } from './summary.js';

const glyph = (shape) => (size = 16) => createElement(shape, { width: size, height: size, 'stroke-width': 2, 'aria-hidden': 'true', focusable: 'false', class: 'icon' });
const sparkles = glyph(Sparkles);
const info = glyph(Info);
const external = { target: '_blank', rel: 'noopener noreferrer' };
// Summaries the user paid for survive closing and reopening the place during the session.
const summaries = new Map();
const remember = (key, value) => { summaries.delete(key); summaries.set(key, value); while (summaries.size > 30) summaries.delete(summaries.keys().next().value); };
const SOURCE_LICENSE = {
  wikipedia: { license: 'CC BY-SA 4.0', licenseURL: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  wikivoyage: { license: 'CC BY-SA 4.0', licenseURL: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  osm: { license: 'ODbL', licenseURL: 'https://www.openstreetmap.org/copyright' },
  wikidata: { license: 'CC0', licenseURL: 'https://creativecommons.org/publicdomain/zero/1.0/' },
};

function section(title, ...children) {
  const id = uid('pd-section');
  return el('section.pl-detail-section', { 'aria-labelledby': id }, el('h3.pl-eyebrow', { id }, title), ...children);
}
const link = (href, text, attrs = {}) => (href ? el('a', { href, ...external, ...attrs }, text) : el('span', {}, text));
const languageName = (code) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? 'English'; } catch { return 'English'; } };
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast(t('places.copied')); } catch { toast(t('places.copyFailed')); }
}

/** Returns `{placeId, element, update(place), destroy()}`; `chat` (default `puter.ai.chat`) and `now` are injectable. */
export function createDetailsSection({ placeId, space, services, puter, canEdit = () => false, track = () => {}, chat, now = Date.now, window: win = globalThis.window }) {
  const root = el('div.pd-root', { hidden: true });
  const runChat = chat ?? (typeof puter?.ai?.chat === 'function' ? (messages, options) => puter.ai.chat(messages, options) : null);
  const lang = (() => { try { return new Intl.Locale(displayLocale()).language; } catch { return 'en'; } })();
  let place = null;
  let queryKey = null;
  let editable = null;
  let state = { status: 'idle', view: null };
  let summary = { status: 'idle' };
  let summaryKey = null;
  let controller = null;
  let sequence = 0;
  let hoursNode = null;
  let summaryNode = null;
  let timer = 0;
  let destroyed = false;
  const online = () => appOnline(win);

  async function load() {
    const token = ++sequence;
    controller?.abort();
    controller = new AbortController();
    const query = detailsQuery(place, { lang });
    if (!services?.placeInfo) { state = { status: 'idle', view: null }; render(); return; }
    if (!query) { state = { status: 'none', view: null }; render(); return; }
    state = { status: 'loading', view: null }; render();
    const offline = !online();
    try {
      const [result, config] = await Promise.all([
        services.placeInfo.details(query, { signal: controller.signal }),
        Promise.resolve(services.context?.loadConfig?.({ offline })).catch(() => null),
      ]);
      if (token !== sequence || destroyed) return;
      const view = shapeDetails(result, place, { osmLookup: Boolean(config?.geoWorker) });
      state = { status: !result && offline ? 'offline' : 'ready', view };
    } catch (error) {
      if (error?.name === 'AbortError' || token !== sequence || destroyed) return;
      state = { status: 'error', view: null };
    }
    render();
  }

  // ---- rendering
  function render() {
    if (destroyed) return;
    clearInterval(timer); timer = 0;
    hoursNode = null; summaryNode = null;
    const { status, view } = state;
    root.hidden = status === 'idle';
    if (status === 'loading') {
      root.replaceChildren(section(t('placeDetails.title'), el('div.pd-loading', { 'aria-busy': 'true', 'aria-label': t('placeDetails.loading') }, skeleton(), skeleton('80%'), skeleton('60%'))));
      return;
    }
    if (status === 'none') { root.replaceChildren(section(t('placeDetails.title'), el('p.pl-muted', {}, t('placeDetails.noRefs')))); return; }
    if (status === 'offline') { root.replaceChildren(section(t('placeDetails.title'), note('offline', t('placeDetails.offline')))); return; }
    if (status === 'error') {
      root.replaceChildren(section(t('placeDetails.title'), el('div.pd-note', { role: 'alert' }, icon('warning', 16), el('span', {}, t('placeDetails.failed')),
        button(t('placeDetails.retry'), { size: 'sm', variant: 'outline', onclick: () => void load() }))));
      return;
    }
    if (status !== 'ready' || !view) { root.replaceChildren(); return; }
    const about = [
      view.stale && note('offline', t('placeDetails.stale')),
      view.limited && note('info', t(view.empty ? 'placeDetails.limitedEmpty' : 'placeDetails.limited')),
      view.empty && !view.limited && el('p.pl-muted', {}, t('placeDetails.nothing')),
      view.description && descriptionBlock(view.description),
    ].filter(Boolean);
    hoursNode = view.hours ? hoursSection(view) : null;
    summaryNode = view.empty ? null : summarySection(view);
    root.replaceChildren();
    append(root, [
      about.length > 0 && section(t('placeDetails.title'), ...about),
      view.photos.length > 0 && photosSection(view.photos),
      hoursNode,
      view.facts.length > 0 && factsSection(view.facts),
      view.links.length > 0 && linksSection(view.links),
      summaryNode,
      view.credits.length > 0 && creditsFooter(view.credits),
    ]);
    if (hoursNode) timer = setInterval(refreshHours, 60_000);
  }
  function note(kind, text) {
    return el('p.pd-hint', {}, kind === 'offline' ? icon('offline', 14) : info(14), el('span', {}, text));
  }

  function descriptionBlock(description) {
    const terms = SOURCE_LICENSE[description.source];
    return el('div.pd-description', {},
      el('p', { lang: description.lang ?? undefined }, description.text),
      el('p.pl-muted.pd-source', {}, link(description.url, t(`placeDetails.from.${description.source}`)),
        terms && [' · ', link(terms.licenseURL, terms.license)]));
  }

  function photosSection(photos) {
    return section(t('placeDetails.photos'), el('ul.pd-photos', {}, photos.map((photo) => {
      const item = el('li.pd-photo');
      const image = el('img', { src: photo.url, alt: photo.title || '', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer',
        onerror: () => { item.hidden = true; } });
      item.append(el('figure', {},
        el('a.pd-photo-link', { href: photo.source, ...external, 'aria-label': t('placeDetails.photoSource', { title: photo.title || t('placeDetails.photo') }) }, image),
        el('figcaption.pl-muted', {},
          photo.author && [link(photo.authorURL, t('placeDetails.photoBy', { author: photo.author })), ' · '],
          link(photo.licenseURL, photo.license), ' · ',
          link(photo.source, t(photo.provider === 'openverse' ? 'placeDetails.viaOpenverse' : 'placeDetails.viaCommons')))));
      return item;
    })));
  }

  function hoursSection(view) {
    const { hours, timeZone } = view;
    const at = now();
    const status = hoursStatus(hours, { timeZone, now: at });
    const clock = zonedClock(at, timeZone);
    const names = weekdays({ style: 'long' });
    const labels = Object.fromEntries(names.map(({ day, label }) => [day, label]));
    const line = statusText(status, { formatTime, weekdayLabel: (offset) => labels[((clock?.day ?? 0) + offset) % 7] });
    const badge = status.open === null ? null
      : el(`span.chip.${status.open ? 'chip-success' : 'pd-closed'}`, {}, icon('clock', 14), t(status.open ? 'placeDetails.openNow' : 'placeDetails.closedNow'));
    const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
    const zoneNote = !timeZone ? t('placeDetails.zoneUnknown') : timeZone !== browserZone ? t('placeDetails.zoneLocal', { zone: timeZone.replaceAll('_', ' ') }) : null;
    let table;
    if (hours.week) {
      const words = { formatTime, allDay: t('placeDetails.allDay'), closed: t('placeDetails.closed') };
      const rows = weekRows(hours.week, { first: weekStart(), today: clock?.day ?? null, labels, ...words });
      table = el('table.pd-hours', {},
        el('caption.sr-only', {}, t('placeDetails.hours')),
        el('tbody', {}, rows.map((row) => el(`tr${row.today ? '.is-today' : ''}${row.closed ? '.is-closed' : ''}`, row.today ? { 'aria-current': 'date' } : {},
          el('th', { scope: 'row' }, row.label), el('td.num', {}, row.text))),
        hours.holidays && el('tr', {}, el('th', { scope: 'row' }, t('placeDetails.holidays')),
          el('td.num', {}, rangesText(hours.holidays, words)))));
    } else table = el('div.pd-raw', {}, el('p.pl-muted', {}, t('placeDetails.hoursRaw')), el('p.pd-raw-text', { dir: 'ltr' }, hours.raw));
    return section(t('placeDetails.hours'),
      (badge || line) && el('p.pd-status', {}, badge, line && el('span', {}, t(line.key, line.values))),
      table,
      zoneNote && el('p.pl-muted', {}, zoneNote));
  }
  function refreshHours() {
    if (destroyed || !hoursNode?.isConnected || state.status !== 'ready' || !state.view?.hours) return;
    const next = hoursSection(state.view);
    hoursNode.replaceWith(next); hoursNode = next;
  }

  function factsSection(facts) {
    const options = { locale: displayLocale(), distanceUnit: prefs().distanceUnit };
    return section(t('placeDetails.facts'), el('dl.pl-facts', {}, facts.map((fact) => {
      const shown = formatFact(fact, options);
      return [el('dt', {}, shown.label), el('dd', {}, el(shown.key === 'phone' ? 'span.num' : 'span', {}, shown.text),
        shown.key === 'phone' && iconButton('copy', t('places.copyPhone'), { class: 'icon-btn icon-btn-sm', onclick: () => copyText(shown.text) }))];
    })));
  }

  function linksSection(links) {
    return section(t('placeDetails.links'), el('ul.pl-links.pd-links', {}, links.map((entry) => el('li', {},
      el('a.btn.btn-sm.btn-ghost', { href: entry.url, ...external }, icon(entry.id === 'website' ? 'web' : 'external', 16),
        t(`placeDetails.link.${entry.id}`), el('span.link-host', { dir: 'ltr' }, entry.host))))));
  }

  function creditsFooter(credits) {
    return el('footer.pd-credits.pl-muted', {}, el('span', {}, t('placeDetails.sources')), el('ul', {}, credits.map((credit) => el('li', {},
      link(credit.url, credit.text), credit.license && [' (', link(credit.licenseURL, credit.license), ')']))));
  }

  // ---- AI summary
  function summarySection(view) {
    const busy = summary.status === 'busy';
    const connected = online();
    const body = [];
    if (summary.status === 'done') {
      body.push(
        el('p.pd-ai-label', {}, el('span.chip.chip-accent', {}, sparkles(14), t('placeDetails.aiLabel'))),
        summary.mismatch && el('div.pd-note', { role: 'note' }, icon('warning', 16), el('span', {}, t('placeDetails.aiMismatch'))),
        el('p.pd-ai-text', { tabIndex: -1 }, summary.text),
        el('p.pl-muted', {}, t('placeDetails.aiDisclaimer')),
        el('div.pl-actions', {},
          canEdit() && !summary.mismatch && button(t(summary.saved ? 'placeDetails.aiSaved' : 'placeDetails.aiSave'), {
            icon: summary.saved ? 'check' : 'file', size: 'sm', variant: 'outline', disabled: summary.saved, onclick: () => confirmSave() }),
          button(t('placeDetails.aiAgain'), { size: 'sm', variant: 'ghost', disabled: !connected || !runChat, onclick: () => void summarize(view) }),
          button(t('placeDetails.aiDiscard'), { size: 'sm', variant: 'ghost', onclick: discard })));
    } else {
      const start = button(t('placeDetails.aiSummarize'), { size: 'sm', variant: 'outline', busy, disabled: !connected || !runChat, onclick: () => void summarize(view) });
      start.prepend(sparkles());
      body.push(el('div.pl-actions', {}, start),
        busy && el('p.pl-muted', { role: 'status' }, t('placeDetails.aiWorking')),
        summary.status === 'error' && el('div.pd-note', { role: 'alert' }, icon('warning', 16), el('span', {}, t(`placeDetails.aiError.${summary.code}`))),
        !busy && el('p.pl-muted', {}, t(!runChat ? 'placeDetails.aiUnavailable' : connected ? 'placeDetails.aiCost' : 'placeDetails.aiOffline')));
    }
    return section(t('placeDetails.aiTitle'), ...body);
  }
  function refreshSummary() {
    if (destroyed || !summaryNode?.isConnected || !state.view) return;
    const next = summarySection(state.view);
    const focused = summaryNode.contains(document.activeElement);
    summaryNode.replaceWith(next); summaryNode = next;
    if (focused) (next.querySelector('.pd-ai-text') ?? next.querySelector('button:not([disabled])'))?.focus();
  }
  async function summarize(view) {
    if (summary.status === 'busy' || !runChat || !place) return;
    const key = summaryKey;
    const target = place;
    summary = { status: 'busy' }; refreshSummary();
    let next;
    try {
      const factText = view.facts.map((fact) => formatFact(fact, { locale: 'en', distanceUnit: 'km' }));
      const result = await requestSummary({ chat: runChat, model: aiPrefs().quickModel, place: target, view, language: languageName(lang), categoryName: categoryOf(space, target.cat)?.name, factText });
      next = { status: 'done', ...result, saved: false };
      remember(key, next);
    } catch (error) {
      next = { status: 'error', code: error instanceof SummaryError && ['credit', 'offline', 'invalid', 'unavailable'].includes(error.code) ? error.code : 'failed' };
    }
    if (destroyed || key !== summaryKey) return;
    summary = next; refreshSummary();
  }
  function discard() {
    summaries.delete(summaryKey);
    summary = { status: 'idle' }; refreshSummary();
    summaryNode?.querySelector('button:not([disabled])')?.focus();
  }
  function confirmSave() {
    if (!canEdit() || summary.status !== 'done') return;
    const confirm = button(t('placeDetails.aiSaveConfirm'), { variant: 'primary' });
    const dialog = openModal({
      title: t('placeDetails.aiSaveTitle'),
      content: el('div.pd-confirm', {}, el('p', {}, t('placeDetails.aiSaveBody')), el('blockquote.pd-ai-text', {}, summary.text)),
      actions: [button(t('places.cancel'), { onclick: () => dialog.close('cancel') }), confirm],
    });
    track(dialog);
    confirm.addEventListener('click', async () => {
      dialog.close('confirm');
      const current = space.get('place', placeId);
      if (!current || !canEdit()) return;
      const date = formatDate(localToday(now()));
      const notes = notesWithSummary(current.notes, summary.text, t('placeDetails.notesHeading', { date }));
      if (!notes) { toast(t('places.tooLarge')); return; }
      try {
        await space.apply([space.ops.patch('place', placeId, { set: { notes } })], { history: t('placeDetails.aiHistory') });
      } catch { toast(t('places.saveFailed')); return; }
      summary = { ...summary, saved: true };
      remember(summaryKey, summary);
      toast(t('placeDetails.aiSavedToast'));
      refreshSummary();
    });
  }

  const onConnection = () => {
    if (destroyed) return;
    if (online() && ['offline', 'error'].includes(state.status)) void load();
    else if (online() && state.view?.stale) void load();
    else refreshSummary();
  };
  win?.addEventListener?.('online', onConnection);
  win?.addEventListener?.('offline', onConnection);

  return {
    placeId,
    element: root,
    /** Call with the latest place on every detail render; reloads only when its references change. */
    update(next) {
      if (destroyed || !next) return;
      place = next;
      const query = detailsQuery(next, { lang });
      const key = stable(query);
      const canNow = canEdit();
      if (key !== queryKey) {
        queryKey = key;
        summaryKey = `${placeId}|${key}`;
        summary = summaries.get(summaryKey) ?? { status: 'idle' };
        editable = canNow;
        void load();
      } else if (canNow !== editable) { editable = canNow; refreshSummary(); }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller?.abort();
      clearInterval(timer);
      win?.removeEventListener?.('online', onConnection);
      win?.removeEventListener?.('offline', onConnection);
    },
  };
}
