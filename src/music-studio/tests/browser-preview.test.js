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

function setup({ library } = {}) {
  const gate = deferred();
  const stop = vi.fn();
  const app = {
    library,
    store: new Store(newProject()),
    prefs: { get: () => undefined, set: vi.fn() },
    engine: { start: vi.fn(() => gate.promise), audition: vi.fn(() => stop) },
    commands: { register: vi.fn() },
    on: vi.fn(),
    notify: vi.fn(),
    addChannel: vi.fn(),
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
  body.querySelector('[data-id="dir:/Music"]').click();
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

it('can open the files root normally after its account cache is cleared', async () => {
  const { app, body } = await cloudSetup();
  expect(body.querySelector('[data-id="file:/Music/tone.wav"]')).not.toBe(null);
  await app.on.mock.calls.find(([event]) => event === 'account')[1]();
  await vi.advanceTimersByTimeAsync(20);
  const root = body.querySelector('[data-id="dir:/Music"]');
  expect(body.querySelector('[data-id="sec:instruments"]').getAttribute('aria-expanded')).toBe('true');
  // An open root must show its current contents; a closed root opens in one click.
  if (root.getAttribute('aria-expanded') === 'false') root.click();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/tone.wav"]')).not.toBe(null);
});

it('removes previous account files while the next account root is loading', async () => {
  const { app, body } = await cloudSetup();
  expect(body.querySelector('[data-id="file:/Music/tone.wav"]')).not.toBe(null);
  const pending = deferred();
  puter.appDir.mockReturnValueOnce(pending.promise);
  const refresh = app.on.mock.calls.find(([event]) => event === 'account')[1]();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="file:/Music/tone.wav"]')).toBe(null);
  expect(body.querySelector('[data-id="dir:/Music"]')).toBe(null);
  expect(body.querySelector('[data-id="files:loading"]')).not.toBe(null);
  pending.resolve('/Current/Music');
  await refresh;
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dir:/Current/Music"]')).not.toBe(null);
  expect(body.querySelector('[data-id="files:loading"]')).toBe(null);
});

it('shows a recoverable error when the cloud files root fails to load', async () => {
  puter.sdk.mockReturnValue({});
  puter.isSignedIn.mockReturnValue(true);
  puter.appDir.mockRejectedValueOnce(new Error('Network unavailable'));
  const { body } = setup();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="files:loading"]')).toBe(null);
  expect(body.textContent).toContain('Your cloud files could not be loaded');
  const retry = [...body.querySelectorAll('[role=treeitem]')].find((row) => row.textContent.includes('Retry loading files'));
  expect(retry).toBeTruthy();
  const pending = deferred();
  puter.appDir.mockReturnValueOnce(pending.promise);
  retry.click();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="files:loading"]')).not.toBe(null);
  expect(body.textContent).not.toContain('Your cloud files could not be loaded');
  pending.resolve('/Recovered/Music');
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dir:/Recovered/Music"]')).not.toBe(null);
  expect(body.querySelector('[data-id="files:loading"]')).toBe(null);
});

it.each(['resolve', 'reject'])('keeps the latest saved-project listing when an older refresh %ss', async (outcome) => {
  const old = deferred();
  const library = { listLocal: vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce([{ key: 'current', name: 'Just saved' }]) };
  const { app, body } = setup({ library });
  body.querySelector('[data-id="sec:device"]').click();
  await app.on.mock.calls.find(([event]) => event === 'file')[1]();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="local:current"]')).not.toBe(null);
  if (outcome === 'resolve') old.resolve([{ key: 'old', name: 'Previous project' }]);
  else old.reject(new Error('Old read failed'));
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="local:current"]')).not.toBe(null);
  expect(body.querySelector('[data-id="local:old"]')).toBe(null);
  library.listLocal.mockResolvedValueOnce([]);
  app.on.mock.calls.find(([event]) => event === 'saving')[1]();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="local:current"]')).toBe(null);
  expect(body.querySelector('[data-id="dev:none"]')).not.toBe(null);
});

it.each([
  ['tone.one.wav', 'tone_one.wav'],
  ['音.wav', '名.wav'],
])('focuses the selected file when names contain distinct punctuation or Unicode (%s, %s)', async (firstName, secondName) => {
  puter.readdir.mockResolvedValueOnce([firstName, secondName].map((name) => ({ name, path: `/Music/${name}` })));
  const { body } = await cloudSetup();
  const files = [...body.querySelectorAll('.k-file')];
  expect(files).toHaveLength(2);
  const first = files[0], second = files[1];
  second.click();
  expect(document.activeElement.dataset.id).toBe(second.dataset.id);
  expect(first.id).not.toBe(second.id);
  expect(first.tabIndex).toBe(-1);
  expect(second.tabIndex).toBe(0);
  first.click();
  expect(document.activeElement).toBe(first);
  expect(second.tabIndex).toBe(-1);
});

