/**
 * Shared time-grid renderer used by both the Week view (7 days) and the Day
 * view (1 day). Renders an all-day rail, day headers, an hour axis, clickable
 * time slots, absolutely-positioned events, and a live "now" indicator.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { draggable } from '../drag.js';
import { createEdgePan } from '../edge-autopan.js';
import { layoutColumns, splitDayEvents } from '../event-layout.js';
import { colorHex, colorFg, DEFAULT_COLOR } from '../colors.js';
import {
  startOfDay,
  minutesIntoDay,
  endOfDay,
  isToday,
  minutesSinceMidnight,
  diffCalendarDays,
  formatHourLabel,
  formatTime,
  formatTimeRange,
  formatFullDate,
  formatTimeInZone,
  tzAbbreviation,
  isValidTimeZone,
  WEEKDAYS_SHORT,
} from '../date-utils.js';

const HOUR_H = 52; // px per hour — mirrored by --hour-h

const nowLineTop = (now) => (minutesSinceMidnight(now) / 60) * HOUR_H;

/** Slide an already-drawn now-line to the current minute without rebuilding
 *  the view. The app's minute tick falls back to this whenever a full render
 *  would be unsafe (an open card, a focused control it could not restore), so
 *  the line keeps time regardless. Only valid while the rendered "today" is
 *  still today — the caller checks. */
export function moveNowLine(root, now = new Date()) {
  const top = `${nowLineTop(now)}px`;
  root.querySelectorAll('.now-line').forEach((line) => {
    line.style.top = top;
  });
}
const GUTTER = 56; // px for the hour axis — mirrored by --gutter
const MIN_EVENT_H = 18;
const SNAP_MIN = 15; // drag-to-reschedule snaps to quarter-hours
const MINUTES_PER_DAY = 24 * 60;
// A timed task is a single instant, but it needs a nominal span so several tasks
// due around the same time lay out side by side instead of stacking. ~30 min is
// roughly one chip-height at HOUR_H — the visual footprint we want to de-conflict.
const TASK_SPAN_MS = 30 * 60_000;

/**
 * Wall-clock minutes from a day's local midnight (`dayStartMs`). The hour axis,
 * now-line and click-to-create are all wall-clock, so event geometry and the
 * drag/resize/create commits must be too — otherwise a timed event shifts by
 * the DST offset (rendering an hour off from the axis, or committing an hour
 * off from where it was dropped) on the one spring-forward / fall-back day each
 * year. An instant on a later calendar day maps past 1440 (a block ending at
 * the next midnight is 1440). On any non-DST day this equals the plain
 * `(ms - dayStartMs) / 60000`, so normal days are unaffected.
 */
function minutesFromMidnight(ms, dayStartMs) {
  const d = new Date(ms);
  const days = diffCalendarDays(new Date(dayStartMs), d);
  return (
    days * MINUTES_PER_DAY +
    d.getHours() * 60 +
    d.getMinutes() +
    d.getSeconds() / 60 +
    d.getMilliseconds() / 60000
  );
}

/** Inverse of {@link minutesFromMidnight}: the instant `min` wall-clock minutes
 *  after a day's local midnight (minutesIntoDay carries the DST-at-midnight
 *  safety — see its doc in date-utils.js). */
function instantFromMinutes(dayStartMs, min) {
  return minutesIntoDay(new Date(dayStartMs), min).getTime();
}

/**
 * End instant of a timed event moved to start `startMin` wall-clock minutes after
 * `dayStartMs`'s midnight, preserving its EXACT original duration `durMs`. The
 * whole-minute part rides the DST-safe minutes-from-midnight basis (so the block's
 * rendered height matches its geometry across a DST transition, unlike adding raw
 * elapsed ms); any sub-minute remainder is added as ms. This keeps a short
 * (sub-15-min) or sub-minute imported event at its true length rather than
 * snapping it up the way `Math.max(SNAP_MIN, …)` would. Pure — unit-tested.
 */
export function movedEventEnd(durMs, dayStartMs, startMin) {
  const durWholeMin = Math.floor(durMs / 60_000);
  const durRemMs = durMs - durWholeMin * 60_000;
  return instantFromMinutes(dayStartMs, startMin + durWholeMin) + durRemMs;
}

/**
 * Clamp a move-drag's snapped start minute into its day. The clamp must use the
 * CEILING of the duration in minutes: movedEventEnd (the commit) floors the
 * whole-minute part and adds the sub-minute remainder back as ms, so rounding
 * here (90m20s → 90) would admit a bottom-of-day start whose committed end
 * spills past midnight by the remainder — a cross-midnight sliver on the next
 * day that loses its drag/resize handles. Pure — unit-tested.
 */
export function clampMoveStart(rawMin, durMs) {
  const durClampMin = Math.max(SNAP_MIN, Math.ceil(durMs / 60_000));
  return Math.min(Math.max(0, rawMin), Math.max(0, MINUTES_PER_DAY - durClampMin));
}

