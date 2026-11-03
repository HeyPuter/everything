// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';

vi.mock('../src/views/editor.js', () => ({
  editorView: vi.fn(({ doc }) => ({
    el: document.createElement('div'), doc,
    flush: () => doc.flush(), destroy: () => doc.destroy(),
  })),
}));

it('saves only pending edits when the connection comes back', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  const write = vi.fn(async (path) => ({ path }));
  vi.stubGlobal('puter', {
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test' }) },
    fs: { readdir: async () => [], read: async () => new Blob(['A']), mkdir: async () => {}, stat: vi.fn(async () => null), write },
  });
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', '#/new');
  await import('../src/main.js');
  await vi.waitFor(() => expect(window.__docs.current?.kind).toBe('editor'));
  const doc = window.__docs.current.view.doc;
  doc.attach(async () => new Blob(['export']));
  expect(doc.dirty).toBe(false);

  const onLine = vi.spyOn(navigator, 'onLine', 'get');
  onLine.mockReturnValue(false);
  window.dispatchEvent(new Event('offline'));
  expect(document.querySelector('.offline-banner')).not.toBeNull();
  // The banner is spoken through the live region that was on the page all along, not by arriving as one already filled.
  expect(document.querySelector('.offline-banner').getAttribute('role')).toBeNull();
  expect(document.querySelector('.toast-root[role="status"]').textContent).toContain('Offline. Changes will save when you reconnect');
  onLine.mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  expect(document.querySelector('.offline-banner')).toBeNull();
  expect(document.querySelector('.toast-root[role="status"]').textContent).toContain('Back online');
  // A save would take several round trips; give it the time and expect none.
  await new Promise((resolve) => setTimeout(resolve, 100));
  // An untouched new document gets no file from a reconnect alone.
  expect(write).not.toHaveBeenCalled();
  expect(puter.fs.stat).not.toHaveBeenCalled();

  doc.changed();
  onLine.mockReturnValue(false);
  window.dispatchEvent(new Event('offline'));
  onLine.mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  // The document is written once (a version snapshot may follow it).
  const documentWrites = () => write.mock.calls.map(([path]) => path).filter((path) => !path.includes('/.versions/'));
  await vi.waitFor(() => expect(documentWrites()).toEqual(['Documents/Untitled document.docx']));
  window.__docs.current.view.destroy();
  vi.unstubAllGlobals();
});

it('with AutoSave off, does not promise that the changes save themselves when the connection is back', async () => {
  vi.resetModules();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {} }));
  localStorage.setItem('documents:autosave', '0');
  vi.stubGlobal('puter', {
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test' }) },
    fs: { readdir: async () => [], read: async () => new Blob(['A']), mkdir: async () => {}, stat: async () => null, write: async (path) => ({ path }) },
  });
  document.body.innerHTML = '<div id="app"></div>';
  history.replaceState(null, '', '#/new');
  const onLine = vi.spyOn(navigator, 'onLine', 'get');
  onLine.mockReturnValue(true);
  try {
    await import('../src/main.js');
    await vi.waitFor(() => expect(window.__docs.current?.kind).toBe('editor'));
    onLine.mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    const banner = document.querySelector('.offline-banner');
    expect(banner.textContent).not.toMatch(/will save/);
    expect(banner.textContent).toContain('Save your changes when you reconnect');
  } finally {
    onLine.mockRestore();
    window.__docs.current?.view.destroy();
    localStorage.removeItem('documents:autosave');
    vi.unstubAllGlobals();
  }
});
