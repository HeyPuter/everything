import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import * as E from '../src/model/edits.js';
import { demoProject } from '../src/model/demo.js';
import * as rack from '../src/panels/channel-rack.js';
import * as mixer from '../src/panels/mixer.js';
import { openChannelEditor } from '../src/rack/editor.js';
import { closeWindows } from '../src/ui/windows.js';

let app;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '<div id="app"></div>';
  app = new App(document.getElementById('app'), { project: demoProject(), storage: { getItem: () => null, setItem() {} } });
  app.start([rack, mixer]);
});
afterEach(() => {
  closeWindows();
  for (const name of ['rack', 'mixer']) app.panel(name).onHide?.();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function controlFor(surface, param = 'volume') {
  if (surface === 'rack') {
    app.shell.show('rack');
    return app.panel('rack').view.grid.querySelector(`.rack-row [aria-label$=" ${param}"]`);
  }
  if (surface === 'channel') {
    const win = openChannelEditor(app, app.store.project.channels[0].id);
    const tab = [...win.el.querySelectorAll('[role="tab"]')].find((el) => el.textContent === 'Channel');
    tab.click();
    return win.el.querySelector(`[aria-label="Channel ${param}"]`);
  }
  app.shell.show('mixer');
  app.mixerController.select(2);
  if (param === 'pan') return app.panel('mixer').strips[2].el.querySelector('[aria-label="Pan"]');
  return surface === 'strip' ? app.panel('mixer').strips[0].el.querySelector('.mx-send-knob') : document.querySelector('.mx-route-list [role="slider"]');
}

const cases = ['rack', 'channel', 'strip', 'sidebar'].flatMap((surface) => [
  ['-6 dB', 10 ** (-6 / 20)], ['0', 1], ['+1 dB', 10 ** (1 / 20)], ['-inf dB', 0], ['-6oops', null],
].map(([text, expected]) => [surface, text, expected]));
it.each(cases)('interprets %s gain entry %s in the displayed decibel scale', (surface, text, expected) => {
  const control = controlFor(surface);
  expect(control).not.toBeNull();
  const before = app.store.project;
  const gain = () => ['rack', 'channel'].includes(surface) ? app.store.project.channels[0].volume : app.store.project.mixer[2].routes[0];
  const initial = gain();
  // An existing route retains a tiny positive floor so muting its level does not remove it.
  const value = expected === 0 && ['strip', 'sidebar'].includes(surface) ? 1e-6 : expected;
  control.focus();
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const input = document.querySelector('input[aria-label="Volume value"], input[aria-label^="Send level"][aria-label$=" value"]');
  expect(input).not.toBeNull();
  expect(input.value).toContain('dB');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(gain()).toBeCloseTo(value ?? initial, 8);
  expect(Number(control.getAttribute('aria-valuenow'))).toBeCloseTo(gain(), 3);
  expect(document.activeElement).toBe(control);
  if (expected === null || expected === initial) expect(app.store.project).toBe(before);
  else {
    app.store.undo();
    expect(app.store.project).toBe(before);
  }
});

const panCases = ['rack', 'channel', 'strip'].flatMap((surface) => [
  ['35% left', -0.35], ['35% right', 0.35], ['Centered', 0], ['-0.5', -0.5], ['25%', 0.25], ['35% sideways', null],
].map(([text, expected]) => [surface, text, expected]));
it.each(panCases)('interprets %s pan entry %s without changing its scale or direction', (surface, text, expected) => {
  const control = controlFor(surface, 'pan');
  const id = app.store.project.channels[0].id;
  app.store.apply('Initial pan', (p) => surface === 'strip' ? E.updateMixerTrack(p, 2, { pan: -0.35 }) : E.updateChannel(p, id, { pan: -0.35 }));
  const before = app.store.project;
  const pan = () => surface === 'strip' ? app.store.project.mixer[2].pan : app.store.project.channels[0].pan;
  control.focus();
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const input = document.querySelector('input[aria-label="Pan value"]');
  expect(input.value).toBe('35% left');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(pan()).toBeCloseTo(expected ?? -0.35, 8);
  expect(Number(control.getAttribute('aria-valuenow'))).toBeCloseTo(pan(), 3);
  expect(document.activeElement).toBe(control);
  if (expected === null || expected === -0.35) expect(app.store.project).toBe(before);
  else {
    app.store.undo();
    expect(app.store.project).toBe(before);
  }
});