/**
 * The dragged edge of a resize, clamped in the right ORDER: to the day first,
 * then to never cross the opposite edge — where an event already shorter than
 * SNAP_MIN can hold its current edge (no shrink) but never jumps past it. The
 * old code applied the min-duration bound OUTSIDE the day bound, so for a
 * sub-15-minute event that floor overrode everything: a top-edge wiggle on a
 * 00:00–00:10 event committed a start on the PREVIOUS day (23:55), a bottom
 * edge at 23:50–23:55 escaped past midnight, and a mid-day 9:00–9:05 top edge
 * dragged DOWN jumped UP to 8:50. Pure — unit-tested.
 */
export function resizedEdges(edge, snappedMin, startMin, endMin) {
  if (edge === 'top') {
    return {
      s: Math.max(0, Math.min(snappedMin, Math.max(startMin, endMin - SNAP_MIN))),
      en: endMin,
    };
  }
  return {
    s: startMin,
    en: Math.min(MINUTES_PER_DAY, Math.max(snappedMin, Math.min(endMin, startMin + SNAP_MIN))),
  };
}

export function renderTimeGrid(days, ctx) {
  const { store, settings, now, actions } = ctx;
  const hour12 = settings.hour12;

  // Optional secondary time zone shown as an extra hour column. Widen the gutter
  // to fit both label columns; the outer grid template is unchanged.
  const secondaryTz = isValidTimeZone(settings.secondaryTz) ? settings.secondaryTz : '';
  const gutter = secondaryTz ? 104 : GUTTER;
  const tzRef = startOfDay(days[0]).getTime(); // reference instant for zone labels

  const root = el('div', {
    class: `view timegrid${secondaryTz ? ' has-secondary-tz' : ''}`,
    style: { '--hour-h': `${HOUR_H}px`, '--gutter': `${gutter}px` },
  });

  // Per-day event + task buckets.
  const perDay = days.map((day) => {
    const dayStart = startOfDay(day).getTime();
    const dayEnd = endOfDay(day).getTime();
    const dayEvents = store.getEventsInRange(dayStart, dayEnd + 1, { includeHolidays: true });
    const dayTasks = store.getTasksInRange(dayStart, dayEnd + 1);
    // Untimed (all-day) tasks live in the top rail; timed tasks are positioned
    // on the hour grid at their due time (below), like events.
    const railTasks = dayTasks.filter((t) => t.allDay);
    const timedTasks = dayTasks.filter((t) => !t.allDay);
    return { day, dayStart, dayEnd, railTasks, timedTasks, ...splitDayEvents(dayEvents, dayStart, dayEnd) };
  });

  const hasAllDay = perDay.some((d) => d.allDay.length > 0);
  const hasTaskRail = perDay.some((d) => d.railTasks.length > 0);

  // ---- Day headers ----
  // Appended FIRST, above the all-day / tasks rails: the weekday + date row
  // is what every chip below it is filed under, and the rails are variable in
  // height, so with the header underneath them an all-day banner sat on screen
  // with no visible date above it and today's highlighted date drifted down the
  // view. Purely a DOM-order change — .timegrid is a flex column and all three
  // bands share the same `var(--gutter) 1fr` grid, so they stay aligned.
  const headCols = el('div', { class: 'timegrid__head-cols' });
  days.forEach((day) => {
    const col = el('div', {
      class: `timegrid__head-col${isToday(day, now) ? ' is-today' : ''}`,
      'aria-current': isToday(day, now) ? 'date' : null,
      role: 'button',
      tabindex: '0',
      'aria-label': `Go to ${formatFullDate(day)}`,
      on: {
        click: () => actions.gotoDayView(day),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            actions.gotoDayView(day);
          }
        },
      },
    });
    col.append(
      el('span', { class: 'timegrid__dow', text: WEEKDAYS_SHORT[day.getDay()] }),
      el('span', { class: 'timegrid__datenum', text: String(day.getDate()) }),
    );
    headCols.append(col);
  });
  const headGutter = el('div', { class: 'timegrid__head-gutter' });
  if (secondaryTz) {
    // Label which column is which zone.
    headGutter.append(
      el('span', { class: 'timegrid__tz-abbr timegrid__tz-abbr--secondary', text: tzAbbreviation(secondaryTz, tzRef) }),
      el('span', { class: 'timegrid__tz-abbr timegrid__tz-abbr--local', text: 'Local' }),
    );
  }
  root.append(el('div', { class: 'timegrid__head' }, [headGutter, headCols]));

  // ---- All-day rail ----
  if (hasAllDay) {
    const allDayCols = el('div', { class: 'timegrid__allday-cols' });
    perDay.forEach(({ day, allDay }) => {
      // Carry `is-today` here too: the today tint runs down the hour grid and
      // through the date header, so without it the stripe breaks across the
      // rails and today's all-day events sit outside their own column.
      const col = el('div', { class: `timegrid__allday-col${isToday(day, now) ? ' is-today' : ''}` });
      allDay.forEach((ev) => col.append(ev.readOnly ? buildOverlayChip(ev, ctx) : buildAllDayChip(ev, ctx)));
      allDayCols.append(col);
    });
    root.append(
      el('div', { class: 'timegrid__allday' }, [
        el('div', { class: 'timegrid__allday-label', text: 'All-day' }),
        allDayCols,
      ]),
    );
  }

  // ---- Tasks rail (untimed / all-day tasks only; timed tasks are placed on the
  // hour grid at their due time, alongside events). ----
  if (hasTaskRail) {
    const taskCols = el('div', { class: 'timegrid__allday-cols' });
    perDay.forEach(({ day, railTasks }) => {
      const col = el('div', { class: `timegrid__allday-col${isToday(day, now) ? ' is-today' : ''}` });
      railTasks.forEach((t) => col.append(buildTaskChip(t, ctx)));
      taskCols.append(col);
    });
    root.append(
      el('div', { class: 'timegrid__allday timegrid__tasks' }, [
        el('div', { class: 'timegrid__allday-label', text: 'Tasks' }),
        taskCols,
      ]),
    );
  }

  // ---- Scrollable body ----
  const axis = el('div', { class: 'timegrid__axis' });
  for (let h = 0; h < 24; h++) {
    const labels = [];
    if (h !== 0) {
      if (secondaryTz) {
        labels.push(
          el('span', {
            class: 'timegrid__hour-label timegrid__hour-label--secondary',
            // Resolve the instant from the wall-clock hour (not a fixed ms
            // offset) so a DST-transition day stays aligned with the local axis
            // — mirrors how event geometry uses instantFromMinutes.
            text: formatTimeInZone(instantFromMinutes(tzRef, h * 60), secondaryTz, { hour12 }),
          }),
        );
      }
      labels.push(el('span', { class: 'timegrid__hour-label', text: formatHourLabel(h, { hour12 }) }));
    }
    axis.append(el('div', { class: 'timegrid__hour' }, labels));
  }

  const cols = el('div', { class: 'timegrid__cols' });
  // Geometry shared with the drag handler — resolved lazily at drag time, so
  // it's safe that the columns are still being appended in this loop.
  const grid = { cols, days, hourH: HOUR_H };
  perDay.forEach(({ day, dayStart, dayEnd, timed, timedTasks }) => {
    const col = el('div', {
      class: `timegrid__col${isToday(day, now) ? ' is-today' : ''}`,
      // Epoch ms of this column's local midnight — the move-drag reads it from
      // the live DOM so a mid-drag re-render (edge auto-paging) is transparent.
      dataset: { day: String(dayStart) },
    });

    // Background hour slots (grid lines + click target).
    for (let h = 0; h < 24; h++) {
      col.append(el('div', { class: 'timegrid__slot' }));
    }

    // Click to create at the pointed time.
    col.addEventListener('click', (e) => {
      if (e.target.closest('.tevent')) return;
      actions.createAt({ start: timeFromPointer(e, col, day) });
    });
    col.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tevent')) return;
      actions.slotContextMenu(e, timeFromPointer(e, col, day));
    });

    // Press-and-drag on empty space to block out an event of arbitrary length.
    attachTimedCreate(col, day, ctx, HOUR_H);

    // Timed events and tasks share ONE column layout, so anything overlapping in
    // time — event-vs-event, task-vs-task, and event-vs-task — is packed into
    // adjacent columns and sits side by side instead of stacking on top of each
    // other. A task is a single instant, so it's given a nominal span
    // (TASK_SPAN_MS) purely so it claims a column against neighbours near its due
    // time; events keep their real clipped span. The `__task` tag routes each
    // laid-out item back to its own builder (which turns colIndex/colCount into
    // the left/width geometry).
    const timedItems = [
      ...timed.map((ev) => ({ ...ev, __task: false })),
      ...timedTasks.map((t) => ({ ...t, __task: true, start: t.due, end: t.due + TASK_SPAN_MS })),
    ];
    layoutColumns(timedItems).forEach(({ event, colIndex, colCount }) => {
      col.append(
        event.__task
          ? buildTimedTaskChip(event, colIndex, colCount, dayStart, ctx, grid)
          : buildTimedEvent(event, colIndex, colCount, dayStart, dayEnd, ctx, grid),
      );
    });

    // Now indicator.
    if (isToday(day, now)) {
      col.append(el('div', { class: 'now-line', style: { top: `${nowLineTop(now)}px` } }));
    }

    cols.append(col);
  });

  const scroll = el('div', { class: 'timegrid__scroll' }, [
    el('div', { class: 'timegrid__body' }, [axis, cols]),
  ]);
  root.append(scroll);

  function afterMount() {
    // The date header and the all-day / tasks rails are siblings of the hour
    // scroller, not children of it, so the scroller's vertical scrollbar eats
    // width from the body's columns and from nothing else. Both bands are
    // `var(--gutter) 1fr` grids, so the 1fr track came out a scrollbar wider up
    // top: every day separator in the grid sat left of the one in the header,
    // drifting further across the view — a seventh of a scrollbar at the first
    // line and a whole one by the last. The today tint split down the same
    // seam. Hand the bands above the width the scroller actually took, so their
    // 1fr resolves against the same space.
    //
    // Measured rather than assumed: it is 0 with the overlay scrollbars macOS
    // uses by default, ~11-15px with classic ones, and it changes with browser
    // zoom — which fires a resize, and a resize re-renders through here.
    root.style.setProperty('--sbw', `${scroll.offsetWidth - scroll.clientWidth}px`);

    // Scroll so the working day (or the current time) is comfortably in view.
    const focusMin = perDay.some((d) => isToday(d.day, now))
      ? Math.max(0, minutesSinceMidnight(now) - 120)
      : 8 * 60;
    scroll.scrollTop = (focusMin / 60) * HOUR_H;
  }

  return { node: root, afterMount };
}

