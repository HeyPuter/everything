/**
 * Item editor modal — create / edit / delete a single event, out-of-office
 * block, or task. All three share one window: a segmented toggle (shown only
 * while creating) switches between them in place, so the user never loses their
 * typing to a different dialog. Tasks live in their own store (see
 * store.saveTask), so task mode routes its own save/delete but reuses the same
 * shared fields (title, all-day, date, notes, color).
 *
 * The modal owns its DOM and talks to the store directly; after any mutation
 * it invokes `onChange` so the app can re-render the active view. Deletions are
 * non-blocking with an Undo toast rather than a confirm dialog.
 */
import { el, clear, linkify } from './dom.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { EVENT_COLORS, DEFAULT_COLOR, categoryLabel } from './colors.js';
import {
  buildPresets,
  matchPreset,
  describeRecurrence,
  normalizeRecurrence,
  isScheduledOccurrence,
  materializeOccurrence,
} from './recurrence.js';
import {
  REMINDER_PRESETS,
  describeReminder,
  ensureNotificationPermission,
  notificationPermission,
  notificationsSupported,
} from './reminders.js';
import { openCustomRecurrence, openScopeDialog, mountDialog } from './recurrence-dialog.js';
import { offerCancellation } from './cancellation-dialog.js';
import { offerInvitations } from './invitation-dialog.js';
import { describeResult } from './invites.js';
import { describeShift } from './dst.js';
import { requestUserEmail } from './auth.js';
import { isBlocked, isOfflineError } from './offline.js';
import { track } from './analytics.js';
import {
  toDateInputValue,
  toTimeInputValue,
  fromDateTimeInputs,
  startOfDay,
  endOfDay,
  addDays,
  diffCalendarDays,
  roundToNearestMinutes,
  addMinutes,
  isSameDay,
  formatTime,
  formatTimeRange,
  formatFullDate,
  formatDateRange,
  formatTimeInZone,
  isValidTimeZone,
  tzLabel,
  tzOffsetLabel,
} from './date-utils.js';
import { createTimeField, ownsEscape } from './time-field.js';

/** What the guest field accepts as an address. Deliberately loose — the mail
 *  server is the real judge — but strict enough that a name or a half-typed
 *  address is never offered, or taken, as a guest. */
