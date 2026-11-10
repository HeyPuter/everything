// Round 2 review of the component library, the component editor and the
// rendering stack.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { findComponent } from '../src/model/library/builtin.js';
import { Project, newProjectData } from '../src/model/project.js';

// jsdom has no 2D canvas or WebGL; the editor logic runs without them.
HTMLCanvasElement.prototype.getContext = () => null;

const tick = () => new Promise((r) => setTimeout(r, 0));

function editor(id = 'ic-555-soic8') {
  const project = new Project(newProjectData('Lib test'));
  const def = structuredClone(findComponent(id));
  project.putComponent(def);
  const app = {
    settings: { get: () => undefined, on: () => () => {} },
    commands: { run: vi.fn() },
    userLibrary: { put: vi.fn(async () => {}) },
    toast: vi.fn(),
    renderTabs: vi.fn(),
    updateTitle: vi.fn(),
    updateStatus: vi.fn(),
    refreshMenus: vi.fn(),
    updateActiveBar: vi.fn(),
  };
  const doc = new LibDoc({ def: structuredClone(def) });
  return { app, project, doc, ed: new LibEditor(app, project, doc) };
}

afterEach(() => {
  for (const el of document.querySelectorAll('.dialog-backdrop')) el.remove();
});

describe('pin table', () => {
  const pins = (doc) => [...doc.symStore.all()].filter((o) => o.t === 'pin');

  // Typing fires `input`; `change` only comes when the field loses focus,
  // which Enter (the dialog's shortcut for Apply) never causes.
  it('applies a name that was typed and confirmed with Enter', async () => {
    const { ed, doc } = editor();
    ed.pinTableDialog();
    await tick();
    const name = document.querySelector('.dialog input[aria-label="Name of pin 1"]');
    const length = document.querySelector('.dialog input[aria-label="Length of pin 1"]');
    name.value = 'TRIGGER';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    length.value = '300';
    length.dispatchEvent(new Event('input', { bubbles: true }));
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(pins(doc)[0].name).toBe('TRIGGER');
    expect(pins(doc)[0].length).toBe(7_620_000);
  });
});