function timeFromPointer(e, col, day) {
  const rect = col.getBoundingClientRect();
  const y = Math.max(0, e.clientY - rect.top);
  const minutes = Math.min(24 * 60 - 30, Math.round(y / HOUR_H / 0.5) * 30);
  return minutesIntoDay(day, minutes).getTime();
}

/**
 * Resolve a drag-to-create gesture to a snapped time range. `anchorMin` is the
 * press position and `pointerMin` the current pointer, both in minutes from
 * midnight (unsnapped). The result is ordered (start ≤ end), snapped to `snap`,
 * clamped to the day, and never shorter than `minDur`. Pure — unit-tested.
 */
export function selectionRange(
  anchorMin,
  pointerMin,
  { snap = SNAP_MIN, minDur = SNAP_MIN, dayMinutes = MINUTES_PER_DAY } = {},
) {
  const snapClamp = (m) => Math.min(Math.max(Math.round(m / snap) * snap, 0), dayMinutes);
  const a = snapClamp(anchorMin);
  const b = snapClamp(pointerMin);
  let start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end - start < minDur) {
    end = Math.min(start + minDur, dayMinutes);
    start = end - minDur;
  }
  return { start, end };
}

/**
 * Press-and-drag on empty column space to block out a new event of arbitrary
 * length (Google-Calendar style). A live preview tracks the pointer showing the
 * snapped time range; releasing opens the new-event modal pre-filled with that
 * range. A plain click / tap (no travel past the threshold, no long-press) still
 * creates at the pointed time via the column's click handler. On touch the drag
 * begins only after a long-press (see draggable), so a swipe still scrolls.
 */
