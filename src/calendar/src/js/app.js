/**
 * Application controller: owns UI state (view, cursor, theme), builds the app
 * shell, and re-renders the sidebar + active view in response to navigation,
 * store changes, resizing, and the per-minute "now" tick.
 */
import { el, clear } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { signOut, userInitial } from './auth.js';
import { showProfilePicture, clearCachedPicture } from './profile.js';
import { clearSnapshot } from './offline-store.js';
import { isBlocked, isOfflineError } from './offline.js';
import { createEventModal } from './modal.js';
import { createSearch } from './search.js';
import { createReminderScheduler } from './reminders.js';
import { openDataDialog } from './data-io.js';
import { bindCalendarFileDrop } from './file-drop.js';
import { openScopeDialog } from './recurrence-dialog.js';
import { offerCancellation } from './cancellation-dialog.js';
import { offerInvitations } from './invitation-dialog.js';
import { openBookingEditor } from './booking-dialog.js';
import { openCategoryRename } from './category-dialog.js';
import { openMailDialog } from './mail-dialog.js';
import { renderSidebar } from './sidebar.js';
import { openContextMenu, closeContextMenu, isContextMenuOpen, onContextMenuClose } from './context-menu.js';
import { onDragEnd } from './drag.js';
import { HOLIDAY_COUNTRIES, detectCountry, countryName } from './holidays.js';
import { renderYear } from './views/year.js';
import { renderMonth } from './views/month.js';
import { renderWeek } from './views/week.js';
import { renderFourDay } from './views/four-day.js';
import { renderDay } from './views/day.js';
import { renderAgenda } from './views/agenda.js';
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  startOfMonth,
  startOfDay,
  isSameMonth,
  formatMonthYear,
  formatWeekRange,
  formatDateRange,
  formatDayTitle,
  startOfWeek,
  displayedWeekNumber,
  tzOffsetLabel,
  tzPickerGroups,
} from './date-utils.js';

const VIEWS = [
  { key: 'year', label: 'Year' },
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: '4day', label: '4 Day' },
  { key: 'day', label: 'Day' },
  { key: 'agenda', label: 'List' },
];

