import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from '../src/panels/browser.js';
import { Store } from '../src/model/store.js';
import { newProject } from '../src/model/demo.js';
import * as puter from '../src/storage/puter.js';

vi.mock('../src/storage/puter.js', () => ({
  sdk: vi.fn(() => null),
  isSignedIn: vi.fn(() => false),
  appDir: vi.fn(async () => '/Music'),
  readdir: vi.fn(),
  pickDirectory: vi.fn(),
  isDir: () => false,
  readURL: vi.fn(),
  readFile: vi.fn(),
  errorMessage: (err) => err.message,
}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
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
    notify: vi.fn(),
    reportError: vi.fn(),
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  puter.appDir.mockReset().mockResolvedValue('/Music');
  puter.readdir.mockReset().mockResolvedValue([{ path: '/Music/tone.wav', name: 'tone.wav' }]);
  puter.pickDirectory.mockReset();
  puter.sdk.mockReturnValue(null);
  puter.isSignedIn.mockReturnValue(false);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function cloudSetup() {
  puter.sdk.mockReturnValue({});
  puter.isSignedIn.mockReturnValue(true);
  const audio = { play: vi.fn(async () => {}), pause: vi.fn(), load: vi.fn(), removeAttribute: vi.fn() };
  vi.stubGlobal('Audio', class { constructor() { return audio; } });
  const ctx = setup();
  await vi.advanceTimersByTimeAsync(20);
  ctx.body.querySelector('[data-id="dir:/Music"]').click();
  await vi.advanceTimersByTimeAsync(20);
  const preview = () => ctx.body.querySelector('[data-id="file:/Music/tone.wav"] [data-action=preview]').click();
  return { ...ctx, audio, preview };
}

describe('cloud file preview cancellation', () => {
  it('releases a fallback download that finishes after the panel is hidden', async () => {
    const download = deferred();
    puter.readURL.mockRejectedValueOnce(new Error('URL unavailable'));
    puter.readFile.mockReturnValueOnce(download.promise);
    const createObjectURL = vi.fn(() => 'blob:test-preview');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const { panel, preview, audio } = await cloudSetup();
    preview();
    await Promise.resolve();
    expect(puter.readFile).toHaveBeenCalledOnce();
    panel.onHide();
    download.resolve(new Blob(['audio']));
    await Promise.resolve();
    expect(audio.play).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-preview');
  });

  it('ignores a play rejection caused by stopping the current preview', async () => {
    puter.readURL.mockResolvedValueOnce('https://example.test/tone.wav');
    const play = deferred();
    const { panel, preview, audio, app } = await cloudSetup();
    audio.play.mockReturnValueOnce(play.promise);
    preview();
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalledOnce();
    panel.onHide();
    play.reject(new Error('Playback interrupted'));
    await Promise.resolve();
    expect(app.notify).not.toHaveBeenCalled();
  });

  it('ignores an old URL after stopping and retrying the same file', async () => {
    const old = deferred(), latest = deferred();
    puter.readURL.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const { audio, preview } = await cloudSetup();
    preview();
    preview();
    preview();
    latest.resolve('https://example.test/new.wav');
    await Promise.resolve();
    expect(audio.src).toBe('https://example.test/new.wav');
    old.resolve('https://example.test/old.wav');
    await Promise.resolve();
    expect(audio.src).toBe('https://example.test/new.wav');
    expect(audio.play).toHaveBeenCalledOnce();
  });

  it('does not download or report an obsolete failure after a retry succeeds', async () => {
    const old = deferred(), latest = deferred();
    puter.readURL.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    puter.readFile.mockRejectedValue(new Error('Old download failed'));
    const { app, audio, preview } = await cloudSetup();
    preview();
    preview();
    preview();
    latest.resolve('https://example.test/new.wav');
    await Promise.resolve();
    old.reject(new Error('Old URL failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(puter.readFile).not.toHaveBeenCalled();
    expect(app.notify).not.toHaveBeenCalled();
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.src).toBe('https://example.test/new.wav');
  });
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

describe('preview account changes', () => {
  it('cancels a pending cloud URL when signing out', async () => {
    const pending = deferred();
    puter.readURL.mockReturnValueOnce(pending.promise);
    const { app, preview, audio } = await cloudSetup();
    preview();
    puter.isSignedIn.mockReturnValue(false);
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    pending.resolve('https://example.test/old-account.wav');
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.play).not.toHaveBeenCalled();
    expect(app.notify).not.toHaveBeenCalled();
  });

  it('stops an active cloud preview when signing out', async () => {
    puter.readURL.mockResolvedValueOnce('https://example.test/old-account.wav');
    const { app, preview, audio } = await cloudSetup();
    preview();
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.play).toHaveBeenCalledOnce();
    audio.pause.mockClear();
    puter.isSignedIn.mockReturnValue(false);
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith('src');
  });

  it('releases a fallback download that finishes after signing out', async () => {
    const pending = deferred();
    puter.readURL.mockRejectedValueOnce(new Error('Rate limit'));
    puter.readFile.mockReturnValueOnce(pending.promise);
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = () => 'blob:old-account';
      static revokeObjectURL = revoke;
    });
    const { app, preview, audio } = await cloudSetup();
    preview();
    await Promise.resolve();
    puter.isSignedIn.mockReturnValue(false);
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    pending.resolve(new Blob(['audio']));
    await vi.advanceTimersByTimeAsync(0);
    expect(audio.play).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:old-account');
  });
});

it('can preview again after an account change without reusing the old URL', async () => {
  puter.readURL.mockResolvedValueOnce('https://example.test/old.wav').mockResolvedValueOnce('https://example.test/new.wav');
  const { app, preview, audio, body } = await cloudSetup();
  preview();
  await vi.advanceTimersByTimeAsync(0);
  await app.on.mock.calls.find(([event]) => event === 'account')[1]();
  await vi.advanceTimersByTimeAsync(20);
  body.querySelector('[data-id="dir:/Music"]').click();
  body.querySelector('[data-id="dir:/Music"]').click();
  await vi.advanceTimersByTimeAsync(20);
  preview();
  await vi.advanceTimersByTimeAsync(0);
  expect(puter.readURL).toHaveBeenCalledTimes(2);
  expect(audio.src).toBe('https://example.test/new.wav');
  expect(audio.play).toHaveBeenCalledTimes(2);
});

it.each(['resolve', 'reject'])('keeps the current account root when an older lookup later %ss', async (outcome) => {
  const old = deferred();
  puter.sdk.mockReturnValue({});
  puter.isSignedIn.mockReturnValue(true);
  puter.appDir.mockReturnValueOnce(old.promise).mockResolvedValueOnce('/Current');
  const { app, body } = setup();
  const refresh = app.on.mock.calls.find(([event]) => event === 'account')[1];
  await refresh();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dir:/Current"]')).not.toBe(null);
  if (outcome === 'resolve') old.resolve('/Previous');
  else old.reject(new Error('Account changed'));
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dir:/Current"]')).not.toBe(null);
  expect(body.querySelector('[data-id="dir:/Previous"]')).toBe(null);
});

function refreshFolder(body, path = '/Music') {
  body.querySelector(`[data-id="dir:${path}"]`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const refresh = [...document.querySelectorAll('[role=menuitem]')].find((el) => el.textContent.trim() === 'Refresh');
  expect(refresh).toBeTruthy();
  refresh.click();
}

it.each(['resolve', 'reject'])('preserves the latest folder refresh when the earlier listing %ss', async (outcome) => {
  const old = deferred();
  const { body } = await cloudSetup();
  puter.readdir.mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ path: '/Music/current.wav', name: 'current.wav' }]);
  refreshFolder(body);
  refreshFolder(body);
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/current.wav"]')).not.toBe(null);
  if (outcome === 'resolve') old.resolve([{ path: '/Music/old.wav', name: 'old.wav' }]);
  else old.reject(new Error('Old request failed'));
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/current.wav"]')).not.toBe(null);
  expect(body.querySelector('[data-id="file:/Music/old.wav"]')).toBe(null);
});

