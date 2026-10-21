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

/** An unsaved imported copy whose engine failed, so leaving asks first. */
async function openUnsavedImport() {
  history.replaceState(null, '', '#/new');
  await import('../src/main.js');
  await vi.waitFor(() => expect(window.__docs.current?.kind).toBe('editor'));
  const previous = window.__docs.current.view;
  const input = window.__docs.current.view.el.querySelector('input[aria-label="Open DOCX file"]');
  Object.defineProperty(input, 'files', { value: [new File(['document'], 'Import.docx')] });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(window.__docs.current?.view !== previous && window.__docs.current?.view.doc?.name === 'Import').toBe(true));
  const view = window.__docs.current.view;
  await vi.waitFor(() => expect(view.el.querySelector('.editor-error')).not.toBeNull());
  return view;
}

it('honors a navigation made while the leave dialog is open: staying shows the document again, leaving goes there', async () => {
  const view = await openUnsavedImport();
  const askToLeave = async () => {
    view.el.querySelector('[aria-label="All Documents"]').click();
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Leave without saving?'));
    // With the question open, the user picks somewhere else: a fresh document from a template.
    location.hash = '#/new/letter';
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.__docs.current.view === view).toBe(true);
  };
  await askToLeave();
  document.querySelector('.modal-root:not(.closing) .modal-panel .btn-ghost').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(window.__docs.current.view === view).toBe(true);
  expect(location.hash).toBe('#/new');
  await askToLeave();
  document.querySelector('.modal-root:not(.closing) .modal-panel .btn-danger').click();
  await vi.waitFor(() => expect(window.__docs.current?.view !== view && window.__docs.current?.kind === 'editor').toBe(true));
  expect(location.hash).toBe('#/new/letter');
  expect(window.__docs.current.view.doc.template).toBe('letter');
// This first case cold-imports the application. Its per-action waitFor bounds
// remain unchanged; allow module transformation separately from UI behavior.
}, 30000);

it('says that a never-saved document has not been saved, rather than speaking of its latest changes', async () => {
  const view = await openUnsavedImport();
  view.el.querySelector('[aria-label="All Documents"]').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Leave without saving?'));
  // The editor could not open it, so there is no editing to keep doing: the question says what staying is for.
  expect(document.querySelector('[role="dialog"]').textContent).toContain('This document could not be opened for editing, so it has not been saved to Puter. Stay to download a copy');
  expect(document.querySelector('[role="dialog"]').textContent).not.toContain('Keep editing');
  document.querySelector('.modal-root:not(.closing) .modal-panel .btn-ghost').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});

it('does not stack a second leave question when a file is dropped while the first is up', async () => {
  const view = await openUnsavedImport();
  view.el.querySelector('[aria-label="All Documents"]').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Leave without saving?'));
  const questions = () => document.querySelectorAll('.modal-root:not(.closing) [role="dialog"]').length;
  const before = questions();
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [new File(['document'], 'Second.docx')] } });
  window.dispatchEvent(drop);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(questions()).toBe(before);
  expect(window.__docs.current.view).toBe(view);
  expect(document.querySelector('.toast')?.textContent).toContain('Answer the question about the open document first');
  document.querySelector('.modal-root:not(.closing) .modal-panel .btn-ghost').click();
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
});