export function createApp(root, { store, user, rsvp = null, contacts = null, invites = null, booking = null, meetings = null, mail = null }) {
  const settings = store.getSettings();

  const state = {
    view: normalizeView(settings.defaultView),
    cursor: startOfDay(new Date()),
    miniCursor: startOfMonth(new Date()),
    sidebarOpen: false,
  };

  applyTheme(store.getSettings().theme);

  // No `onChange` render hook: every store mutation emit()s and the subscription
  // below re-renders, so passing render here too would fire a second, redundant
  // render *after* the modal's restoreFocus() runs — silently dropping keyboard
  // focus to <body>. The store subscription is the single render path.
  // One editor for events, out-of-office blocks, and tasks — the create-time
  // mode toggle switches between them in place (see modal.js). `user` lets the
  // details card recognize the signed-in user in a guest list (RSVP chips);
  // `rsvp` powers the host's per-guest RSVP-link buttons on the details card;
  // `invites` emails those links to the guests; `contacts` suggests people from
  // the user's address book in the guest field; `booking` powers the details
  // card's cancel action for events booked through a booking link; `meetings`
  // mints the editor's Puter Meetings links.
  const modal = createEventModal({
    store,
    user,
    rsvp,
    contacts,
    invites,
    booking,
    meetings,
    mail,
    // A holiday's details card offers to change the country — that picker
    // lives in the account menu, which is where nobody looks for it.
    onHolidaySettings: () => openUserMenu({ focus: 'holidays' }),
    onClockChangeSettings: () => openUserMenu({ focus: 'clock-changes' }),
  });

  // Jump to an event or task from search: move the calendar to its day, then
  // open it. A task has a single `due` instant where an event has `start`.
  const search = createSearch({
    store,
    onPick: (item) => {
      const when = item.isTask ? item.due : item.start;
      state.cursor = startOfDay(new Date(when));
      state.miniCursor = startOfMonth(new Date(when));
      render();
      modal.openView(item);
    },
  });

  /**
   * Rejection handler for a store write nothing awaits — a drag, a resize, a
   * check-off, an Undo. The store updates memory and re-renders BEFORE it
   * awaits the network, so a write that then fails leaves the change on screen
   * and silently gone on the next load; say so, exactly as the editor does.
   * Offline rejections stay quiet: the write-gate already showed its notice.
   */
  function reportWriteFailure(message) {
    return (err) => {
      if (isOfflineError(err)) return;
      console.error(err);
      toast(message, { variant: 'danger' });
    };
  }

  /** Flip one of the sidebar's fold settings. */
  function foldSection(key) {
    Promise.resolve(store.saveSettings({ [key]: !store.getSettings()[key] })).catch(
      reportWriteFailure('Could not save the sidebar layout.'),
    );
  }

  // ---- Actions shared with views + sidebar ----
  const actions = {
    createAt: (defaults) => {
      closeSidebar();
      modal.openNew(defaults);
    },
    // Click = read-only details card; editing is an explicit action from there
    // (or straight from the context menu's Edit).
    openEvent: (ev) => modal.openView(ev),
    selectDate: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      closeSidebar();
      render();
    },
    gotoDayView: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      state.view = 'day';
      render();
    },
    gotoMonthView: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      state.view = 'month';
      render();
    },
    gotoWeekView: (day) => {
      state.cursor = startOfDay(day);
      state.miniCursor = startOfMonth(day);
      state.view = 'week';
      closeSidebar();
      render();
    },
    miniShift: (delta) => {
      state.miniCursor = addMonths(state.miniCursor, delta);
      render();
    },
    toggleColor: (key) => {
      const hidden = new Set(store.getSettings().hiddenColors);
      hidden.has(key) ? hidden.delete(key) : hidden.add(key);
      store.saveSettings({ hiddenColors: [...hidden] });
    },
    // Fold one of the sidebar's two sections away. Persisted like any other
    // view preference, so it stays folded across reloads and devices; a shut
    // header still reports the state it covers (categories the filter is
    // hiding, links no longer taking bookings), so neither can go on acting
    // from behind a closed section.
    toggleCategories: () => foldSection('categoriesCollapsed'),
    toggleBookingLinks: () => foldSection('bookingLinksCollapsed'),
    // Every category back on. Offered by the list view's empty state, the one
    // place where the filter can be mistaken for an empty calendar.
    showAllCategories: () => {
      Promise.resolve(store.saveSettings({ hiddenColors: [] })).catch(
        reportWriteFailure('Could not update the category filter.'),
      );
    },
    // Rename a sidebar category. The palette key is untouched — every event
    // keeps its color, and nothing but `settings.categoryNames` is written.
    // The drawer stays open behind the dialog on mobile: `.dialog-scrim` (100)
    // outranks the drawer (20), so the dialog is over it either way — and
    // closing it would take the row being renamed off screen, drop the focus
    // mountDialog hands back, and make a second rename start with reopening
    // the drawer. Unlike createAt/selectDate, this action leaves the user
    // exactly where they were.
    renameCategory: (key) => {
      const names = store.getSettings().categoryNames || {};
      openCategoryRename({
        key,
        names,
        onSave: (name) => {
          // This category alone, not the whole map: `saveSettings` merges a
          // `categoryNames` patch key-by-key against the cloud copy, so a
          // whole-map patch would carry `names` — as old as this device's last
          // sync — over a rename another device has since made.
          //
          // A cleared name still travels as '' rather than a dropped key: in
          // that same merge, a key that simply isn't there has nothing to
          // overrule the cloud's older name with (see saveSettings).
          Promise.resolve(store.saveSettings({ categoryNames: { [key]: name } })).catch(
            reportWriteFailure('Could not rename the category.'),
          );
        },
      });
    },
    moveEvent: (ev, start, end) => applyTimeChange(ev, start, end, 'Event rescheduled'),
    resizeEvent: (ev, start, end) => applyTimeChange(ev, start, end, 'Event updated'),
    // Advance the period mid-drag when an event is held against a calendar edge,
    // so it can be dropped on a date outside the current viewport. `dir` is -1
    // (previous) or +1 (next). shiftCursor re-renders; the in-flight drag reads
    // its geometry from the live DOM, so it continues against the fresh view.
    edgePage: (dir) => shiftCursor(dir),
    eventContextMenu: (evt, ev) =>
      openContextMenu(evt, [
        { label: 'Edit', action: () => modal.openEdit(ev) },
        { label: 'Duplicate', action: () => duplicateEvent(ev) },
        // A plain event dimmed by an out-of-office block can be un-declined here.
        ...(ev.declined && !ev.seriesId
          ? [
              {
                label: 'Restore (accept)',
                action: () =>
                  Promise.resolve(store.setDeclined(ev.id, false)).catch(
                    reportWriteFailure('Could not restore event.'),
                  ),
              },
            ]
          : []),
        '-',
        { label: 'Delete', danger: true, action: () => deleteWithUndo(ev) },
      ]),
    slotContextMenu: (evt, startMs) =>
      openContextMenu(evt, [
        { label: 'New event', action: () => modal.openNew({ start: startMs }) },
        { label: 'New all-day event', action: () => modal.openNew({ start: startMs, allDay: true }) },
        { label: 'New task', action: () => modal.openNew({ mode: 'task', due: startMs }) },
        { label: 'New out of office', action: () => modal.openNew({ start: startMs, ooo: true, allDay: true }) },
      ]),
    createTask: (defaults) => {
      closeSidebar();
      modal.openNew({ ...defaults, mode: 'task' });
    },
    openTask: (task) => modal.openView(task),
    toggleTask: (task) =>
      Promise.resolve(store.toggleTask(task.id)).catch(reportWriteFailure('Could not update task.')),
    // Drag-to-reschedule a task (month: new day, timegrid: new time). Mirrors
    // moveEvent: optimistic + an Undo that reverts only the due date onto the
    // task's current state (so an edit made while the toast was up isn't lost).
    moveTask: (task, due) => {
      const prev = { due: task.due, allDay: task.allDay };
      Promise.resolve(store.saveTask({ ...task, due })).then(
        () =>
          toast('Task rescheduled', {
            action: {
              label: 'Undo',
              onClick: () =>
                Promise.resolve(store.saveTask({ ...(store.getTask(task.id) || task), ...prev })).catch(
                  reportWriteFailure('Could not undo — please try again.'),
                ),
            },
          }),
        reportWriteFailure('Could not reschedule task.'),
      );
    },
    taskContextMenu: (evt, task) =>
      openContextMenu(evt, [
        {
          label: task.done ? 'Mark as not done' : 'Mark as done',
          action: () => actions.toggleTask(task),
        },
        { label: 'Edit', action: () => modal.openEdit(task) },
        '-',
        { label: 'Delete', danger: true, action: () => deleteTaskWithUndo(task) },
      ]),
    // Booking links (sidebar section → editor dialog; see booking-dialog.js).
    newBookingPage: () => {
      closeSidebar();
      openBookingEditor({ booking, store, user });
    },
    editBookingPage: (page) => {
      closeSidebar();
      openBookingEditor({ booking, store, user, page });
    },
    copyBookingLink: (page) => {
      const url = booking && booking.linkFor(page.id);
      if (!url) {
        toast('Your booking link is still being prepared. Try again in a moment.');
        return;
      }
      const write =
        navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(url)
          : Promise.reject(new Error('clipboard unavailable'));
      write
        .then(() => toast('Booking link copied', { variant: 'success' }))
        .catch(() => toast('Could not copy — clipboard access was blocked.', { variant: 'danger' }));
    },
    // Mail-detected invitations (sidebar "Invitations" section; see
    // mail-intake.js). Fold state persists like the other sidebar sections;
    // Add/Ignore/Block route straight to intake, which owns the tray and
    // re-renders through its own onChange subscription below.
    toggleMailInvites: () => foldSection('mailInvitesCollapsed'),
    addMailInvite: (id) =>
      mail && Promise.resolve(mail.intake.accept(id)).catch(reportWriteFailure('Could not add the invitation.')),
    ignoreMailInvite: (id) =>
      mail && Promise.resolve(mail.intake.ignore(id)).catch(reportWriteFailure('Could not ignore the invitation.')),
    blockMailSender: (id) =>
      mail && Promise.resolve(mail.intake.blockSender(id)).catch(reportWriteFailure('Could not block the sender.')),
    openMailInvites: () => {
      if (!mail) return;
      closeSidebar();
      openMailDialog({ mailbox: mail.mailbox, intake: mail.intake, store, toast });
    },
    // Take the reader to the tray itself, not to the settings dialog: unfold
    // the section (it may be shut) and, on a phone, open the drawer it lives in.
    showMailInvites: () => {
      if (store.getSettings().mailInvitesCollapsed) {
        Promise.resolve(store.saveSettings({ mailInvitesCollapsed: false })).catch(
          reportWriteFailure('Could not open the invitations list.'),
        );
      }
      state.sidebarOpen = true;
      render();
    },
  };

  function deleteTaskWithUndo(task) {
    Promise.resolve(store.deleteTask(task.id)).then(
      () =>
        toast('Task deleted', {
          action: {
            label: 'Undo',
            onClick: () =>
              Promise.resolve(store.saveTask(task)).catch(
                reportWriteFailure('Could not undo — please try again.'),
              ),
          },
        }),
      reportWriteFailure('Could not delete task.'),
    );
  }

  function duplicateEvent(ev) {
    // Occurrences carry no recurrence rule, so a duplicate is a plain one-off.
    // `declined` is derived state (set by an overlapping out-of-office block or
    // an explicit decline of THAT event) — a fresh copy starts active, it
    // doesn't inherit the original's dimmed/declined rendering. `booking` is
    // dropped too: the copy is a new event, not the guest's booking.
    Promise.resolve(store.saveEvent({ ...ev, id: undefined, declined: false, booking: null })).then(
      () => toast('Event duplicated', { variant: 'success' }),
      reportWriteFailure('Could not duplicate event.'),
    );
  }

  /** Turn a store result's `undo` (or a fallback) into a toast Undo action.
   *  Store-returned undos close over raw store internals and bypass the offline
   *  write-gate, so refuse them while offline (read-only) rather than mutate. */
  function undoAction(undo) {
    if (typeof undo !== 'function') return undefined;
    return {
      label: 'Undo',
      onClick: () => {
        if (isBlocked()) return void toast("You're offline — reconnect to make changes");
        Promise.resolve(undo()).catch(reportWriteFailure('Could not undo — please try again.'));
      },
    };
  }

  function deleteWithUndo(ev) {
    if (ev.seriesId) {
      openScopeDialog({ mode: 'delete', onConfirm: (scope) => applyScopedDelete(ev, scope) });
      return;
    }
    // Same offer the details card's delete makes (modal.js handleDelete): the
    // guests who were emailed an invitation get asked about a cancellation,
    // from a snapshot taken while the event still exists.
    const cancel = invites ? invites.cancellationFor(ev) : null;
    Promise.resolve(store.deleteEvent(ev.id)).then(() => {
      toast('Event deleted', {
        action: {
          label: 'Undo',
          onClick: () =>
            Promise.resolve(store.saveEvent(ev)).catch(
              reportWriteFailure('Could not undo — please try again.'),
            ),
        },
      });
      if (cancel) offerCancellation({ invites, store, cancel, toast });
    }, reportWriteFailure('Could not delete event.'));
  }

  function applyScopedDelete(ev, scope) {
    // Snapshot the selected occurrence, or the master for a whole-series delete.
    const cancel = !invites ? null : scope === 'future'
      ? invites.cancellationFor(ev, { future: true })
      : invites.cancellationFor(scope === 'one' ? ev : { id: ev.seriesId });
    let op;
    let fallbackUndo;
    if (scope === 'one') {
      op = store.deleteOccurrence(ev.seriesId, ev.recurrenceId);
    } else if (scope === 'future') {
      op = store.deleteFuture(ev.seriesId, ev.recurrenceId);
    } else {
      op = Promise.resolve(store.deleteEvent(ev.seriesId)).then((master) => {
        fallbackUndo = master ? () => store.saveEvent(master) : null;
        return null;
      });
    }
    Promise.resolve(op).then((res) => {
      toast('Event deleted', { action: undoAction(res && res.undo ? res.undo : fallbackUndo) });
      if (cancel && (scope === 'all' || res)) offerCancellation({ invites, store, cancel, toast });
    }, reportWriteFailure('Could not delete event.'));
  }

  // Persist a drag-to-reschedule or edge-resize, keeping the old span for
  // one-tap undo. For a recurring occurrence this becomes a per-occurrence
  // exception. `message` distinguishes the two gestures in the toast. Moving
  // an event a guest BOOKED gets a plainer warning: nothing tells the guest —
  // their confirmation and manage page keep the original time (see booking.js).
  function applyTimeChange(ev, start, end, message) {
    if (start === ev.start && end === ev.end) return;
    let undone = false;
    const offerUpdate = () => {
      // A booked appointment has its own schedule on the booking worker.
      // Keep its existing warning; sending a regular invite cannot reschedule it.
      if (ev.booking) return;
      offerInvitations({
        eventId: ev.seriesId || ev.id, invites, store,
        canSend: () => {
          const current = store.getEvent(ev.id);
          return !undone && current && current.start === start && current.end === end;
        },
      });
    };
    if (ev.booking && (start !== ev.start || end !== ev.end)) {
      const who = ev.booking.name || ev.booking.email || 'the guest';
      message = `${message} — ${who} won't be notified of the change`;
    }
    if (ev.seriesId) {
      Promise.resolve(store.updateOccurrence(ev.seriesId, ev.recurrenceId, { start, end })).then(
        (res) => {
          if (!res) return;
          toast(message, { action: undoAction(res.undo && (() => {
            undone = true;
            return res.undo();
          })) });
          offerUpdate();
        },
        reportWriteFailure('Could not save the new time.'),
      );
      return;
    }
    const prev = { start: ev.start, end: ev.end };
    Promise.resolve(store.saveEvent({ ...ev, start, end })).then(
      () => {
        toast(message, {
          action: {
            label: 'Undo',
            // Revert only the time, onto the event's CURRENT state, so an edit to
            // another field made while the toast was up isn't clobbered. Falls
            // back to the pre-drag snapshot if the event was since deleted.
            onClick: () => {
              undone = true;
              return Promise.resolve(store.saveEvent({ ...(store.getEvent(ev.id) || ev), ...prev })).catch(
                reportWriteFailure('Could not undo — please try again.'),
              );
            },
          },
        });
        offerUpdate();
      },
      reportWriteFailure('Could not save the new time.'),
    );
  }

  // ---- Navigation ----
  function shiftCursor(dir) {
    if (state.view === 'year') state.cursor = addYears(state.cursor, dir);
    else if (state.view === 'month') state.cursor = addMonths(state.cursor, dir);
    else if (state.view === 'week') state.cursor = addWeeks(state.cursor, dir);
    else if (state.view === '4day') state.cursor = addDays(state.cursor, dir * 4);
    else if (state.view === 'day') state.cursor = addDays(state.cursor, dir);
    else state.cursor = addMonths(state.cursor, dir); // agenda
    state.miniCursor = startOfMonth(state.cursor);
    render();
  }
  function goToday() {
    state.cursor = startOfDay(new Date());
    state.miniCursor = startOfMonth(new Date());
    render();
  }
  // No render() after these saveSettings calls: saveSettings applies the
  // patch to memory and emit()s before its first await, and the store
  // subscription below renders on that emit — synchronously, with the new
  // `state`/settings already in place. A second render() here drew the whole
  // app twice per keystroke (every view switch and settings toggle).
  function setView(view) {
    state.view = view;
    store.saveSettings({ defaultView: view });
  }

  function headerTitle() {
    const s = store.getSettings();
    if (state.view === 'year') return { main: String(state.cursor.getFullYear()) };
    if (state.view === 'month') return { main: formatMonthYear(state.cursor) };
    if (state.view === 'week') {
      const range = formatWeekRange(state.cursor, s.weekStartsOn);
      if (s.showWeekNumbers === true) {
        const week = displayedWeekNumber(startOfWeek(state.cursor, s.weekStartsOn));
        return { main: `${range} · Week ${week}` };
      }
      return { main: range };
    }
    if (state.view === '4day') return { main: formatDateRange(state.cursor, addDays(state.cursor, 3)) };
    if (state.view === 'day') return { main: formatDayTitle(state.cursor) };
    return { main: formatMonthYear(state.cursor), muted: 'and beyond' };
  }

  function closeSidebar() {
    state.sidebarOpen = false;
    shell.classList.remove('sidebar-open');
    // Remove every scrim, not just the last-tracked one, so none can leak.
    shell.querySelectorAll('.scrim').forEach((s) => s.remove());
    scrimEl = null;
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  function openSidebar() {
    if (state.sidebarOpen) return; // idempotent — never stack scrims
    state.sidebarOpen = true;
    shell.classList.add('sidebar-open');
    scrimEl = el('div', { class: 'scrim', on: { click: closeSidebar } });
    shell.append(scrimEl);
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  function toggleSidebar() {
    state.sidebarOpen ? closeSidebar() : openSidebar();
  }

  // ---- Shell (built once) ----
  const headerTitleEl = el('h1', { class: 'header__title' });
  const mainEl = el('main', { class: 'main' });
  const sidebarSlot = el('div', { style: { display: 'contents' } });
  let scrimEl = null;

  const segmented = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Calendar view' });
  const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Calendar view' });
  VIEWS.forEach((v) => {
    segmented.append(
      el('button', {
        type: 'button',
        text: v.label,
        title: `${v.label} view`,
        dataset: { view: v.key },
        on: { click: () => setView(v.key) },
      }),
    );
    tabbar.append(
      el('button', {
        type: 'button',
        class: 'tabbar__btn',
        dataset: { view: v.key },
        html:
          icon(tabIcon(v.key), { size: 'sm' }) + `<span class="tabbar__label">${v.label}</span>`,
        on: { click: () => setView(v.key) },
      }),
    );
  });

  const searchBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'aria-label': 'Search events and tasks',
    title: 'Search events and tasks',
    html: icon('search'),
    on: { click: () => search.open() },
  });

  const avatarBtn = el('button', {
    class: 'avatar',
    type: 'button',
    'aria-label': 'Account and settings',
    'aria-haspopup': 'dialog',
    text: userInitial(user),
    on: { click: (e) => toggleUserMenu(e) },
  });
  // Upgrade the letter to the account's public profile picture when it has one
  // (cached copy first, then a fresh read). Strictly fire-and-forget: every
  // failure path inside keeps the letter, and nothing here can reject.
  showProfilePicture(avatarBtn, user);

  const menuBtn = el('button', {
    class: 'icon-btn menu-toggle',
    type: 'button',
    'aria-label': 'Toggle menu',
    'aria-expanded': 'false',
    html: icon('menu'),
    on: { click: toggleSidebar },
  });

  const header = el('header', { class: 'header' }, [
    menuBtn,
    el('div', { class: 'header__brand' }, [
      el('span', { class: 'brand-mark' }, [
        el('img', { src: '/icon-192.png', alt: '', width: '30', height: '30' }),
      ]),
      el('span', { class: 'brand-name', text: 'Calendar' }),
    ]),
    el('div', { class: 'header__nav' }, [
      el('button', { class: 'btn hide-xs', type: 'button', text: 'Today', on: { click: goToday } }),
      el('div', { class: 'nav-arrows' }, [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Previous',
          html: icon('chevron-left'),
          on: { click: () => shiftCursor(-1) },
        }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Next',
          html: icon('chevron-right'),
          on: { click: () => shiftCursor(1) },
        }),
      ]),
      headerTitleEl,
    ]),
    el('div', { class: 'header__spacer' }),
    el('div', { class: 'header__tools' }, [searchBtn, segmented, avatarBtn]),
  ]);

  const shell = el('div', { class: 'app' }, [header, sidebarSlot, mainEl, tabbar]);
  clear(root);
  root.removeAttribute('aria-busy');
  root.append(shell);

  // ---- Render ----
  let lastViewKey = null;
  let lastCursorMs = null;
  // A store change that arrived mid-drag, waiting for the gesture to end.
  let renderPending = false;

  function render() {
    renderPending = false;
    closeContextMenu();
    const s = store.getSettings();
    // Keep the DOM theme in step with the (possibly just-reloaded) setting. The
    // views read weekStartsOn/hour12/secondaryTz/showWeekNumbers from `s` on every render, but
    // theme is a document-level attribute applied out-of-band — so without this a
    // reconnect reload (onReconnectRefresh → load() → emit → render) would leave
    // the page on its old theme while the setting and the account menu already
    // show the new one. applyTheme is idempotent, so re-running it each render is
    // free for the common case.
    applyTheme(s.theme);
    const now = new Date();
    const ctx = { store, settings: s, cursor: state.cursor, miniCursor: state.miniCursor, now, actions, booking, mail };

    // Header title + active states.
    const title = headerTitle();
    clear(headerTitleEl);
    headerTitleEl.append(document.createTextNode(title.main));
    if (title.muted) headerTitleEl.append(el('span', { class: 'muted', text: ' ' + title.muted }));

    segmented.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.view === state.view)),
    );
    // The phone tab bar states its current view the same way the desktop
    // segmented control does, so it is announced and not only painted.
    tabbar.querySelectorAll('button').forEach((b) => {
      const active = b.dataset.view === state.view;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });

    // Both the sidebar and the view are rebuilt from scratch, which detaches
    // whatever the user last activated and drops keyboard focus to <body>.
    // Remember its data-focus-key now and hand focus to the counterpart in the
    // fresh DOM at the end. Scoped to the two rebuilt regions, so focus living
    // anywhere else (the header, an open dialog) is never yanked.
    const active = document.activeElement;
    const focusKey =
      active && (sidebarSlot.contains(active) || mainEl.contains(active))
        ? active.getAttribute('data-focus-key')
        : null;
    const newSidebar = renderSidebar(ctx);
    if (sidebarSlot.firstChild) sidebarSlot.firstChild.replaceWith(newSidebar);
    else sidebarSlot.append(newSidebar);

    // Preserve the active view's scroll position across same-view re-renders
    // (the time grid's hour scroller, the year view's own scroll, or the
    // agenda list — every re-render source counts: a store change, a settings
    // change, even the minute tick, none of which may yank the list to the top).
    //
    // Except when the period itself moved. The hour grid and the year grid
    // keep their layout from one period to the next, so a kept scroll lands
    // the reader on the same hours or months; the List view is a different
    // list of days entirely, and keeping its offset would open the period the
    // reader just asked for with its first days already scrolled off screen.
    const SCROLL_SEL = '.timegrid__scroll, .year, .agenda';
    const prevScrollEl = mainEl.querySelector(SCROLL_SEL);
    const prevScroll = prevScrollEl?.scrollTop;
    const cursorMs = state.cursor.getTime();
    const keepScroll =
      state.view === lastViewKey &&
      prevScroll != null &&
      (cursorMs === lastCursorMs || !prevScrollEl.classList.contains('agenda'));

    const rendered = renderView(state.view, ctx);
    clear(mainEl);
    mainEl.append(rendered.node);
    rendered.afterMount?.();

    if (keepScroll) {
      const sc = mainEl.querySelector(SCROLL_SEL);
      if (sc) sc.scrollTop = prevScroll;
    }
    lastViewKey = state.view;
    lastCursorMs = cursorMs;

    // Last, so the scroll position above is already restored: preventScroll
    // keeps re-focusing an event chip from yanking the hour grid to it, but the
    // order also matters for engines that ignore the option.
    if (focusKey) restoreShellFocus(focusKey);
  }

  /** Hand focus to the rebuilt counterpart of the control that had it. Matched
   *  by reading each candidate's dataset rather than by building a selector:
   *  an event key carries the event's id, which an import can make an arbitrary
   *  string, and there is nothing to escape when nothing is interpolated. */
  function restoreShellFocus(focusKey) {
    for (const node of shell.querySelectorAll('[data-focus-key]')) {
      if (node.dataset.focusKey !== focusKey) continue;
      if (node.focus) node.focus({ preventScroll: true });
      return;
    }
  }

  function renderView(view, ctx) {
    if (view === 'year') return renderYear(ctx);
    if (view === 'month') return renderMonth(ctx);
    if (view === 'week') return renderWeek(ctx);
    if (view === '4day') return renderFourDay(ctx);
    if (view === 'day') return renderDay(ctx);
    return renderAgenda(ctx);
  }

  // ---- User / settings menu ----
  let popover = null;
  function closeUserMenu() {
    if (!popover) return;
    // Return focus to the avatar only if it's still inside the popover (i.e.
    // closed via Escape/keyboard), so a click elsewhere isn't yanked back.
    const focusInside = popover.box && popover.box.contains(document.activeElement);
    popover.cleanup();
    popover = null;
    if (focusInside && avatarBtn.focus) avatarBtn.focus();
  }
  function toggleUserMenu(e) {
    e.stopPropagation();
    if (popover) return closeUserMenu();
    openUserMenu();
  }
  /**
   * Open the account menu. `focus: 'holidays'` lands focus on the public-holiday
   * country picker (and 'clock-changes' on that toggle) instead of the dialog
   * itself — the details cards' settings actions deep-link here, and the user
   * should be looking at (and able to operate) the one control they came for.
   */
  function openUserMenu({ focus } = {}) {
    if (popover) closeUserMenu();
    const s = store.getSettings();

    const themeSeg = el('div', { class: 'segmented', style: { width: '100%' }, role: 'group', 'aria-label': 'Theme' });
    [
      ['system', 'monitor', 'Auto'],
      ['light', 'sun', 'Light'],
      ['dark', 'moon', 'Dark'],
    ].forEach(([key, ic, label]) => {
      themeSeg.append(
        el('button', {
          type: 'button',
          style: { flex: '1', whiteSpace: 'nowrap' },
          'aria-pressed': String(s.theme === key),
          html: icon(ic, { size: 'sm' }) + `<span>${label}</span>`,
          on: {
            click: () => {
              applyTheme(key);
              store.saveSettings({ theme: key });
              closeUserMenu();
            },
          },
        }),
      );
    });

    const box = el('div', {
      class: 'popover',
      // Not a menu: it holds a segmented control, toggles and a button. Expose
      // it as a labelled dialog and make it programmatically focusable.
      role: 'dialog',
      'aria-label': 'Account and settings',
      tabindex: '-1',
      style: { minWidth: '284px' },
    }, [
      el('div', { class: 'popover__header' }, [
        el('span', { class: 'popover__name', text: (user && user.username) || 'Signed in' }),
        user && user.email
          ? el('span', { class: 'popover__meta', text: user.email })
          : null,
      ]),
      el('div', { style: { padding: '4px 8px 8px' } }, [
        el('span', { class: 'field__label', style: { display: 'block', marginBottom: '6px' }, text: 'Appearance' }),
        themeSeg,
      ]),
      settingToggle('Start week on Monday', s.weekStartsOn === 1, (on) => {
        store.saveSettings({ weekStartsOn: on ? 1 : 0 });
      }),
      settingToggle('Show week numbers', s.showWeekNumbers === true, (on) => {
        store.saveSettings({ showWeekNumbers: on });
      }, { name: 'showWeekNumbers' }),
      settingToggle('24-hour time', !s.hour12, (on) => {
        store.saveSettings({ hour12: !on });
      }),
      el('div', { style: { padding: '4px 8px 8px' } }, [
        el('span', {
          class: 'field__label',
          style: { display: 'block', marginBottom: '6px' },
          text: 'Secondary time zone',
        }),
        buildTzSelect(s.secondaryTz),
      ]),
      el('div', { style: { padding: '4px 8px 8px' } }, [
        el('span', {
          class: 'field__label',
          style: { display: 'block', marginBottom: '6px' },
          text: 'Public holidays',
        }),
        buildHolidaySelect(s.holidayCountry),
      ]),
      settingToggle('Clock changes (daylight saving)', s.clockChanges !== false, (on) => {
        store.saveSettings({ clockChanges: on });
      }, { name: 'clockChanges' }),
      el('div', { class: 'ctx-menu__sep' }),
      mail && mail.mailbox.available()
        ? el('button', {
            class: 'menu-item',
            type: 'button',
            html:
              icon('mail', { size: 'sm' }) +
              `<span>Mailbox invitations…${mailPendingSuffix(mail)}</span>`,
            on: {
              click: () => {
                closeUserMenu();
                actions.openMailInvites();
              },
            },
          })
        : null,
      el('button', {
        class: 'menu-item',
        type: 'button',
        html: icon('swap-vertical', { size: 'sm' }) + '<span>Import &amp; export</span>',
        on: {
          click: () => {
            closeUserMenu();
            openDataDialog({ store });
          },
        },
      }),
      el('div', { class: 'ctx-menu__sep' }),
      el('button', {
        class: 'menu-item',
        type: 'button',
        html: icon('logout', { size: 'sm' }) + '<span>Sign out</span>',
        on: { click: handleSignOut },
      }),
    ]);

    document.body.append(box);
    const rect = avatarBtn.getBoundingClientRect();
    box.style.top = `${rect.bottom + 8}px`;
    box.style.right = `${window.innerWidth - rect.right}px`;
    // Move focus into the popover so keyboard/SR users reach it immediately
    // (it's appended at the end of <body>, far from the avatar in tab order).
    const target =
      focus === 'holidays'
        ? box.querySelector('select[aria-label="Public holidays"]')
        : focus === 'clock-changes'
          ? box.querySelector('input[data-setting="clockChanges"]')
          : null;
    (target || box).focus();

    const onDocDown = (ev) => {
      // contains(), not ===: the avatar may hold a profile-picture <img>. CSS
      // gives it pointer-events: none so in browsers the target stays the
      // button; this is the DOM-level guarantee for anything dispatching on
      // the <img> itself — without it, such a pointerdown would close the
      // popover here only for the button's click handler to reopen it.
      if (!box.contains(ev.target) && !avatarBtn.contains(ev.target)) closeUserMenu();
    };
    const onKey = (ev) => ev.key === 'Escape' && closeUserMenu();
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    popover = {
      box,
      cleanup() {
        document.removeEventListener('pointerdown', onDocDown, true);
        document.removeEventListener('keydown', onKey, true);
        box.remove();
      },
    };
  }

  function buildTzSelect(current) {
    const select = el('select', {
      class: 'select',
      style: { width: '100%' },
      'aria-label': 'Secondary time zone',
    });
    select.append(el('option', { value: '', text: 'None' }));
    select.append(el('option', { value: 'UTC', text: 'UTC', selected: current === 'UTC' }));
    tzPickerGroups(current).forEach(({ label, zones }) => {
      select.append(el('optgroup', { label }, zones.map((z) => el('option', {
        value: z.id,
        text: `${z.city} (${tzOffsetLabel(z.offset)})`,
        selected: z.id === current,
      }))));
    });
    select.addEventListener('change', () => {
      store.saveSettings({ secondaryTz: select.value });
    });
    return select;
  }

  /**
   * Country picker for the public-holiday overlay (see holidays.js).
   *
   * "Automatic" is the default and names the country it resolved to, so the
   * guess is visible rather than mysterious — and when the browser gives
   * nothing recognisable it says so, instead of quietly showing no holidays
   * and leaving the user to wonder whether the feature is broken.
   */
  function buildHolidaySelect(current) {
    const detected = detectCountry();
    const select = el('select', {
      class: 'select',
      style: { width: '100%' },
      'aria-label': 'Public holidays',
    });
    select.append(
      el('option', {
        value: 'auto',
        text: detected ? `Automatic (${countryName(detected)})` : 'Automatic (none detected)',
        selected: current === 'auto' || current == null,
      }),
      el('option', { value: '', text: 'None', selected: current === '' }),
    );
    HOLIDAY_COUNTRIES.forEach((c) => {
      select.append(el('option', { value: c.id, text: c.name, selected: c.id === current }));
    });
    select.addEventListener('change', () => {
      store.saveSettings({ holidayCountry: select.value });
    });
    return select;
  }

  function settingToggle(label, checked, onToggle, { name = '' } = {}) {
    const input = el('input', {
      type: 'checkbox',
      role: 'switch',
      checked,
      // A stable hook for openUserMenu({ focus }) to land on this toggle.
      dataset: name ? { setting: name } : {},
      on: { change: (e) => onToggle(e.target.checked) },
    });
    return el('label', { class: 'menu-item', style: { cursor: 'pointer', justifyContent: 'space-between' } }, [
      el('span', { text: label }),
      el('span', { class: 'switch' }, [
        input,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);
  }

  async function handleSignOut() {
    closeUserMenu();
    // Drop this account's cached calendar so it can't be read offline on a
    // shared machine after sign-out — and its cached address book and profile
    // picture with it.
    clearSnapshot();
    clearCachedPicture();
    if (contacts) {
      contacts.invalidate(); // the snapshot, on disk and in memory
      // …and the Contacts service window we may still be holding open. It runs
      // in the session we are about to end and would otherwise linger — an
      // invisible window holding the previous user's address book — until its
      // own idle timeout. Disposing second so invalidate() can still tell this
      // window's subscribers that the suggestions they were showing are gone.
      contacts.dispose();
    }
    try {
      await signOut();
    } finally {
      window.location.reload();
    }
  }

  // ---- Keyboard shortcuts ----
  // True when any overlay other than search is up (event modal, settings
  // popover, fallback context menu, or a nested dialog — scope chooser, custom
  // recurrence, import/export). Global shortcuts must not act underneath these.
  function otherOverlayOpen() {
    return (
      modal.isOpen() ||
      isContextMenuOpen() ||
      Boolean(popover) ||
      Boolean(document.querySelector('.dialog-scrim'))
    );
  }

  function onKeydown(e) {
    // A shortcut that re-renders (view switch, navigation, new event) would
    // tear down the nodes an in-flight drag measures, committing a bogus move.
    // Ignore keys until the gesture ends — mirrors the tick/resize guards.
    // (Escape-to-cancel is handled by drag.js's own capture-phase listener.)
    if (isDragging()) return;
    // Cmd/Ctrl+K opens search from anywhere (checked before the modifier guard),
    // but never on top of another overlay. If search is already open, re-focus.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (!otherOverlayOpen()) search.open();
      return;
    }
    if (search.isOpen() || otherOverlayOpen()) return;
    // The mobile drawer sits over the calendar behind a scrim, like any other
    // overlay — so Escape dismisses it too, and hands focus back to the button
    // that opened it (the drawer's controls are about to leave the screen).
    if (e.key === 'Escape' && state.sidebarOpen) {
      closeSidebar();
      menuBtn.focus();
      return;
    }
    const tag = (e.target.tagName || '').toLowerCase();
    // altKey too: browser chords like Alt+D (address bar) or Alt+ArrowLeft
    // (history back) reach the page with the plain key in e.key — without the
    // guard they'd also switch the calendar view or move the cursor.
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey)
      return;

    // Match letter shortcuts case-insensitively so CapsLock (or a held Shift)
    // doesn't silently disable them — mirrors the Cmd/Ctrl+K handler above, which
    // accepts both 'k' and 'K'. Only single-character keys are lowercased;
    // named keys like 'ArrowLeft' must keep their exact casing to match below.
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (key) {
      case '/':
        e.preventDefault();
        search.open();
        break;
      case 't':
        goToday();
        break;
      case 'y':
        setView('year');
        break;
      case 'm':
        setView('month');
        break;
      case 'w':
        setView('week');
        break;
      case 'x':
        setView('4day');
        break;
      case 'd':
        setView('day');
        break;
      case 'a':
        setView('agenda');
        break;
      case 'n':
        e.preventDefault();
        modal.openNew({ start: defaultCreate() });
        break;
      case 'ArrowLeft':
        shiftCursor(-1);
        break;
      case 'ArrowRight':
        shiftCursor(1);
        break;
      default:
        return;
    }
  }
  function defaultCreate() {
    const d = startOfDay(state.cursor);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  // ---- Lifecycle ----
  // Never re-render mid-drag: it would tear down the nodes the gesture measures
  // (mirrors the tick/resize/keydown guards below). The intentional edge-page
  // re-render goes through shiftCursor() directly, so it stays unaffected; and
  // the drop-commit's emit lands after the drag has cleared `is-dragging`.
  //
  // Held back, not dropped: a change that lands mid-drag (another app writing
  // through the API, a booking being adopted, a settings merge from another
  // device) is rendered as soon as the gesture ends. A drop that commits a
  // write renders through that write's own emit; a cancelled or no-op drop
  // used to leave the stale view up until the next minute tick.
  //
  // The same for the fallback context menu: render() closes it, so a change
  // landing while it was open yanked it out from under the pointer (the
  // minute tick already waits for it). It is flushed the moment the menu
  // closes — including by the pick that closes it, before its action runs.
  const renderOrDefer = () => {
    if (document.body.classList.contains('is-dragging') || isContextMenuOpen()) renderPending = true;
    else render();
  };
  const unsub = store.subscribe(renderOrDefer);
  // The sidebar's booking-link rows change outside the store too — a page
  // saved, or the share links becoming available once the worker deploys.
  // Same drag guard as the store subscription.
  const unsubBooking = booking ? booking.onUpdate(renderOrDefer) : () => {};
  // The sidebar's Invitations section and the account-menu badge both read
  // live mail state — the tray (intake) and the connection (mailbox) each
  // change independently of any store write.
  const unsubMailIntake = mail ? mail.intake.onChange(renderOrDefer) : () => {};
  const unsubMailbox = mail ? mail.mailbox.onChange(renderOrDefer) : () => {};
  const flushPending = () => {
    if (renderPending) render();
  };
  const unsubDragEnd = onDragEnd(flushPending);
  const unsubMenuClose = onContextMenuClose(flushPending);
  const reminders = createReminderScheduler({ store });
  reminders.start();
  document.addEventListener('keydown', onKeydown);

  // A re-render clears and rebuilds the view; doing so mid-drag would detach the
  // dragged node (and the columns the drag handler measures) while the gesture
  // keeps running against stale/detached nodes, committing a bogus move.
  const isDragging = () => document.body.classList.contains('is-dragging');
  const unbindFileDrop = bindCalendarFileDrop(mainEl, {
    store,
    canImport: () => !otherOverlayOpen() && !search.isOpen() && !isDragging(),
  });

  let resizeRaf = null;
  const onResize = () => {
    if (isDragging()) return;
    // The account popover is anchored to the avatar's rect at open time; a resize
    // would leave it floating out of place, so dismiss it (mirrors the context
    // menu, which closes on resize).
    closeUserMenu();
    // The drawer + scrim are mobile-only; never let them survive a resize.
    if (!window.matchMedia('(max-width: 720px)').matches && state.sidebarOpen) closeSidebar();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(render);
  };
  window.addEventListener('resize', onResize);

  // Re-render each minute so the "now" line and today highlight stay accurate.
  // Skip while any overlay is open (render would tear it down mid-interaction) or
  // while a drag is in flight (see above).
  const tick = setInterval(() => {
    if (otherOverlayOpen() || search.isOpen() || isDragging()) return;
    // render() replaces both the sidebar and the view, so a focused control in
    // either region has to survive it. One that carries a data-focus-key does —
    // render() hands focus to its counterpart. One that doesn't (a day-number
    // button, a column header) would be dropped to <body> under the user, so
    // the tick still waits it out; the clock catches up on a later tick.
    //
    // Waiting on ANY focus inside those regions used to be the rule, and it
    // froze the common case indefinitely: closing an event's details card
    // returns focus to its chip, so from then on the now-line and the "today"
    // highlight simply stopped moving until the user clicked elsewhere.
    const active = document.activeElement;
    const inRebuilt = active && (mainEl.contains(active) || sidebarSlot.contains(active));
    if (inRebuilt && !active.getAttribute('data-focus-key')) return;
    render();
  }, 60_000);

  render();

  return {
    render,
    /** Navigate without changing the user's saved default view. */
    showDate(date, view = 'week') {
      state.cursor = startOfDay(date);
      state.miniCursor = startOfMonth(date);
      state.view = normalizeView(view);
      render();
    },
    /** New invitations landed in the tray while the app was open. Called by
     *  main.js, which wires it to the intake once both exist. */
    notifyMailDetected(count) {
      const n = Number(count) || 0;
      if (n <= 0) return;
      toast(`${n} invitation${n === 1 ? '' : 's'} detected`, {
        action: { label: 'Show', onClick: () => actions.showMailInvites() },
      });
    },
    destroy() {
      unbindFileDrop();
      unsub();
      unsubBooking();
      unsubMailIntake();
      unsubMailbox();
      unsubDragEnd();
      unsubMenuClose();
      reminders.stop();
      clearInterval(tick);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('resize', onResize);
      closeUserMenu();
      closeContextMenu();
      search.close();
    },
  };
}

function normalizeView(v) {
  return VIEWS.some((x) => x.key === v) ? v : 'week';
}

/** " (N)" for the account-menu's "Mailbox invitations…" item, or '' when the
 *  tray is empty. */
function mailPendingSuffix(mail) {
  const n = mail.intake.getPending().length;
  return n ? ` (${n})` : '';
}

function tabIcon(key) {
  const icons = {
    year: 'grid',
    month: 'calendar',
    week: 'calendar-blank',
    '4day': 'columns',
    day: 'clock',
    agenda: 'align-left',
  };
  return icons[key] || 'align-left';
}

/** Apply the theme by toggling the root `data-theme` attribute. */
// Browser / installed-PWA chrome colors; must match --bg in tokens.css and the
// per-scheme <meta name="theme-color"> defaults in index.html.
const THEME_COLORS = { light: '#ffffff', dark: '#0e0f13' };

export function applyTheme(theme) {
  const rootEl = document.documentElement;
  if (theme === 'light' || theme === 'dark') rootEl.dataset.theme = theme;
  else delete rootEl.dataset.theme;
  // The theme-color metas are media-scoped to the OS scheme, which data-theme
  // overrides can't reach — picking "Dark" on a light-mode OS left a white
  // browser/status bar above a dark app. With an explicit theme, force BOTH
  // metas to its color (whichever media matches then yields the right chrome);
  // with 'system', restore the per-scheme defaults.
  for (const m of document.querySelectorAll('meta[name="theme-color"][media]')) {
    const os = (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS[os]);
  }
}
