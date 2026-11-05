// Component library review: wizard and component dialog edge cases.
import { describe, it, expect, vi } from 'vitest';
import { mil, mm } from '../src/core/units.js';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { padDialog } from '../src/editors/lib-tools.js';
import { textBox } from '../src/model/sch.js';
import { mirrorLib, validateComponent } from '../src/editors/lib-model.js';
import { ComponentsPanel } from '../src/ui/panels/components.js';
import { App } from '../src/app/app.js';
import { setPuterForTests } from '../src/app/puter.js';
import { createExampleProject } from '../src/app/demo.js';
import { findWizard } from '../src/model/library/wizards.js';
import { findComponent, searchComponents } from '../src/model/library/builtin.js';
import { overlappingPads } from '../src/model/library/footprints.js';
import { newComponentDialog } from '../src/app/lib-dialogs.js';
import { Project, newProjectData } from '../src/model/project.js';

// jsdom has no 2D canvas; previews draw nothing.
HTMLCanvasElement.prototype.getContext = () => null;
Element.prototype.scrollIntoView ??= () => {};

const tick = () => new Promise((r) => setTimeout(r, 0));
const button = (text) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === text);
const inputFor = (label) => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent === label);
  return document.getElementById(l.htmlFor);
};
const setValue = (el, v) => {
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('footprint wizard pad clashes', () => {
  it('finds pads that overlap and ignores pads sharing a number', () => {
    expect(overlappingPads(findWizard('soic').generate({}).pads)).toBe(null);
    expect(overlappingPads(findWizard('soic').generate({ pitch: mm(0.5) }).pads)).toEqual([
      '1',
      '2',
    ]);
    expect(overlappingPads(findWizard('header').generate({ pitch: mm(1.27) }).pads)).toEqual([
      '1',
      '2',
    ]);
    expect(overlappingPads(findWizard('qfn').generate({ pins: 128 }).pads)).not.toBe(null);
    expect(
      overlappingPads(findWizard('qfp').generate({ pins: 100, size: mm(14), pitch: mm(0.5) }).pads),
    ).toBe(null);
    const tact = [
      { num: '1', x: 0, y: 0, w: 10, h: 10, shape: 'rect' },
      { num: '1', x: 5, y: 0, w: 10, h: 10, shape: 'rect' },
    ];
    expect(overlappingPads(tact)).toBe(null);
  });
});

describe('new component dialog', () => {
  function fakeApp() {
    return {
      project: new Project(newProjectData('Dialog test')),
      userLibrary: { put: vi.fn() },
      toast: vi.fn(),
      activeEditor: null,
    };
  }

  it('does not create a footprint-less component when the wizard input is invalid', async () => {
    const app = fakeApp();
    const result = newComponentDialog(app);
    await tick();
    const pitch = inputFor('Pitch (mm)');
    setValue(pitch, '');
    // Typing elsewhere must not pull focus back to the invalid field.
    const padL = inputFor('Pad length (mm)');
    padL.focus();
    setValue(padL, '1.6');
    expect(document.activeElement).toBe(padL);
    expect(document.body.textContent).toContain('Pitch (mm): enter a valid value');
    button('Create component').click();
    await tick();
    expect(Object.keys(app.project.library)).toHaveLength(0);
    expect(app.userLibrary.put).not.toHaveBeenCalled();

    // Overlapping pads are refused too.
    setValue(pitch, '0.5');
    expect(document.body.textContent).toContain('Pads 1 and 2 overlap');
    button('Create component').click();
    await tick();
    expect(Object.keys(app.project.library)).toHaveLength(0);

    setValue(pitch, '1.27');
    expect(document.body.textContent).not.toContain('overlap');
    button('Create component').click();
    const created = await result;
    expect(created.footprint?.name).toBe('SOIC-8');
    expect(app.project.library[created.id].footprint.pads).toHaveLength(8);
  });
});

describe('component search', () => {
  it('orders equally ranked results naturally by number', () => {
    const headers = searchComponents('header 1x').map((d) => d.name);
    expect(headers.slice(0, 3)).toEqual(['Header 1x2', 'Header 1x3', 'Header 1x4']);
    expect(headers.indexOf('Header 1x10')).toBeGreaterThan(headers.indexOf('Header 1x9'));
    const radial = searchComponents('electrolytic radial').map((d) => d.name);
    expect(radial[radial.length - 1]).toBe('Electrolytic 10x16 radial');
  });
});

describe('component editor footprint switch', () => {
  it('drops the footprint when it is switched off and adds one when pads are drawn', () => {
    const doc = new LibDoc({ def: structuredClone(findComponent('res-0603')) });
    expect(doc.toDef().footprint.pads).toHaveLength(2);
    doc.fpStore.transact('Footprint', (s) => s.update('fpmeta', { enabled: false }));
    expect(doc.toDef().footprint).toBe(null);
    doc.fpStore.undo();
    expect(doc.toDef().footprint.pads).toHaveLength(2);

    const logo = {
      id: 'logo',
      name: 'Logo',
      prefix: 'LOGO',
      symbol: { pins: [], graphics: [{ t: 'circle', cx: 0, cy: 0, r: mil(100), w: 0 }] },
      footprint: null,
    };
    const doc2 = new LibDoc({ def: logo });
    expect(doc2.toDef().footprint).toBe(null);
    doc2.fpStore.transact('Place pad', (s) =>
      s.add({
        t: 'pad',
        num: '1',
        x: 0,
        y: 0,
        shape: 'round',
        w: mm(1),
        h: mm(1),
        side: 'top',
        rot: 0,
      }),
    );
    expect(doc2.toDef().footprint.pads).toHaveLength(1);
  });
});

describe('components panel', () => {
  it('clears the active option when a search finds nothing', () => {
    const app = {
      project: new Project(newProjectData('Panel test')),
      userLibrary: { all: () => [] },
      commands: { run: vi.fn() },
      on: () => {},
    };
    const panel = new ComponentsPanel(app);
    panel.refresh();
    expect(panel.list.getAttribute('aria-activedescendant')).toBe(`cmp-${panel.selected.id}`);
    panel.search.value = 'no such part';
    panel.search.dispatchEvent(new Event('input'));
    expect(panel.selected).toBe(null);
    expect(panel.list.hasAttribute('aria-activedescendant')).toBe(false);
    panel.search.value = 'header 1x';
    panel.search.dispatchEvent(new Event('input'));
    expect(panel.selected.name).toBe('Header 1x2');
    expect(panel.list.getAttribute('aria-activedescendant')).toBe('cmp-hdr-1x02');
  });

  it('keeps the selected part selected after placing copies it into the project', () => {
    const app = {
      project: new Project(newProjectData('Panel test')),
      userLibrary: { all: () => [] },
      commands: { run: vi.fn() },
      on: () => {},
    };
    app.project.ensureComponent(findComponent('ic-555-soic8'));
    const panel = new ComponentsPanel(app);
    panel.refresh();
    panel.select(findComponent('cap-0805'));
    app.project.ensureComponent(findComponent('cap-0805'));
    panel.refresh();
    expect(panel.selected.id).toBe('cap-0805');
    expect(panel.selected).toBe(app.project.library['cap-0805']);
    expect(panel.list.getAttribute('aria-activedescendant')).toBe('cmp-cap-0805');
  });
});

describe('leaving a project with a component open in the editor', () => {
  it('asks about unsaved component changes before closing the project', async () => {
    document.body.innerHTML = '<div id="app"></div><div id="live-region"></div>';
    setPuterForTests(null);
    delete window.puter;
    const app = new App(document.getElementById('app'), { puterTimeout: 10 });
    await app.init();
    app.setProject(createExampleProject(), null);
    const doc = app.openComponentEditor('ic-555-soic8');
    doc.symStore.transact('Value', (s) => s.update('libmeta', { value: 'TLC555' }));
    expect(app.project.dirty).toBe(false);

    let closed = app.closeProject();
    await tick();
    const title = () => document.querySelector('.dialog-head h2')?.textContent;
    expect(title()).toBe('Unsaved component');
    [...document.querySelectorAll('.dialog-foot button')]
      .find((b) => b.textContent === 'Cancel')
      .click();
    await closed;
    expect(app.project).toBeTruthy();

    closed = app.closeProject();
    await tick();
    [...document.querySelectorAll('.dialog-foot button')]
      .find((b) => b.textContent === 'Save')
      .click();
    await tick();
    // Saving the component changed the project, which asks next.
    expect(title()).toBe('Unsaved changes');
    [...document.querySelectorAll('.dialog-foot button')]
      .find((b) => b.textContent === 'Discard changes')
      .click();
    await closed;
    expect(app.project).toBe(null);
    app.kernel.dispose();
    document.body.innerHTML = '';
  });
});

describe('component editor dialogs', () => {
  function editor() {
    const project = new Project(newProjectData('Lib test'));
    const def = structuredClone(findComponent('res-0603'));
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
    const doc = new LibDoc({ def });
    return { doc, ed: new LibEditor(app, project, doc) };
  }
  const pads = (doc) => [...doc.fpStore.all()].filter((o) => o.t === 'pad');
  const alert = () => document.querySelector('.dialog [role=alert]')?.textContent || '';

  it('refuses pad arrays with overlapping pads, zero sizes or fractional counts', async () => {
    const { ed, doc } = editor();
    const done = ed.padArrayDialog();
    await tick();
    const apply = async () => {
      button('Add pads').click();
      await tick();
    };
    setValue(inputFor('Row spacing (mm)'), '1');
    await apply();
    expect(alert()).toContain('overlap');
    setValue(inputFor('Row spacing (mm)'), '0');
    await apply();
    expect(alert()).toContain('Row spacing');
    setValue(inputFor('Row spacing (mm)'), '2.54');
    setValue(inputFor('Rows'), '2.5');
    await apply();
    expect(alert()).toContain('Rows');
    expect(pads(doc)).toHaveLength(2);
    setValue(inputFor('Rows'), '3');
    await apply();
    await done;
    expect(pads(doc)).toHaveLength(8);
  });

  it('refuses a zero or negative pad size for the next pad', async () => {
    const result = padDialog({ num: '1', shape: 'rect', w: mm(1), h: mm(1), side: 'top', rot: 0 });
    await tick();
    setValue(inputFor('Width (mm)'), '-1');
    setValue(inputFor('Rotation (degrees)'), '-90');
    button('Apply').click();
    await tick();
    expect(document.querySelector('.dialog')).toBeTruthy();
    setValue(inputFor('Width (mm)'), '1.5');
    button('Apply').click();
    const v = await result;
    expect(v.w).toBe(mm(1.5));
    expect(v.rot).toBe(270);
  });
});

describe('built-in footprints match their packages', () => {
  // Pad centres in mm, top view, +y up.
  const centres = (id) => {
    const fp = findComponent(id).footprint;
    return Object.fromEntries(fp.pads.map((p) => [p.num, [p.x / 1e6, p.y / 1e6]]));
  };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

  it('SOIC-8: 1.27 mm pitch, pin 1 top left, counter-clockwise', () => {
    const c = centres('ic-555-soic8');
    expect(near(c[1], [-2.7, 1.905])).toBe(true);
    expect(near(c[4], [-2.7, -1.905])).toBe(true);
    expect(near(c[5], [2.7, -1.905])).toBe(true);
    expect(near(c[8], [2.7, 1.905])).toBe(true);
    expect(c[1][1] - c[2][1]).toBeCloseTo(1.27);
  });

  it('DIP-8: 7.62 mm rows, 2.54 mm pitch, square pin 1 top left', () => {
    const fp = findComponent('ic-555-dip8').footprint;
    const c = centres('ic-555-dip8');
    expect(near(c[1], [-3.81, 3.81])).toBe(true);
    expect(near(c[4], [-3.81, -3.81])).toBe(true);
    expect(near(c[5], [3.81, -3.81])).toBe(true);
    expect(near(c[8], [3.81, 3.81])).toBe(true);
    expect(fp.pads.find((p) => p.num === '1').shape).toBe('rect');
  });

  it('SOT-23 and SOT-23-5 pin positions', () => {
    const c = centres('npn-sot23');
    expect(c[1][0]).toBeCloseTo(-0.95);
    expect(c[2][0]).toBeCloseTo(0.95);
    expect(c[1][1]).toBeLessThan(0);
    expect(c[3][0]).toBeCloseTo(0);
    expect(c[3][1]).toBeGreaterThan(0);
    const c5 = centres('opamp-single-sot23-5');
    expect([1, 2, 3].map((n) => c5[n][0])).toEqual([-0.95, 0, 0.95]);
    expect(c5[4][0]).toBeCloseTo(0.95);
    expect(c5[5][0]).toBeCloseTo(-0.95);
    expect(c5[4][1]).toBeGreaterThan(0);
  });

  it('power packages: SOT-223 2.3 mm, DPAK 2.28 mm, TO-220 and TO-92 2.54 mm', () => {
    const s = centres('reg-ldo-1117-sot223');
    expect(s[2][0] - s[1][0]).toBeCloseTo(2.3);
    expect(s[3][0] - s[2][0]).toBeCloseTo(2.3);
    const d = centres('nmos-dpak');
    expect(d[3][0] - d[1][0]).toBeCloseTo(4.56);
    for (const id of ['reg-7805-to220', 'npn-to92']) {
      const t = centres(id);
      expect(t[2][0] - t[1][0]).toBeCloseTo(2.54);
      expect(t[3][0] - t[2][0]).toBeCloseTo(2.54);
    }
  });

  it('TQFP-32: 0.8 mm pitch, pin 1 at the top of the left side, counter-clockwise', () => {
    const c = centres('mcu-atmega328p-tqfp32');
    expect(c[1][0]).toBeLessThan(0);
    expect(c[1][1]).toBeCloseTo(2.8);
    expect(c[1][1] - c[2][1]).toBeCloseTo(0.8);
    expect(c[9][1]).toBeLessThan(0);
    expect(c[9][0]).toBeCloseTo(-2.8);
    expect(c[17][0]).toBeGreaterThan(0);
    expect(c[17][1]).toBeCloseTo(-2.8);
    expect(c[25][1]).toBeGreaterThan(0);
    expect(c[25][0]).toBeCloseTo(2.8);
  });

  it('crystals, LEDs, electrolytics and headers', () => {
    const x = centres('xtal-3225');
    expect(near(x[1], [-1.1, -0.8]) && near(x[2], [1.1, -0.8])).toBe(true);
    expect(near(x[3], [1.1, 0.8]) && near(x[4], [-1.1, 0.8])).toBe(true);
    const hc = centres('xtal-hc49');
    expect(hc[2][0] - hc[1][0]).toBeCloseTo(4.88);
    const led = centres('led-5mm-red');
    expect(led[2][0] - led[1][0]).toBeCloseTo(2.54);
    expect(led[1][0]).toBeLessThan(0);
    for (const [id, pitch] of [
      ['cap-elec-rad-5x11', 2],
      ['cap-elec-rad-6.3x11', 2.5],
      ['cap-elec-rad-8x11.5', 3.5],
      ['cap-elec-rad-10x16', 5],
    ]) {
      const c = centres(id);
      expect(c[2][0] - c[1][0], id).toBeCloseTo(pitch);
    }
    const h = centres('hdr-2x05');
    expect(near(h[1], [-1.27, 5.08]) && near(h[2], [1.27, 5.08]) && near(h[3], [-1.27, 2.54])).toBe(
      true,
    );
  });

  it('chip sizes keep their pads on the IPC nominal centres', () => {
    for (const [size, gap] of [
      ['0402', 1.0],
      ['0603', 1.6],
      ['0805', 1.9],
      ['1206', 3.0],
    ]) {
      const c = centres(`res-${size}`);
      expect(c[2][0] - c[1][0], size).toBeCloseTo(gap);
    }
  });
});

describe('component checks', () => {
  const pad = (num, x, extra = {}) => ({
    num,
    x,
    y: 0,
    shape: 'rect',
    w: mm(1),
    h: mm(1),
    side: 'top',
    rot: 0,
    ...extra,
  });
  const comp = (pads) => ({
    prefix: 'U',
    symbol: {
      pins: [...new Set(pads.map((p) => p.num).filter(Boolean))].map((num) => ({ num, name: num })),
      graphics: [],
    },
    footprint: { name: 'X', pads, graphics: [] },
  });
  const errors = (pads) =>
    validateComponent(comp(pads))
      .filter((m) => m.severity === 'error')
      .map((m) => m.message);

  it('reports pads that short together and accepts pads that do not', () => {
    expect(errors([pad('1', 0), pad('2', mm(0.5))])).toEqual([
      'Pads 1 and 2 overlap, shorting them together.',
    ]);
    expect(errors([pad('1', 0), pad('2', mm(1.5))])).toEqual([]);
    // Opposite sides of the board, shared numbers and unnumbered pads do not short.
    expect(errors([pad('1', 0), pad('2', 0, { side: 'bottom' })])).toEqual([]);
    expect(errors([pad('1', 0), pad('1', mm(0.5))])).toEqual([]);
    expect(errors([pad('1', 0), pad('', mm(0.5))])).toEqual([]);
    const thru = { side: 'thru', drill: mm(0.5), shape: 'round' };
    expect(errors([pad('1', 0), pad('2', mm(0.5), thru)])).toHaveLength(1);
  });
});

describe('component checks for mechanical parts', () => {
  it('accepts a non-plated hole the size of its pad', () => {
    const msgs = validateComponent(findComponent('mh-m3-npth')).map((m) => m.message);
    expect(msgs.some((m) => /hole as large as the pad/.test(m))).toBe(false);
    const plated = structuredClone(findComponent('mh-m3'));
    plated.footprint.pads[0].drill = plated.footprint.pads[0].w;
    expect(validateComponent(plated).map((m) => m.message)).toContain(
      'Pad 1 has a hole as large as the pad.',
    );
  });
});

describe('component editor mirroring', () => {
  const text = (rot) => ({ t: 'text', id: 't', text: 'A', x: mm(1), y: mm(2), size: mm(1), rot });

  it('negates the angle of mirrored text so it follows the mirrored baseline', () => {
    const m = mirrorLib(text(30), 0, 0, 'x');
    expect(m).toMatchObject({ x: -mm(1), y: mm(2), rot: 330, mirror: false });
    // Across a horizontal line the baseline turns to -30 degrees too (drawn
    // upright, 150 reads the same as 330).
    const v = mirrorLib(text(30), 0, 0, 'y');
    expect(v).toMatchObject({ x: mm(1), y: -mm(2) });
    expect([150, 330]).toContain(v.rot);
    // Mirroring twice restores the text.
    expect(mirrorLib(m, 0, 0, 'x')).toMatchObject({ x: mm(1), y: mm(2), rot: 30 });
    expect(mirrorLib(text(0), 0, 0, 'x').rot).toBe(0);
  });

  it('swaps left and right alignment so mirrored text runs away from the axis', () => {
    const left = mirrorLib(text(0), 0, 0, 'x');
    expect(left.align).toEqual({ h: 'right' });
    const back = mirrorLib(left, 0, 0, 'x');
    expect(back.align).toBeUndefined();
    const right = { ...text(0), align: { h: 'right', v: 'top' } };
    expect(mirrorLib(right, 0, 0, 'x').align).toEqual({ v: 'top' });
    const centre = { ...text(0), align: { h: 'center', v: 'middle' } };
    expect(mirrorLib(centre, 0, 0, 'x').align).toEqual({ h: 'center', v: 'middle' });
    // The text's extent mirrors with it: it lay right of x = 1 mm, now left of -1 mm.
    const b0 = textBox('ABC', mm(1), mm(2), mm(1), 0, undefined);
    const b1 = textBox('ABC', left.x, left.y, mm(1), left.rot, left.align);
    expect(b1.minX).toBeCloseTo(-b0.maxX, -2);
    expect(b1.maxX).toBeCloseTo(-b0.minX, -2);
  });
});

describe('component editor footprint drawing', () => {
  it('draws a filled circle with its outline width, as the board and Gerber do', () => {
    const doc = new LibDoc({ def: structuredClone(findComponent('res-0603')) });
    const app = {
      settings: { get: () => undefined, on: () => () => {} },
      commands: { run: vi.fn() },
      renderTabs: vi.fn(),
      updateActiveBar: vi.fn(),
    };
    const ed = new LibEditor(app, null, doc);
    doc.mode = 'footprint';
    const calls = [];
    const b = {
      circle: (...a) => calls.push(['circle', ...a]),
      ring: (...a) => calls.push(['ring', ...a]),
    };
    const dot = { t: 'circle', cx: 0, cy: 0, r: mm(0.5), w: mm(0.2), layer: 'topOverlay' };
    ed.drawObject(b, { ...dot, fill: true });
    ed.drawObject(b, { ...dot, fill: true, w: 0 });
    ed.drawObject(b, dot);
    expect(calls.map((c) => [c[0], c[3]])).toEqual([
      ['circle', mm(0.6)],
      ['circle', mm(0.5)],
      ['ring', mm(0.5)],
    ]);
  });
});