it('ignores a folder listing that finishes after the account cache is cleared', async () => {
  const old = deferred();
  const { app, body } = await cloudSetup();
  puter.readdir.mockReturnValueOnce(old.promise);
  refreshFolder(body);
  await app.on.mock.calls.find(([event]) => event === 'account')[1]();
  await vi.advanceTimersByTimeAsync(20);
  old.resolve([{ path: '/Music/old-account.wav', name: 'old-account.wav' }]);
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/old-account.wav"]')).toBe(null);
  refreshFolder(body);
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/tone.wav"]')).not.toBe(null);
});

describe('picked folders and account changes', () => {
  let scrollDescriptor;
  beforeEach(() => {
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    if (scrollDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor);
    else delete Element.prototype.scrollIntoView;
  });

  it('removes folders selected in the previous account', async () => {
    const { app, body } = await cloudSetup();
    puter.pickDirectory.mockResolvedValueOnce({ path: '/Previous/Samples' });
    body.querySelector('[data-id="files:pick"]').click();
    await vi.advanceTimersByTimeAsync(20);
    expect(body.querySelector('[data-id="dir:/Previous/Samples"]')).not.toBe(null);
    expect(app.reportError).not.toHaveBeenCalled();
    puter.appDir.mockResolvedValueOnce('/Current/Music');
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    await vi.advanceTimersByTimeAsync(20);
    expect(body.querySelector('[data-id="dir:/Current/Music"]')).not.toBe(null);
    expect(body.querySelector('[data-id="dir:/Previous/Samples"]')).toBe(null);
  });

  it.each(['resolve', 'reject'])('ignores an obsolete folder picker that %ss after an account change', async (outcome) => {
    const pending = deferred();
    const { app, body } = await cloudSetup();
    puter.pickDirectory.mockReturnValueOnce(pending.promise);
    body.querySelector('[data-id="files:pick"]').click();
    puter.appDir.mockResolvedValueOnce('/Current/Music');
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    puter.readdir.mockClear();
    if (outcome === 'resolve') pending.resolve({ path: '/Previous/Samples' });
    else pending.reject(new Error('Old picker failed'));
    await vi.advanceTimersByTimeAsync(20);
    expect(puter.readdir).not.toHaveBeenCalled();
    expect(body.querySelector('[data-id="dir:/Previous/Samples"]')).toBe(null);
    expect(app.reportError).not.toHaveBeenCalled();
  });

  it('can pick a folder after changing accounts and reports a current picker error', async () => {
    const { app, body } = await cloudSetup();
    await app.on.mock.calls.find(([event]) => event === 'account')[1]();
    await vi.advanceTimersByTimeAsync(20);
    puter.pickDirectory.mockResolvedValueOnce({ path: '/Current/Samples' });
    body.querySelector('[data-id="files:pick"]').click();
    await vi.advanceTimersByTimeAsync(20);
    expect(body.querySelector('[data-id="dir:/Current/Samples"]')).not.toBe(null);
    expect(puter.readdir).toHaveBeenCalledWith('/Current/Samples');
    expect(app.reportError).not.toHaveBeenCalled();
    const failure = new Error('Picker failed');
    puter.pickDirectory.mockRejectedValueOnce(failure);
    body.querySelector('[data-id="files:pick"]').click();
    await vi.advanceTimersByTimeAsync(20);
    expect(app.reportError).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
