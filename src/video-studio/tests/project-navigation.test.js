import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ homes: [], editors: [], library: {} }));
vi.mock('../src/storage/library.js', () => ({ Library: class { constructor() { return state.library; } } }));
vi.mock('../src/media/dsp.js', () => ({ loadDsp() {} }));
vi.mock('../src/ui/home.js', () => ({ Home: class {
  constructor(root, options) { this.options = options; state.homes.push(this); root.textContent = 'Home'; }
  dispose() { this._disposed = true; }
} }));
vi.mock('../src/ui/review/review-page.js', () => ({ ReviewPage: class {
  constructor(root, options) { Object.assign(this, options); root.textContent = 'Review'; }
  dispose() {}
} }));
vi.mock('../src/ui/editor.js', () => ({ Editor: class {
  constructor(root, options) {
    Object.assign(this, options);
    this.store = { project: options.project, duration: 0, seek: vi.fn() };
    this.ctx = { store: this.store, actions: state.actions };
    this.prepareToLeave = vi.fn(async () => true);
    this.dispose = vi.fn(() => { this._disposed = true; this.claim.release(); });
    state.editors.push(this);
    root.textContent = options.project.name;
  }
} }));

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const opened = (id) => ({ project: { id, name: id }, claim: { held: true, release: vi.fn() } });
let listeners;
beforeEach(async () => {
  vi.resetModules();
  state.homes.length = 0;
  state.editors.length = 0;
  state.actions = { importFiles: vi.fn(), addAssets: vi.fn() };
  state.library = { openForEditing: vi.fn(), createProject: vi.fn(), nextProjectName: vi.fn(async () => 'New'), unsavedMedia: 0 };
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', '/?local');
  listeners = vi.spyOn(window, 'addEventListener');
  window.__VIDEO_STUDIO_TEST__ = false;
  await import('../src/main.js');
});
afterEach(() => {
  for (const [type, fn, options] of listeners.mock.calls) window.removeEventListener(type, fn, options);
  for (const editor of state.editors) if (!editor._disposed) editor.dispose();
  window.__VIDEO_STUDIO_TEST__ = true;
  vi.restoreAllMocks();
});

describe('overlapping project navigation', () => {
  it('keeps the latest project open when an earlier read finishes last, releasing the unused claim', async () => {
    const slow = deferred();
    const a = opened('A'), b = opened('B');
    state.library.openForEditing.mockImplementation((id) => id === 'A' ? slow.promise : Promise.resolve(b));
    const home = state.homes.at(-1);
    const first = home.options.onOpen('A');
    await home.options.onOpen('B');
    expect(document.getElementById('app').textContent).toBe('B');
    slow.resolve(a);
    await first;
    expect(document.getElementById('app').textContent).toBe('B');
    expect(location.hash).toBe('#project=B');
    expect(a.claim.release).toHaveBeenCalledTimes(1);
    expect(b.claim.release).not.toHaveBeenCalled();
    expect(state.editors).toHaveLength(1);
  });

  it('does not send the current editor home when an obsolete project read fails', async () => {
    const slow = deferred();
    const b = opened('B');
    state.library.openForEditing.mockImplementation((id) => id === 'A' ? slow.promise : Promise.resolve(b));
    const home = state.homes.at(-1);
    const first = home.options.onOpen('A');
    await home.options.onOpen('B');
    slow.reject(new Error('A is unavailable'));
    await first;
    expect(document.getElementById('app').textContent).toBe('B');
    expect(state.editors[0].dispose).not.toHaveBeenCalled();
    expect(document.querySelector('.toast.error')).toBeNull();
  });
  it('keeps a review link opened while the project is still loading', async () => {
    const slow = deferred();
    const a = opened('A');
    state.library.openForEditing.mockReturnValue(slow.promise);
    const first = state.homes.at(-1).options.onOpen('A');
    history.replaceState(null, '', '#review=review123&server=example.puter.work');
    window.dispatchEvent(new Event('hashchange'));
    await vi.waitFor(() => expect(document.getElementById('app').textContent).toBe('Review'));
    slow.resolve(a);
    await first;
    expect(document.getElementById('app').textContent).toBe('Review');
    expect(location.hash).toContain('review=review123');
    expect(a.claim.release).toHaveBeenCalledTimes(1);
    expect(state.editors).toHaveLength(0);
  });

  it('does not open a newly created project over a newer navigation', async () => {
    const slow = deferred();
    state.library.createProject.mockReturnValue(slow.promise);
    const home = state.homes.at(-1);
    const creating = home.options.onCreate({});
    await vi.waitFor(() => expect(state.library.createProject).toHaveBeenCalled());
    state.library.openForEditing.mockResolvedValue(opened('B'));
    await home.options.onOpen('B');
    slow.resolve({ id: 'new' });
    await creating;
    expect(state.library.openForEditing).toHaveBeenCalledTimes(1);
    expect(document.getElementById('app').textContent).toBe('B');
  });

  it('keeps the current editor when saving before navigation is declined', async () => {
    const home = state.homes.at(-1);
    state.library.openForEditing.mockResolvedValue(opened('A'));
    await home.options.onOpen('A');
    state.editors[0].prepareToLeave.mockResolvedValue(false);
    await home.options.onOpen('B');
    expect(state.library.openForEditing).toHaveBeenCalledTimes(1);
    expect(document.getElementById('app').textContent).toBe('A');
    expect(state.editors[0].dispose).not.toHaveBeenCalled();
  });

  it('finishes adding imported media if a later attempt to leave is declined', async () => {
    const importing = deferred();
    const a = opened('A');
    state.library.createProject.mockResolvedValue(a.project);
    state.library.openForEditing.mockResolvedValue(a);
    state.actions.importFiles.mockReturnValue(importing.promise);
    const home = state.homes.at(-1);
    const files = [new File(['x'], 'photo.png')];
    const opening = home.options.onImportFiles(files);
    await vi.waitFor(() => expect(state.actions.importFiles).toHaveBeenCalledWith(files));
    state.editors[0].prepareToLeave.mockResolvedValue(false);
    await home.options.onOpen('B');
    importing.resolve([{ id: 'photo' }]);
    await opening;
    expect(document.getElementById('app').textContent).toBe('A');
    expect(state.actions.addAssets).toHaveBeenCalledWith([{ id: 'photo' }], { start: 0 });
  });

  it('does not add imported media to an editor that has already been replaced', async () => {
    const importing = deferred();
    const a = opened('A'), b = opened('B');
    state.library.createProject.mockResolvedValue(a.project);
    state.library.openForEditing.mockImplementation(async (id) => id === 'A' ? a : b);
    state.actions.importFiles.mockReturnValue(importing.promise);
    const home = state.homes.at(-1);
    const opening = home.options.onImportFiles([new File(['x'], 'photo.png')]);
    await vi.waitFor(() => expect(state.actions.importFiles).toHaveBeenCalled());
    await home.options.onOpen('B');
    importing.resolve([{ id: 'photo' }]);
    await opening;
    expect(document.getElementById('app').textContent).toBe('B');
    expect(state.actions.addAssets).not.toHaveBeenCalled();
    expect(a.claim.release).toHaveBeenCalledTimes(1);
  });

});
