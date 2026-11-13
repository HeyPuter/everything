/**
 * Sidebar: primary "Create" action, an independent mini-month picker, the
 * user's booking links (Calendly-style share-your-availability pages; see
 * booking.js), and last a collapsible category filter over the colors in use
 * (each row renameable).
 */
import { el } from './dom.js';
import { icon } from './icons.js';
import { EVENT_COLORS, categoryLabel, colorFg } from './colors.js';
import {
  getMonthGrid,
  orderedWeekdays,
  addDays,
  startOfDay,
  isSameDay,
  isSameMonth,
  isToday,
  formatMonthYearShort,
  displayedWeekNumber,
  WEEKDAYS_NARROW,
} from './date-utils.js';

/** The lists the folding headings own. One of each per page — the sidebar is
 *  rendered once. */
const BOOKING_LIST_ID = 'side-booking';
const MAIL_LIST_ID = 'side-mail';
const FILTER_LIST_ID = 'side-categories';

export function renderSidebar(ctx) {
  const { store, settings, cursor, miniCursor, now, actions } = ctx;

  const root = el('aside', { class: 'sidebar', 'aria-label': 'Calendar navigation' });

  // Create.
  root.append(
    el('button', {
      class: 'btn btn--primary sidebar__create',
      type: 'button',
      html: icon('plus', { size: 'sm' }) + '<span>Create</span>',
      on: { click: () => actions.createAt({ start: defaultTime(cursor) }) },
    }),
  );

  root.append(buildMini(ctx));
  root.append(buildBookingLinks(ctx));
  root.append(buildMailInvites(ctx));
  // Categories last, at the foot of the sidebar: the filter is set up once and
  // then mostly left alone, so it no longer stands between the month picker
  // and the booking links, which are what the sidebar is used for day to day.
  root.append(buildFilters(ctx));

  return root;
}

/**
 * A sidebar section whose heading folds it away: returns the section with its
 * heading already in it, for the caller to append the list to.
 *
 * The heading itself is the disclosure, the way the sidebar sections of every
 * other calendar work. The <button> sits inside the <h2> rather than wrapping
 * it: a heading is not phrasing content, so it cannot legally live in a
 * button — and a heading that stops being a heading also stops being a
 * landmark screen readers can jump between.
 *
 * `note` is a word about what the section is doing while it is shut (a filter
 * still hiding events, a link no longer taking bookings) — a folded section
 * must not be able to swallow state that is acting on the calendar or on
 * guests. Nothing to report, or a section standing open, shows none.
 */
function buildFoldingSection({ title, noun, listId, collapsed, note, focusKey, onToggle }) {
  const section = el('div', {
    class: `side-section${collapsed ? ' is-collapsed' : ''}`,
  });
  section.append(
    el('h2', { class: 'side-section__title' }, [
      el('button', {
        class: 'side-section__toggle',
        type: 'button',
        'aria-expanded': String(!collapsed),
        'aria-controls': listId,
        title: `${collapsed ? 'Show' : 'Hide'} ${noun}`,
        dataset: { focusKey },
        on: { click: onToggle },
      }, [
        el('span', { text: title }),
        collapsed && note ? el('span', { class: 'side-section__note', text: note }) : null,
        el('span', {
          class: 'side-section__caret',
          html: icon('chevron-down', { size: 'sm' }),
        }),
      ]),
    ]),
  );
  return section;
}

/**
 * The user's booking links. Each row opens the editor; the copy button copies
 * the shareable URL (disabled with an explanation while the per-user worker is
 * still being deployed, which the first link creation kicks off). Rendered only
 * when the booking module exists — a service-mode or degraded boot shows the
 * sidebar exactly as before.
 */
