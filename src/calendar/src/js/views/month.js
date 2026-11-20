/**
 * Month view: a 7-column grid snapped to whole weeks. Each cell shows event
 * chips; overflow is collapsed into a "+N more" affordance whose count is
 * measured after layout so it stays accurate at any viewport height.
 */
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { draggable } from '../drag.js';
import { createEdgePan } from '../edge-autopan.js';
import { colorHex, colorFg } from '../colors.js';
import {
  getMonthGrid,
  orderedWeekdays,
  addDays,
  diffCalendarDays,
  startOfDay,
  endOfDay,
  isToday,
  isSameMonth,
  isWeekend,
  formatTime,
  formatFullDate,
  displayedWeekNumber,
  WEEKDAYS_SHORT,
} from '../date-utils.js';

const DROP_TARGET_CLASS = 'is-drop-target'; // the cell a dragged chip would land on

export function renderMonth(ctx) {
  const { store, settings, cursor, now, actions } = ctx;
  const grid = getMonthGrid(cursor, settings.weekStartsOn);
  const showWeeks = settings.showWeekNumbers === true;

  const root = el('div', { class: 'view month' + (showWeeks ? ' month--weeks' : '') });

  // Weekday header.
  const dow = el('div', { class: 'month__dow' });
  if (showWeeks) {
    // Empty corner above the week-number gutter, so the seven weekday labels
    // still line up with the day cells.
    dow.append(el('div', { class: 'month__weeknum month__weeknum--head', 'aria-hidden': 'true' }));
  }
  orderedWeekdays(settings.weekStartsOn).forEach((idx) => {
    dow.append(el('div', { class: 'month__dow-cell', text: WEEKDAYS_SHORT[idx] }));
  });
  root.append(dow);

  const gridEl = el('div', { class: 'month__grid' });
  const cellData = [];

  grid.forEach((day, i) => {
    if (showWeeks && i % 7 === 0) {
      const weekStart = day;
      const week = displayedWeekNumber(weekStart);
      gridEl.append(
        el('button', {
          class: 'month__weeknum',
          type: 'button',
          text: String(week),
          title: `Open week ${week}`,
          'aria-label': `Open week ${week}`,
          on: {
            click: (e) => {
              e.stopPropagation();
              actions.gotoWeekView(weekStart);
            },
          },
        }),
      );
    }
    const inMonth = isSameMonth(day, cursor);
    const cell = el('div', {
      class:
        'month__cell' +
        (inMonth ? '' : ' is-othermonth') +
        (isToday(day, now) ? ' is-today' : '') +
        (isWeekend(day) ? ' is-weekend' : ''),
      // Today is painted; say it too, for anyone who can't see the tint.
      'aria-current': isToday(day, now) ? 'date' : null,
      // Epoch ms of this cell's local midnight — the drag hit-test reads it from
      // the live DOM so a mid-drag re-render (edge auto-paging) is transparent.
      dataset: { day: String(startOfDay(day).getTime()) },
      on: {
        click: (e) => {
          if (e.target.closest('.chip') || e.target.closest('.month__more')) return;
          // On compact screens events collapse to dots, so a tap opens the day.
          if (window.matchMedia('(max-width: 520px)').matches) actions.gotoDayView(day);
          else actions.createAt({ start: defaultCreateTime(day), allDay: false });
        },
        contextmenu: (e) => {
          if (e.target.closest('.chip')) return;
          actions.slotContextMenu(e, defaultCreateTime(day));
        },
      },
    });

    cell.append(
      el('span', {
        class: 'month__daynum',
        text: String(day.getDate()),
        role: 'button',
        tabindex: '0',
        title: 'Open day',
        'aria-label': `Open ${formatFullDate(day)}`,
        style: { cursor: 'pointer' },
        on: {
          click: (e) => {
            e.stopPropagation();
            actions.gotoDayView(day);
          },
          keydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              actions.gotoDayView(day);
            }
          },
        },
      }),
    );

    const eventsWrap = el('div', { class: 'month__events' });
    const dayStart = startOfDay(day).getTime();
    const dayEnd = endOfDay(day).getTime();
    const events = store.getEventsInRange(dayStart, dayEnd + 1, { includeHolidays: true });
    const tasks = store.getTasksInRange(dayStart, dayEnd + 1);
    events.forEach((ev) =>
      eventsWrap.append(ev.readOnly ? buildOverlayChip(ev, ctx) : buildChip(ev, day, ctx, cellData)),
    );
    tasks.forEach((t) => eventsWrap.append(buildTaskChip(t, day, ctx, cellData)));
    cell.append(eventsWrap);

    gridEl.append(cell);
    cellData.push({ cell, eventsWrap, count: events.length + tasks.length, day });
  });

  root.append(gridEl);

  function afterMount() {
    const dotMode = window.matchMedia('(max-width: 520px)').matches;
    if (dotMode) return; // dots wrap + clip via CSS; no "+more" needed
    // All measures up front, in one layout pass: the grid's 1fr rows size the
    // cells from the container, so visibility of chips can't change these —
    // and reading geometry between the per-cell hides/appends below would
    // force a fresh reflow for nearly every one of the ~40 cells.
    //
    // MEASURED, not assumed. The room under the day number and the height of
    // a chip used to be constants beside the stylesheet, and drifted from it:
    // the constants were 8px too generous on the room and 1px too tight on
    // the chip, so a cell tall enough for four rows showed three chips and a
    // "+N more" whose bottom edge sat 5px past the cell — clipped, along with
    // the descenders of a fourth chip when exactly four fit. Every cell has
    // the same paddings and the same chip metrics, so one cell's numbers
    // serve all; the "more" button is sized like a chip in the stylesheet.
    const sample = cellData.find(({ count }) => count > 0);
    if (!sample) return;
    const chip = sample.eventsWrap.firstElementChild;
    const gap = parseFloat(getComputedStyle(sample.eventsWrap).gap) || 0;
    const rowH = (chip ? chip.offsetHeight : 0) + gap;
    if (!(rowH > gap)) return; // nothing measurable (a detached render)
    const rooms = cellData.map(({ cell, eventsWrap, count }) =>
      count ? cell.clientHeight - eventsWrap.offsetTop - parseFloat(getComputedStyle(cell).paddingBottom) : 0,
    );
    cellData.forEach(({ eventsWrap, count, day }, idx) => {
      if (count === 0) return;
      const chips = [...eventsWrap.querySelectorAll('.chip')];
      // Reset any prior collapse.
      chips.forEach((c) => (c.hidden = false));
      const existingMore = eventsWrap.querySelector('.month__more');
      if (existingMore) existingMore.remove();

      // Rows that fit: n rows take n heights and n-1 gaps.
      const capacity = Math.max(1, Math.floor((rooms[idx] + gap) / rowH));
      if (count <= capacity) return;

      // The "+N more" row takes the last slot.
      const visible = Math.max(1, capacity - 1);
      chips.forEach((c, i) => {
        c.hidden = i >= visible;
      });
      const more = el('button', {
        class: 'month__more',
        type: 'button',
        text: `${count - visible} more`,
        on: {
          click: (e) => {
            e.stopPropagation();
            actions.gotoDayView(day);
          },
        },
      });
      eventsWrap.append(more);
    });
  }

  return { node: root, afterMount };
}