function attachTimedCreate(col, day, ctx, hourH) {
  let draft = null;
  let anchorMin = 0;
  let sel = null;

  draggable(col, {
    // Empty space only — a press on an event or timed-task chip runs its own
    // handlers. Touch is allowed: draggable() starts a create only on a
    // long-press, so a plain swipe still scrolls the grid and a tap still
    // creates at the slot.
    canStart: (e) => !e.target.closest('.tevent, .task-chip'),
    onStart(e, origin) {
      const rect = col.getBoundingClientRect();
      anchorMin = ((origin.y - rect.top) / hourH) * 60;
      draft = el(
        'div',
        { class: 'tg-draft', 'aria-hidden': 'true', style: { '--draft-fill': colorHex(DEFAULT_COLOR), '--ev-fg': colorFg(DEFAULT_COLOR) } },
        [el('span', { class: 'tg-draft__time' })],
      );
      col.append(draft);
      update(e);
    },
    onMove: update,
    onDrop() {
      const range = sel;
      if (!range) return cleanup();
      const base = startOfDay(day).getTime();
      // Hand the preview block to the editor instead of clearing it: it stays on
      // the calendar as a placeholder for the event being created and is removed
      // only when the modal closes (on save the re-render replaces it anyway; on
      // cancel this is what takes it away). Detach it from local state so a fresh
      // drag starts a new draft.
      const preview = draft;
      draft = null;
      sel = null;
      ctx.actions.createAt({
        start: instantFromMinutes(base, range.start),
        end: instantFromMinutes(base, range.end),
        onClose: () => preview.remove(),
      });
    },
    onCancel: cleanup,
  });

  function update(e) {
    // Resolve the LIVE column: a mid-gesture re-render (on touch, a second
    // finger tapping a nav control) replaces every column node, and a detached
    // rect of all zeros would compute minutes from the viewport origin. If the
    // day paged out of view, void the selection so the drop is a no-op.
    const liveCol = liveColumnFor(col, startOfDay(day).getTime());
    if (!liveCol) {
      sel = null;
      return;
    }
    col = liveCol;
    if (draft && draft.parentElement !== liveCol) liveCol.append(draft);
    const rect = col.getBoundingClientRect();
    const pointerMin = ((e.clientY - rect.top) / hourH) * 60;
    sel = selectionRange(anchorMin, pointerMin);
    draft.style.top = `${(sel.start / 60) * hourH}px`;
    draft.style.height = `${Math.max(((sel.end - sel.start) / 60) * hourH, MIN_EVENT_H)}px`;
    const base = startOfDay(day).getTime();
    const label = draft.querySelector('.tg-draft__time');
    if (label) {
      label.textContent = formatTimeRange(
        new Date(instantFromMinutes(base, sel.start)),
        new Date(instantFromMinutes(base, sel.end)),
        { hour12: ctx.settings.hour12 },
      );
    }
  }

  function cleanup() {
    if (draft) draft.remove();
    draft = null;
    sel = null;
  }
}

