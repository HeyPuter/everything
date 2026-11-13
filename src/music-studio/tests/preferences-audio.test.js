import { afterEach, expect, it, vi } from 'vitest';
import { openPreferences } from '../src/dialogs/preferences.js';
import { Prefs } from '../src/lib/prefs.js';
import { Engine } from '../src/engine/engine.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const originalDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
afterEach(async () => {
  document.querySelectorAll('.dialog-head button').forEach((button) => button.click());
  await Promise.resolve();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  if (originalDevices) Object.defineProperty(navigator, 'mediaDevices', originalDevices);
  else delete navigator.mediaDevices;
});

const testToneButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Play test tone');

it.each(['pending', 'just resolved'])('does not start a test tone after Preferences closes with startup %s', async (timing) => {
  vi.useFakeTimers();
  const { app, done } = await setup();
  const gate = deferred();
  app.engine.start = vi.fn(() => gate.promise);
  app.engine.audition = vi.fn(() => vi.fn());
  testToneButton().click();
  if (timing === 'just resolved') gate.resolve(true);
  document.querySelector('.dialog-head button').click();
  await done;
  gate.resolve(true);
  await Promise.resolve();
  expect(app.engine.audition).not.toHaveBeenCalled();
});

it.each(['unavailable', 'rejected'])('does not audition when startup is %s and permits a retry', async (failure) => {
  vi.useFakeTimers();
  const { app } = await setup();
  const stop = vi.fn();
  app.engine.start = failure === 'rejected' ? vi.fn().mockRejectedValueOnce(new Error('Startup failed')).mockResolvedValue(true) : vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  app.engine.audition = vi.fn(() => stop);
  testToneButton().click();
  await Promise.resolve();
  expect(app.engine.audition).not.toHaveBeenCalled();
  expect(app.reportError).toHaveBeenCalledTimes(failure === 'rejected' ? 1 : 0);
  testToneButton().click();
  await Promise.resolve();
  expect(app.engine.audition).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(900);
  expect(stop).toHaveBeenCalledOnce();
});

it('stops a sounding test tone when Preferences closes', async () => {
  vi.useFakeTimers();
  const { app, done } = await setup();
  const stop = vi.fn();
  app.engine.start = vi.fn(async () => true);
  app.engine.audition = vi.fn(() => stop);
  testToneButton().click();
  await Promise.resolve();
  expect(app.engine.audition).toHaveBeenCalledOnce();
  document.querySelector('.dialog-head button').click();
  await done;
  expect(stop).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(stop).toHaveBeenCalledOnce();
});

it('plays only the latest requested test tone after delayed startup', async () => {
  vi.useFakeTimers();
  const { app } = await setup();
  const gate = deferred();
  app.engine.start = vi.fn(() => gate.promise);
  app.engine.audition = vi.fn(() => vi.fn());
  testToneButton().click();
  testToneButton().click();
  gate.resolve(true);
  await Promise.resolve();
  expect(app.engine.audition).toHaveBeenCalledOnce();
});

it('stops the previous tone on retrigger and gives the new tone its own duration', async () => {
  vi.useFakeTimers();
  const { app } = await setup();
  const first = vi.fn(), second = vi.fn();
  app.engine.start = vi.fn(async () => true);
  app.engine.audition = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  testToneButton().click();
  await Promise.resolve();
  vi.advanceTimersByTime(450);
  testToneButton().click();
  await Promise.resolve();
  expect(first).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(450);
  expect(second).not.toHaveBeenCalled();
  vi.advanceTimersByTime(450);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

it('plays and releases an ordinary test tone', async () => {
  vi.useFakeTimers();
  const { app } = await setup();
  const stop = vi.fn();
  app.engine.start = vi.fn(async () => true);
  app.engine.audition = vi.fn(() => stop);
  testToneButton().click();
  await Promise.resolve();
  expect(app.engine.audition).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(899);
  expect(stop).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(stop).toHaveBeenCalledOnce();
});

async function setup() {
  vi.stubGlobal('puter', undefined);
  vi.stubGlobal('AudioContext', class { setSinkId() {} });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { enumerateDevices: vi.fn(async () => [
    { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
    { kind: 'audiooutput', deviceId: 'headphones', label: 'Headphones' },
  ]) } });
  const prefs = new Prefs({ getItem: () => null, setItem() {} });
  prefs.set('outputDevice', 'speakers');
  const app = { prefs, engine: { setOutputDevice: vi.fn(async () => true) }, commands: { has: () => false }, notify: vi.fn(), reportError: vi.fn() };
  const done = openPreferences(app, { section: 'audio' });
  await Promise.resolve();
  const label = [...document.querySelectorAll('label')].find((el) => el.textContent === 'Output device');
  const select = document.getElementById(label.htmlFor);
  const choose = (value) => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); };
  return { app, prefs, select, choose, done };
}

