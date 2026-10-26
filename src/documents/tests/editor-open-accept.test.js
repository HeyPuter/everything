// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { stubEditorBrowser } from './helpers/editor-browser.js';
// Booting the whole app shell can exceed the default timeout on a loaded machine.
vi.setConfig({ testTimeout: 60000 });

vi.mock('../src/lib/engine.js', () => ({ loadEngine: async () => { throw new Error('engine unavailable'); } }));

let errors;
beforeEach(() => {
  stubEditorBrowser();
  vi.stubGlobal('puter', {
    auth: { isSignedIn: () => true, getUser: async () => ({ username: 'test' }) },
    fs: { readdir: async () => [] },
  });
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { window.__docs?.current?.view.destroy(); errors.mockRestore(); vi.unstubAllGlobals(); });

it('opens from the editor the same kinds of files Import takes, and names one it cannot open', async () => {
  history.replaceState(null, '', '#/new');
  await import('../src/main.js');
  await vi.waitFor(() => expect(window.__docs.current?.kind).toBe('editor'));
  const view = window.__docs.current.view;
  const input = view.el.querySelector('input[aria-label="Open DOCX file"]');
  // File > Open names Hanword, Markdown, HTML and text files; the device's file picker offers them.
  for (const type of ['.docx', '.dotx', '.hwp', '.hwpx', '.md', '.html', '.txt']) expect(input.accept.split(',')).toContain(type);
  Object.defineProperty(input, 'files', { value: [new File(['%PDF'], 'Scan.pdf')], configurable: true });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.querySelector('.toast-root')?.textContent).toContain('That file cannot be imported'));
  expect(window.__docs.current.view).toBe(view);
});