function buildBookingLinks(ctx) {
  const { booking, settings, actions } = ctx;
  if (!booking) return el('div', { hidden: true });
  const pages = booking.getPages();

  const collapsed = !!settings.bookingLinksCollapsed;
  // A paused link is a page guests are being turned away from, so it is the
  // one thing here worth saying with the section shut. (The rows themselves
  // carry the same word on an "Off" pill.)
  const off = pages.filter((p) => !p.enabled).length;
  const section = buildFoldingSection({
    title: 'Booking links',
    noun: 'booking links',
    listId: BOOKING_LIST_ID,
    collapsed,
    note: off ? `${off} off` : null,
    focusKey: 'book-collapse',
    onToggle: () => actions.toggleBookingLinks(),
  });
  const list = el('div', { class: 'book-list', id: BOOKING_LIST_ID, hidden: collapsed });

  pages.forEach((page) => {
    const url = booking.linkFor(page.id);
    list.append(
      el('div', { class: 'book-item' }, [
        el('button', {
          class: 'book-item__open',
          type: 'button',
          title: 'Edit booking link',
          dataset: { focusKey: `book-${page.id}` },
          on: { click: () => actions.editBookingPage(page) },
        }, [
          el('span', { class: 'book-item__title', text: page.title }),
          // A paused link is the one thing about a row worth noticing without
          // opening it, and "· off" tacked onto the 11px meta line was easy to
          // scan straight past. Same state pill the details card uses.
          el('span', { class: 'book-item__meta' }, [
            `${page.durationMin} min`,
            page.enabled ? null : el('span', { class: 'book-item__off', text: 'Off' }),
          ]),
        ]),
        el('button', {
          class: 'icon-btn book-item__copy',
          type: 'button',
          'aria-label': url ? `Copy link for ${page.title}` : 'Preparing your link…',
          title: url ? 'Copy booking link' : 'Preparing your link…',
          disabled: !url,
          dataset: { focusKey: `book-copy-${page.id}` },
          // The copy icon, like every other copy-to-clipboard button in the app
          // (the meeting link, the RSVP links, the booking editor's own Copy) —
          // a chain link here read as "open the page", which is the one thing
          // this button does not do.
          html: icon('copy', { size: 'sm' }),
          on: { click: () => actions.copyBookingLink(page) },
        }),
      ]),
    );
  });

  list.append(
    el('button', {
      class: 'btn btn--ghost book-new',
      type: 'button',
      dataset: { focusKey: 'book-new' },
      html: icon('plus', { size: 'sm' }) + '<span>New booking link</span>',
      title: 'Share a link that lets others book time with you',
      on: { click: () => actions.newBookingPage() },
    }),
  );

  section.append(list);
  return section;
}

/**
 * Mail-detected invitations waiting for a decision (see mail-intake.js). Every
 * row is a pre-parsed view model — plain strings only, so nothing here ever
 * touches `record.ical` or calls into ics.js. Rendered only when there is
 * something pending, same as buildBookingLinks with no booking module.
 */
function buildMailInvites(ctx) {
  const { mail, settings, actions } = ctx;
  if (!mail) return el('div', { hidden: true });
  const pending = mail.intake.getPending();
  if (!pending.length) return el('div', { hidden: true });

  const collapsed = !!settings.mailInvitesCollapsed;
  const section = buildFoldingSection({
    title: 'Invitations',
    noun: 'invitations',
    listId: MAIL_LIST_ID,
    collapsed,
    note: `${pending.length} waiting`,
    focusKey: 'mail-collapse',
    onToggle: () => actions.toggleMailInvites(),
  });
  const list = el('div', { class: 'mail-list', id: MAIL_LIST_ID, hidden: collapsed });

  pending.forEach((row) => list.append(buildMailRow(row, actions)));

  section.append(list);
  return section;
}

/** One pending row: title + hint pill, when, sender, and the primary action
 *  (Add / Add as new / Remove event) with Ignore and Block. A row with nothing
 *  safe for a press to mean — a cancellation from someone who is not the
 *  event's organizer — offers no primary action at all, and says why.
 *  Block asks for a second press instead of opening a dialog — the row itself
 *  says so once pressed, and reverts if nothing follows. */
function buildMailRow(row, actions) {
  const sender = row.fromName ? `${row.fromName} · ${row.fromEmail}` : row.fromEmail;
  return el('div', { class: 'mail-item' }, [
    el('div', { class: 'mail-item__title' }, [
      el('span', { text: row.title || '(No title)' }),
      row.hint ? el('span', { class: 'mail-item__pill', text: row.hint }) : null,
    ]),
    row.whenText ? el('div', { class: 'mail-item__meta', text: row.whenText }) : null,
    sender ? el('div', { class: 'mail-item__meta', text: sender }) : null,
    row.blockedReason
      ? el('div', {
          class: `mail-item__meta${row.canApply === false ? ' mail-item__warn' : ''}`,
          text: row.blockedReason,
        })
      : null,
    el('div', { class: 'mail-item__actions' }, [
      row.canApply === false
        ? null
        : el('button', {
            class: 'btn btn--primary',
            type: 'button',
            text: row.action || 'Add',
            dataset: { focusKey: `mail-add-${row.id}` },
            on: { click: () => actions.addMailInvite(row.id) },
          }),
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Ignore',
        dataset: { focusKey: `mail-ignore-${row.id}` },
        on: { click: () => actions.ignoreMailInvite(row.id) },
      }),
      buildBlockButton(row, actions),
    ]),
  ]);
}