it('keeps the working output preference and selection when switching devices fails', async () => {
  const { app, prefs, select, choose } = await setup();
  app.engine.setOutputDevice.mockRejectedValue(new Error('Device disconnected'));
  choose('headphones');
  await vi.waitFor(() => expect(app.notify).toHaveBeenCalled());
  expect(prefs.get('outputDevice')).toBe('speakers');
  expect(select.value).toBe('speakers');
  expect(select.disabled).toBe(false);
});

it('does not save a pending device choice before the engine accepts it', async () => {
  const { app, prefs, select, choose } = await setup();
  const gate = deferred();
  app.engine.setOutputDevice.mockReturnValue(gate.promise);
  choose('headphones');
  expect(prefs.get('outputDevice')).toBe('speakers');
  expect(select.disabled).toBe(true);
  gate.resolve(true);
  await vi.waitFor(() => expect(prefs.get('outputDevice')).toBe('headphones'));
  expect(select.disabled).toBe(false);
});

it('stores the output choice for the next startup when the engine has not started', async () => {
  const { app, prefs, select, choose } = await setup();
  app.engine.setOutputDevice.mockResolvedValue(false);
  choose('headphones');
  await vi.waitFor(() => expect(prefs.get('outputDevice')).toBe('headphones'));
  expect(select.value).toBe('headphones');
  expect(select.disabled).toBe(false);
  expect(app.notify).not.toHaveBeenCalled();
});

it.each(['success', 'failure'])('applies a newer choice after reopening Preferences while an earlier switch awaits %s', async (outcome) => {
  const { app, prefs, choose, done } = await setup();
  const gate = deferred();
  let actualDevice = 'speakers';
  app.engine.setOutputDevice.mockImplementation(async (id) => {
    if (id === 'headphones') await gate.promise;
    actualDevice = id;
    return true;
  });
  choose('headphones');
  document.querySelector('.dialog-head button').click();
  await done;
  openPreferences(app, { section: 'audio' });
  await Promise.resolve();
  const label = [...document.querySelectorAll('label')].find((el) => el.textContent === 'Output device');
  const select = document.getElementById(label.htmlFor);
  select.value = '';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  expect(app.engine.setOutputDevice).toHaveBeenCalledTimes(1);
  if (outcome === 'success') gate.resolve(true);
  else gate.reject(new Error('Disconnected'));
  await vi.waitFor(() => expect(prefs.get('outputDevice')).toBe(''));
  expect(actualDevice).toBe('');
  expect(select.value).toBe('');
  expect(select.disabled).toBe(false);
  expect(app.engine.setOutputDevice).toHaveBeenCalledTimes(2);
});

it.each(['success', 'closed context'])('applies a pending output choice to the replacement audio context after %s', async (outcome) => {
  const { app, prefs, choose } = await setup();
  const gate = deferred();
  app.engine.ctx = { setSinkId: vi.fn(() => gate.promise) };
  app.engine.setOutputDevice = vi.fn(Engine.prototype.setOutputDevice.bind(app.engine));
  choose('headphones');
  const replacement = { setSinkId: vi.fn(async () => {}) };
  app.engine.ctx = replacement;
  if (outcome === 'success') gate.resolve();
  else gate.reject(new Error('Context closed during restart'));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(replacement.setSinkId).toHaveBeenCalledWith('headphones');
  await vi.waitFor(() => expect(prefs.get('outputDevice')).toBe('headphones'));
  expect(app.notify).not.toHaveBeenCalled();
});
