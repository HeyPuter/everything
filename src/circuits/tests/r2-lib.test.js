// Round 2 review of the component library, the component editor and the
// rendering stack.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { validateComponent } from '../src/editors/lib-model.js';
import { findComponent } from '../src/model/library/builtin.js';
import { Project, newProjectData } from '../src/model/project.js';
import { mm } from '../src/core/units.js';
import { findWizard } from '../src/model/library/wizards.js';
import { createViewer3D } from '../src/render/viewer3d.js';

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
    name.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await tick();
    expect(document.querySelector('.dialog')).toBeNull();
    expect(pins(doc)[0].name).toBe('TRIGGER');
    expect(pins(doc)[0].length).toBe(7_620_000);
  });

  // The 555's last listed pin is pin 1 (GND, at the bottom), so counting up
  // from the last row gave the new pin the number 2, which is taken.
  it('gives an added pin a number that is not in use', async () => {
    const { ed, doc } = editor();
    ed.pinTableDialog();
    await tick();
    const click = (text) =>
      [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === text).click();
    click('Add pin');
    await tick();
    click('Add pin');
    await tick();
    click('Apply');
    await tick();
    const nums = pins(doc).map((p) => p.num);
    expect(nums).toHaveLength(10);
    expect(new Set(nums).size).toBe(10);
    expect(nums.slice(-2)).toEqual(['9', '10']);
    expect(validateComponent(doc.toDef()).filter((m) => m.severity === 'error')).toEqual([]);
  });
});

describe('footprint courtyard', () => {
  const courtyardRect = (doc) =>
    [...doc.fpStore.all()].find((o) => o.t === 'rect' && o.layer === 'courtyard');

  // The courtyard box is what the design rule check tests; the rectangle on
  // the courtyard layer is what the user sees and edits. They must agree.
  it('follows the courtyard rectangle when it is resized on the canvas', () => {
    const { ed, doc } = editor();
    ed.setMode('footprint');
    const r = courtyardRect(doc);
    expect(doc.toDef().footprint.courtyard).toEqual({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
    ed.endVertexDrag({ id: r.id, index: 2, x: r.x2 + mm(2), y: r.y2 + mm(1) }, true);
    expect(doc.toDef().footprint.courtyard).toEqual({
      x1: r.x1,
      y1: r.y1,
      x2: r.x2 + mm(2),
      y2: r.y2 + mm(1),
    });
    doc.fpStore.undo();
    expect(doc.toDef().footprint.courtyard).toEqual({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
  });

  it('uses a courtyard drawn by hand instead of fitting one on save', async () => {
    const { ed, doc, project } = editor('res-0603');
    ed.setMode('footprint');
    doc.fpStore.transact('Redraw courtyard', (s) => {
      s.remove(courtyardRect(doc).id);
      s.update('fpmeta', { courtyard: undefined });
      s.add({
        t: 'rect',
        layer: 'courtyard',
        w: mm(0.05),
        x1: mm(3),
        y1: mm(2),
        x2: mm(-3),
        y2: mm(-2),
      });
    });
    await ed.save();
    expect(project.library['res-0603'].footprint.courtyard).toEqual({
      x1: mm(-3),
      y1: mm(-2),
      x2: mm(3),
      y2: mm(2),
    });
  });

  it('keeps the stored courtyard when nothing is drawn on the courtyard layer', () => {
    const { doc } = editor();
    const before = doc.toDef().footprint.courtyard;
    doc.fpStore.transact('Delete', (s) => s.remove(courtyardRect(doc).id));
    expect(doc.toDef().footprint.courtyard).toEqual(before);
  });
});

/** A WebGL2 context that accepts every call, for code that only needs one to exist. */
function fakeGl() {
  return new Proxy(
    {},
    {
      get: (t, k) => {
        if (k in t) return t[k];
        if (typeof k !== 'string') return undefined;
        if (/^[A-Z0-9_]+$/.test(k)) return 1;
        if (k.startsWith('create')) return () => ({});
        if (/^get(Shader|Program)Parameter$/.test(k)) return () => true;
        return () => null;
      },
    },
  );
}

describe('3D viewer', () => {
  // Pressing on the canvas cancels the pointer event's default action (to
  // keep the page from selecting or scrolling), which also keeps the browser
  // from focusing the canvas, so the viewer has to do it.
  it('takes keyboard focus when the canvas is pressed', () => {
    const canvas = document.createElement('canvas');
    canvas.getContext = () => fakeGl();
    const other = document.createElement('button');
    document.body.append(canvas, other);
    const viewer = createViewer3D(canvas);
    expect(viewer.supported).toBe(true);
    other.focus();
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
    canvas.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(canvas);
    viewer.dispose();
    canvas.remove();
    other.remove();
  });
});

describe('footprint wizards', () => {
  // The exposed pad is clamped to the room between the pad rows. On a very
  // small body that room is negative, and the pad came out with a negative
  // size: nothing sensible on screen and an invalid aperture when exported.
  it('refuses an exposed pad that does not fit instead of giving it a negative size', () => {
    const tiny = { pins: 8, size: mm(1), pitch: mm(0.3), padL: mm(0.3) };
    expect(() => findWizard('qfn').generate(tiny)).toThrow(/exposed pad/);
    expect(() =>
      findWizard('soic').generate({ pins: 4, pitch: mm(0.3), padW: mm(0.15), epad: mm(0.5) }),
    ).toThrow(/exposed pad/);
    const noPad = findWizard('qfn').generate({ ...tiny, epad: 0 });
    expect(noPad.pads).toHaveLength(8);
    for (const w of ['qfn', 'soic']) {
      const fp = findWizard(w).generate({ epad: mm(2.4) });
      for (const p of fp.pads) expect(p.w > 0 && p.h > 0).toBe(true);
      expect(fp.pads.at(-1).shape).toBe('rect');
    }
  });
});
