// The timeline: entries grouped by day, suggestions from linked trips, search results and jumping to a day.
import { el, uid } from '../../ui/dom.js';
import { button, iconButton, emptyState } from '../../ui/bits.js';
import { markdown } from '../../ui/md.js';
import { openMenu } from '../../ui/menu.js';
import { confirmDialog } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatNumber, formatTime } from '../../lib/format.js';
import { prefersReducedMotion } from '../../lib/prefs.js';
import { daysBetween } from '../../shared/dates.js';
import { TYPE_ICONS, icon } from './icons.js';
import { groupByDate, isSuggestion, moveOrder, orderedSiblings, visibleEntries, writtenEntries } from './model.js';
import { liveMedia, mediaTile, trashOrphans } from './media.js';
import { setDismissed } from './editor.js';
import { errorText } from './spaces.js';

const STORY_PREVIEW = 600;
const STRIP = 6;
const countryName = (cc) => { try { return new Intl.DisplayNames(undefined, { type: 'region' }).of(cc) ?? cc; } catch { return cc; } };

/** Day number in the journey ("Day 3"), counted from the first written day. */
export const dayNumber = (first, date) => (first ? daysBetween(first, date) + 1 : null);

/**
 * One entry as a card. `ctx`: `{space, canEdit, onEdit(entry), onMedia(fileId, ids), tripTitle(ref), focusKey}`.
 * Suggestions show their source trip and Write up / Dismiss (or Restore once dismissed).
 */
