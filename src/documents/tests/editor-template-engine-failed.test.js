// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stubEditorBrowser } from './helpers/editor-browser.js';
import { editorView } from '../src/views/editor.js';
import { Doc, versioning, needsUnloadWarning } from '../src/lib/doc.js';
// Booting the whole app shell can exceed the default timeout on a loaded machine.
vi.setConfig({ testTimeout: 60000 });

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn(() => ({ dismiss() {} })), announce: vi.fn() }));
vi.mock('../src/lib/engine.js', () => ({ loadEngine: async () => { throw new Error('engine unavailable'); } }));

let view;
beforeEach(() => {
  vi.useFakeTimers(); versioning.enabled = false;
  stubEditorBrowser();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { view?.destroy(); document.body.replaceChildren(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); versioning.enabled = true; });

it('leaves a template document clean when the engine cannot load, since it has no content to lose', async () => {
  const doc = Doc.blank({ template: 'letter', name: 'Letter' });
  view = editorView({ doc, goHome: vi.fn(), newDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
  expect(view.el.querySelector('.editor-error')).not.toBeNull();
  expect(doc.dirty).toBe(false);
  expect(needsUnloadWarning(doc)).toBe(false);
  expect(await view.flush()).toBe(true);
});

it('keeps an imported document\'s content protected when the engine cannot load', async () => {
  const doc = Doc.fromTextImport('Notes', { value: '# Imported', type: 'markdown' });
  view = editorView({ doc, goHome: vi.fn(), newDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el);
  await vi.advanceTimersByTimeAsync(0);
  expect(view.el.querySelector('.editor-error')).not.toBeNull();
  expect(doc.dirty).toBe(true);
});