function buildTimedEvent(event, colIndex, colCount, dayStart, dayEnd, ctx, grid) {
  // `event` is a per-day CLIPPED copy (start/end clamped to the day window),
  // used for positioning within the column. `source` is the full, unclipped
  // event resolved from the store — used for the label and all interactions so
  // cross-midnight events show their true times and aren't truncated on edit.
  const source = ctx.store.getEvent(event.id) || event;
  const clipStart = Math.max(event.start, dayStart);
  const clipEnd = Math.min(event.end, dayEnd);
  const startMin = minutesFromMidnight(clipStart, dayStart);
  const durMin = Math.max(minutesFromMidnight(clipEnd, dayStart) - startMin, 15);
  const top = (startMin / 60) * HOUR_H;
  const height = Math.max((durMin / 60) * HOUR_H, MIN_EVENT_H);
  const isShort = height < 34;

  const hex = colorHex(source.color);
  const node = el('div', {
    class: `tevent${isShort ? ' is-short' : ''}${source.ooo ? ' is-ooo' : ''}${source.declined ? ' is-declined' : ''}`,
    style: {
      top: `${top}px`,
      height: `${height}px`,
      left: `calc(${(colIndex / colCount) * 100}% + 2px)`,
      width: `calc(${(1 / colCount) * 100}% - 4px)`,
      '--ev-fill': hex,
      '--ev-fg': colorFg(source.color),
    },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${source.id}` },
    title: source.title || '(Untitled)',
    'aria-label': `${source.title || 'Untitled'}, ${formatTimeRange(new Date(source.start), new Date(source.end), { hour12: ctx.settings.hour12 })}`,
  });

  node.append(el('span', { class: 'tevent__title', text: source.title || '(Untitled)' }));
  if (!isShort) {
    node.append(
      el('span', {
        class: 'tevent__time',
        text: formatTimeRange(new Date(source.start), new Date(source.end), {
          hour12: ctx.settings.hour12,
        }),
      }),
    );
  } else {
    node.append(
      el('span', {
        class: 'tevent__time',
        text: formatTime(new Date(source.start), { hour12: ctx.settings.hour12 }),
      }),
    );
  }

  attachEventHandlers(node, source, ctx);
  // Drag-to-move and edge-resize attach only for events living entirely within
  // this day. A clipped cross-midnight/multi-day sliver has no single-day
  // geometry: its full duration doesn't fit one column, so the move clamp
  // (MINUTES_PER_DAY − durMin) would snap the start hours away on the slightest
  // drag, and an edge has no single day to resize against. Such events stay
  // clickable (open the editor) and are repositioned via the modal instead.
  const withinDay = source.start >= dayStart && source.end <= dayEnd + 1;
  if (grid && withinDay) {
    attachTimedDrag(node, source, ctx, grid);
    attachTimedResize(node, source, ctx, grid, dayStart);
  }
  return node;
}

/**
 * Drag an event's top or bottom edge to change its start or end time (snapped
 * to quarter-hours, minimum 15 minutes). The block resizes live under the
 * pointer; the change commits on release. Pressing an edge never starts a
 * whole-event move — the handle swallows the pointerdown.
 */
function attachTimedResize(node, source, ctx, grid, dayStart) {
  const { hourH } = grid;
  const startMin = Math.round(minutesFromMidnight(source.start, dayStart));
  const endMin = Math.round(minutesFromMidnight(source.end, dayStart));

  ['top', 'bottom'].forEach((edge) => {
    const handle = el('div', { class: `tevent__resize tevent__resize--${edge}`, 'aria-hidden': 'true' });
    // A press on the handle must not also trigger the whole-event move drag.
    handle.addEventListener('pointerdown', (e) => e.stopPropagation());
    node.append(handle);

    let orig = null;
    let pending = null;

    draggable(handle, {
      onStart() {
        orig = {
          col: node.closest('.timegrid__col') || node.parentElement,
          top: node.style.top,
          height: node.style.height,
          short: node.classList.contains('is-short'),
          timeText: node.querySelector('.tevent__time')?.textContent,
        };
        node.classList.add('tevent--resizing');
        pending = null;
      },
      onMove(e) {
        // Recompute the column rect each move so scrolling mid-resize stays
        // accurate (mirrors the move-drag's columnAt), resolving the LIVE
        // column in case a mid-gesture re-render replaced it. If this day
        // paged out entirely, void the pending commit and ignore the move.
        const col = liveColumnFor(orig.col, dayStart);
        if (!col) {
          pending = null;
          return;
        }
        orig.col = col;
        const y = e.clientY - col.getBoundingClientRect().top;
        const snapped = Math.round((y / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
        const { s, en } = resizedEdges(edge, snapped, startMin, endMin);

        const height = Math.max(((en - s) / 60) * hourH, MIN_EVENT_H);
        node.style.top = `${(s / 60) * hourH}px`;
        node.style.height = `${height}px`;
        node.classList.toggle('is-short', height < 34);

        // Only the dragged edge moves; keep the other edge's exact original
        // instant so a sub-minute (imported) event isn't silently nudged by the
        // minute-rounding of startMin/endMin. For whole-minute events this is
        // identical to instantFromMinutes(dayStart, startMin/endMin).
        pending = {
          start: edge === 'top' ? instantFromMinutes(dayStart, s) : source.start,
          end: edge === 'bottom' ? instantFromMinutes(dayStart, en) : source.end,
        };
        const timeEl = node.querySelector('.tevent__time');
        if (timeEl) {
          timeEl.textContent = formatTimeRange(new Date(pending.start), new Date(pending.end), {
            hour12: ctx.settings.hour12,
          });
        }
      },
      onDrop() {
        node.classList.remove('tevent--resizing');
        const p = pending;
        pending = null;
        if (!p || (p.start === source.start && p.end === source.end)) return;
        ctx.actions.resizeEvent(source, p.start, p.end);
      },
      onCancel() {
        node.classList.remove('tevent--resizing');
        if (orig) {
          node.style.top = orig.top;
          node.style.height = orig.height;
          node.classList.toggle('is-short', orig.short);
          const timeEl = node.querySelector('.tevent__time');
          if (timeEl && orig.timeText != null) timeEl.textContent = orig.timeText;
        }
        pending = null;
      },
    });
  });
}

/**
 * Drag a timed event to reschedule it: vertical travel changes the start time
 * (snapped to quarter-hours), horizontal travel moves it between day columns.
 * The original stays dimmed in place while a full-width "ghost" follows the
 * pointer showing the live target time; the move is committed on release.
 */
function attachTimedDrag(node, source, ctx, grid) {
  const { hourH } = grid;
  const durMs = source.end - source.start;
  // `durMin` snaps up to SNAP_MIN and rounds to whole minutes — right for the
  // day-clamp and the ghost's minimum-visible height. The committed/previewed end
  // comes from movedEventEnd() instead, so a short (sub-15-min) or sub-minute
  // imported event keeps its exact duration rather than being snapped up.
  const durMin = Math.max(SNAP_MIN, Math.round(durMs / 60_000));
  let ghost = null;
  let grabOffsetY = 0; // pointer-to-event-top offset, so the block doesn't jump
  let target = null; // { day, startMin }
  let px = 0;
  let py = 0;

  // Hold the event against the left/right edge to page to the previous/next
  // week or day; hold against the top/bottom edge to scroll the hour grid to
  // reveal earlier/later times. Geometry is read from the live DOM (columns
  // carry their day as `data-day`), so the drag rides through the re-render an
  // edge-page triggers and always drops on an absolute day + time.
  const pan = createEdgePan({
    getBounds: () => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return null;
      const s = scroll.getBoundingClientRect();
      const colsEl = document.querySelector('.timegrid__cols');
      const c = colsEl ? colsEl.getBoundingClientRect() : s;
      // Horizontal extent from the day columns (excludes the hour gutter);
      // vertical extent from the scroll viewport.
      return { left: c.left, right: c.right, top: s.top, bottom: s.bottom };
    },
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py); // re-target against the newly rendered period
    },
    onScroll: (dir, dy) => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return;
      scroll.scrollTop += dir * dy;
      applyAt(px, py); // keep the ghost under the pointer as hours scroll past
    },
  });

  draggable(node, {
    onStart(e, origin) {
      const startTop = parseFloat(node.style.top) || 0;
      const startCol = node.closest('.timegrid__col');
      const rect = (startCol || node.parentElement).getBoundingClientRect();
      grabOffsetY = origin.y - rect.top - startTop;

      ghost = node.cloneNode(true);
      ghost.classList.add('tevent--ghost');
      ghost.classList.remove('tevent--drag-source');
      ghost.removeAttribute('tabindex');
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      node.classList.add('tevent--drag-source');
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onMove(e) {
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onDrop() {
      pan.stop();
      const drop = target; // cleanup() clears `target`, so capture it first
      cleanup();
      if (!drop) return;
      const dayStart = startOfDay(drop.day).getTime();
      const newStart = instantFromMinutes(dayStart, drop.startMin);
      if (newStart === source.start) return;
      // Preserve the exact duration (see movedEventEnd) — DST-safe and mirroring
      // the resize handler / month drag, rather than snapping a short event up.
      const newEnd = movedEventEnd(durMs, dayStart, drop.startMin);
      ctx.actions.moveEvent(source, newStart, newEnd);
    },
    onCancel() {
      pan.stop();
      cleanup();
    },
  });

  function applyAt(x, y) {
    const col = columnAt(x);
    if (!col) {
      // columnAt is null only when the time grid itself is GONE (a second
      // finger switched views mid-drag). Keeping the last resolved target
      // would commit the event to a time hovered in a view that no longer
      // exists — void the drop instead; a later re-render re-targets.
      target = null;
      if (ghost) ghost.remove();
      return;
    }
    const yInCol = y - col.rect.top - grabOffsetY;
    const raw = Math.round((yInCol / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
    const startMin = clampMoveStart(raw, durMs);
    target = { day: new Date(col.dayMs), startMin };

    // Re-parent onto the live column (its identity changes after a page).
    if (ghost.parentElement !== col.el) col.el.append(ghost);
    ghost.style.top = `${(startMin / 60) * hourH}px`;
    ghost.style.height = `${Math.max((durMin / 60) * hourH, MIN_EVENT_H)}px`;
    ghost.style.left = '2px';
    ghost.style.width = 'calc(100% - 4px)';

    const dayStartMs = startOfDay(target.day).getTime();
    const start = new Date(instantFromMinutes(dayStartMs, startMin));
    // Match the commit exactly (see movedEventEnd) so the preview time equals the
    // saved time even for a short event `durMin` would round up.
    const end = new Date(movedEventEnd(durMs, dayStartMs, startMin));
    const timeEl = ghost.querySelector('.tevent__time');
    if (timeEl) {
      const opts = { hour12: ctx.settings.hour12 };
      timeEl.textContent = ghost.classList.contains('is-short')
        ? formatTime(start, opts)
        : formatTimeRange(start, end, opts);
    }
  }

  function cleanup() {
    node.classList.remove('tevent--drag-source');
    ghost?.remove();
    ghost = null;
    target = null;
  }
}

/**
 * The day column under `clientX`, clamped to the first/last column. Reads the
 * live DOM (not a captured node list) so it still resolves after an auto-page
 * re-render swaps every column; each column carries its day as `data-day`.
 */
/**
 * The live column node for a day: the captured node while it is still attached,
 * else its re-rendered replacement, else null when the day is no longer in
 * view. A re-render can swap every column mid-gesture — on touch, a second
 * finger can tap a nav arrow / view tab while the first is resizing or
 * drag-creating — and measuring a detached node's rect returns zeros, which
 * would silently commit times computed from the viewport origin (hours off).
 */
function liveColumnFor(node, dayMs) {
  if (node && node.isConnected) return node;
  return document.querySelector(`.timegrid__cols > .timegrid__col[data-day="${dayMs}"]`);
}

function columnAt(clientX) {
  const els = document.querySelectorAll('.timegrid__cols > .timegrid__col');
  if (!els.length) return null;
  const last = els.length - 1;
  for (let i = 0; i <= last; i++) {
    const rect = els[i].getBoundingClientRect();
    if (clientX < rect.right || i === last) {
      return { idx: i, el: els[i], rect, dayMs: Number(els[i].dataset.day) };
    }
  }
  const first = els[0];
  return { idx: 0, el: first, rect: first.getBoundingClientRect(), dayMs: Number(first.dataset.day) };
}

function buildAllDayChip(event, ctx) {
  const node = el('div', {
    class: `allday-chip${event.ooo ? ' is-ooo' : ''}${event.declined ? ' is-declined' : ''}`,
    style: { '--chip-color': colorHex(event.color), '--ev-fg': colorFg(event.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${event.id}` },
    title: event.title || '(Untitled)',
    'aria-label': `${event.ooo ? 'Out of office: ' : ''}${event.title || 'Untitled'}, all day`,
  });
  if (event.ooo) node.append(el('span', { class: 'allday-chip__icon', html: icon('plane', { size: 'sm' }) }));
  node.append(el('span', { class: 'allday-chip__title', text: event.title || '(Untitled)' }));
  attachEventHandlers(node, event, ctx);
  return node;
}