export function entryCard(entry, ctx) {
  const { space, canEdit } = ctx;
  const titleId = uid('jr-entry');
  const suggestion = isSuggestion(entry);
  const meta = [];
  if (entry.time) meta.push(el('span.jr-time.num', {}, formatTime(entry.time)));
  if (entry.loc?.name || entry.loc?.cc) {
    meta.push(el('span.jr-place', {}, icon('map-pin', 14), el('span', {}, [entry.loc.name, entry.loc.cc && !entry.loc.name?.includes(countryName(entry.loc.cc)) ? countryName(entry.loc.cc) : ''].filter(Boolean).join(', '))));
  }
  if (entry.mood) meta.push(el('span.jr-badge', { title: t(`journey.mood.${entry.mood}`) }, icon(entry.mood, 15), el('span.sr-only', {}, t(`journey.mood.${entry.mood}`))));
  if (entry.weather) meta.push(el('span.jr-badge', { title: t(`journey.weather.${entry.weather}`) }, icon(entry.weather, 15), el('span.sr-only', {}, t(`journey.weather.${entry.weather}`))));
  if (entry.vis === 'members') meta.push(el('span.jr-badge', { title: t('journey.membersOnly') }, icon('lock', 14), el('span', {}, t('journey.membersOnly'))));
  if (entry.excluded) meta.push(el('span.jr-badge.jr-muted', {}, t('journey.excludedBadge')));

  const body = [];
  if (suggestion) {
    const from = entry.src?.trip ? ctx.tripTitle?.(entry.src.trip) : null;
    body.push(el('p.jr-muted', {}, from ? t('journey.suggestedFrom', { trip: from }) : t('journey.suggested')));
  }
  if (entry.story) {
    const long = entry.story.length > STORY_PREVIEW;
    const story = el('div.jr-story-text', {}, markdown(long ? `${entry.story.slice(0, STORY_PREVIEW)}…` : entry.story));
    body.push(story);
    if (long) {
      const more = button(t('journey.readMore'), { size: 'sm', variant: 'ghost', 'aria-expanded': 'false', onclick: () => {
        const open = more.getAttribute('aria-expanded') !== 'true';
        story.replaceChildren(markdown(open ? entry.story : `${entry.story.slice(0, STORY_PREVIEW)}…`));
        more.setAttribute('aria-expanded', String(open));
        more.textContent = t(open ? 'journey.readLess' : 'journey.readMore');
      } });
      body.push(more);
    }
  }
  if (entry.pros?.length || entry.cons?.length) {
    body.push(el('div.jr-proscons', {},
      entry.pros?.length && el('div', {}, el('h4.jr-mini', {}, icon('pro', 14), t('journey.pros')), el('ul', {}, entry.pros.map((item) => el('li', {}, item)))),
      entry.cons?.length && el('div', {}, el('h4.jr-mini', {}, icon('con', 14), t('journey.cons')), el('ul', {}, entry.cons.map((item) => el('li', {}, item))))));
  }
  if (entry.tags?.length) body.push(el('ul.jr-tags', { 'aria-label': t('journey.fieldTags') }, entry.tags.map((tag) => el('li.chip', {}, tag))));
  const media = liveMedia(space, entry);
  if (media.length) {
    body.push(el('ul.jr-strip', { 'aria-label': t('journey.mediaCount', { count: formatNumber(media.length) }) }, media.slice(0, STRIP).map((fileId, index) => {
      const more = index === STRIP - 1 && media.length > STRIP ? media.length - STRIP + 1 : 0;
      const file = space.get('file', fileId);
      return el('li', {}, el('button.jr-tile-button', { type: 'button', 'aria-label': more ? t('journey.morePhotos', { count: formatNumber(more) }) : t('journey.openPhoto', { name: file?.desc || file?.name || '' }),
        onclick: () => ctx.onMedia?.(fileId, media) }, mediaTile(space, fileId), more ? el('span.jr-tile-more', { 'aria-hidden': 'true' }, `+${formatNumber(more)}`) : null));
    })));
  }

  const actions = [];
  if (canEdit && suggestion && !entry.dismissed) {
    actions.push(button(t('journey.writeUp'), { size: 'sm', variant: 'primary', dataset: { focus: `write:${entry.id}` }, onclick: () => ctx.onEdit(entry) }),
      button(t('journey.dismiss'), { size: 'sm', variant: 'ghost', dataset: { focus: `dismiss:${entry.id}` }, onclick: () => void dismiss(entry, true) }));
  } else if (canEdit && entry.dismissed) {
    actions.push(button(t('journey.restore'), { size: 'sm', variant: 'outline', dataset: { focus: `restore:${entry.id}` }, onclick: () => void dismiss(entry, false) }));
  } else if (canEdit) {
    actions.push(iconButton('pencil', t('journey.editEntry', { title: entry.title }), { dataset: { focus: `edit:${entry.id}` }, onclick: () => ctx.onEdit(entry) }),
      iconButton('more', t('journey.entryActions', { title: entry.title }), { dataset: { focus: `menu:${entry.id}` }, onclick: (event) => menu(event.currentTarget, entry) }));
  }

  async function dismiss(item, value) {
    try { await setDismissed(space, item, value); } catch (error) { toast(errorText(error)); }
  }
  function move(item, delta) {
    const siblings = orderedSiblings(space.select.entry.all(), item.date);
    const writes = moveOrder(siblings, siblings.findIndex((entry) => entry.id === item.id), delta);
    if (writes.length) void space.apply(writes.map(({ id, order }) => space.ops.patch('entry', id, { set: { order } })), { history: t('journey.historyMove') }).catch((error) => toast(errorText(error)));
  }
  function menu(anchor, item) {
    const siblings = orderedSiblings(space.select.entry.all(), item.date);
    const at = siblings.findIndex((entry) => entry.id === item.id);
    openMenu(anchor, [
      { label: t('journey.edit'), icon: 'pencil', onSelect: () => ctx.onEdit(item) },
      at > 0 && { label: t('journey.moveEarlier'), onSelect: () => move(item, -1) },
      at >= 0 && at < siblings.length - 1 && { label: t('journey.moveLater'), onSelect: () => move(item, 1) },
      { label: t(item.excluded ? 'journey.includeStats' : 'journey.excludeStats'), onSelect: () => void space.apply([space.ops.patch('entry', item.id, item.excluded ? { unset: ['excluded'] } : { set: { excluded: true } })]).catch((error) => toast(errorText(error))) },
      { separator: true },
      { label: t('journey.deleteEntry'), icon: 'trash', danger: true, onSelect: () => void remove(item) },
    ].filter(Boolean));
  }
  async function remove(item) {
    const ok = await confirmDialog({ title: t('journey.deleteTitle'), body: t('journey.deleteBody'), confirmLabel: t('journey.deleteEntry'), danger: true });
    if (!ok) return;
    try { await space.apply([space.ops.remove('entry', item.id)]); void trashOrphans(space, item); toast(t('journey.deleted')); } catch (error) { toast(errorText(error)); }
  }

  const overlay = space.overlay?.('entry', entry.id);
  return el(`article.jr-entry${suggestion ? '.is-suggestion' : ''}${entry.dismissed ? '.is-dismissed' : ''}`, { 'aria-labelledby': titleId, dataset: { id: entry.id, type: entry.type } },
    el('span.jr-entry-icon', { 'aria-hidden': 'true' }, icon(TYPE_ICONS[entry.type] ?? 'write', 16)),
    el('div.jr-entry-main', {},
      el('header.jr-entry-head', {},
        el('h3.jr-entry-title', { id: titleId }, entry.title),
        overlay?.pending && el('span.jr-pending', { title: t('journey.pending') }, el('span.sr-only', {}, t('journey.pending'))),
        actions.length && el('div.jr-entry-actions', {}, actions)),
      meta.length && el('div.jr-entry-meta', {}, meta),
      body));
}