it('distinguishes a failed saved-project listing from an empty library and can retry', async () => {
  const library = { listLocal: vi.fn().mockRejectedValueOnce(new Error('Storage read failed')) };
  const { body } = setup({ library });
  body.querySelector('[data-id="sec:device"]').click();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dev:none"]')).toBe(null);
  expect(body.textContent).toContain('Saved projects could not be loaded');
  const retry = [...body.querySelectorAll('[role=treeitem]')].find((row) => row.textContent.includes('Retry loading saved projects'));
  expect(retry).toBeTruthy();
  const pending = deferred();
  library.listLocal.mockReturnValueOnce(pending.promise);
  retry.click();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dev:loading"]')).not.toBe(null);
  expect(body.textContent).not.toContain('Saved projects could not be loaded');
  pending.resolve([{ key: 'recovered', name: 'Recovered project' }]);
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="local:recovered"]')).not.toBe(null);
  expect(body.querySelector('[data-id="dev:loading"]')).toBe(null);
});

it('shows loading rather than an empty library while saved projects are being read', async () => {
  const pending = deferred();
  const library = { listLocal: vi.fn(() => pending.promise) };
  const { body } = setup({ library });
  body.querySelector('[data-id="sec:device"]').click();
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dev:none"]')).toBe(null);
  expect(body.querySelector('[data-id="dev:loading"]')).not.toBe(null);
  pending.resolve([]);
  await vi.advanceTimersByTimeAsync(20);
  expect(body.querySelector('[data-id="dev:loading"]')).toBe(null);
  expect(body.querySelector('[data-id="dev:none"]')).not.toBe(null);
});

describe('browser search keyboard actions', () => {
  let scrollDescriptor;
  beforeEach(() => {
    scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    if (scrollDescriptor) Object.defineProperty(Element.prototype, 'scrollIntoView', scrollDescriptor);
    else delete Element.prototype.scrollIntoView;
  });
  const type = (body, text) => {
    const search = body.querySelector('input[type=search]');
    search.focus();
    search.value = text;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    return search;
  };
  const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

  it('adds a result matching the current search when Enter precedes the debounce', () => {
    const { app, body } = setup();
    key(type(body, 'drum'), 'Enter');
    expect(app.addChannel).toHaveBeenCalledOnce();
    expect(app.addChannel.mock.calls[0][0].type).toBe('drum');
  });

  it('focuses a current search result when ArrowDown precedes the debounce', () => {
    const { body } = setup();
    key(type(body, 'drum'), 'ArrowDown');
    expect(document.activeElement.dataset.id).toBe('inst:drum');
  });

  it('does not add an old result when the current search has no matches', () => {
    const { app, body } = setup();
    const search = type(body, 'zzznomatchinginstrument');
    key(search, 'Enter');
    expect(app.addChannel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
  });

  it.each(['Enter', 'ArrowDown', 'Escape'])('leaves %s to the input method while text is composing', (pressed) => {
    const { app, body } = setup();
    const search = type(body, 'drum');
    const composing = new KeyboardEvent('keydown', { key: pressed, isComposing: true, bubbles: true, cancelable: true });
    expect(composing.isComposing).toBe(true);
    search.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(app.addChannel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(search);
    expect(search.value).toBe('drum');
    key(search, 'Enter');
    expect(app.addChannel).toHaveBeenCalledOnce();
    expect(app.addChannel.mock.calls[0][0].type).toBe('drum');
  });

  it('keeps the current query after normal debouncing and Escape clears it', async () => {
    const { app, body } = setup();
    const search = type(body, 'drum');
    await vi.advanceTimersByTimeAsync(140);
    key(search, 'Enter');
    expect(app.addChannel.mock.calls[0][0].type).toBe('drum');
    search.focus();
    key(search, 'Escape');
    expect(search.value).toBe('');
    expect(body.querySelector('[data-id="inst:synth"]')).not.toBe(null);
  });
});

it('cancels pending instrument previews when another project is loaded', async () => {
  const { app, gate, clickInstrument } = setup();
  clickInstrument('synth');
  app.store.load(newProject());
  gate.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(app.engine.audition).not.toHaveBeenCalled();
});

it('stops cloud audio previews when a project is loaded even if its references are unchanged', async () => {
  puter.readURL.mockResolvedValueOnce('https://example.test/tone.wav');
  const { app, preview, audio } = await cloudSetup();
  preview();
  await vi.advanceTimersByTimeAsync(0);
  expect(audio.play).toHaveBeenCalledOnce();
  app.store.load(app.store.project);
  expect(audio.pause).toHaveBeenCalledOnce();
  expect(audio.removeAttribute).toHaveBeenCalledWith('src');
});

it('keeps instrument previews available across ordinary project edits', async () => {
  const { app, gate, clickInstrument } = setup();
  clickInstrument('synth');
  app.store.apply('Tempo', (p) => ({ ...p, bpm: 101 }));
  gate.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(app.engine.audition).toHaveBeenCalledOnce();
});
