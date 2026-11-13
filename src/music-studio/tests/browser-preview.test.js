import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from '../src/panels/browser.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';

vi.mock('../src/storage/puter.js', () => ({
  sdk: () => null,
  isSignedIn: () => false,
}));

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup() {
  const gate = deferred();
  const stop = vi.fn();
  const app = {
    store: new Store(newProject()),
    prefs: { get: () => undefined, set: vi.fn() },
    engine: { start: vi.fn(() => gate.promise), audition: vi.fn(() => stop) },
    commands: { register: vi.fn() },
    on: vi.fn(),
    registerPanel: vi.fn(),
  };
  install(app);
  const body = document.createElement('div');
  document.body.append(body);
  const panel = app.registerPanel.mock.calls[0][0].create(app, { body });
  const clickInstrument = (type) => {
    const row = body.querySelector(`[data-id="inst:${type}"]`);
    expect(row).toBeTruthy();
    row.click();
  };
  return { app, gate, stop, panel, body, clickInstrument };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('browser preview startup', () => {
  it('connects the search field to the styled browser tree', () => {
    const { body } = setup();
    const search = body.querySelector('input[type=search]');
    const tree = document.getElementById(search.getAttribute('aria-controls'));
    expect(tree).toBe(body.querySelector('[role=tree]'));
    expect(tree.classList.contains('br-tree')).toBe(true);
  });

  it('does not start a preview after the browser panel is hidden', async () => {
    const { app, gate, panel, clickInstrument } = setup();
    clickInstrument('synth');
    expect(app.engine.start).toHaveBeenCalledOnce();
    panel.onHide();
    gate.resolve(true);
    await Promise.resolve();
    expect(app.engine.audition).not.toHaveBeenCalled();
  });

  it('previews only the latest selection after audio startup', async () => {
    const { app, gate, stop, clickInstrument } = setup();
    clickInstrument('synth');
    clickInstrument('drum');
    gate.resolve(true);
    await Promise.resolve();
    expect(app.engine.audition).toHaveBeenCalledOnce();
    expect(app.engine.audition.mock.calls[0][0].type).toBe('drum');
    await vi.advanceTimersByTimeAsync(1500);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('Escape cancels a preview while audio is starting', async () => {
    const { app, gate, body, clickInstrument } = setup();
    clickInstrument('synth');
    body.querySelector('[role=tree]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    gate.resolve(true);
    await Promise.resolve();
    expect(app.engine.audition).not.toHaveBeenCalled();
  });
});
