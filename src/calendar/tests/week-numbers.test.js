/**
 * Optional ISO week numbers on the month grid, the sidebar mini-calendar, and
 * the week-view title. Off by default so the 7-column layout stays as it is.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderMonth } from '../src/js/views/month.js';
import { renderSidebar } from '../src/js/sidebar.js';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';
import { isSameDay, displayedWeekNumber } from '../src/js/date-utils.js';

const JULY = new Date(2026, 6, 15); // Wed 15 Jul 2026

function monthCtx({ settings = {}, actions = {} } = {}) {
  const s = { weekStartsOn: 0, hour12: true, showWeekNumbers: false, ...settings };
  return {
    store: {
      getEventsInRange: () => [],
      getTasksInRange: () => [],
      getEvent: () => null,
      getAllEvents: () => [],
      getAllTasks: () => [],
      getSettings: () => ({ ...s }),
    },
    settings: s,
    cursor: JULY,
    miniCursor: JULY,
    now: JULY,
    actions: {
      createAt() {},
      gotoDayView() {},
      gotoWeekView() {},
      slotContextMenu() {},
      openEvent() {},
      openTask() {},
      toggleTask() {},
      eventContextMenu() {},
      taskContextMenu() {},
      moveEvent() {},
      moveTask() {},
      edgePage() {},
      ...actions,
    },
  };
}

describe('month view week numbers', () => {
  it('are omitted by default, leaving a 7-column grid', () => {
    const { node } = renderMonth(monthCtx());
    expect(node.classList.contains('month--weeks')).toBe(false);
    expect(node.querySelectorAll('.month__weeknum')).toHaveLength(0);
    expect(node.querySelectorAll('.month__cell')).toHaveLength(35);
    expect(node.querySelectorAll('.month__dow-cell')).toHaveLength(7);
  });

  it('draw one ISO number per week row when the setting is on', () => {
    const { node } = renderMonth(monthCtx({ settings: { showWeekNumbers: true } }));
    expect(node.classList.contains('month--weeks')).toBe(true);
    const nums = [...node.querySelectorAll('.month__weeknum:not(.month__weeknum--head)')].map(
      (el) => el.textContent,
    );
    // July 2026, Sunday-start: rows beginning 28 Jun, 5/12/19/26 Jul → weeks 27–31.
    expect(nums).toEqual(['27', '28', '29', '30', '31']);
    expect(node.querySelectorAll('.month__cell')).toHaveLength(35);
  });

  it('labels a Monday-start row by its Thursday, not its Monday', () => {
    const { node } = renderMonth(
      monthCtx({ settings: { showWeekNumbers: true, weekStartsOn: 1 } }),
    );
    const first = node.querySelector('.month__weeknum:not(.month__weeknum--head)');
    // Monday 29 Jun 2026 row: Thursday is 2 Jul → week 27, same as the Sunday-start
    // row that also contains that Thursday.
    expect(first.textContent).toBe('27');
  });

  it('opens that week from a click on the number', () => {
    const opened = [];
    const { node } = renderMonth(
      monthCtx({
        settings: { showWeekNumbers: true },
        actions: { gotoWeekView: (day) => opened.push(day) },
      }),
    );
    node.querySelector('.month__weeknum:not(.month__weeknum--head)').click();
    expect(opened).toHaveLength(1);
    expect(isSameDay(opened[0], new Date(2026, 5, 28))).toBe(true); // Sun 28 Jun
    expect(displayedWeekNumber(opened[0])).toBe(27);
  });
});

describe('sidebar mini-calendar week numbers', () => {
  function miniCtx(settings = {}, actions = {}) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    return {
      store: {
        getAllEvents: () => [],
        getAllTasks: () => [],
        getEventsInRange: () => [],
        getSettings: () => ({ ...s }),
      },
      settings: s,
      cursor: JULY,
      miniCursor: new Date(2026, 6, 1),
      now: JULY,
      actions: {
        createAt() {},
        miniShift() {},
        selectDate() {},
        gotoWeekView() {},
        toggleColor() {},
        ...actions,
      },
    };
  }

  it('are omitted by default', () => {
    const node = renderSidebar(miniCtx());
    expect(node.querySelector('.mini--weeks')).toBeNull();
    expect(node.querySelectorAll('.mini__weeknum')).toHaveLength(0);
    expect(node.querySelectorAll('.mini__cell')).toHaveLength(35);
  });

  it('draw the same numbers as the month grid, and open that week on click', () => {
    const opened = [];
    const node = renderSidebar(
      miniCtx({ showWeekNumbers: true }, { gotoWeekView: (day) => opened.push(day) }),
    );
    expect(node.querySelector('.mini--weeks')).not.toBeNull();
    const nums = [...node.querySelectorAll('.mini__weeknum:not(.mini__weeknum--head)')].map(
      (el) => el.textContent,
    );
    expect(nums).toEqual(['27', '28', '29', '30', '31']);
    node.querySelector('.mini__weeknum:not(.mini__weeknum--head)').click();
    expect(opened).toHaveLength(1);
    expect(isSameDay(opened[0], new Date(2026, 5, 28))).toBe(true);
  });
});

describe('app — week numbers setting', () => {
  let app;

  function makeStore(overrides = {}) {
    const s = { ...DEFAULT_SETTINGS, defaultView: 'month', ...overrides };
    const listeners = new Set();
    const saved = [];
    const store = {
      saved,
      getSettings: () => ({ ...s }),
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      getAllEvents: () => [],
      getAllTasks: () => [],
      getEventsInRange: () => [],
      getTasksInRange: () => [],
      getTask: () => null,
      getEvent: () => null,
      saveSettings(patch) {
        saved.push(patch);
        Object.assign(s, patch);
        for (const fn of [...listeners]) fn();
        return Promise.resolve({ ...s });
      },
      toggleTask: async () => {},
    };
    return store;
  }

  beforeEach(() => {
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
    });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    delete document.documentElement.dataset.theme;
    document.querySelectorAll('.popover').forEach((n) => n.remove());
    document.body.replaceChildren();
  });

  function mount(overrides) {
    const root = document.createElement('div');
    document.body.append(root);
    const store = makeStore(overrides);
    app = createApp(root, { store, user: { username: 'x' } });
    return store;
  }

  it('leaves the month grid 7 columns until the account-menu toggle is on', () => {
    const store = mount();
    app.showDate(JULY, 'month');
    expect(document.querySelectorAll('.month__weeknum')).toHaveLength(0);
    document.querySelector('.avatar').click();
    const input = document.querySelector('input[data-setting="showWeekNumbers"]');
    expect(input).not.toBeNull();
    expect(input.checked).toBe(false);
    input.click();
    expect(store.saved).toEqual([{ showWeekNumbers: true }]);
    expect(document.querySelector('.month--weeks')).not.toBeNull();
    expect(document.querySelectorAll('.month__weeknum:not(.month__weeknum--head)')).toHaveLength(5);
  });

  it('names the week in the week-view title when the setting is on', () => {
    mount({ showWeekNumbers: true, defaultView: 'week' });
    app.showDate(new Date(2026, 6, 12), 'week'); // Sunday 12 Jul 2026
    expect(document.querySelector('.header__title').textContent).toBe(
      'Jul 12 – 18, 2026 · Week 29',
    );
  });

  it('leaves the week-view title as a date range when the setting is off', () => {
    mount({ defaultView: 'week' });
    app.showDate(new Date(2026, 6, 12), 'week');
    expect(document.querySelector('.header__title').textContent).toBe('Jul 12 – 18, 2026');
  });

  it('opens week view from a month-grid week number without saving the view', () => {
    const store = mount({ showWeekNumbers: true });
    app.showDate(JULY, 'month');
    document.querySelector('.month__weeknum:not(.month__weeknum--head)').click();
    expect(document.querySelector('.timegrid')).not.toBeNull();
    expect(document.querySelector('.header__title').textContent).toMatch(/Week 27/);
    expect(store.saved).toEqual([]);
  });
});