/**
 * A read-only overlay item in the all-day rail — a public holiday (holidays.js)
 * or a clock change (dst.js). Opens the read-only details card like its
 * month-view twin; no drag and no context menu, because there is no stored
 * event behind it to move or delete.
 */
function buildOverlayChip(item, ctx) {
  const kind = item.dst ? 'Clock change' : 'Public holiday';
  const node = el(
    'div',
    {
      class: 'allday-chip allday-chip--holiday',
      tabindex: '0',
      role: 'button',
      dataset: { focusKey: item.id },
      title: item.dst ? item.title : `${item.title} · ${item.countryName}`,
      'aria-label': `${kind}: ${item.title}`,
    },
    [
      el('span', { class: 'allday-chip__icon', html: icon(item.dst ? 'clock' : 'flag', { size: 'sm' }), 'aria-hidden': 'true' }),
      el('span', { class: 'allday-chip__title', text: item.title }),
    ],
  );
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(item);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(item);
    }
  });
  return node;
}

function buildTaskChip(task, ctx) {
  const timeText = task.allDay ? '' : formatTime(new Date(task.due), { hour12: ctx.settings.hour12 });
  const node = el('div', {
    class: `allday-chip task-chip${task.done ? ' is-done' : ''}`,
    style: { '--chip-color': colorHex(task.color), '--ev-fg': colorFg(task.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `task:${task.id}` },
    title: task.title || '(Untitled task)',
    'aria-label': `Task: ${task.title || 'Untitled'}${task.done ? ', done' : ''}`,
  });
  const check = el('button', {
    class: `chip__check${task.done ? ' is-checked' : ''}`,
    type: 'button',
    role: 'checkbox',
    'aria-checked': String(task.done),
    'aria-label': task.done ? 'Mark as not done' : 'Mark as done',
    html: task.done ? icon('check', { size: 'sm' }) : '',
    on: {
      click: (e) => {
        e.stopPropagation();
        ctx.actions.toggleTask(task);
      },
    },
  });
  node.append(check);
  // Title first, with the due time as a compact suffix on the same line. The
  // title is the task's identity (its position on the hour grid already conveys
  // the time), so when a packed column squeezes the chip the time truncates away
  // before the title does — a narrow chip still reads "Re…" rather than a
  // title-less "2:4". The time stays in a `.allday-chip__time` span (nested in
  // the title so it shares the one ellipsized run) so the drag ghost can still
  // update it in place. An all-day task has no time and renders title-only.
  const titleEl = el('span', { class: 'allday-chip__title', text: task.title || '(Untitled task)' });
  if (timeText) titleEl.append(el('span', { class: 'allday-chip__time', text: timeText }));
  node.append(titleEl);

  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openTask(task);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // The nested check button handles its own keys: preventDefault here
      // would cancel its activation and open the editor over a toggle.
      if (e.target.closest('.chip__check')) return;
      e.preventDefault();
      ctx.actions.openTask(task);
    }
  });
  node.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.taskContextMenu(e, task);
  });
  return node;
}