const GUEST_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createEventModal({
  store,
  onChange,
  user,
  requestEmail = requestUserEmail,
  rsvp = null,
  // Emails those RSVP links to the guests (see invites.js). Null — or a Puter
  // build without the worker bridge — leaves the card with its copy buttons,
  // which is how the links got out before there was anything to send them.
  invites = null,
  // The user's address book, borrowed from the Contacts app (see contacts.js).
  // Null — or simply unavailable — means the guest field takes typed addresses
  // only, exactly as it did before.
  contacts = null,
  // Booking links (see booking.js). Powers the details card's "Cancel booking"
  // action on events a guest booked through one; null hides that action.
  booking = null,
  // Meeting links for the Puter Meetings app, minted locally from its
  // published stateless recipe (see meetings.js). Null — or simply
  // unavailable — hides the editor's "Add Puter Meetings link" button; a
  // link already on an event still shows and can still be removed.
  meetings = null,
  // Opens the account menu on the public-holiday country picker (see app.js).
  // A holiday's details card offers it as its one action; null hides it.
  onHolidaySettings = null,
  // Likewise for the clock-changes toggle, from a clock change's card.
  onClockChangeSettings = null,
  // Offers to email an RSVP reply for a mail-detected invitation (see
  // mail-reply.js). Null — or an event with no organizer — simply skips the
  // offer; the store write it follows already stands on its own.
  mail = null,
}) {
  let scrim = null;
  let current = null; // the event/task being edited, or null for new
  let mode = 'event'; // 'event' | 'ooo' (out of office) | 'task'
  let color = DEFAULT_COLOR;
  let recurrence = null; // the recurrence rule for this event, or null
  let reminders = []; // minutes-before values for this event (timed events only)
  let guests = []; // RSVP guest list [{ email, name?, status }] (events only)
  let openedGuestsJson = '[]'; // guests as shown at open, to detect a change on save
  let meeting = null; // the meeting link on this event { url, code? }, or null
  let openedMeetingJson = 'null'; // the link as shown at open, to detect a change on save
  let selfRemoved = false; // the user took themself off the list — don't re-add this open
  // The signed-in user's email — how we recognize "me" in a guest list. Puter
  // withholds it from apps until the user grants email access, so this may be
  // empty here and get filled in lazily by ensureSelfEmail().
  let selfEmail =
    user && typeof user.email === 'string' ? user.email.trim().toLowerCase() : '';
  let emailRequest = null; // settled or in-flight ensureSelfEmail() result
  let awaitingEmailSave = false; // a Save is parked on the permission prompt
  let preOooState = null; // event-mode config snapshot, so returning from OOO restores it
  let lastRepeatValue = 'none'; // last committed <select> value (to revert on cancel)
  let openedRuleJson = 'null'; // the rule as shown at open, to detect a Repeat change on save
  let lastFocused = null;
  let onCloseCb = null; // caller cleanup to run when this modal closes (e.g. remove a create preview)
  let viewing = false; // true while the read-only details card (not the editor) is up
  const fields = {};
  const OOO_COLOR = 'graphite';

  function isOpen() {
    return Boolean(scrim);
  }

  function headingFor(m) {
    return m === 'ooo' ? 'New out of office' : m === 'task' ? 'New task' : 'New event';
  }

  /** Switch between Event, Out of office, and Task — all three share this window,
   *  so the user never loses their typing to a different dialog. Only Out of
   *  office *forces* field values (default title, graphite), so it snapshots
   *  the prior config on the way in and restores it on the way out; Event and
   *  Task only change which fields are visible. Shared fields (title, all-day,
   *  color, notes, date, repeat) carry across every switch. */
  function setMode(next) {
    if (next === mode) return applyMode(); // no-op — never re-snapshot OOO-forced state
    if (next === 'ooo') {
      // Snapshot only the fields OOO overrides (default title, graphite color)
      // so switching back restores the user's choices. All-day, the date/time
      // and Repeat are shared fields that carry across every mode — OOO does
      // NOT force all-day, so a timed out-of-office block works just like a
      // timed event (and declines only the events it actually overlaps), and a
      // repeating one ("every Friday afternoon") is an ordinary series.
      preOooState = {
        title: fields.title.value,
        color,
        reminders: [...reminders],
      };
      mode = 'ooo';
      if (!fields.title.value.trim()) fields.title.value = 'Out of office';
      color = OOO_COLOR;
      syncSwatches();
    } else {
      const leavingOoo = mode === 'ooo';
      mode = next; // 'event' or 'task'
      // Restore the pre-OOO config captured on the way in.
      if (leavingOoo && preOooState) {
        fields.title.value = preOooState.title;
        color = preOooState.color;
        reminders = [...preOooState.reminders];
        preOooState = null;
        syncSwatches();
        renderReminders();
      }
    }
    // The toggle only shows while creating, so keep the heading in sync there.
    if (!current) fields.titleHeading.textContent = headingFor(mode);
    applyMode();
  }

  /** Show only the fields each mode uses. Event: everything. Out of office: no
   *  guests / meeting link / notifications (Repeat stays — a recurring away
   *  block is a common need). Task: a single "Due" instant (no end row), a
   *  Completed toggle, and notes — no repeat, notifications, or location. */
  function applyMode() {
    const isOoo = mode === 'ooo';
    const isTask = mode === 'task';
    fields.startLabel.textContent = isTask ? 'Due' : 'Starts';
    fields.endRow.style.display = isTask ? 'none' : '';
    fields.doneRow.style.display = isTask ? '' : 'none';
    fields.repeatField.style.display = isTask ? 'none' : '';
    fields.locationField.style.display = isTask ? 'none' : '';
    // Guests belong to plain events only — an out-of-office block marks you
    // away (it has no invitees) and tasks are personal. Meeting links follow
    // the same rule: you don't video-call your own absence.
    fields.guestsField.style.display = isOoo || isTask ? 'none' : '';
    syncMeetingVisibility();
    fields.descLabel.textContent = isTask ? 'Notes' : 'Description';
    fields.description.placeholder = isTask ? 'Add notes' : 'Add description';
    fields.modeToggle.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode)),
    );
    applyAllDayVisibility();
    // The secondary-zone hint depends on the mode (hidden for a task) — refresh
    // it on every mode switch, not just on open / time edits, so it never goes
    // stale (e.g. a task showing a start–end range, or an event missing it).
    updateTzHint();
  }

  function buildForm() {
    // --- Event / Out of office / Task mode toggle (new events only) ---
    fields.modeToggle = el(
      'div',
      { class: 'segmented modal__mode', role: 'group', 'aria-label': 'Create', style: { display: 'none' } },
      [
        el('button', { type: 'button', text: 'Event', dataset: { mode: 'event' }, 'aria-pressed': 'true', on: { click: () => setMode('event') } }),
        el('button', { type: 'button', text: 'Out of office', dataset: { mode: 'ooo' }, 'aria-pressed': 'false', on: { click: () => setMode('ooo') } }),
        el('button', { type: 'button', text: 'Task', dataset: { mode: 'task' }, 'aria-pressed': 'false', on: { click: () => setMode('task') } }),
      ],
    );

    // --- Title ---
    // The one field every item has — an underline-style input, visually the
    // form's headline rather than one more boxed row.
    fields.title = el('input', {
      class: 'input input--title',
      type: 'text',
      placeholder: 'Add title',
      autocomplete: 'off',
      'aria-label': 'Event title',
    });

    // --- All-day switch ---
    // Label before switch: the label text sits in the editor's shared label
    // column, so the row lines up with Starts / Ends below it.
    fields.allDay = el('input', { type: 'checkbox', role: 'switch' });
    const allDayRow = el('label', { class: 'inline-field', style: { cursor: 'pointer' } }, [
      el('span', { class: 'field__label', text: 'All day' }),
      el('span', { class: 'switch' }, [
        fields.allDay,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);

    // --- Completed switch (task mode only) ---
    fields.doneToggle = el('input', { type: 'checkbox', role: 'switch' });
    fields.doneRow = el('label', { class: 'inline-field', style: { cursor: 'pointer', display: 'none' } }, [
      el('span', { class: 'field__label', text: 'Completed' }),
      el('span', { class: 'switch' }, [
        fields.doneToggle,
        el('span', { class: 'switch__track' }),
        el('span', { class: 'switch__thumb' }),
      ]),
    ]);

    // --- Start / end ---
    fields.startDate = el('input', { class: 'input', type: 'date', 'aria-label': 'Start date' });
    // Time fields open their 15-minute list on the time they already hold (see
    // time-field.js). Choices, not constraints: typing any minute stays
    // allowed, so an off-grid time (say an imported 9:07 start) is kept as-is
    // and can't be refused at Save.
    const hour12 = () => store.getSettings().hour12;
    fields.startTime = createTimeField({ label: 'Start time', hour12 });
    fields.endDate = el('input', { class: 'input', type: 'date', 'aria-label': 'End date' });
    // The end list runs from the start time onward, each choice labeled with
    // the event's length, so the times before the start sit at the bottom and
    // read as the next morning — which is what saving one means here (see
    // timeOrderProblem). Only while the end is on the start's date: once it
    // is on a later date every time of day is a plain choice, and a "1 hr"
    // label next to 10:00 would be a lie.
    fields.endTime = createTimeField({
      label: 'End time',
      hour12,
      after: () => (fields.endDate.value && fields.endDate.value === fields.startDate.value ? fields.startTime.value : ''),
    });

    fields.startLabel = el('span', { class: 'field__label', text: 'Starts' });
    const startRow = el('div', { class: 'field' }, [
      fields.startLabel,
      el('div', { class: 'form-row' }, [fields.startDate, fields.startTime.el]),
    ]);
    fields.endRow = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Ends' }),
      el('div', { class: 'form-row' }, [fields.endDate, fields.endTime.el]),
    ]);

    // Read-only secondary time-zone hint (shown only when a secondary zone is set
    // and the event is timed).
    fields.tzHint = el('div', { class: 'field__label modal__tz-hint', style: { display: 'none' } });

    // --- Repeat ---
    fields.repeat = el('select', { class: 'select', 'aria-label': 'Repeat' });
    fields.repeat.addEventListener('change', onRepeatChange);
    fields.repeatField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Repeat' }),
      fields.repeat,
    ]);

    // --- Notifications (reminders) ---
    fields.reminderList = el('div', { class: 'reminders' });
    fields.reminderAdd = el('button', {
      class: 'btn btn--ghost reminders__add',
      type: 'button',
      html: icon('bell', { size: 'sm' }) + '<span>Add notification</span>',
      on: { click: addReminder },
    });
    fields.reminderHint = el('div', {
      class: 'field__label reminders__hint',
      style: { display: 'none' },
    });
    fields.remindersField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Notifications' }),
      fields.reminderList,
      fields.reminderAdd,
      fields.reminderHint,
    ]);

    fields.error = el('div', {
      class: 'field__label modal__error',
      style: { color: 'var(--danger-ink)', display: 'none' },
      role: 'alert',
    });

    // --- Location ---
    fields.location = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Add location',
      autocomplete: 'off',
      'aria-label': 'Location',
    });
    fields.locationField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Location' }),
      fields.location,
    ]);

    // --- Meeting link (events only; see meetings.js) ---
    fields.meetingBox = el('div', { class: 'meeting' });
    fields.meetingField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Meeting' }),
      fields.meetingBox,
    ]);
    renderMeeting();

    // --- Guests (events only) ---
    // Only the *name* matching needs an address book; the list itself always has
    // something to offer, because whatever address is typed is a pickable row of
    // its own (see refreshSuggestions). So the combobox wiring is unconditional
    // and only what the field promises differs.
    const canSuggest = canSuggestNames();
    fields.guestInput = el('input', {
      class: 'input',
      type: 'text',
      inputmode: 'email',
      placeholder: canSuggest ? 'Add guests by name or email' : 'Add guests',
      autocomplete: 'off',
      'aria-label': canSuggest ? 'Add guest by name or email' : 'Add guest by email',
      role: 'combobox',
      'aria-expanded': 'false',
      'aria-controls': 'guest-suggestions',
      'aria-autocomplete': 'list',
    });
    fields.guestInput.addEventListener('keydown', (e) => {
      // Enter must add the guest, not submit the form; comma commits too.
      // (Arrow/Enter navigation of the suggestion list is handled ahead of this,
      // in the modal's document-level key handler.)
      // Not the Enter that commits an IME composition, though: that one only
      // settles the name being typed — treating it as "add this guest" would
      // flag a half-typed Japanese name as not an address.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commitGuestInput();
      }
    });
    fields.guestInput.addEventListener('input', () => {
      fields.guestInput.removeAttribute('aria-invalid');
      refreshSuggestions();
    });
    // Focus is the last safe moment before someone starts typing a guest, and
    // the one that matters most: "I just added them in Contacts and switched
    // back" ends here. So re-read the address book if ours has aged (a no-op
    // when it hasn't), and only while the field is still empty — a launch is
    // worth avoiding once there is half-typed text to disturb.
    fields.guestInput.addEventListener('focus', () => {
      if (!contacts) return;
      const input = fields.guestInput;
      const stale = !input.value.trim() && typeof contacts.revalidate === 'function';
      const fresh = stale
        ? contacts.revalidate()
        : typeof contacts.warm === 'function'
          ? contacts.warm()
          : null;
      Promise.resolve(fresh)
        .then(() => {
          // The editor is rebuilt on every open, so only refresh if this is
          // still the live field and the user is still in it.
          if (fields.guestInput === input && document.activeElement === input) {
            refreshSuggestions();
          }
        })
        .catch(() => {
          /* no suggestions is a fine outcome */
        });
    });
    // Leaving the field commits valid text silently (so "type then hit Save"
    // includes the typed guest) but never nags about leftovers. It is also the
    // moment a stale address book may be re-read: launching an app while
    // someone is mid-word is the one thing worth avoiding here.
    fields.guestInput.addEventListener('blur', () => {
      closeSuggestions();
      commitGuestInput({ quiet: true });
      if (contacts && contacts.settle) contacts.settle();
    });
    fields.guestList = el('div', { class: 'guests' });
    fields.guestSuggest = el('div', {
      class: 'guests__suggest',
      id: 'guest-suggestions',
      role: 'listbox',
      'aria-label': 'Guest suggestions',
      hidden: true,
    });
    // Input first, added guests listed under it (the suggestion dropdown
    // overlays the list while open) — and the row label stays aligned with
    // the input however long the list grows.
    fields.guestsField = el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Guests' }),
      el('div', { class: 'guests__entry' }, [fields.guestInput, fields.guestSuggest]),
      fields.guestList,
    ]);

    // --- Description / notes ---
    fields.description = el('textarea', {
      class: 'textarea',
      placeholder: 'Add description',
      rows: '3',
      'aria-label': 'Description',
    });
    fields.descLabel = el('span', { class: 'field__label', text: 'Description' });
    fields.descField = el('div', { class: 'field' }, [fields.descLabel, fields.description]);

    // --- Color swatches ---
    fields.swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Event color' });
    EVENT_COLORS.forEach((c) => {
      const sw = el('button', {
        class: 'swatch',
        type: 'button',
        role: 'radio',
        // The palette default, as a floor: syncSwatches replaces both with the
        // user's own category name every time the editor opens.
        title: c.label,
        'aria-label': c.label,
        style: { background: c.hex, '--swatch-color': c.hex },
        on: {
          click: () => {
            color = c.key;
            syncSwatches();
          },
        },
      });
      sw.dataset.color = c.key;
      fields.swatches.append(sw);
    });
    // The radio pattern: one tab stop for the group (the checked swatch), and
    // the arrows move both selection and focus. Nine separate tab stops with
    // no arrow handling announced "radio button, 1 of 9" and then ignored
    // the keys that pattern promises.
    fields.swatches.addEventListener('keydown', (e) => {
      const list = [...fields.swatches.querySelectorAll('.swatch')].filter((b) => !b.disabled);
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let j;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % list.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = list.length - 1;
      else return;
      e.preventDefault();
      color = list[j].dataset.color;
      syncSwatches();
      list[j].focus();
    });

    // --- Buttons ---
    fields.deleteBtn = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      html: icon('trash', { size: 'sm' }) + '<span>Delete</span>',
      on: { click: handleDelete },
    });
    const cancelBtn = el('button', {
      class: 'btn',
      type: 'button',
      text: 'Cancel',
      on: { click: close },
    });
    const saveBtn = el('button', { class: 'btn btn--primary', type: 'submit', text: 'Save' });

    const form = el('form', { class: 'modal modal--editor', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title' }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'modal-title', text: 'Event' }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'aria-label': 'Close',
          html: icon('close'),
          on: { click: close },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        fields.modeToggle,
        el('div', { class: 'field field--title' }, [fields.title]),
        allDayRow,
        startRow,
        fields.endRow,
        fields.doneRow,
        fields.tzHint,
        // The only save errors are about the start/end (or due) instants, so
        // the message belongs right under the time rows it complains about.
        fields.error,
        fields.repeatField,
        fields.remindersField,
        // Schedule above, details below.
        el('hr', { class: 'modal__sep' }),
        fields.guestsField,
        fields.meetingField,
        fields.locationField,
        fields.descField,
        el('div', { class: 'field' }, [
          el('span', { class: 'field__label', text: 'Color' }),
          fields.swatches,
        ]),
      ]),
      el('div', { class: 'modal__foot' }, [
        fields.deleteBtn,
        el('div', { class: 'spacer' }),
        cancelBtn,
        saveBtn,
      ]),
    ]);

    fields.titleHeading = form.querySelector('#modal-title');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSave();
    });

    // Toggling all-day shows/hides the time inputs.
    fields.allDay.addEventListener('change', () => {
      applyAllDayVisibility();
      // Leaving all-day: re-derive the end from the remembered timed duration so
      // the now-visible time inputs show a sensible span. Without this the end
      // keeps the all-day end-of-day value (≈24h after the start), and the next
      // start-time edit would carry that stale duration and push the end onto the
      // following day.
      if (!fields.allDay.checked) {
        const start = readStart();
        if (!Number.isNaN(start.getTime())) writeEnd(new Date(start.getTime() + lastDuration));
      } else {
        // Entering all-day: preserve the whole-day span. Take the larger of the
        // span the (timed) date inputs currently cover and the remembered all-day
        // span, then rewrite the end date to match. The max is what makes an
        // uncheck→recheck round-trip restore a multi-day event: unchecking shrinks
        // the end to a 1-hour block on the start day, so allDaySpanDays() alone
        // would read back a single day and silently collapse the event. A genuine
        // timed→all-day conversion (a longer or cross-midnight timed event) still
        // wins via allDaySpanDays(), since lastDayCount is only ever 1 there.
        lastDayCount = Math.max(allDaySpanDays(), lastDayCount);
        const start = readStart();
        if (!Number.isNaN(start.getTime())) {
          fields.endDate.value = toDateInputValue(addDays(startOfDay(start), lastDayCount - 1));
        }
      }
      updateTzHint();
    });

    // Keep the end anchored to the start's duration when start changes.
    fields.startDate.addEventListener('change', shiftEndWithStart);
    fields.startTime.addEventListener('change', shiftEndWithStart);
    // Changing the start date re-labels the repeat presets ("Weekly on <day>")
    // and re-anchors a "Weekly on <day>" rule to the new weekday, so a weekly
    // event's start always stays one of its own occurrences.
    fields.startDate.addEventListener('change', onStartDateChange);

    // When the user edits the end directly, remember the new duration so a
    // later start change preserves it instead of the stale open-time duration.
    fields.endDate.addEventListener('change', rememberDuration);
    fields.endTime.addEventListener('change', rememberDuration);

    // Keep the secondary-zone hint in sync with any time edit — and clear a
    // stale complaint about the instants once they read cleanly again. Every
    // message this editor shows is about the start/end (or due) fields, so a
    // user who has just fixed them should not be left looking at an error they
    // appear unable to clear.
    ['startDate', 'startTime', 'endDate', 'endTime'].forEach((k) =>
      fields[k].addEventListener('change', () => {
        if (timesValid()) showError('');
        updateTzHint();
      }),
    );

    return form;
  }

  /** Show the start–end range converted to the configured secondary time zone,
   *  for timed events only. No-ops when no secondary zone is set. */
  function updateTzHint() {
    const tz = store.getSettings().secondaryTz;
    const start = readStart();
    const end = readEnd();
    if (
      mode === 'task' ||
      !isValidTimeZone(tz) ||
      fields.allDay.checked ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    ) {
      fields.tzHint.style.display = 'none';
      return;
    }
    const opts = { hour12: store.getSettings().hour12 };
    fields.tzHint.textContent = `${tzLabel(tz)}: ${formatTimeInZone(start.getTime(), tz, opts)} – ${formatTimeInZone(end.getTime(), tz, opts)}`;
    fields.tzHint.style.display = 'block';
  }

  function syncSwatches() {
    // Named here, not at build time: the swatches are built once per modal and
    // a category can be renamed from the sidebar at any point after that. The
    // picker has to say what the sidebar says.
    const names = store.getSettings().categoryNames;
    const swatches = [...fields.swatches.querySelectorAll('.swatch')];
    const checked = swatches.find((sw) => sw.dataset.color === color) || swatches[0];
    swatches.forEach((sw) => {
      // role="radio" → aria-checked (aria-pressed is only valid on toggle buttons).
      sw.setAttribute('aria-checked', String(sw.dataset.color === color));
      // Roving tabindex: Tab reaches the checked swatch; arrows do the rest.
      sw.tabIndex = sw === checked ? 0 : -1;
      const label = categoryLabel(sw.dataset.color, names);
      sw.title = label;
      sw.setAttribute('aria-label', label);
    });
  }

  /* ---- Reminders ------------------------------------------------------ */

  /** Rebuild the reminder rows from the `reminders` array. */
  function renderReminders() {
    clear(fields.reminderList);
    reminders.forEach((min, i) => {
      const select = el('select', { class: 'select', 'aria-label': 'Notification time' });
      // A stored offset that isn't one of the presets (e.g. from an imported
      // file) still needs a matching option, or the <select> would silently
      // display the first preset instead of the real value.
      if (!REMINDER_PRESETS.some((p) => p.min === min)) {
        const opt = el('option', { value: String(min), text: describeReminder(min) });
        opt.selected = true;
        select.append(opt);
      }
      REMINDER_PRESETS.forEach((p) => {
        const opt = el('option', { value: String(p.min), text: p.label });
        if (p.min === min) opt.selected = true;
        select.append(opt);
      });
      select.addEventListener('change', () => setReminderAt(i, Number(select.value)));

      const remove = el('button', {
        class: 'icon-btn reminders__remove',
        type: 'button',
        'aria-label': 'Remove notification',
        title: 'Remove notification',
        html: icon('close', { size: 'sm' }),
        on: { click: () => removeReminderAt(i) },
      });
      fields.reminderList.append(el('div', { class: 'reminders__row' }, [select, remove]));
    });

    // Hide "Add" once every preset is in use (or the 5-reminder cap is hit).
    const atCapacity = reminders.length >= Math.min(5, REMINDER_PRESETS.length);
    fields.reminderAdd.style.display = atCapacity ? 'none' : '';
    updateReminderHint();
  }

  function setReminderAt(i, min) {
    reminders[i] = min;
    reminders = [...new Set(reminders)]; // collapse a duplicate onto the existing row
    renderReminders();
    // The rebuild detached the <select> being operated, dropping keyboard
    // focus to <body> (Chrome fires `change` on every arrow press over a
    // closed select, so this happened mid-choice). Hand focus to the row that
    // now holds the chosen value — the same row, or the one a duplicate
    // collapsed onto.
    const select = [...fields.reminderList.querySelectorAll('select')].find((s) => Number(s.value) === min);
    if (select) select.focus();
  }

  function removeReminderAt(i) {
    reminders.splice(i, 1);
    renderReminders();
    // The remove button just vanished under the keyboard user's focus: move it
    // to the row that took this one's place, or back to "Add notification".
    const removes = fields.reminderList.querySelectorAll('.reminders__remove');
    const next = removes[Math.min(i, removes.length - 1)] || fields.reminderAdd;
    if (next) next.focus();
  }

  function addReminder() {
    const used = new Set(reminders);
    const next = REMINDER_PRESETS.find((p) => !used.has(p.min)) || REMINDER_PRESETS[0];
    reminders.push(next.min);
    renderReminders();
    // Ask for permission on this user gesture, then reflect the outcome.
    Promise.resolve(ensureNotificationPermission()).then(updateReminderHint);
  }

  function updateReminderHint() {
    let msg = '';
    if (reminders.length) {
      if (!notificationsSupported()) {
        msg = 'This browser does not support notifications.';
      } else if (notificationPermission() === 'denied') {
        msg = 'Notifications are blocked in your browser settings.';
      }
    }
    fields.reminderHint.textContent = msg;
    fields.reminderHint.style.display = msg ? 'block' : 'none';
  }

  /* ---- Guests (editor) ------------------------------------------------- */

  const GUEST_STATUS_LABEL = {
    accepted: 'Yes',
    declined: 'No',
    tentative: 'Maybe',
    'needs-action': 'Awaiting',
  };

  /** Is the item in the editor my own event (as opposed to an invitation from
   *  someone else)? True for new events — saving stamps me as the organizer. */
  function selfIsHost() {
    return Boolean(
      selfEmail && !(current && current.organizer && current.organizer.email !== selfEmail),
    );
  }

  /** Rebuild the editor's guest rows from the `guests` array. Guests of an
   *  already-saved event I host also get their RSVP-link copy button here. */
  function renderGuests() {
    const host = selfIsHost();
    const linkMap =
      (current && canOfferLinks(current) && rsvp.linksFor(rsvpEventId(current))) || {};
    clear(fields.guestList);
    guests.forEach((g, i) => {
      const remove = el('button', {
        class: 'icon-btn reminders__remove',
        type: 'button',
        'aria-label': `Remove ${g.email}`,
        title: 'Remove guest',
        html: icon('close', { size: 'sm' }),
        on: {
          click: () => {
            if (g.email === selfEmail) selfRemoved = true;
            guests.splice(i, 1);
            renderGuests();
          },
        },
      });
      const isSelfHost = host && g.email === selfEmail;
      fields.guestList.append(
        el('div', { class: 'guests__row' }, [
          el('span', { class: 'guests__email', text: g.name ? `${g.name} — ${g.email}` : g.email }),
          el('span', {
            class: 'guests__status',
            text: isSelfHost ? 'Organizer' : GUEST_STATUS_LABEL[g.status] || 'Awaiting',
          }),
          !isSelfHost && linkMap[g.email] ? copyLinkButton(linkMap[g.email], g.email) : null,
          remove,
        ]),
      );
    });
  }

  /** The organizer is implicitly a participant (that's how Google models it):
   *  once my own event has other guests, put me at the top of the list as
   *  accepted — unless the user already took themself off this open. Idempotent;
   *  safe to call any time. */
  function maybeAddSelfGuest() {
    if (!scrim || viewing || mode !== 'event' || !selfIsHost() || selfRemoved) return;
    if (!guests.length || guests.some((g) => g.email === selfEmail)) return;
    guests.unshift({ email: selfEmail, status: 'accepted' });
    renderGuests();
  }

  /** Resolve the signed-in user's email, asking Puter for the email-read
   *  permission (a one-time Puter prompt) the first time it's needed. The
   *  outcome — including a denial — is remembered for the session so the user
   *  is never re-prompted while browsing. Resolves to '' when denied. */
  function ensureSelfEmail() {
    if (selfEmail || typeof requestEmail !== 'function') return Promise.resolve(selfEmail);
    if (!emailRequest) {
      emailRequest = Promise.resolve()
        .then(() => requestEmail())
        .then((email) => {
          if (typeof email === 'string' && email.trim()) selfEmail = email.trim().toLowerCase();
          return selfEmail;
        })
        .catch(() => selfEmail);
    }
    return emailRequest;
  }

  /** Add one guest, unless they're already on the list. `name` is optional and
   *  only ever comes from a contact the user picked. */
  function addGuest(email, name = '') {
    if (guests.some((g) => g.email === email)) return;
    guests.push(name ? { email, name, status: 'needs-action' } : { email, status: 'needs-action' });
    renderGuests();
    // First use of the guests feature: start resolving "who am I" now (this
    // may pop Puter's permission prompt), so it's usually settled by the
    // time Save needs it to stamp the organizer — then join me to my own
    // event's list, since the organizer is implicitly a participant.
    ensureSelfEmail().then(maybeAddSelfGuest);
  }

  /** The guest input's text read as an address — what a commit adds, and what
   *  the typed-address suggestion offers, so clicking that row and pressing
   *  Enter can never disagree about who gets invited. */
  function typedGuestEmail() {
    return fields.guestInput.value.trim().replace(/,+$/, '').toLowerCase();
  }

  /** Turn the guest input's text into a guest entry. Returns false (and marks
   *  the field, unless quiet) when the text isn't an email. */
  function commitGuestInput({ quiet } = {}) {
    const email = typedGuestEmail();
    if (!email) return true;
    if (!GUEST_EMAIL_RE.test(email)) {
      if (!quiet) fields.guestInput.setAttribute('aria-invalid', 'true');
      return quiet;
    }
    // An address typed in by hand that the address book has never heard of is
    // the clearest sign our copy of it is behind. Contacts decides what to do
    // with that (and does it after typing stops, never during).
    if (contacts && typeof contacts.noteTyped === 'function') contacts.noteTyped(email);
    addGuest(email);
    fields.guestInput.value = '';
    fields.guestInput.removeAttribute('aria-invalid');
    closeSuggestions();
    return true;
  }

  /* ---- Guest suggestions (contacts, and the typed address) --------------- */

  /** Suggestions currently on screen, and which one is highlighted. Contact
   *  matches carry `{ email, name?, company? }`; the row standing for whatever
   *  is currently typed carries `typed: true`. */
  const SUGGEST_LIMIT = 6;
  let suggestions = [];
  let suggestActive = -1;

  /** Can the address book match names right now? `ready`, not `available`: a
   *  snapshot suggests on its own, so a Contacts app that happens to be
   *  unreachable this second must not cost the user their matches. Cheap by
   *  contract — safe to ask per keystroke. */
  function canSuggestNames() {
    return Boolean(contacts && contacts.ready && contacts.ready());
  }

  function suggestionsOpen() {
    return Boolean(fields.guestSuggest && !fields.guestSuggest.hidden && suggestions.length);
  }

  function closeSuggestions() {
    if (!fields.guestSuggest) return;
    suggestions = [];
    suggestActive = -1;
    fields.guestSuggest.hidden = true;
    clear(fields.guestSuggest);
    fields.guestInput.setAttribute('aria-expanded', 'false');
    fields.guestInput.removeAttribute('aria-activedescendant');
  }

  /** Is this address on the guest list already? Case-insensitively: the list
   *  holds addresses from several places (typed, contacts, a saved event). */
  function invitedAlready(email) {
    const address = String(email).toLowerCase();
    return guests.some((g) => String(g.email).toLowerCase() === address);
  }

  /** Re-run the lookup for whatever is typed. Matching is a local scan of the
   *  snapshot Contacts handed us, so this is cheap enough to do per keystroke;
   *  an empty field shows nothing rather than the whole address book. */
  function refreshSuggestions() {
    if (!fields.guestSuggest) return;
    const query = fields.guestInput.value.trim();
    if (query.length < 1) return closeSuggestions();
    let found = [];
    // Note there is no reachability check here: matching is a local scan, so it
    // works from the snapshot whether or not Contacts can be launched right now.
    if (canSuggestNames()) {
      try {
        // Ask for extras to cover the invited: everyone already on the guest
        // list is filtered out below, and without headroom a query whose best
        // matches are all invited would show nothing while a fresh match sits
        // just past the cutoff.
        found = contacts.suggest(query, SUGGEST_LIMIT + guests.length) || [];
      } catch {
        // A broken address book must never break typing a guest in by hand.
        found = [];
      }
    }
    // Someone already invited isn't a suggestion.
    const matches = found
      .filter((s) => s && s.email && !invitedAlready(s.email))
      .slice(0, SUGGEST_LIMIT);
    // The address being typed is a row of its own, so adding someone the address
    // book has never heard of takes one click like everybody else instead of
    // requiring Enter — the whole point of the list being here. Listed under the
    // contact matches (those carry a name, so they say more), and never as a
    // second copy of one.
    const typed = typedGuestEmail();
    const offerTyped =
      GUEST_EMAIL_RE.test(typed) &&
      !invitedAlready(typed) &&
      !matches.some((s) => String(s.email).toLowerCase() === typed);
    suggestions = offerTyped ? [...matches, { email: typed, typed: true }] : matches;
    if (!suggestions.length) return closeSuggestions();
    renderSuggestions();
  }

  // A read of the address book can land while the user is already typing — the
  // first one of the session, or one that picked up somebody added a moment ago
  // in Contacts. Show it: without this, an empty list stays empty until they
  // press another key, which is indistinguishable from "you have no such
  // contact". Only ever acts on the field the user is actually in.
  if (contacts && typeof contacts.onChange === 'function') {
    contacts.onChange(() => {
      const input = fields.guestInput;
      if (!input || !fields.guestSuggest || document.activeElement !== input) return;
      if (!input.isConnected) return; // an editor that has since been closed
      refreshSuggestions();
    });
  }

  function renderSuggestions() {
    const opening = fields.guestSuggest.hidden;
    clear(fields.guestSuggest);
    suggestions.forEach((s, i) => {
      // A nameless contact is shown by their address, so don't repeat it below.
      const primary = s.name || s.email;
      // The typed row says what picking it does — it is an action, not a person
      // we know something about.
      const secondary = s.typed
        ? 'Add as guest'
        : [s.company, primary === s.email ? '' : s.email].filter(Boolean).join(' · ');
      const row = el(
        'div',
        {
          class: `guests__suggestion${s.typed ? ' guests__suggestion--typed' : ''}`,
          role: 'option',
          id: `guest-opt-${i}`,
          'aria-selected': 'false',
        },
        [
          // A face per row, so the list reads as people rather than as text: the
          // contact's initial, or a mail glyph for an address being typed in.
          s.typed
            ? el('span', { class: 'guests__face', html: icon('mail', { size: 'sm' }) })
            : el('span', {
                class: 'guests__face',
                text: (primary.trim() || String(s.email)).charAt(0),
                'aria-hidden': 'true',
              }),
          el('span', { class: 'guests__suggestion-text' }, [
            el('span', { class: 'guests__suggestion-name', text: primary }),
            secondary ? el('span', { class: 'guests__suggestion-meta', text: secondary }) : null,
          ]),
        ],
      );
      // Prevent pointerdown's default so the press never blurs the field
      // (which would trip the blur-commit) — but PICK on click. Picking on the
      // press itself added whoever was under a finger that landed on the list
      // to scroll it: a swipe starts with a pointerdown too, and only a tap
      // ends in a click. (The time field's list makes the same split.)
      row.addEventListener('pointerdown', (e) => e.preventDefault());
      row.addEventListener('click', () => pickSuggestion(i));
      row.addEventListener('pointermove', () => {
        if (suggestActive !== i) setSuggestActive(i, false);
      });
      fields.guestSuggest.append(row);
    });
    fields.guestSuggest.hidden = false;
    fields.guestInput.setAttribute('aria-expanded', 'true');
    // The list floats inside the modal body, which scrolls: opened near its
    // bottom edge it would sit below the fold, indistinguishable from "no
    // matches". Nudge it into view once, on open — never per keystroke, which
    // would fight the user's own scrolling.
    if (opening && typeof fields.guestSuggest.scrollIntoView === 'function') {
      fields.guestSuggest.scrollIntoView({ block: 'nearest' });
    }
    // Nothing is preselected: Enter must still commit a fully typed address
    // rather than silently swapping in the first contact that looked similar.
    setSuggestActive(-1, false);
  }

  function setSuggestActive(i, scroll = true) {
    suggestActive = i < 0 ? -1 : Math.max(0, Math.min(i, suggestions.length - 1));
    const rows = fields.guestSuggest.querySelectorAll('.guests__suggestion');
    rows.forEach((row, idx) => {
      const on = idx === suggestActive;
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    });
    if (suggestActive < 0) fields.guestInput.removeAttribute('aria-activedescendant');
    else fields.guestInput.setAttribute('aria-activedescendant', `guest-opt-${suggestActive}`);
  }

  function pickSuggestion(i) {
    const s = suggestions[i];
    if (!s) return;
    // The typed row is the field's own text: commit it exactly as Enter would,
    // so the address book still hears about an address it has never seen and
    // there is only one path an address can take onto the list.
    if (s.typed) {
      if (!commitGuestInput()) return;
    } else {
      addGuest(s.email, s.name);
      fields.guestInput.value = '';
      fields.guestInput.removeAttribute('aria-invalid');
      closeSuggestions();
    }
    fields.guestInput.focus();
  }

  /**
   * Keys the open suggestion list owns, handled before the modal's own bindings
   * (Escape would otherwise close the whole editor) and before the input's
   * (Enter would otherwise commit half-typed text). Returns true when the key
   * was consumed.
   */
  function handleSuggestKey(e) {
    if (!suggestionsOpen() || document.activeElement !== fields.guestInput) return false;
    // Mid-IME composition the arrows and Enter belong to the input method's own
    // candidate list, not to ours. (keyCode 229 covers engines that don't set
    // isComposing on the committing Enter.)
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.key === 'ArrowDown') {
      setSuggestActive(suggestActive + 1);
      return true;
    }
    if (e.key === 'ArrowUp') {
      // Up from the top steps back out of the list, into what was typed.
      if (suggestActive <= 0) setSuggestActive(-1, false);
      else setSuggestActive(suggestActive - 1);
      return true;
    }
    if (e.key === 'Escape') {
      closeSuggestions();
      return true;
    }
    if ((e.key === 'Enter' || e.key === 'Tab') && suggestActive >= 0) {
      pickSuggestion(suggestActive);
      return true;
    }
    return false;
  }

  /** Moving the start date follows a single-weekday "Weekly on <day>" rule to the
   *  new weekday (the preset shape), so the start never falls on a day the series
   *  doesn't recur — which would leave the start date without an occurrence.
   *  Multi-day, non-weekly, or every-N-weeks rules are treated as custom and left
   *  alone. Runs only on an explicit start-date change, never on open, so a rule
   *  the user deliberately built is not silently rewritten.
   *
   *  Only when the save will honor the picked start date — a new event or a plain
   *  event, both routed through saveEvent. Editing an existing series (updateSeries
   *  / updateFuture) keeps the master/split's original anchor date and carries only
   *  the time of day across, so re-anchoring the weekday there would desync the
   *  weekday from the kept date and clip the first occurrence. */
  function reanchorWeeklyPreset() {
    if (current && current.seriesId) return;
    if (!recurrence || recurrence.freq !== 'weekly') return;
    // Follow ONLY the plain "Weekly on <day>" preset to the new weekday. A custom
    // weekly rule — a different weekday, every-N-weeks, or a count/until end — is
    // shown via the "__current" option, so its last committed <select> value is
    // never 'weekly'. The old shape test (interval 1 + a single weekday) also
    // matched those custom rules and silently overwrote the weekday the user
    // deliberately chose in the custom builder whenever the start date moved.
    if (lastRepeatValue !== 'weekly') return;
    recurrence = { ...recurrence, byWeekday: [readStart().getDay()] };
  }

  function onStartDateChange() {
    reanchorWeeklyPreset();
    refreshRepeatOptions();
  }

  /** Rebuild the Repeat <select> options + selection for the current start. */
  function refreshRepeatOptions() {
    const start = readStart();
    if (Number.isNaN(start.getTime())) return;
    const startMs = start.getTime();
    const presets = buildPresets(startMs);
    let key = recurrence ? matchPreset(recurrence, startMs) : 'none';

    // A preset rule follows the start date the user picks ("Weekly on Monday"
    // becomes "Weekly on Tuesday" if they move it), while a custom rule stays.
    if (recurrence && key !== 'custom' && key !== 'none') {
      const p = presets.find((x) => x.key === key);
      if (p && p.rule) recurrence = { ...p.rule };
    }

    clear(fields.repeat);
    presets.forEach((p) => {
      if (p.key === 'custom' && key === 'custom' && recurrence) {
        const cur = el('option', { value: '__current', text: describeRecurrence(recurrence, startMs) });
        cur.selected = true;
        fields.repeat.append(cur);
      }
      const opt = el('option', { value: p.key, text: p.label });
      if (p.key === key && key !== 'custom') opt.selected = true;
      fields.repeat.append(opt);
    });
    lastRepeatValue = fields.repeat.value;
  }

  function onRepeatChange() {
    const val = fields.repeat.value;
    if (val === '__current') return; // the current custom rule — no change
    // Every repeat rule is written against the start date: the presets are
    // LABELLED from it ("Weekly on Saturday"), and the custom builder derives
    // its whole form from it — the weekday circle, "Monthly on day N", "the
    // Nth <weekday>", and the earliest date "Ends on" may pick. With the date
    // field cleared (a native date input can always be emptied) that start is
    // an Invalid Date, and the builder rendered "Monthly on day NaN" / "the
    // NaNth undefined" over a blank, min-less end date whose "Ends on" then
    // silently resolved to "never". refreshRepeatOptions already refuses to
    // run without a valid start; refuse to change the rule for the same
    // reason, and say why instead of leaving a dead-looking dropdown.
    const start = readStart();
    if (Number.isNaN(start.getTime())) {
      // Snap back and say why, but do NOT move focus to the date field: Chrome
      // fires `change` on every arrow press over a closed <select>, so a
      // keyboard user stepping through Repeat would have the keypress swallowed
      // and be teleported out of the control they were using. The message is
      // role="alert" and sits directly above this row.
      fields.repeat.value = lastRepeatValue;
      showError('Pick a start date before setting a repeat.');
      return;
    }
    if (val === 'custom') {
      // Revert the visible selection until the dialog resolves.
      fields.repeat.value = lastRepeatValue;
      // "Ends on" may not precede the series' first occurrence. For a series
      // occurrence that floor is the MASTER's start (an earlier bound
      // legitimately shortens the series); for a plain/new event it is the
      // displayed start itself.
      const master = current && current.seriesId ? store.getEvent(current.seriesId) : null;
      openCustomRecurrence({
        rule: recurrence,
        startMs: start.getTime(),
        anchorMs: master ? master.start : start.getTime(),
        weekStartsOn: store.getSettings().weekStartsOn,
        onDone: (rule) => {
          recurrence = rule;
          refreshRepeatOptions();
        },
      });
      return;
    }
    const startMs = start.getTime();
    const preset = buildPresets(startMs).find((p) => p.key === val);
    recurrence = preset && preset.rule ? { ...preset.rule } : null;
    refreshRepeatOptions();
  }

  function applyAllDayVisibility() {
    const allDay = fields.allDay.checked;
    fields.startTime.hidden = allDay;
    fields.endTime.hidden = allDay;
    // Reminders are minute offsets from the start time — meaningless for an
    // all-day event, and neither out-of-office blocks nor tasks carry them.
    fields.remindersField.style.display = allDay || mode === 'ooo' || mode === 'task' ? 'none' : '';
  }

  function readStart() {
    return fromDateTimeInputs(fields.startDate.value, fields.allDay.checked ? '00:00' : fields.startTime.value);
  }
  function readEnd() {
    return fromDateTimeInputs(fields.endDate.value, fields.allDay.checked ? '00:00' : fields.endTime.value);
  }

  /** Is a time field the current mode saves sitting empty? readStart/readEnd
   *  read '' as 00:00, which is right for every consumer that only wants the
   *  date — but a save must not turn a cleared time into midnight without a
   *  word. Only a native time input (touch devices) can be emptied; the
   *  combobox keeps its last committed time. */
  function timesMissing() {
    if (fields.allDay.checked) return false;
    if (!fields.startTime.value) return true;
    return mode !== 'task' && !fields.endTime.value;
  }

  /** Why the start and end, as entered, don't describe a span — or '' when
   *  they do. An end time earlier than the start on the SAME date is not a
   *  problem: it means the next morning (a 10 PM – 1 AM party), and readTimes
   *  rolls it over midnight. An end on an earlier date, or equal to the
   *  start, is a mistake to name — the editor used to quietly save a
   *  30-minute event (or a one-day all-day event) instead of what was typed. */
  function timeOrderProblem() {
    if (mode === 'task') return '';
    const start = readStart();
    const end = readEnd();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
    if (fields.allDay.checked) {
      return startOfDay(end) < startOfDay(start) ? "The end date can't be before the start date." : '';
    }
    if (end > start) return '';
    const sameDay = startOfDay(start).getTime() === startOfDay(end).getTime();
    if (sameDay && end < start) return '';
    return sameDay ? 'The end time must be after the start time.' : "The end can't be before the start.";
  }

  /** Do the time fields the current mode actually saves read as real instants
   *  in the right order? A task has only a due instant (the start row); the
   *  end row is hidden and its inputs stay empty while editing one, so it
   *  must not count. */
  function timesValid() {
    if (timesMissing()) return false;
    if (Number.isNaN(readStart().getTime())) return false;
    if (mode === 'task') return true;
    return !Number.isNaN(readEnd().getTime()) && !timeOrderProblem();
  }

  let lastDuration = 60 * 60_000;
  // The whole-day span (in calendar days) to preserve when an *all-day* event's
  // start date moves. Tracked separately from `lastDuration` (a timed, ms span)
  // because an all-day event's 1-hour `lastDuration` — kept sensible for the
  // "uncheck All day" case — would otherwise collapse a multi-day all-day event
  // to a single day the first time its start date is moved.
  let lastDayCount = 1;
  /** Whole-day span currently shown in the (all-day) date inputs, >= 1. */
  function allDaySpanDays() {
    const s = fromDateTimeInputs(fields.startDate.value, '00:00');
    const e = fromDateTimeInputs(fields.endDate.value, '00:00');
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
    return Math.max(1, diffCalendarDays(s, e) + 1);
  }
  function shiftEndWithStart() {
    const start = readStart();
    if (Number.isNaN(start.getTime())) return;
    if (fields.allDay.checked) {
      // Move the end date by the same number of days as the start, preserving
      // the whole-day span. (The end time input is hidden for all-day events.)
      fields.endDate.value = toDateInputValue(addDays(startOfDay(start), lastDayCount - 1));
      return;
    }
    const newEnd = new Date(start.getTime() + lastDuration);
    fields.endDate.value = toDateInputValue(newEnd);
    fields.endTime.value = toTimeInputValue(newEnd);
  }
  function rememberDuration() {
    const start = readStart();
    const end = readEnd();
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;
    // For an all-day event, track only the whole-day span. `lastDuration` must
    // stay the timed default (a 1-hour block) so unchecking All day collapses to
    // a sensible short event — deriving it from the ~24h all-day span here would
    // make "uncheck All day" spill the end onto the next calendar day.
    if (fields.allDay.checked) {
      lastDayCount = allDaySpanDays();
    } else {
      let endMs = end.getTime();
      // Same date, earlier clock time: the editor reads that as the next
      // morning (a 10 PM – 1 AM party — see readTimes). Measure the same span
      // here, or the next start edit would re-apply a stale, shorter duration
      // and quietly collapse the party to an hour on the same evening.
      if (endMs < start.getTime() && startOfDay(start).getTime() === startOfDay(end).getTime()) {
        endMs = addDays(end, 1).getTime();
      }
      if (endMs > start.getTime()) lastDuration = endMs - start.getTime();
      // An explicit timed end edit is the user's newest span intent, so it also
      // re-baselines the remembered whole-day count. Otherwise re-checking
      // "All day" would restore a stale, larger span from before the toggle
      // (the max() in the all-day handler exists only to survive the
      // *untouched* uncheck→recheck round-trip, where no end edit happens).
      lastDayCount = allDaySpanDays();
    }
  }

  function writeStart(date) {
    fields.startDate.value = toDateInputValue(date);
    fields.startTime.value = toTimeInputValue(date);
  }
  function writeEnd(date) {
    fields.endDate.value = toDateInputValue(date);
    fields.endTime.value = toTimeInputValue(date);
  }

  function showError(msg) {
    fields.error.textContent = msg;
    fields.error.style.display = msg ? 'block' : 'none';
  }

  /* ---- Meeting link ------------------------------------------------------ */

  /** The Meeting row earns its place only when it has something to show: the
   *  event's link, or the button to mint one. Events only — see applyMode. */
  function syncMeetingVisibility() {
    if (!fields.meetingField) return;
    const relevant = mode === 'event' && fields.meetingBox.childNodes.length > 0;
    fields.meetingField.style.display = relevant ? '' : 'none';
  }

  function renderMeeting() {
    if (!fields.meetingBox) return;
    clear(fields.meetingBox);
    if (meeting && meeting.url) {
      fields.meetingBox.append(
        el('div', { class: 'meeting__row' }, [
          el('a', {
            class: 'linkified meeting__url',
            href: meeting.url,
            text: meeting.url,
            target: '_blank',
            rel: 'noopener noreferrer',
          }),
          el('button', {
            class: 'icon-btn meeting__action',
            type: 'button',
            'aria-label': 'Copy meeting link',
            title: 'Copy meeting link',
            html: icon('copy', { size: 'sm' }),
            on: { click: () => copyText(meeting.url, 'Meeting link copied') },
          }),
          el('button', {
            class: 'icon-btn meeting__action',
            type: 'button',
            'aria-label': 'Remove meeting link',
            title: 'Remove meeting link',
            html: icon('close', { size: 'sm' }),
            on: { click: removeMeetingLink },
          }),
        ]),
      );
    } else if (meetings && meetings.available()) {
      fields.meetingBox.append(
        el('button', {
          class: 'btn btn--ghost meeting__add',
          type: 'button',
          html: icon('video', { size: 'sm' }) + '<span>Add Puter Meetings link</span>',
          on: { click: addMeetingLink },
        }),
      );
    }
    // No link and nothing to offer (no meetings module, or no crypto to mint
    // with): the box stays empty and the row hides itself.
    syncMeetingVisibility();
  }

  /** Mint a meeting link and put it on the form. Minting is local and
   *  instant — nothing exists anywhere until someone opens the link and
   *  starts the meeting — so a link discarded before saving simply never
   *  was, and there is nothing to release. */
  function addMeetingLink() {
    if ((meeting && meeting.url) || !meetings || !meetings.available()) return;
    const link = meetings.mintLink();
    meeting = { url: link.url, code: link.code };
    track('Meeting Link Added');
    renderMeeting();
    // The clicked button is gone from the DOM — hand keyboard focus to the
    // link row's first action rather than dropping it on <body>.
    fields.meetingBox.querySelector('.meeting__action')?.focus();
  }

  function removeMeetingLink() {
    // An unstarted link is inert and a saved one may be in guests' hands —
    // either way removal only detaches it from this event.
    meeting = null;
    renderMeeting();
    // Same courtesy in reverse: the remove button just vanished under the
    // keyboard user's focus.
    fields.meetingBox.querySelector('.meeting__add')?.focus();
  }

  async function handleSave() {
    if (mode === 'task') return handleSaveTask();
    // Commit any guest email still sitting in the input; refuse to save while
    // it holds text that isn't an email (the field is marked, focus returns).
    if (mode === 'event' && !commitGuestInput()) {
      fields.guestInput.focus();
      return;
    }
    const readTimes = () => {
      const allDay = fields.allDay.checked;
      let start = readStart();
      let end = readEnd();
      if (timesMissing() || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        showError('Please provide valid start and end times.');
        return null;
      }
      const problem = timeOrderProblem();
      if (problem) {
        showError(problem);
        return null;
      }
      if (allDay) {
        start = startOfDay(start);
        end = endOfDay(end);
      } else if (end < start) {
        // Same date, earlier clock time (timeOrderProblem passed everything
        // else): the end is the next morning. Both typed times are kept.
        end = addDays(end, 1);
      }
      return { allDay, start, end };
    };
    let times = readTimes();
    if (!times) return;

    // Stamping the organizer on a guest-bearing event needs to know who "me"
    // is, which may pop Puter's permission prompt. Park this save on it (and
    // swallow further Save clicks meanwhile); the modal may have been closed —
    // or switched to task mode — by the time it settles.
    if (mode === 'event' && guests.length && !selfEmail && !(current && current.organizer)) {
      if (awaitingEmailSave) return;
      // The editor stays interactive while the prompt is up. Guard on the
      // SCRIM'S IDENTITY, not just its presence: a close followed by opening a
      // different event replaces the scrim, and resuming here would save the
      // new editor's fields under the old editor's intent (then yank it shut).
      const scrimAtSave = scrim;
      awaitingEmailSave = true;
      try {
        await ensureSelfEmail();
      } finally {
        awaitingEmailSave = false;
      }
      if (!scrim || scrim !== scrimAtSave || viewing) return;
      if (mode === 'task') return handleSaveTask();
      // Re-read the times: edits made while parked must not be dropped while
      // the text fields (read live below) are kept — a mixed snapshot.
      times = readTimes();
      if (!times) return;
    }
    const { allDay, start, end } = times;
    // Snapshot the guest list as the USER left it before the organizer
    // auto-add below: the scope chooser's "did guests change?" must reflect
    // their edits only, or a title-only edit on a series whose list doesn't
    // carry the host (imported events; a host who removed themself on an
    // earlier open) loses its "This event" scope over a change nobody made.
    // Scope 'one' is safe either way — overrides never carry guests.
    const guestsJsonBeforeAutoAdd = JSON.stringify(guests);
    // The chained add from commitGuestInput is a microtask away — make sure an
    // immediate Save still carries me on my own event's guest list.
    maybeAddSelfGuest();

    const isOoo = mode === 'ooo';
    // Out-of-office blocks have no invitees. For your own event the organizer
    // becomes you the moment it has guests (that's what ICS export emits); an
    // imported invitation keeps its original organizer.
    const organizer =
      (current && current.organizer) ||
      (!isOoo && guests.length && selfEmail ? { email: selfEmail } : null);
    // The host is implicitly going: adding yourself to your own event must not
    // leave you "awaiting" your own reply.
    const selfIsOrganizer = Boolean(selfEmail && organizer && organizer.email === selfEmail);
    const fieldsPayload = {
      title: fields.title.value.trim() || (isOoo ? 'Out of office' : ''),
      description: fields.description.value.trim(),
      location: fields.location.value.trim(),
      start: start.getTime(),
      end: end.getTime(),
      allDay,
      color,
      ooo: isOoo,
      // All-day / out-of-office blocks don't carry reminders.
      reminders: allDay || isOoo ? [] : [...reminders],
      guests: isOoo
        ? []
        : guests.map((g) =>
            selfIsOrganizer && g.email === selfEmail && g.status === 'needs-action'
              ? { ...g, status: 'accepted' }
              : { ...g },
          ),
      organizer,
      // Null removes an existing link (see store.updateSeries); out-of-office
      // blocks never carry one.
      meeting: !isOoo && meeting ? { ...meeting } : null,
    };

    // Editing one occurrence of a recurring series: ask which occurrences the
    // change applies to, then route to the matching store operation.
    if (current && current.seriesId) {
      const occ = current;
      const rule = recurrence;
      // A per-occurrence override can't carry a recurrence rule, so scope
      // "This event" would silently discard a Repeat change (while still
      // pinning a full override). When the rule changed, offer only the scopes
      // that can honor it — as Google Calendar does. Compare NORMALIZED
      // shapes: the custom dialog rebuilds a sparse object, so a no-op
      // round-trip through it would otherwise read as a change.
      const ruleChanged =
        JSON.stringify(normalizeRecurrence(rule, start.getTime()) ?? null) !== openedRuleJson;
      // A per-occurrence override can't carry a guest list either (guests live
      // on the series master), so a guest change also rules out "This event".
      const guestsChanged = guestsJsonBeforeAutoAdd !== openedGuestsJson;
      // Nor a meeting link — one room serves the whole series.
      const meetingChanged = JSON.stringify(meeting ?? null) !== openedMeetingJson;
      openScopeDialog({
        mode: 'edit',
        allowOne: !ruleChanged && !guestsChanged && !meetingChanged,
        onConfirm: (scope) => {
          applySeriesSave(occ, fieldsPayload, rule, scope);
          close();
        },
      });
      return;
    }

    // A plain event, or a new event (which becomes a series when a rule is set).
    const editing = Boolean(current);
    const payload = { id: current ? current.id : undefined, ...fieldsPayload };
    // Here `start` is the series anchor (first occurrence), so an "ends on"
    // bound before it means zero occurrences — the event would vanish from
    // every view. Reachable by picking a valid end date, then moving the start
    // date past it. Clamp to the start's own day (a single occurrence).
    // Series-scope edits (above) are exempt: there the anchor is the master's,
    // not the displayed occurrence, and an earlier `until` legitimately
    // shortens the series.
    const clampedRule =
      recurrence && recurrence.until != null && recurrence.until < start.getTime()
        ? { ...recurrence, until: endOfDay(start).getTime() }
        : recurrence;
    if (clampedRule) payload.recurrence = clampedRule;
    else if (current && current.recurrence) payload.recurrence = null;

    // Did this save arm a reminder that wasn't there before? (none → some,
    // on create or edit — the moment the user starts relying on notifications.)
    const hadReminders = editing && current && Array.isArray(current.reminders) && current.reminders.length > 0;
    const armedReminder = fieldsPayload.reminders.length > 0 && !hadReminders;

    // Moving an event a guest BOOKED deserves a plain warning: nothing tells
    // the guest — their confirmation and manage page keep the original time
    // (see booking.js; the honest path for a real change is Cancel booking).
    const movedBookingWho =
      editing && current && current.booking && (payload.start !== current.start || payload.end !== current.end)
        ? current.booking.name || current.booking.email || 'the guest'
        : '';

    const before = current && store.getEvent(current.id);
    Promise.resolve(store.saveEvent(payload))
      .then((saved) => {
        onChange && onChange();
        if (saved && saved.ooo) {
          return Promise.all([offerSavedInvitations(before, saved), applyOooDecline(saved, editing)]);
        }
        toast(
          editing
            ? movedBookingWho
              ? `Event updated — ${movedBookingWho} won't be notified of the change`
              : 'Event updated'
            : 'Event created',
          { variant: 'success' },
        );
        if (!editing) track('Event Created');
        if (armedReminder) track('Reminder Set');
        // Guests only learn about an event if someone tells them. Ask now,
        // while this save is still the thing the host has in mind.
        return offerSavedInvitations(before, saved);
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not save event. Please try again.', { variant: 'danger' });
      });

    close();
  }

  /** Save the current form as a task. Tasks live in their own store (own KV
   *  prefix), so this never touches event logic — it reuses this window's shared
   *  fields: title, all-day, the start inputs (as the single "Due" instant),
   *  the description textarea (as notes), and color. */
  function handleSaveTask() {
    const allDay = fields.allDay.checked;
    const due = readStart();
    if (timesMissing() || Number.isNaN(due.getTime())) {
      showError(timesMissing() ? 'Please provide a due time.' : 'Please provide a valid due date.');
      return;
    }
    const editing = Boolean(current);
    const payload = {
      id: current ? current.id : undefined,
      title: fields.title.value.trim(),
      notes: fields.description.value.trim(),
      due: due.getTime(),
      allDay,
      done: fields.doneToggle.checked,
      color,
    };
    Promise.resolve(store.saveTask(payload))
      .then(() => {
        onChange && onChange();
        toast(editing ? 'Task updated' : 'Task created', { variant: 'success' });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not save task. Please try again.', { variant: 'danger' });
      });
    close();
  }

  /** After saving an out-of-office block, dim (decline) the plain events it now
   *  overlaps, and surface an Undo for the batch. `quiet` skips the plain
   *  confirmation when nothing was declined — for a caller that already
   *  toasted the save itself (a series-scope edit, whose toast carries the
   *  edit's own Undo). */
  function applyOooDecline(ooo, editing, { quiet = false } = {}) {
    return Promise.resolve(store.applyOutOfOffice(ooo)).then((res) => {
      onChange && onChange();
      const n = res && res.declined ? res.declined.length : 0;
      if (!n) {
        if (!quiet) toast(editing ? 'Out of office updated' : 'Out of office set', { variant: 'success' });
        return;
      }
      toast(`Out of office set · ${n} event${n === 1 ? '' : 's'} declined`, {
        variant: 'success',
        action: {
          label: 'Undo',
          onClick: () => {
            if (isBlocked()) return void toast("You're offline — reconnect to make changes");
            Promise.resolve(res.undo())
              .then(() => onChange && onChange())
              .catch(reportUndoFailure);
          },
        },
      });
    });
  }

  function applySeriesSave(occ, payload, rule, scope) {
    const before = store.getEvent(occ.seriesId);
    let op;
    if (scope === 'one') {
      op = store.updateOccurrence(occ.seriesId, occ.recurrenceId, payload);
    } else if (scope === 'future') {
      op = store.updateFuture(occ.seriesId, occ.recurrenceId, { ...payload, recurrence: rule });
    } else {
      op = store.updateSeries(occ.seriesId, { ...payload, recurrence: rule });
    }
    Promise.resolve(op)
      .then((res) => {
        onChange && onChange();
        const isOoo = Boolean(res && res.event && res.event.ooo);
        toast(isOoo ? 'Out of office updated' : 'Event updated', { variant: 'success', action: undoAction(res) });
        // A series' guests live on its master, whichever scope was saved.
        const invitations = offerSavedInvitations(before, res && res.event, {
          recurrenceId: scope === 'future' ? occ.recurrenceId : null,
        });
        if (!isOoo) return invitations;
        // A repeating out-of-office block declines what it now overlaps, like
        // a one-off one does on save. The store hands back the master for
        // every scope; for "This event" only the edited occurrence moved, so
        // sweep just its (override-applied) window, not the whole series.
        const swept = scope === 'one' ? materializeOccurrence(res.event, occ.recurrenceId) : res.event;
        return Promise.all([invitations, swept ? applyOooDecline(swept, true, { quiet: true }) : null]);
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not save event. Please try again.', { variant: 'danger' });
      });
  }

  /** Build an Undo toast action from a store result exposing `undo`. The undo
   *  closes over raw store internals and bypasses the offline write-gate, so
   *  refuse it while offline (read-only) instead of mutating / hitting the KV. */
  function undoAction(res) {
    if (!res || typeof res.undo !== 'function') return undefined;
    return {
      label: 'Undo',
      onClick: () => {
        if (isBlocked()) return void toast("You're offline — reconnect to make changes");
        Promise.resolve(res.undo())
          .then(() => onChange && onChange())
          .catch(reportUndoFailure);
      },
    };
  }

  /**
   * Rejection handler for an Undo. The store restores memory and re-renders
   * BEFORE it awaits the network, so an undo whose write then fails leaves the
   * event back on screen and silently gone again on the next load — say so,
   * exactly as app.js does for its own Undo actions. Offline rejections stay
   * quiet: the write-gate already showed its notice.
   */
  function reportUndoFailure(err) {
    if (isOfflineError(err)) return;
    console.error(err);
    toast('Could not undo — please try again.', { variant: 'danger' });
  }

  function handleDelete() {
    if (!current) return close();
    if (mode === 'task') return handleDeleteTask();
    const removed = current;

    // Deleting one occurrence of a recurring series: ask the scope first.
    if (removed.seriesId) {
      openScopeDialog({
        mode: 'delete',
        onConfirm: (scope) => {
          applySeriesDelete(removed, scope);
          close();
        },
      });
      return;
    }

    // Guests who were emailed an invitation deserve to hear it's off — and by
    // the time anyone can ask, the event (and their links) will be gone, so
    // what the mail needs is snapshotted while it still exists.
    const cancel = invites ? invites.cancellationFor(removed) : null;
    Promise.resolve(store.deleteEvent(removed.id))
      .then(() => {
        onChange && onChange();
        toast('Event deleted', {
          variant: 'default',
          action: {
            label: 'Undo',
            onClick: () => {
              Promise.resolve(store.saveEvent(removed))
                .then(() => onChange && onChange())
                .catch(reportUndoFailure);
            },
          },
        });
        if (cancel) offerCancellation({ invites, store, cancel, toast });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not delete event.', { variant: 'danger' });
      });
    close();
  }

  function handleDeleteTask() {
    const removed = current;
    if (!removed) return close();
    Promise.resolve(store.deleteTask(removed.id))
      .then(() => {
        onChange && onChange();
        toast('Task deleted', {
          variant: 'default',
          action: {
            label: 'Undo',
            onClick: () =>
              Promise.resolve(store.saveTask(removed))
                .then(() => onChange && onChange())
                .catch(reportUndoFailure),
          },
        });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not delete task.', { variant: 'danger' });
      });
    close();
  }

  function applySeriesDelete(occ, scope) {
    // The selected occurrence keeps its original slot and current details;
    // whole-series cancellations use the master that owns the guest list.
    const cancel = !invites ? null : scope === 'future'
      ? invites.cancellationFor(occ, { future: true })
      : invites.cancellationFor(scope === 'one' ? occ : { id: occ.seriesId });
    let op;
    let fallbackUndo;
    if (scope === 'one') {
      op = store.deleteOccurrence(occ.seriesId, occ.recurrenceId);
    } else if (scope === 'future') {
      op = store.deleteFuture(occ.seriesId, occ.recurrenceId);
    } else {
      // Whole series: deleteEvent returns the removed master to re-save on undo.
      op = Promise.resolve(store.deleteEvent(occ.seriesId)).then((master) => {
        fallbackUndo = master ? () => store.saveEvent(master) : null;
        return null;
      });
    }
    Promise.resolve(op)
      .then((res) => {
        onChange && onChange();
        const action = res && res.undo ? undoAction(res) : undoAction({ undo: fallbackUndo });
        toast('Event deleted', { variant: 'default', action });
        if (cancel && (scope === 'all' || res)) offerCancellation({ invites, store, cancel, toast });
      })
      .catch((err) => {
        if (isOfflineError(err)) return; // the offline notice already showed
        console.error(err);
        toast('Could not delete event.', { variant: 'danger' });
      });
  }

  function trapFocus(e) {
    if (e.key !== 'Tab' || !scrim) return;
    const focusables = scrim.querySelectorAll(
      'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const list = [...focusables].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (!scrim.contains(document.activeElement)) {
      // Clicking a non-interactive part of the dialog (a label, padding) blurs
      // focus to <body>; the next Tab would then walk the page BEHIND the
      // aria-modal scrim. Pull it back inside instead.
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e) {
    // A nested dialog (custom recurrence / scope chooser) handles its own keys.
    if (document.querySelector('.dialog-scrim')) return;
    // Mid-IME composition, Escape belongs to the input method — it cancels the
    // candidate being composed in the title, not the whole editor with
    // everything typed into it. (keyCode 229 covers engines that don't set
    // isComposing on the key that ends a composition.)
    if (e.isComposing || e.keyCode === 229) return;
    // The guest suggestion list gets first refusal on its own keys, and having
    // consumed one, must stop it reaching the editor (Escape) or the input's
    // commit-on-Enter binding.
    if (handleSuggestKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // A combobox with its list open (a time field) owns Escape: it closes the
    // list, not the editor. This listener runs in the capture phase, ahead of
    // the field's own handler, so it has to step aside here rather than rely
    // on the field stopping propagation.
    if (e.key === 'Escape' && ownsEscape(e.target)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Tab') {
      trapFocus(e);
    }
  }

  function openWith(event, defaults) {
    // A computed, read-only item (a public holiday) has no editor: whatever
    // path asked to edit it gets its details card instead.
    if (event && event.readOnly) return openView(event);
    // Offline is read-only: don't open the editor at all — a single friendly
    // toast beats letting the user type an edit that can't be saved. This one
    // chokepoint covers every open path (new, edit, context menu, search, `n`).
    if (isBlocked()) {
      toast("You're offline — reconnect to make changes");
      // The editor never opens, so run the caller's cleanup now (otherwise a
      // create preview handed in via defaults.onClose would linger).
      if (defaults && defaults.onClose) defaults.onClose();
      return;
    }
    close();
    current = event;
    onCloseCb = (defaults && defaults.onClose) || null;
    if (event && event.isTask) mode = 'task';
    else if (event && event.ooo) mode = 'ooo';
    else if (defaults && defaults.mode === 'task') mode = 'task';
    else if (defaults && defaults.ooo) mode = 'ooo';
    else mode = 'event';
    preOooState = null; // the modal instance is reused across opens; don't carry state over
    color =
      (event && event.color) ||
      (defaults && defaults.color) ||
      (mode === 'ooo' ? OOO_COLOR : DEFAULT_COLOR);
    // Resolve the recurrence rule: from the series master for an occurrence, or
    // directly off a plain/recurring event; none for a brand-new event.
    if (event && event.seriesId) {
      const master = store.getEvent(event.seriesId);
      recurrence = master && master.recurrence ? { ...master.recurrence } : null;
    } else {
      recurrence = event && event.recurrence ? { ...event.recurrence } : null;
    }
    lastFocused = document.activeElement;

    const form = buildForm();
    scrim = el('div', { class: 'modal-scrim modal-scrim--anchored' }, [form]);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    document.body.append(scrim);
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('resize', onViewportResize);

    reminders = event && Array.isArray(event.reminders) ? [...event.reminders] : [];
    guests = event && Array.isArray(event.guests) ? event.guests.map((g) => ({ ...g })) : [];
    openedGuestsJson = JSON.stringify(guests);
    meeting = event && event.meeting && event.meeting.url ? { ...event.meeting } : null;
    openedMeetingJson = JSON.stringify(meeting ?? null);
    selfRemoved = false;
    closeSuggestions(); // the modal is reused across opens; start with no list
    // Opening the editor is a safe moment to re-read a stale address book: no
    // text entry is in flight yet. Only for someone who has actually used guest
    // suggestions this session, so a user who never invites anyone never pays
    // for a Contacts launch they'll get nothing out of.
    if (contacts && contacts.inUse && contacts.inUse()) contacts.revalidate();

    // The Event / Out of office / Task switch is offered only while creating —
    // you can't convert an existing item between the event and task stores.
    fields.modeToggle.style.display = event ? 'none' : '';

    // Populate.
    if (event && event.isTask) {
      fields.titleHeading.textContent = 'Edit task';
      fields.title.value = event.title || '';
      fields.description.value = event.notes || '';
      fields.allDay.checked = Boolean(event.allDay);
      fields.doneToggle.checked = Boolean(event.done);
      writeStart(new Date(event.due));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = '';
    } else if (event) {
      fields.titleHeading.textContent = mode === 'ooo' ? 'Edit out of office' : 'Edit event';
      fields.title.value = event.title || '';
      fields.description.value = event.description || '';
      fields.location.value = event.location || '';
      fields.allDay.checked = event.allDay;
      writeStart(new Date(event.start));
      writeEnd(new Date(event.end));
      // An all-day event spans ≈24h — not a sensible *timed* duration to carry if
      // the user unchecks "All day", so remember the 1-hour default instead.
      lastDuration = event.allDay ? 60 * 60_000 : Math.max(event.end - event.start, 5 * 60_000);
      fields.deleteBtn.style.display = '';
    } else if (mode === 'task') {
      fields.titleHeading.textContent = 'New task';
      const allDay = Boolean(defaults && defaults.allDay);
      const base =
        defaults && defaults.due != null
          ? new Date(defaults.due)
          : roundToNearestMinutes(new Date(), 30);
      fields.allDay.checked = allDay;
      fields.doneToggle.checked = false;
      writeStart(allDay ? startOfDay(base) : base);
      // Tasks have no end row, but seed the hidden end inputs anyway: the mode
      // toggle can switch this window to Event / Out of office, whose save
      // validates the end — left blank it would reject with an error the user
      // can't see the reason for.
      writeEnd(allDay ? startOfDay(base) : addMinutes(base, 60));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    } else if (mode === 'ooo') {
      fields.titleHeading.textContent = 'New out of office';
      const start = defaults && defaults.start ? new Date(defaults.start) : startOfDay(new Date());
      // Out of office defaults to an all-day block unless a time was supplied.
      const allDay = defaults && defaults.allDay != null ? Boolean(defaults.allDay) : true;
      fields.allDay.checked = allDay;
      fields.title.value = 'Out of office';
      writeStart(start);
      writeEnd(allDay ? start : addMinutes(start, 60));
      lastDuration = 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    } else {
      fields.titleHeading.textContent = 'New event';
      const now = new Date();
      const start =
        defaults && defaults.start ? new Date(defaults.start) : roundToNearestMinutes(now, 30);
      const allDay = Boolean(defaults && defaults.allDay);
      fields.allDay.checked = allDay;
      // A drag-to-create gesture passes an explicit end so the modal opens with
      // the dragged span; otherwise fall back to the usual 1-hour default.
      const hasEnd = defaults && defaults.end != null && Number(defaults.end) > start.getTime();
      const end = hasEnd ? new Date(defaults.end) : allDay ? start : addMinutes(start, 60);
      writeStart(start);
      writeEnd(end);
      lastDuration = hasEnd ? end.getTime() - start.getTime() : 60 * 60_000;
      fields.deleteBtn.style.display = 'none';
    }

    // Seed the all-day span from the now-populated date inputs, so moving the
    // start of a multi-day all-day event preserves its length (the timed
    // `lastDuration` set per-branch above intentionally stays a 1-hour default
    // for all-day events, which is only for the "uncheck All day" path).
    lastDayCount = fields.allDay.checked ? allDaySpanDays() : 1;

    syncSwatches();
    renderReminders();
    renderGuests();
    renderMeeting();
    refreshRepeatOptions();
    // Snapshot the rule as displayed (refreshRepeatOptions may have rebuilt a
    // preset-shaped rule), so save can tell whether the user changed Repeat.
    // Normalized, so shape differences (store's 6-key canonical form vs the
    // custom dialog's sparse rebuild) never read as a change.
    openedRuleJson = JSON.stringify(normalizeRecurrence(recurrence, readStart().getTime()) ?? null);
    applyMode();
    updateTzHint();
    showError('');
    anchorTop();

    requestAnimationFrame(() => fields.title.focus());
  }

  /** Freeze the modal's top edge at its opened (centered) position, so that a
   *  later height change — switching Event / Out of office / Task — grows or
   *  shrinks from the bottom instead of re-centering and making the whole dialog
   *  jump. The scrim is top-aligned (.modal-scrim--anchored); we set the margin
   *  that reproduces the centered position once, then leave it fixed across mode
   *  switches. `--modal-anchor-top` also caps max-height so a taller variant
   *  scrolls its body rather than pushing the footer off-screen. */
  function anchorTop() {
    if (!scrim) return;
    const form = scrim.firstElementChild;
    if (!form) return;
    // The measurement below un-caps the height for a moment, which lets a
    // scrolled body snap back to the top under the user. Put it back.
    const body = form.querySelector('.modal__body');
    const scrolled = body ? body.scrollTop : 0;
    // Reset first so max-height is a full 100% while we measure natural height.
    form.style.setProperty('--modal-anchor-top', '0px');
    const cs = getComputedStyle(scrim);
    const avail =
      scrim.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
    const top = Math.max(0, Math.round((avail - form.offsetHeight) / 2));
    form.style.setProperty('--modal-anchor-top', top + 'px');
    if (body && scrolled && body.scrollTop !== scrolled) body.scrollTop = scrolled;
  }

  /**
   * Re-anchor when the viewport itself changes — a resized window, a rotated
   * phone, an on-screen keyboard opening.
   *
   * The pin above is measured once against the viewport it opened in, and
   * `--modal-anchor-top` also CAPS the dialog's height (max-height: 100% minus
   * that margin). So a viewport that gets shorter subtracted an anchor computed
   * for the tall one: a details card opened on a full-height window and then
   * resized down was squeezed to its header row, with its body and its actions
   * unreachable. Nothing else re-ran anchorTop (the app's own resize handler
   * re-renders the calendar behind the dialog, never the dialog itself).
   *
   * Coalesced through one rAF: a drag-resize fires `resize` continuously, and
   * anchorTop reads layout.
   */
  let anchorRaf = null;
  function onViewportResize() {
    if (!scrim || anchorRaf) return;
    anchorRaf = requestAnimationFrame(() => {
      anchorRaf = null;
      anchorTop();
    });
  }
  function stopViewportWatch() {
    window.removeEventListener('resize', onViewportResize);
    if (anchorRaf) cancelAnimationFrame(anchorRaf);
    anchorRaf = null;
  }

  /* ---- View mode (read-only details card) ----------------------------- */
  //
  // Clicking an existing item opens this card, not the editor: a compact,
  // read-only summary with Edit / Delete / Close actions (Google Calendar's
  // click-for-details pattern). Editing is an explicit step — the pencil icon
  // or `e`. Unlike the editor, the card opens fine while offline: it writes
  // nothing, and its actions individually refuse offline use. A public
  // holiday (item.holiday, see holidays.js) gets a variant with Close alone.

  function colorHex(key) {
    const c = EVENT_COLORS.find((x) => x.key === key) || EVENT_COLORS.find((x) => x.key === DEFAULT_COLOR);
    return c ? c.hex : 'transparent';
  }

  /** The card's main date/time line for an event, OOO block, or task. */
  function viewWhen(item) {
    const opts = { hour12: store.getSettings().hour12 };
    if (item.isTask) {
      const due = new Date(item.due);
      return item.allDay
        ? `Due ${formatFullDate(due)}`
        : `Due ${formatFullDate(due)} · ${formatTime(due, opts)}`;
    }
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (item.allDay) {
      return isSameDay(start, end)
        ? `${formatFullDate(start)} · All day`
        : `${formatDateRange(start, end)} · All day`;
    }
    if (isSameDay(start, end)) return `${formatFullDate(start)} · ${formatTimeRange(start, end, opts)}`;
    return `${formatFullDate(start)}, ${formatTime(start, opts)} – ${formatFullDate(end)}, ${formatTime(end, opts)}`;
  }

  /** "Weekly on Monday" etc., or '' for a non-repeating item. An occurrence's
   *  rule lives on its series master — and is described against the MASTER's
   *  start, like search and the invitation emails do: the rule's "day 15" /
   *  "third Tuesday" / "March 17" come from the anchor, and an occurrence
   *  moved on its own (a this-event edit) would otherwise relabel the whole
   *  series after the day it was moved to. */
  function viewRepeat(item) {
    if (item.isTask) return '';
    const master = item.seriesId ? store.getEvent(item.seriesId) || {} : item;
    return master.recurrence ? describeRecurrence(master.recurrence, master.start) : '';
  }

  /** The start–end in the configured secondary zone (timed events only) —
   *  the same line the editor shows under its time inputs. */
  function viewTzHint(item) {
    if (item.isTask || item.allDay) return '';
    const tz = store.getSettings().secondaryTz;
    if (!isValidTimeZone(tz)) return '';
    const opts = { hour12: store.getSettings().hour12 };
    return `${tzLabel(tz)}: ${formatTimeInZone(item.start, tz, opts)} – ${formatTimeInZone(item.end, tz, opts)}`;
  }

  function viewRow(iconName, children) {
    return el('div', { class: 'view__row' }, [
      el('span', { class: 'view__row-icon', html: icon(iconName, { size: 'sm' }) }),
      el('div', { class: 'view__row-main' }, children),
    ]);
  }

  const RSVP_DOT_LABEL = {
    accepted: 'Accepted',
    declined: 'Declined',
    tentative: 'Maybe',
    'needs-action': 'Awaiting reply',
  };
  const MAX_GUEST_ROWS = 8;

  /* ---- RSVP links (host side) ------------------------------------------ */

  /** The id the guest list lives under (a series' guests live on its master). */
  function rsvpEventId(item) {
    return item.seriesId || item.id;
  }

  /** Am I the host of this saved item, so RSVP links apply? */
  function canOfferLinks(item) {
    if (!rsvp || item.isTask || item.ooo) return false;
    // A mail-detected invitation with no ORGANIZER must never read as ours —
    // see rsvp-links.js's isHosted for the same guard.
    if (item.invite) return false;
    return !item.organizer || Boolean(selfEmail && item.organizer.email === selfEmail);
  }

  function copyText(text, what) {
    const write =
      navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('clipboard unavailable'));
    write
      .then(() => toast(what, { variant: 'success' }))
      .catch(() => toast('Could not copy — clipboard access was blocked.', { variant: 'danger' }));
  }

  /** A guest's link set, ready to paste: the self-contained one-click answers
   *  (see the worker's /rsvp/:token/:action; each lands on the RSVP page). */
  function rsvpLinkBlock(url) {
    return `Yes: ${url}/accept\nNo: ${url}/decline\nMaybe: ${url}/maybe`;
  }

  function copyLinkButton(url, email) {
    return el('button', {
      class: 'icon-btn guests__copy',
      type: 'button',
      title: 'Copy one-click RSVP links (Yes/No/Maybe)',
      'aria-label': `Copy RSVP links for ${email}`,
      html: icon('copy', { size: 'sm' }),
      on: { click: () => copyText(rsvpLinkBlock(url), 'RSVP links copied') },
    });
  }

  /* ---- Emailed invitations (host side) --------------------------------- */

  let sending = false; // one send at a time — a double press must not double-mail

  /** A press always gets an answer, including "nothing to do" — unlike the
   *  after-save send, which stays quiet in that case (see describeResult). */
  function toastSendResult(out) {
    const { message, variant } = describeResult(out);
    toast(message, { variant });
  }

  async function offerSavedInvitations(before, saved, { recurrenceId = null } = {}) {
    if (!saved) return;
    const cancel = invites && invites.removedGuestsFor
      ? await invites.removedGuestsFor(before, saved, { recurrenceId }) : null;
    // A save may remove some guests and add/update others. Ask separately,
    // without stacking dialogs or losing either choice on dismissal.
    const split = before && before.id !== saved.id && recurrenceId != null;
    const canSend = () => Boolean(store.getEvent(saved.id)) && (!split ||
      Boolean(store.getEvent(before.id)) && !isScheduledOccurrence(store.getEvent(before.id), recurrenceId));
    const next = () => offerInvitations({
      eventId: saved.id, previousEventId: split ? before.id : null, invites, store, canSend,
    });
    if (cancel) offerCancellation({ invites, store, cancel, onClose: next });
    else next();
  }

  /**
   * The card's send action, or null when there is nothing to send: not the
   * host, no links minted yet, offline, or no worker bridge to send through.
   * Its label says exactly what pressing it will do — who gets mail, and
   * whether it is a first invitation or an update — because the press is not
   * undoable.
   */
  function sendInvitesButton(item, plan) {
    if (!plan || !plan.ready.length || isBlocked()) return null;
    const fresh = plan.pending.filter((r) => !r.sentAt);
    const stale = plan.pending.filter((r) => r.sentAt);
    const resend = plan.pending.length === 0;
    let label;
    if (resend) label = 'Resend invitations';
    else if (!stale.length && plan.lastSentAt) {
      label = `Email ${fresh.length} new guest${fresh.length === 1 ? '' : 's'}`;
    } else if (!fresh.length) label = 'Send updated invitations';
    else if (!plan.lastSentAt) label = `Email invitation${plan.ready.length === 1 ? '' : 's'}`;
    else label = `Send ${plan.pending.length} invitations`;

    return el('button', {
      class: `btn ${resend ? '' : 'btn--primary '}view__send-invites`,
      type: 'button',
      html: icon('mail', { size: 'sm' }) + `<span>${label}</span>`,
      on: {
        click: (e) => {
          if (sending) return;
          sending = true;
          e.currentTarget.disabled = true;
          // Resending is the deliberate "send it again" case: it covers every
          // guest and overrides the worker's already-sent guard.
          const opts = resend ? { emails: plan.ready.map((r) => r.email), force: true } : {};
          Promise.resolve(invites.send(item, opts))
            .then(toastSendResult)
            .catch((err) =>
              toast(err.message || 'Could not send the invitations.', { variant: 'danger' }),
            )
            .then(() => {
              sending = false;
              // Labels and per-guest state both move on a send — but never
              // rebuild the card underneath a nested dialog (the delete or
              // edit scope chooser opened while the send was in flight): its
              // focus trap would be left holding detached nodes, and closing
              // it would drop focus to <body>. Same rule as settleSuggestion
              // and the rsvp.onUpdate rebuild; the fresh labels show on the
              // next open.
              if (document.querySelector('.dialog-scrim')) return;
              if (viewing && current) refreshView(store.getEvent(current.id) || current);
            });
        },
      },
    });
  }

  /** One pending guest suggestion (a guest proposed adding someone from their
   *  RSVP page): who, proposed by whom, and the host's two ways to settle it.
   *  Approving just adds the guest — the normal invite flow (link mint +
   *  email) takes over, and the worker retires the suggestion when the next
   *  sync shows it the new member. */
  function suggestionRow(item, s) {
    const canMail = invites && invites.available() && !isBlocked();
    return el('div', { class: 'view__guest view__suggestion' }, [
      el('div', { class: 'view__guest-main' }, [
        el('span', { class: 'view__guest-who', text: s.name ? `${s.name} — ${s.email}` : s.email }),
        el('span', { class: 'view__muted view__guest-note', text: `Suggested by ${s.by || 'a guest'}` }),
      ]),
      el('button', {
        class: 'btn btn--primary view__suggest-approve',
        type: 'button',
        text: canMail ? 'Add & invite' : 'Add guest',
        on: { click: (e) => settleSuggestion(e, item, s, true) },
      }),
      el('button', {
        class: 'btn view__suggest-dismiss',
        type: 'button',
        text: 'Dismiss',
        on: { click: (e) => settleSuggestion(e, item, s, false) },
      }),
    ]);
  }

  function settleSuggestion(e, item, s, approved) {
    if (isBlocked()) return void toast("You're offline — reconnect to make changes");
    // Both buttons freeze while the settle is in flight — a second press (or
    // pressing the other button) would race the first to the same suggestion.
    const row = e.currentTarget.closest('.view__suggestion');
    const buttons = row ? [...row.querySelectorAll('button')] : [];
    for (const b of buttons) b.disabled = true;
    Promise.resolve(
      approved ? approveSuggestion(item, s) : rsvp.dismissSuggestion(rsvpEventId(item), s.email),
    )
      .then(() => {
        // Same rule as the rsvp.onUpdate rebuild: never underneath a nested
        // dialog (delete/edit scope chooser) — it would break its focus trap.
        // The settled row simply won't be there on the next open.
        if (document.querySelector('.dialog-scrim')) return;
        if (viewing && current) refreshView(store.getEvent(current.id) || current);
      })
      .catch((err) => {
        for (const b of buttons) b.disabled = false;
        toast(err.message || 'Could not update the suggestion.', { variant: 'danger' });
      });
  }

  /** Put the suggested person on the guest list, then hand off to the same
   *  send-when-links-exist path a saved edit uses. The button said "Add &
   *  invite", so no extra "email them?" dialog — the click is the yes. */
  async function approveSuggestion(item, s) {
    const owner = store.getEvent(rsvpEventId(item));
    if (!owner) throw new Error('This event no longer exists.');
    const entry = s.name
      ? { email: s.email, name: s.name, status: 'needs-action' }
      : { email: s.email, status: 'needs-action' };
    const saved = await store.saveEvent({ ...owner, guests: [...(owner.guests || []), entry] });
    // saveEvent silently caps the guest list (MAX_GUESTS) — verify the add took.
    if (!saved.guests.some((g) => g.email === s.email)) {
      throw new Error('Could not add them — the guest list is full.');
    }
    if (invites && invites.available()) invites.sendWhenReady({ id: saved.id });
  }

  /** The card's guests block: a count, a response summary, and the list itself
   *  (organizer tagged; long lists truncated with a "+N more" line). For the
   *  host, each guest row also carries a copy button for their personal RSVP
   *  link (see rsvp-links.js) and whether they have been emailed it, plus
   *  "Copy all" and send actions — and any guest suggestions awaiting review. */
  function viewGuests(item) {
    const guests = item.guests;
    const orgEmail = item.organizer ? item.organizer.email : '';
    // An organizer outside the guest list (uncommon, but Google emits it, and
    // so does an .ics import) still gets a row of their own — so they have to
    // be counted with everyone else, or the header reads "2 guests · 1 yes"
    // above three rows showing two accepted dots. This app's own events carry
    // the host IN `guests` (see maybeAddSelfGuest), where they have always
    // counted; this makes the two shapes agree.
    const standaloneOrganizer =
      orgEmail && !guests.some((g) => g.email === orgEmail)
        ? { ...item.organizer, status: 'accepted' }
        : null;
    const attendees = standaloneOrganizer ? [standaloneOrganizer, ...guests] : guests;
    const counts = { accepted: 0, declined: 0, tentative: 0, 'needs-action': 0 };
    for (const g of attendees) counts[g.status] != null ? counts[g.status]++ : counts['needs-action']++;
    const bits = [];
    if (counts.accepted) bits.push(`${counts.accepted} yes`);
    if (counts.declined) bits.push(`${counts.declined} no`);
    if (counts.tentative) bits.push(`${counts.tentative} maybe`);
    if (counts['needs-action']) bits.push(`${counts['needs-action']} awaiting`);

    const hosting = canOfferLinks(item);
    const linkMap = (hosting && rsvp.linksFor(rsvpEventId(item))) || {};
    // One plan for the whole block: it is what the rows mark themselves from
    // and what the send button labels itself from.
    const plan = hosting && invites && invites.available() ? invites.planFor(item) : null;
    const invited = new Map((plan ? plan.ready : []).map((r) => [r.email, r]));

    /** Has this guest been emailed the invitation they hold right now? */
    const inviteMark = (email) => {
      const entry = invited.get(email);
      if (!entry || !entry.sentAt) return null;
      return el('span', {
        class: 'view__muted view__guest-sent',
        text: entry.current ? 'Invited' : 'Update pending',
        title: entry.current
          ? `Invitation emailed ${formatFullDate(new Date(entry.sentAt))}`
          : 'This event changed after they were emailed',
      });
    };

    const guestRow = (g, isOrganizer) =>
      el('div', { class: 'view__guest' }, [
        el('span', {
          class: 'view__rsvp-dot',
          dataset: { status: g.status || 'needs-action' },
          role: 'img',
          title: RSVP_DOT_LABEL[g.status] || RSVP_DOT_LABEL['needs-action'],
          'aria-label': RSVP_DOT_LABEL[g.status] || RSVP_DOT_LABEL['needs-action'],
        }),
        el('div', { class: 'view__guest-main' }, [
          el('span', { class: 'view__guest-who', text: g.name ? `${g.name} — ${g.email}` : g.email }),
          g.comment
            ? el('span', { class: 'view__muted view__guest-note', text: `“${g.comment}”` })
            : null,
        ]),
        isOrganizer ? el('span', { class: 'view__muted', text: 'Organizer' }) : null,
        !isOrganizer ? inviteMark(g.email) : null,
        !isOrganizer && linkMap[g.email] ? copyLinkButton(linkMap[g.email], g.email) : null,
      ]);

    // The organizer leads the list when they aren't already in it (see above).
    const listed = attendees.slice(0, MAX_GUEST_ROWS);
    const list = listed.map((g) => guestRow(g, g.email === orgEmail));
    if (attendees.length > listed.length) {
      list.push(el('div', { class: 'view__muted', text: `+ ${attendees.length - listed.length} more` }));
    }

    const extras = [];
    if (hosting) {
      const linkable = guests.filter((g) => g.email !== orgEmail && g.email !== selfEmail);
      const ready = linkable.filter((g) => linkMap[g.email]);
      // Emailing the links is the primary action; copying them stays for the
      // host who would rather write the message themselves. One row, so the
      // pair reads as the block's actions rather than a stack of links.
      const actions = [];
      const send = plan ? sendInvitesButton(item, plan) : null;
      if (send) actions.push(send);
      if (ready.length) {
        const block = (g) =>
          `${g.email}\n${rsvpLinkBlock(linkMap[g.email]).replace(/^/gm, '  ')}`;
        actions.push(
          el('button', {
            class: 'btn view__copy-links',
            type: 'button',
            html: icon('copy', { size: 'sm' }) + '<span>Copy RSVP links</span>',
            on: {
              click: () =>
                copyText(
                  ready.map(block).join('\n\n'),
                  ready.length === 1 ? 'RSVP links copied' : `RSVP links for ${ready.length} guests copied`,
                ),
            },
          }),
        );
      }
      if (actions.length) extras.push(el('div', { class: 'view__guest-actions' }, actions));
      if (linkable.length > ready.length && !isBlocked()) {
        // Links are minted by the user's RSVP worker moments after save; the
        // onUpdate hook below rebuilds this card when they land.
        extras.push(
          el('div', { class: 'view__muted', text: 'Preparing RSVP links…' }),
        );
      }
    }

    // Guests' suggestions, for the host to settle. suggestionsFor re-filters
    // against the live guest list, so an approved row is gone on the very
    // next rebuild. (Older rsvp fakes/stubs may not carry the method.)
    const suggestions =
      hosting && typeof rsvp.suggestionsFor === 'function'
        ? rsvp.suggestionsFor(rsvpEventId(item))
        : [];
    const suggestionBlock = suggestions.length
      ? el('div', { class: 'view__suggestions' }, [
          el('div', { class: 'view__muted', text: 'Guests suggested adding' }),
          ...suggestions.map((s) => suggestionRow(item, s)),
        ])
      : null;

    return [
      el('div', { text: `${attendees.length} guest${attendees.length === 1 ? '' : 's'}` }),
      bits.length ? el('div', { class: 'view__muted', text: bits.join(', ') }) : null,
      el('div', { class: 'view__guests' }, list),
      suggestionBlock,
      ...extras,
    ];
  }

  /** The guest entry that is us: the account address, or — on a mail-detected
   *  invitation — the address the invitation actually reached us at. */
  function findSelfGuest(item) {
    const guests = (item && item.guests) || [];
    if (!guests.length) return null;
    const invited = item.invite && item.invite.attendee;
    return (
      (selfEmail && guests.find((g) => g.email === selfEmail)) ||
      (invited && guests.find((g) => g.email === invited)) ||
      null
    );
  }

  /** Record the signed-in user's Yes / No / Maybe on an invitation. A series
   *  occurrence responds series-wide (the reply covers the whole invitation). */
  function respondToInvite(status) {
    if (isBlocked()) return void toast("You're offline — reconnect to make changes");
    const targetId = current.seriesId || current.id;
    // Snapshot before the write resolves and refreshView reassigns `current` —
    // the offer needs the invite/organizer this response was actually about.
    const before = current;
    // Answer as whichever address is on the guest list — store.rsvpEvent only
    // updates a guest it can find.
    const asEmail = (findSelfGuest(current) || {}).email || selfEmail;
    Promise.resolve(store.rsvpEvent(targetId, status, asEmail))
      .then((saved) => {
        if (!saved) return;
        refreshView({ ...current, guests: saved.guests, declined: saved.declined });
        // Offered only for a mail-detected invitation with an organizer to
        // reply to — never for the app's own invites, which have their own
        // RSVP-link flow (see rsvp-links.js).
        const organizer = (saved && saved.organizer) || before.organizer;
        if (mail && mail.reply && before.invite && organizer) {
          mail.reply.offerReply(saved || before, status);
        }
      })
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast('Could not save your response.', { variant: 'danger' });
      });
  }

  function toggleTaskDone() {
    if (isBlocked()) return void toast("You're offline — reconnect to make changes");
    const id = current.id;
    Promise.resolve(store.toggleTask(id))
      .then(() => refreshView(store.getTask(id)))
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast('Could not update task.', { variant: 'danger' });
      });
  }

  function restoreDeclined() {
    if (isBlocked()) return void toast("You're offline — reconnect to make changes");
    const id = current.id;
    Promise.resolve(store.setDeclined(id, false))
      .then(() => refreshView(store.getEvent(id)))
      .catch((err) => {
        if (isOfflineError(err)) return;
        console.error(err);
        toast('Could not restore event.', { variant: 'danger' });
      });
  }

  /* ---- Bookings (events created through a booking link) ------------------ */

  /**
   * "Cancel booking?" — cancelling is not deleting: the worker frees the slot
   * and EMAILS the guest, which can't be undone, so it takes an explicit
   * confirm naming exactly that. (Plain deletion still works and is caught by
   * booking.js's safety net after a grace period; this is the honest path.)
   */
  function confirmCancelBooking(item) {
    if (isBlocked()) return void toast("You're offline — reconnect to make changes");
    const who = item.booking.name || item.booking.email || 'The guest';
    const dialog = el('form', {
      class: 'modal rr-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'cancel-booking-title',
    }, [
      el('div', { class: 'modal__head' }, [
        el('h2', { class: 'modal__title', id: 'cancel-booking-title', text: 'Cancel this booking?' }),
      ]),
      el('div', { class: 'modal__body' }, [
        el('p', { text: `${who} will get an email letting them know, and the time opens up again.` }),
      ]),
      el('div', { class: 'modal__foot' }, [
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn', type: 'button', text: 'Keep it', on: { click: () => closeConfirm() } }),
        el('button', { class: 'btn btn--danger', type: 'submit', text: 'Cancel booking' }),
      ]),
    ]);
    dialog.addEventListener('submit', (e) => {
      e.preventDefault();
      closeConfirm();
      // The card stays up while the worker is asked, so mark the request on
      // the button that started it: a second "Cancel booking…" during a slow
      // round-trip issued a second cancellation, whose 404 then added a
      // contradictory "no email was sent" toast after the first success.
      const trigger = scrim && scrim.querySelector('.view__cancel-booking');
      const busy = (on) => {
        if (!trigger) return;
        trigger.disabled = on;
        trigger.setAttribute('aria-busy', String(on));
      };
      busy(true);
      Promise.resolve(booking.cancelBooking(item.booking.id))
        .then((res) => {
          close();
          const notified = res && res.notified === true;
          toast(
            notified
              ? `Booking cancelled — cancellation email sent to ${who}.`
              : 'Booking cancelled, but no cancellation email was sent.',
            { variant: notified ? 'success' : 'default' },
          );
        })
        .catch((err) => {
          busy(false);
          if (isOfflineError(err)) return;
          console.error(err);
          toast(err.message || 'Could not cancel the booking. Please try again.', { variant: 'danger' });
        });
    });
    const closeConfirm = mountDialog(dialog);
    requestAnimationFrame(() => dialog.querySelector('.btn--danger').focus());
  }

  /**
   * The card for a public holiday (see holidays.js): the same shape as an
   * event's, so a click on any chip lands somewhere familiar, but with nothing
   * to edit or delete — a holiday is computed from the country setting, not
   * stored — so the head holds Close alone and the one action changes country.
   */
  function buildHolidayCard(item) {
    const head = el('div', { class: 'modal__head modal__head--view' }, [
      el('span', { class: 'view__kind', text: 'Public holiday' }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Close',
        title: 'Close (Esc)',
        html: icon('close'),
        on: { click: close },
      }),
    ]);

    // Always one day, and the end is the exclusive next midnight (not an
    // event's 23:59:59.999), which viewWhen would misread as a two-day range.
    const rows = [viewRow('clock', [el('div', { text: `${formatFullDate(new Date(item.start))} · All day` })])];
    // Why this particular day is a holiday, when it is not self-evident from
    // the name: a substitute day off, or Japan's bridge between two holidays.
    const note = item.bridged
      ? 'A working day between two holidays, which makes it one as well.'
      : item.observed
        ? 'The day off for a holiday that falls on a weekend this year.'
        : '';
    // The calendar glyph, not a second flag: this row names the source list,
    // the way an event's card would name its calendar.
    rows.push(
      viewRow('calendar', [
        el('div', { text: `Holidays in ${item.countryName}` }),
        note ? el('div', { class: 'view__muted', text: note }) : null,
        el('div', { class: 'view__muted', text: 'Built into the calendar · not editable' }),
      ]),
    );

    const foot = onHolidaySettings
      ? el('div', { class: 'modal__foot modal__foot--view' }, [
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            html: icon('settings', { size: 'sm' }) + '<span>Change country…</span>',
            on: {
              click: () => {
                close();
                onHolidaySettings();
              },
            },
          }),
        ])
      : null;

    return el('div', {
      class: 'modal modal--view modal--holiday',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'view-title',
      tabindex: '-1',
    }, [
      head,
      el('div', { class: 'modal__body view__body' }, [
        el('div', { class: 'view__title-row' }, [
          el('span', { class: 'view__color view__color--holiday', html: icon('flag', { size: 'sm' }) }),
          el('div', { class: 'view__title-main' }, [
            el('h2', { class: 'view__title', id: 'view-title', text: item.title }),
          ]),
        ]),
        ...rows,
      ]),
      foot,
    ]);
  }

  /**
   * The card for a clock change (see dst.js): when the clocks move, by how
   * much, and what that does to the day — said in terms of the clocks, since
   * that is all the calendar actually knows. Close alone in the head, and one
   * action, which leads to the toggle that turns these markers off.
   */
  function buildClockChangeCard(item) {
    const opts = { hour12: store.getSettings().hour12 };
    const head = el('div', { class: 'modal__head modal__head--view' }, [
      el('span', { class: 'view__kind', text: 'Clock change' }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Close',
        title: 'Close (Esc)',
        html: icon('close'),
        on: { click: close },
      }),
    ]);

    // The wall clock at the instant of the change, read on the OLD clock and
    // then on the new one: "2:00 AM becomes 3:00 AM". Formatting the instant
    // shifted by each offset in UTC is what gives the two readings.
    const oldClock = formatTimeInZone(item.at + item.before * 60_000, 'UTC', opts);
    const newClock = formatTimeInZone(item.at + item.after * 60_000, 'UTC', opts);
    const shift = item.after - item.before;
    const dayHours = 24 - shift / 60;
    const rows = [
      viewRow('clock', [
        el('div', { text: `${formatFullDate(new Date(item.start))} · at ${oldClock}` }),
        el('div', {
          class: 'view__muted',
          text: `${oldClock} becomes ${newClock} · the day has ${Number.isInteger(dayHours) ? dayHours : dayHours.toFixed(1)} hours`,
        }),
      ]),
      viewRow('calendar', [
        el('div', { text: `${tzLabel(item.zone)} time (${tzOffsetLabel(item.before)} → ${tzOffsetLabel(item.after)})` }),
        el('div', { class: 'view__muted', text: 'From your browser\u2019s time zone · not editable' }),
      ]),
    ];

    const foot = onClockChangeSettings
      ? el('div', { class: 'modal__foot modal__foot--view' }, [
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            html: icon('settings', { size: 'sm' }) + '<span>Clock change settings…</span>',
            on: {
              click: () => {
                close();
                onClockChangeSettings();
              },
            },
          }),
        ])
      : null;

    return el('div', {
      class: 'modal modal--view modal--holiday',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'view-title',
      tabindex: '-1',
    }, [
      head,
      el('div', { class: 'modal__body view__body' }, [
        el('div', { class: 'view__title-row' }, [
          el('span', { class: 'view__color view__color--holiday', html: icon('clock', { size: 'sm' }) }),
          el('div', { class: 'view__title-main' }, [
            el('h2', { class: 'view__title', id: 'view-title', text: `${item.title} ${describeShift(shift)}` }),
          ]),
        ]),
        ...rows,
      ]),
      foot,
    ]);
  }

  function buildViewCard(item) {
    if (item.holiday) return buildHolidayCard(item);
    if (item.dst) return buildClockChangeCard(item);
    const isTask = Boolean(item.isTask);
    const kind = isTask ? 'Task' : item.ooo ? 'Out of office' : 'Event';

    const head = el('div', { class: 'modal__head modal__head--view' }, [
      el('span', { class: 'view__kind', text: kind }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Edit ${kind.toLowerCase()}`,
        title: 'Edit (e)',
        html: icon('edit', { size: 'sm' }),
        on: { click: () => openWith(item, null) },
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': `Delete ${kind.toLowerCase()}`,
        title: 'Delete',
        html: icon('trash', { size: 'sm' }),
        on: { click: handleDelete },
      }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Close',
        title: 'Close (Esc)',
        html: icon('close'),
        on: { click: close },
      }),
    ]);

    const badges = [];
    if (isTask && item.done) badges.push(el('span', { class: 'view__badge', text: 'Completed' }));
    if (!isTask && item.declined) badges.push(el('span', { class: 'view__badge', text: 'Declined' }));
    if (!isTask && item.invite) badges.push(el('span', { class: 'view__badge', text: 'From email' }));

    const rows = [];
    const whenExtras = [viewRepeat(item), viewTzHint(item)].filter(Boolean);
    rows.push(viewRow(!isTask && item.ooo ? 'plane' : 'clock', [
      el('div', { text: viewWhen(item) }),
      ...whenExtras.map((t) => el('div', { class: 'view__muted', text: t })),
    ]));
    const reminderList = !isTask && !item.ooo && !item.allDay && Array.isArray(item.reminders)
      ? [...item.reminders].sort((a, b) => a - b)
      : [];
    if (reminderList.length) {
      rows.push(viewRow('bell', reminderList.map((m) => el('div', { text: describeReminder(m) }))));
    }
    if (!isTask && item.location) {
      rows.push(viewRow('map-pin', [el('div', {}, linkify(item.location))]));
    }
    if (!isTask && !item.ooo && item.meeting && item.meeting.url) {
      rows.push(
        viewRow('video', [
          el('div', {}, [
            el('a', {
              class: 'linkified view__join',
              href: item.meeting.url,
              text: 'Join meeting',
              target: '_blank',
              rel: 'noopener noreferrer',
            }),
          ]),
          el('div', { class: 'view__muted view__join-url', text: item.meeting.url }),
        ]),
      );
    }
    if (!isTask && Array.isArray(item.guests) && item.guests.length) {
      rows.push(viewRow('users', viewGuests(item)));
    }
    // An event a guest booked through one of the user's booking links.
    if (!isTask && item.booking) {
      const pageTitle = item.booking.pageTitle || 'your booking link';
      rows.push(
        viewRow('link', [
          el('div', { text: `Booked via “${pageTitle}”` }),
          item.booking.email
            ? el('div', {
                class: 'view__muted',
                text: item.booking.name
                  ? `${item.booking.name} · ${item.booking.email}`
                  : item.booking.email,
              })
            : null,
        ]),
      );
    }
    const desc = isTask ? item.notes : item.description;
    if (desc) rows.push(viewRow('align-left', [el('div', { class: 'view__desc' }, linkify(desc))]));

    // "Going?" chips appear when this is an invitation TO me: someone else is
    // the organizer and my email is on the guest list.
    // An invitation that arrived by mail names us by the address it was sent
    // to — the Puter mailbox — which need not be the account email. Matching on
    // the account address alone hid the Yes / No / Maybe chips entirely for
    // those, and with them the reply-by-email offer.
    const myGuest = !isTask ? findSelfGuest(item) : null;
    const isInvite = Boolean(myGuest && item.organizer && item.organizer.email !== myGuest.email);

    const footActions = [];
    if (isTask) {
      footActions.push(el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        dataset: { focusKey: 'view:done' },
        html: icon('check', { size: 'sm' }) + `<span>${item.done ? 'Mark as not done' : 'Mark as done'}</span>`,
        on: { click: toggleTaskDone },
      }));
    } else if (isInvite) {
      const chip = (label, status) =>
        el('button', {
          class: 'view__going-chip',
          type: 'button',
          text: label,
          dataset: { focusKey: `view:going:${status}` },
          'aria-pressed': String(myGuest.status === status),
          on: { click: () => respondToInvite(status) },
        });
      footActions.push(
        el('span', { class: 'view__going-label', id: 'view-going-label', text: 'Going?' }),
        el('div', { class: 'segmented view__going', role: 'group', 'aria-labelledby': 'view-going-label' }, [
          chip('Yes', 'accepted'),
          chip('No', 'declined'),
          chip('Maybe', 'tentative'),
        ]),
      );
    } else if (item.declined && !item.seriesId) {
      footActions.push(el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: 'Restore (accept)',
        on: { click: restoreDeclined },
      }));
    }
    // Cancel a booking that hasn't finished yet — distinct from Delete because
    // it also frees the slot on the booking page and notifies the guest.
    // Gated on the END so a meeting already underway (or an event dragged
    // slightly earlier than the recorded booking) can still be cancelled.
    if (!isTask && item.booking && booking && !item.seriesId && item.end > Date.now()) {
      footActions.push(el('button', {
        class: 'btn btn--ghost view__cancel-booking',
        type: 'button',
        html: icon('close', { size: 'sm' }) + '<span>Cancel booking…</span>',
        on: { click: () => confirmCancelBooking(item) },
      }));
    }

    return el('div', {
      class: 'modal modal--view',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'view-title',
      tabindex: '-1',
    }, [
      head,
      el('div', { class: 'modal__body view__body' }, [
        el('div', { class: 'view__title-row' }, [
          el('span', { class: 'view__color', style: { background: colorHex(item.color) } }),
          el('div', { class: 'view__title-main' }, [
            el('h2', { class: 'view__title', id: 'view-title', text: item.title || '(Untitled)' }),
            badges.length ? el('div', { class: 'view__badges' }, badges) : null,
          ]),
        ]),
        ...rows,
      ]),
      footActions.length ? el('div', { class: 'modal__foot modal__foot--view' }, footActions) : null,
    ]);
  }

  /** Rebuild the open card in place after a store mutation (task toggled,
   *  decline restored, RSVP data arriving), keeping the dialog and focus
   *  where they are. Focus is re-planted only when it was already inside the
   *  card — a background refresh (rsvp.onUpdate) must never steal focus from
   *  wherever the user is working. */
  function refreshView(item) {
    if (!viewing || !scrim) return;
    if (!item) return close();
    const active = document.activeElement;
    const hadFocus = scrim.contains(active);
    // The control that was just pressed (Yes / No / Maybe, Mark as done) is
    // about to be rebuilt; remember which so focus can land on its
    // counterpart, where its new pressed state is announced — not on the
    // dialog root, from where a keyboard user had to Tab back through the card.
    const focusKey = hadFocus && active ? active.getAttribute('data-focus-key') : null;
    current = item;
    const card = buildViewCard(item);
    // The dialog is already open — the fresh card must not replay the modal-in
    // entrance animation, which reads as the dialog collapsing and reopening.
    card.classList.add('modal--settled');
    clear(scrim).append(card);
    anchorTop();
    if (!hadFocus) return;
    const target = focusKey
      ? [...card.querySelectorAll('[data-focus-key]')].find((n) => n.dataset.focusKey === focusKey)
      : null;
    (target || card).focus();
  }

  function onViewKeydown(e) {
    // A nested dialog (delete-scope chooser) handles its own keys.
    if (document.querySelector('.dialog-scrim')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      trapFocus(e);
    } else if (current && current.readOnly) {
      // A public holiday's card: nothing to edit or delete, so the shortcuts
      // below must not reach a handler that assumes a stored item.
      return;
    } else if ((e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (current) openWith(current, null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      handleDelete();
    }
  }

  /** `respond`: answer the invitation as soon as it's open, as the Going? chips do. */
  function openView(item, { respond = null } = {}) {
    if (!item) return;
    close();
    current = item;
    mode = item.isTask ? 'task' : item.ooo ? 'ooo' : 'event';
    viewing = true;
    lastFocused = document.activeElement;

    const card = buildViewCard(item);
    scrim = el('div', { class: 'modal-scrim modal-scrim--anchored' }, [card]);
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close();
    });
    document.body.append(scrim);
    document.addEventListener('keydown', onViewKeydown, true);
    window.addEventListener('resize', onViewportResize);
    anchorTop();
    requestAnimationFrame(() => card.focus());

    const myGuest = respond && !item.isTask ? findSelfGuest(item) : null;
    if (myGuest && item.organizer && item.organizer.email !== myGuest.email) respondToInvite(respond);

    // An event with guests and an organizer may be an invitation TO me, but we
    // can't tell without my email. Ask (one-time Puter prompt) and, once known,
    // rebuild the card so the Going? chips and my Organizer tag can appear.
    if (!selfEmail && item.organizer && Array.isArray(item.guests) && item.guests.length) {
      ensureSelfEmail().then((email) => {
        if (email && viewing && current === item) refreshView(current);
      });
    }

    // Host side: ask the RSVP worker for this event's latest guest answers
    // (and any links still being minted). The onUpdate subscription below
    // rebuilds the open card when the round-trip lands.
    if (rsvp && canOfferLinks(item) && Array.isArray(item.guests) && item.guests.length) {
      rsvp.refreshEvent(rsvpEventId(item));
    }
  }

  // Rebuild the open details card when this event's RSVP links or guest
  // answers change (links minted after save, a guest responding while the
  // card is up, statuses merged on open). Never while a nested dialog (the
  // delete/edit scope chooser) is up — rebuilding underneath it would break
  // its focus trap; the fresh data simply shows on the next open.
  if (rsvp) {
    rsvp.onUpdate((eventId) => {
      if (!viewing || !current || current.isTask) return;
      if (rsvpEventId(current) !== eventId) return;
      if (document.querySelector('.dialog-scrim')) return;
      refreshView(store.getEvent(current.id) || current);
    });
  }

  function openNew(defaults) {
    openWith(null, defaults);
  }
  function openEdit(event) {
    openWith(event, null);
  }

  function close() {
    if (!scrim) return;
    // Closing without leaving the field first (Escape, Cancel) still ends the
    // editing session, so any deferred address-book re-read can happen now.
    if (contacts && contacts.settle) contacts.settle();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keydown', onViewKeydown, true);
    stopViewportWatch();
    viewing = false;
    scrim.remove();
    scrim = null;
    current = null;
    // Run any caller cleanup registered for this open (e.g. remove the drag-to-
    // create preview left on the calendar) exactly once.
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
    restoreFocus();
    lastFocused = null;
  }

  /** Return focus to whatever opened the modal. A save/delete re-renders the
   *  active view synchronously (store emit -> app render), detaching the event
   *  element that was `lastFocused`; focusing it then would silently drop focus to
   *  <body>. Fall back to its re-rendered replacement via the shared data-focus-key. */
  function restoreFocus() {
    if (!lastFocused) return;
    if (lastFocused.isConnected && lastFocused.focus) {
      lastFocused.focus();
      return;
    }
    const key = lastFocused.dataset && lastFocused.dataset.focusKey;
    if (key && typeof CSS !== 'undefined' && CSS.escape) {
      const repl = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
      if (repl && repl.focus) repl.focus();
    }
  }

  return { openNew, openEdit, openView, close, isOpen };
}