function buildBlockButton(row, actions) {
  const btn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': `Block ${row.fromEmail}`,
    title: 'Block sender',
    dataset: { focusKey: `mail-block-${row.id}` },
    html: icon('close', { size: 'sm' }),
  });
  let timer = null;
  btn.addEventListener('click', () => {
    if (btn.dataset.confirm === '1') {
      actions.blockMailSender(row.id);
      return;
    }
    btn.dataset.confirm = '1';
    btn.classList.add('is-confirm');
    btn.title = `Click again to block ${row.fromEmail}`;
    btn.setAttribute('aria-label', `Click again to block ${row.fromEmail}`);
    clearTimeout(timer);
    // Revert after a few seconds so a stray later click can't land as a block.
    timer = setTimeout(() => {
      delete btn.dataset.confirm;
      btn.classList.remove('is-confirm');
      btn.title = 'Block sender';
      btn.setAttribute('aria-label', `Block ${row.fromEmail}`);
    }, 4000);
  });
  return btn;
}

function defaultTime(day) {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function buildMini(ctx) {
  const { store, settings, cursor, miniCursor, now, actions } = ctx;
  const showWeeks = settings.showWeekNumbers === true;

  const wrap = el('div', { class: 'mini' + (showWeeks ? ' mini--weeks' : '') });
  wrap.append(
    el('div', { class: 'mini__head' }, [
      el('span', { class: 'mini__title', text: formatMonthYearShort(miniCursor) }),
      el('div', { class: 'mini__nav' }, [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Previous month',
          dataset: { focusKey: 'mini-prev' },
          html: icon('chevron-left', { size: 'sm' }),
          on: { click: () => actions.miniShift(-1) },
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Next month',
          dataset: { focusKey: 'mini-next' },
          html: icon('chevron-right', { size: 'sm' }),
          on: { click: () => actions.miniShift(1) },
        }),
      ]),
    ]),
  );

  const gridEl = el('div', { class: 'mini__grid' });
  if (showWeeks) {
    gridEl.append(el('div', { class: 'mini__weeknum mini__weeknum--head', 'aria-hidden': 'true' }));
  }
  orderedWeekdays(settings.weekStartsOn).forEach((idx) => {
    gridEl.append(el('div', { class: 'mini__dow', text: WEEKDAYS_NARROW[idx] }));
  });

  const days = getMonthGrid(miniCursor, settings.weekStartsOn);
  const eventDays = daysWithEvents(store, days);

  days.forEach((day, i) => {
    if (showWeeks && i % 7 === 0) {
      const weekStart = day;
      const week = displayedWeekNumber(weekStart);
      gridEl.append(
        el('button', {
          class: 'mini__weeknum',
          type: 'button',
          text: String(week),
          title: `Open week ${week}`,
          'aria-label': `Open week ${week}`,
          dataset: { focusKey: `mini-week-${startOfDay(weekStart).getTime()}` },
          on: { click: () => actions.gotoWeekView(weekStart) },
        }),
      );
    }
    const classes = ['mini__cell'];
    if (!isSameMonth(day, miniCursor)) classes.push('is-muted');
    if (isToday(day, now)) classes.push('is-today');
    if (isSameDay(day, cursor)) classes.push('is-selected');
    if (eventDays.has(startOfDay(day).getTime())) classes.push('has-events');
    gridEl.append(
      el('button', {
        class: classes.join(' '),
        type: 'button',
        text: String(day.getDate()),
        // aria-current="date" means TODAY (the current date), not the day the
        // calendar is showing — that one is named in the label instead.
        'aria-label': `${day.toDateString()}${isSameDay(day, cursor) ? ', selected' : ''}`,
        'aria-current': isToday(day, now) ? 'date' : null,
        dataset: { focusKey: `mini-${startOfDay(day).getTime()}` },
        on: { click: () => actions.selectDate(day) },
      }),
    );
  });

  wrap.append(gridEl);
  return wrap;
}

