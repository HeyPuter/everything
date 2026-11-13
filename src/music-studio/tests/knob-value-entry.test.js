import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import * as E from '../src/model/edits.js';
import { defaultParams } from '../src/instruments/catalog.js';
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

const noteCases = ['step', 'sample'].flatMap((kind) => [
  ['D5', 62], ['f#4', 54], ['Bb3', 46], ['0', 0], ['127', 127], ['200', null], ['61oops', null], ['H2', null], ['C5', 60],
].map(([text, expected]) => [kind, text, expected]));
it.each(noteCases)('interprets the %s key entry %s using the displayed note convention', (kind, text, expected) => {
  const id = app.store.project.channels[0].id;
  if (kind === 'sample') app.store.apply('Sampler', (p) => E.updateChannel(p, id, { type: 'sampler', params: defaultParams('sampler') }));
  const win = openChannelEditor(app, id);
  const tab = [...win.el.querySelectorAll('[role="tab"]')].find((el) => el.textContent === (kind === 'step' ? 'Channel' : 'Instrument'));
  tab.click();
  const control = win.el.querySelector(kind === 'step' ? '[aria-label="Channel step key"]' : '[aria-label="Sample root key"]');
  expect(control).not.toBeNull();
  const before = app.store.project;
  const value = () => kind === 'step' ? app.store.project.channels[0].root : app.store.project.channels[0].params.root;
  expect(value()).toBe(60);
  control.focus();
  control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const input = document.querySelector(kind === 'step' ? 'input[aria-label="Step key value"]' : 'input[aria-label="Root key value"]');
  expect(input.value).toBe('C5');
  input.value = text;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(value()).toBe(expected ?? 60);
  expect(Number(control.getAttribute('aria-valuenow'))).toBe(value());
  expect(document.activeElement).toBe(control);
  if (expected === null || expected === 60) expect(app.store.project).toBe(before);
  else {
    app.store.undo();
    expect(app.store.project).toBe(before);
  }
});

it.each(['rack', 'channel', 'strip', 'sidebar', 'fader', 'pan'].flatMap((surface) => ['Enter', 'blur'].map((end) => [surface, end])))('keeps the precise %s value when an unchanged input ends with %s', (surface, end) => {
  let control = controlFor(['fader', 'pan'].includes(surface) ? 'strip' : surface, surface === 'pan' ? 'pan' : 'volume');
  if (surface === 'fader') control = app.panel('mixer').strips[2].fader.slider;
  const id = app.store.project.channels[0].id;
  const initial = surface === 'pan' ? -0.352 : 0.731;
  app.store.apply('Precise value', (p) => {
    if (['rack', 'channel'].includes(surface)) return E.updateChannel(p, id, { volume: initial });
    if (surface === 'pan') return E.updateMixerTrack(p, 2, { pan: initial });
    if (surface === 'fader') return E.updateMixerTrack(p, 2, { volume: initial });
    return E.setRoute(p, 2, 0, initial);
  });
  const before = app.store.project;
  const undoCount = app.store.undoStack.length;
  const open = () => {
    control.focus();
    control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.activeElement.tagName).toBe('INPUT');
    return document.activeElement;
  };
  const finish = (input) => {
    if (end === 'Enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    else input.blur();
    expect(input.isConnected).toBe(false);
  };
  finish(open());
  expect(app.store.project).toBe(before);
  expect(app.store.undoStack).toHaveLength(undoCount);
  const input = open();
  input.value = surface === 'pan' ? '25% right' : '-6 dB';
  finish(input);
  const value = ['rack', 'channel'].includes(surface) ? app.store.project.channels[0].volume : surface === 'pan' ? app.store.project.mixer[2].pan : surface === 'fader' ? app.store.project.mixer[2].volume : app.store.project.mixer[2].routes[0];
  expect(value).toBeCloseTo(surface === 'pan' ? 0.25 : 10 ** (-6 / 20), 8);
  expect(app.store.undoStack).toHaveLength(undoCount + 1);
  app.store.undo();
  expect(app.store.project).toBe(before);
});
