import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp } from '../src/js/app.js';
import { DEFAULT_SETTINGS } from '../src/js/store.js';

/**
 * The now-line has to keep time even when the minute tick may not rebuild the
 * view: with focus on a control render() could not restore, or with a card
 * open, the tick used to do nothing at all and the line sat still until the
 * user pressed "Today". It now slides the existing line in place instead, and
 * catches up as soon as a hidden tab is looked at again.
 */

const HOUR_H = 52;
const topAt = (h, m) => `${((h * 60 + m) / 60) * HOUR_H}px`;

function makeStore() {
  const settings = { ...DEFAULT_SETTINGS, defaultView: 'week' };
  return {
    getSettings: () => ({ ...settings }),
    subscribe: () => () => {},
    getAllEvents: () => [],
    getEventsInRange: () => [],
    getAllTasks: () => [],
    getTasksInRange: () => [],
    getTask: () => null,
    getEvent: () => null,
    saveSettings: async (patch) => (Object.assign(settings, patch), { ...settings }),
    saveEvent: async (e) => e,
    toggleTask: async () => {},
  };
}

describe('app — the now-line keeps time', () => {
  let app;
  let root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 10, 10, 0, 30));
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    });
    root = document.createElement('div');
    root.className = 'app-root';
    document.body.append(root);
    app = createApp(root, { store: makeStore(), user: { username: 'x' } });
  });

  afterEach(() => {
    if (app) app.destroy();
    app = null;
    vi.useRealTimers();
    delete document.documentElement.dataset.theme;
    document.querySelectorAll('.app-root, .toast, .ctx-menu').forEach((n) => n.remove());
  });

  it('ticks on the minute boundary, not 60s after boot', () => {
    expect(root.querySelector('.now-line').style.top).toBe(topAt(10, 0));
    vi.advanceTimersByTime(30_000); // 10:01:00
    expect(root.querySelector('.now-line').style.top).toBe(topAt(10, 1));
  });

  it('moves the line in place under a focused control it cannot restore', () => {
    const head = root.querySelector('.timegrid__head-col');
    expect(head.getAttribute('data-focus-key')).toBe(null);
    head.focus();
    const line = root.querySelector('.now-line');

    vi.advanceTimersByTime(5 * 60_000);

    expect(root.querySelector('.timegrid__head-col')).toBe(head); // no rebuild
    expect(document.activeElement).toBe(head);
    expect(root.querySelector('.now-line')).toBe(line);
    expect(line.style.top).toBe(topAt(10, 5));
  });

  it('does not wrap the line to the top of yesterday past midnight', () => {
    root.querySelector('.timegrid__head-col').focus();
    const line = root.querySelector('.now-line');
    vi.setSystemTime(new Date(2026, 5, 10, 23, 59, 30));
    vi.advanceTimersByTime(30_000); // midnight, render still held off
    expect(line.style.top).toBe(topAt(10, 0));
  });

  it('catches up when the tab becomes visible again', () => {
    // A hidden tab's timers were throttled: the clock moved, no tick ran.
    vi.setSystemTime(new Date(2026, 5, 10, 13, 45, 10));
    expect(root.querySelector('.now-line').style.top).toBe(topAt(10, 0));

    document.dispatchEvent(new Event('visibilitychange'));

    expect(root.querySelector('.now-line').style.top).toBe(topAt(13, 45));
  });

  it('slides the line on window focus without rebuilding the view', () => {
    const line = root.querySelector('.now-line');
    vi.setSystemTime(new Date(2026, 5, 10, 11, 20, 0));

    window.dispatchEvent(new Event('focus'));

    expect(root.querySelector('.now-line')).toBe(line);
    expect(line.style.top).toBe(topAt(11, 20));
  });
});