function defaultCreateTime(day) {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

function buildChip(event, day, ctx, cellData) {
  const hex = colorHex(event.color);
  // ">= 24h of real time" alone would misread the 25-hour DST fall-back day:
  // a timed event covering most of it is still a same-day event and renders
  // as a normal dot chip, not a filled multi-day bar (mirrors splitDayEvents).
  const multiDay =
    startOfDay(new Date(event.start)).getTime() !== startOfDay(new Date(event.end)).getTime();
  const filled = event.allDay || (event.end - event.start >= 24 * 3600_000 && multiDay);
  // A timed event that crosses midnight gets its own chip in each day it touches.
  // Label it with its start *within this cell's day*, not the original start: on
  // the day after it began the event is present from midnight, so a 11:30 PM →
  // 12:30 AM event must read "12 AM" (not the misleading "11:30 PM") on that
  // second day. On the start day this is just event.start, so nothing changes.
  const shownStart = Math.max(event.start, startOfDay(day).getTime());
  const chip = el('div', {
    class: `chip${filled ? ' chip--filled' : ''}${event.ooo ? ' is-ooo' : ''}${event.declined ? ' is-declined' : ''}`,
    style: { '--chip-color': hex, '--ev-fg': colorFg(event.color) },
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: `ev:${event.id}` },
    title: event.title || '(Untitled)',
    'aria-label': `${event.ooo ? 'Out of office: ' : ''}${event.title || 'Untitled'}${event.declined ? ' (declined)' : ''}${event.allDay ? ', all day' : ', ' + formatTime(new Date(shownStart), { hour12: ctx.settings.hour12 })}`,
  });

  if (event.ooo) chip.append(el('span', { class: 'chip__ooo-icon', html: icon('plane', { size: 'sm' }) }));
  if (!filled && !event.ooo) chip.append(el('span', { class: 'chip__dot' }));
  if (!filled && !event.allDay) {
    chip.append(
      el('span', {
        class: 'chip__time',
        text: formatTime(new Date(shownStart), { hour12: ctx.settings.hour12 }),
      }),
    );
  }
  chip.append(el('span', { class: 'chip__title', text: event.title || '(Untitled)' }));

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(event);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(event);
    }
  });
  chip.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.eventContextMenu(e, event);
  });
  if (cellData) {
    attachMonthDrag(chip, day, ctx, (delta) => {
      const start = addDays(new Date(event.start), delta).getTime();
      const end = addDays(new Date(event.end), delta).getTime();
      ctx.actions.moveEvent(event, start, end);
    });
  }
  return chip;
}