/**
 * Mounts the timeline. `ctx`: `{space, ui, canEdit, onEdit, onMedia, onAdd, tripTitle, today}`; `ui` holds `query`,
 * `hideSuggestions`, `showDismissed`. Returns `{render(), jump(date), destroy()}`.
 */
export function mountTimeline(container, ctx) {
  const { space, ui } = ctx;
  const live = el('p.sr-only', { role: 'status' });
  const list = el('div.jr-days');
  container.replaceChildren(list, live);
  let opened = false;

  function render() {
    const all = space.select.entry.all();
    const entries = visibleEntries(all, ui);
    const first = writtenEntries(all)[0]?.date ?? entries[0]?.date ?? null;
    const dismissed = all.filter((entry) => entry.dismissed).length;
    if (!entries.length) {
      const searching = Boolean(ui.query.trim());
      list.replaceChildren(emptyState({
        title: t(searching ? 'journey.noMatches' : 'journey.emptyTitle'),
        body: t(searching ? 'journey.noMatchesBody' : ctx.canEdit() ? 'journey.emptyBody' : 'journey.emptyViewer'),
        icon: 'pin',
        action: !searching && ctx.canEdit() ? button(t('journey.addEntry'), { variant: 'primary', icon: 'plus', onclick: () => ctx.onAdd() }) : null,
      }));
      live.textContent = searching ? t('journey.noMatches') : '';
      return;
    }
    const cardCtx = { ...ctx, canEdit: ctx.canEdit() };
    const groups = groupByDate(entries);
    const nodes = groups.map((group) => {
      const headingId = uid('jr-day');
      const number = dayNumber(first, group.date);
      return el('section.jr-day', { 'aria-labelledby': headingId, dataset: { date: group.date } },
        el('h2.jr-day-head', { id: headingId, tabIndex: -1 },
          el('span.jr-day-date', {}, formatDate(group.date, { weekday: true, style: 'long' })),
          number && number > 0 && el('span.jr-day-num', {}, t('journey.dayNumber', { number: formatNumber(number) })),
          group.date === ctx.today && el('span.chip.chip-accent', {}, t('journey.today'))),
        el('div.jr-day-entries', {}, group.entries.map((entry) => entryCard(entry, cardCtx))));
    });
    if (dismissed && !ui.showDismissed) nodes.push(el('p.jr-muted.jr-dismissed-note', {}, t('journey.dismissedCount', { count: formatNumber(dismissed) })));
    const focused = document.activeElement?.closest?.('[data-focus]')?.dataset.focus;
    list.replaceChildren(...nodes);
    if (focused) [...list.querySelectorAll('[data-focus]')].find((node) => node.dataset.focus === focused)?.focus({ preventScroll: true });
    live.textContent = ui.query.trim() ? t('journey.matchCount', { count: formatNumber(entries.length) }) : '';
    if (!opened) { opened = true; requestAnimationFrame(() => jump(ctx.opening?.(entries) ?? null, { focus: false, smooth: false })); }
  }

  /** Scrolls to the day on or after `date` (the last day when none is later). */
  function jump(date, { focus = true, smooth = true } = {}) {
    if (!date) return;
    const days = [...list.querySelectorAll('.jr-day')];
    const target = days.find((node) => (ui.newestFirst ? node.dataset.date <= date : node.dataset.date >= date)) ?? days.at(-1);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
    if (focus) target.querySelector('.jr-day-head')?.focus({ preventScroll: true });
  }

  render();
  return { render, jump, destroy() { container.replaceChildren(); } };
}