/**
 * A timed task placed on the hour grid at its due time (vs. the all-day rail).
 * Reuses the rail chip for identical look + interactions, then positions it like
 * an event. `colIndex`/`colCount` come from laying the day's timed tasks out
 * among themselves, so several due at once sit side by side.
 */
function buildTimedTaskChip(task, colIndex, colCount, dayStart, ctx, grid) {
  const node = buildTaskChip(task, ctx);
  node.classList.add('task-chip--grid');
  const startMin = minutesFromMidnight(task.due, dayStart);
  node.style.top = `${(startMin / 60) * HOUR_H}px`;
  node.style.left = `calc(${(colIndex / colCount) * 100}% + 2px)`;
  node.style.width = `calc(${(1 / colCount) * 100}% - 4px)`;
  if (grid) attachTimedTaskDrag(node, task, ctx, grid);
  return node;
}

/**
 * Drag a timed task to reschedule it: vertical travel changes its due time
 * (snapped to quarter-hours), horizontal travel moves it between day columns.
 * Mirrors attachTimedDrag, but a task is a single instant — there's no duration
 * to preserve or resize, so the ghost keeps the chip's own height and only the
 * due time is committed. The check-off control keeps its own click (a press
 * there never starts a drag).
 */
function attachTimedTaskDrag(node, task, ctx, grid) {
  const { hourH } = grid;
  let ghost = null;
  let grabOffsetY = 0; // pointer-to-chip-top offset, so the chip doesn't jump
  let target = null; // { day, startMin }
  let px = 0;
  let py = 0;

  const pan = createEdgePan({
    getBounds: () => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return null;
      const s = scroll.getBoundingClientRect();
      const colsEl = document.querySelector('.timegrid__cols');
      const c = colsEl ? colsEl.getBoundingClientRect() : s;
      return { left: c.left, right: c.right, top: s.top, bottom: s.bottom };
    },
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py);
    },
    onScroll: (dir, dy) => {
      const scroll = document.querySelector('.timegrid__scroll');
      if (!scroll) return;
      scroll.scrollTop += dir * dy;
      applyAt(px, py);
    },
  });

  draggable(node, {
    // A press on the check-off toggle is a click, not a reschedule.
    canStart: (e) => !e.target.closest('.chip__check'),
    onStart(e, origin) {
      const startTop = parseFloat(node.style.top) || 0;
      const startCol = node.closest('.timegrid__col');
      const rect = (startCol || node.parentElement).getBoundingClientRect();
      grabOffsetY = origin.y - rect.top - startTop;

      ghost = node.cloneNode(true);
      ghost.classList.add('task-chip--ghost');
      ghost.removeAttribute('tabindex');
      ghost.removeAttribute('role');
      ghost.setAttribute('aria-hidden', 'true');
      node.classList.add('task-chip--drag-source');
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onMove(e) {
      px = e.clientX;
      py = e.clientY;
      applyAt(px, py);
      pan.move(px, py);
    },
    onDrop() {
      pan.stop();
      const drop = target; // cleanup() clears `target`, so capture it first
      cleanup();
      if (!drop) return;
      const dayStart = startOfDay(drop.day).getTime();
      const newDue = instantFromMinutes(dayStart, drop.startMin);
      if (newDue === task.due) return;
      ctx.actions.moveTask(task, newDue);
    },
    onCancel() {
      pan.stop();
      cleanup();
    },
  });

  function applyAt(x, y) {
    const col = columnAt(x);
    if (!col) {
      // Same rule as the event drag above: columnAt is null only when the
      // grid itself is gone (a second finger switched views mid-drag), and a
      // kept target would commit the task to a time hovered in a dead view.
      target = null;
      if (ghost) ghost.remove();
      return;
    }
    const yInCol = y - col.rect.top - grabOffsetY;
    const raw = Math.round((yInCol / hourH) * 60 / SNAP_MIN) * SNAP_MIN;
    // A task is a single instant (no duration), so clamp only to the last
    // snap slot of the day — 23:45 for a 15-min snap. Clamping by the chip's
    // nominal layout span (30 min) would wrongly forbid the final half hour.
    const startMin = Math.min(Math.max(0, raw), MINUTES_PER_DAY - SNAP_MIN);
    target = { day: new Date(col.dayMs), startMin };

    if (ghost.parentElement !== col.el) col.el.append(ghost);
    ghost.style.top = `${(startMin / 60) * hourH}px`;
    ghost.style.left = '2px';
    ghost.style.width = 'calc(100% - 4px)';

    const dayStartMs = startOfDay(target.day).getTime();
    const due = new Date(instantFromMinutes(dayStartMs, startMin));
    const timeEl = ghost.querySelector('.allday-chip__time');
    if (timeEl) timeEl.textContent = formatTime(due, { hour12: ctx.settings.hour12 });
  }

  function cleanup() {
    node.classList.remove('task-chip--drag-source');
    ghost?.remove();
    ghost = null;
    target = null;
  }
}

function attachEventHandlers(node, event, ctx) {
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(event);
  });
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(event);
    }
  });
  node.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.eventContextMenu(e, event);
  });
}