/**
 * A read-only overlay item — a public holiday (holidays.js) or a clock change
 * (dst.js). It opens the same details card an event does — read-only there,
 * since there is no stored event behind it — because a month cell truncates
 * "National Day for Truth and Reconciliation" to three words and a hover
 * tooltip is the only other way to read the rest, which touch never gets. No
 * drag and no context menu: there is nothing to move or delete. The month
 * cell's own click handler skips anything matching `.chip`, so a click here
 * does not fall through and create a 9 a.m. event either.
 */
function buildOverlayChip(item, ctx) {
  const kind = item.dst ? 'Clock change' : 'Public holiday';
  const chip = el('div', {
    class: 'chip chip--holiday',
    tabindex: '0',
    role: 'button',
    dataset: { focusKey: item.id },
    title: item.dst ? item.title : `${item.title} · ${item.countryName}`,
    // Named by kind so a screen reader can tell it from an event; the label
    // also survives the ≤520px dot mode, where the visible title is
    // display:none and the chip would otherwise read as nothing.
    'aria-label': `${kind}: ${item.title}`,
  }, [
    el('span', { class: 'chip__holiday-icon', html: icon(item.dst ? 'clock' : 'flag', { size: 'sm' }), 'aria-hidden': 'true' }),
    el('span', { class: 'chip__title', text: item.title }),
  ]);
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openEvent(item);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ctx.actions.openEvent(item);
    }
  });
  return chip;
}

function buildTaskChip(task, day, ctx, cellData) {
  const chip = el('div', {
    class: `chip chip--task${task.done ? ' is-done' : ''}`,
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
  chip.append(check, el('span', { class: 'chip__title', text: task.title || '(Untitled task)' }));
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.actions.openTask(task);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      // The nested check button handles its own keys: preventDefault here
      // would cancel its activation and open the editor over a toggle.
      if (e.target.closest('.chip__check')) return;
      e.preventDefault();
      ctx.actions.openTask(task);
    }
  });
  chip.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    ctx.actions.taskContextMenu(e, task);
  });
  if (cellData) {
    attachMonthDrag(chip, day, ctx, (delta) =>
      ctx.actions.moveTask(task, addDays(new Date(task.due), delta).getTime()),
    );
  }
  return chip;
}