function daysWithEvents(store, days) {
  if (!days.length) return new Set();
  const from = startOfDay(days[0]).getTime();
  // Extend to the next local midnight via a calendar-day step, not a fixed
  // +86_400_000: on a fall-back DST day (25h) as the last grid cell (e.g. a
  // Monday-start October whose grid ends on the Nov fall-back Sunday), the
  // fixed offset lands an hour before midnight and drops the has-events dot for
  // a late-night event there. Mirrors the DST-safe stepping the fill loop uses.
  const to = addDays(startOfDay(days[days.length - 1]), 1).getTime();
  const set = new Set();
  // Mirror the main grid: the mini-calendar's event dots must respect the
  // category filter, so a day whose only events are a hidden color reads as
  // empty in both places. (Unlike the reminder scheduler and search, which
  // deliberately scan every color, this is a purely visual echo of the view.)
  for (const ev of store.getEventsInRange(from, to)) {
    // Step by calendar day so the keys stay aligned to local midnight across
    // DST transitions (a fixed +86_400_000 ms would drift off midnight).
    let cur = startOfDay(new Date(Math.max(ev.start, from)));
    const end = Math.min(ev.end, to);
    while (cur.getTime() < end) {
      set.add(cur.getTime());
      cur = addDays(cur, 1);
    }
  }
  return set;
}


function buildFilters(ctx) {
  const { store, settings, actions } = ctx;

  // Only surface colors actually in use, preserving palette order. A recurring
  // series can carry per-occurrence color overrides, and those colors both
  // render on the calendar and are respected by the hide machinery (which keys
  // off each occurrence's own color) — so a color that exists only on an
  // override still needs a toggle, or it would show with no way to filter it.
  const used = new Set();
  for (const e of store.getAllEvents()) {
    used.add(e.color);
    if (e.overrides) {
      for (const ov of Object.values(e.overrides)) {
        if (ov && ov.color) used.add(ov.color);
      }
    }
  }
  // Tasks carry a palette color too, and the filter hides them by it (see
  // getTasksInRange), so a color that lives only on a task needs its toggle
  // as well: without one that task could never be hidden, and once hidden
  // could never be brought back.
  for (const t of store.getAllTasks()) used.add(t.color);
  // Plus any category the user has named: a name is a deliberate act, and a
  // row that vanished when its last event was deleted would take the only way
  // to rename it back with it.
  const names = settings.categoryNames || {};
  const colors = EVENT_COLORS.filter((c) => used.has(c.key) || names[c.key]);
  if (colors.length === 0) return el('div', { hidden: true });

  const hidden = new Set(settings.hiddenColors);
  const collapsed = !!settings.categoriesCollapsed;
  const hiddenCount = colors.filter((c) => hidden.has(c.key)).length;

  // Hiding a color is the whole point of this section, and a shut header must
  // not swallow the reason half the calendar looks empty.
  const section = buildFoldingSection({
    title: 'Categories',
    noun: 'categories',
    listId: FILTER_LIST_ID,
    collapsed,
    note: hiddenCount ? `${hiddenCount} hidden` : null,
    focusKey: 'filter-collapse',
    onToggle: () => actions.toggleCategories(),
  });
  const list = el('div', { class: 'cal-filter', id: FILTER_LIST_ID, hidden: collapsed });

  colors.forEach((c) => {
    const checked = !hidden.has(c.key);
    const label = categoryLabel(c.key, names);
    // The checkbox is the inner element, not the row: the rename button is a
    // sibling of it rather than a control nested inside a role="checkbox".
    const toggle = el('div', {
      class: 'cal-filter__toggle',
      role: 'checkbox',
      tabindex: '0',
      'aria-checked': String(checked),
      dataset: { focusKey: `filter-${c.key}` },
      on: {
        click: () => actions.toggleColor(c.key),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actions.toggleColor(c.key);
          }
        },
      },
    });
    toggle.append(
      el('span', { class: 'cal-filter__check', html: icon('check', { size: 'sm' }) }),
      el('span', { class: 'cal-filter__label', text: label }),
    );
    list.append(
      el('div', { class: 'cal-filter__item', style: { '--dot-color': c.hex, '--ev-fg': colorFg(c.key) } }, [
        toggle,
        el('button', {
          class: 'icon-btn cal-filter__rename',
          type: 'button',
          'aria-label': `Rename ${label}`,
          title: `Rename ${label}`,
          dataset: { focusKey: `filter-rename-${c.key}` },
          html: icon('edit', { size: 'sm' }),
          on: { click: () => actions.renameCategory(c.key) },
        }),
      ]),
    );
  });

  section.append(list);
  return section;
}