/**
 * Drag a month chip (event or task) onto another day to reschedule it. On drop
 * `onCommit(delta)` receives the number of calendar days between the chip's
 * origin cell and the drop cell; the caller shifts its own dates by that delta
 * (preserving time of day, DST-safe — events keep their duration, tasks their
 * due time).
 *
 * Holding the chip against any edge of the grid pages to the neighbouring month
 * (previous on the left/top, next on the right/bottom), so a chip can be dropped
 * on dates outside the current viewport. Because the target cell is resolved
 * from the live DOM (by its `data-day`), the drag continues seamlessly across
 * the re-render that paging triggers; `chipDay` stays the chip's original day,
 * so the committed day-delta is correct no matter how many months were paged.
 */
function attachMonthDrag(chip, chipDay, ctx, onCommit) {
  let targetCell = null; // DOM cell under the pointer (may be detached after a page)
  let targetDay = null; // absolute drop day
  let px = 0;
  let py = 0;

  const clearHighlight = () => {
    // A detached cell (the grid re-rendered under an auto-page) drops the class
    // harmlessly, so this needs no isConnected guard.
    if (targetCell) targetCell.classList.remove(DROP_TARGET_CLASS);
    targetCell = null;
    targetDay = null;
  };

  // Re-resolve the cell/day under the pointer. Called on every move and again
  // after each auto-page so the target tracks the freshly-rendered grid.
  // Compares by day rather than node identity, since paging replaces the cell
  // nodes wholesale.
  const applyAt = (x, y) => {
    const hit = cellAt(x, y);
    const cell = hit ? hit.cell : null;
    if (cell === targetCell) return;
    if (targetCell) targetCell.classList.remove(DROP_TARGET_CLASS);
    targetCell = cell;
    targetDay = hit ? hit.day : null;
    // Ring the day the chip will land on. Unlike the time grid — where a ghost
    // block tracks the pointer — a month chip is a flow child of its cell and
    // stays put, so without this the whole gesture is invisible: the drop day
    // is a guess, and after an edge auto-page swaps the grid the pointer is
    // over a month the user never saw arrive.
    if (targetCell) targetCell.classList.add(DROP_TARGET_CLASS);
  };

  const pan = createEdgePan({
    getBounds: () => document.querySelector('.month__grid')?.getBoundingClientRect() || null,
    onPage: (dir) => {
      ctx.actions.edgePage(dir);
      applyAt(px, py); // re-target against the newly rendered month
    },
  });

  draggable(chip, {
    // A press on a task's check-off ring is a click, not a reschedule (the
    // time grid's task drag makes the same exception).
    canStart: (e) => !e.target.closest('.chip__check'),
    onStart(e) {
      chip.classList.add('chip--drag-source');
      px = e.clientX;
      py = e.clientY;
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
      chip.classList.remove('chip--drag-source');
      const day = targetDay;
      clearHighlight();
      if (!day) return;
      const delta = diffCalendarDays(chipDay, day);
      if (delta === 0) return;
      onCommit(delta);
    },
    onCancel() {
      pan.stop();
      chip.classList.remove('chip--drag-source');
      clearHighlight();
    },
  });
}

/**
 * The month cell whose rect contains the point, or null if outside the grid.
 * Reads the live DOM (not a captured node list) so it still resolves correctly
 * after an auto-page re-render swaps every cell.
 */
function cellAt(x, y) {
  const cells = document.querySelectorAll('.month__grid .month__cell');
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return { cell, day: new Date(Number(cell.dataset.day)) };
    }
  }
  return null;
}
