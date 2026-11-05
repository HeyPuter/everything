// Component library review: wizard and component dialog edge cases.
import { describe, it, expect, vi } from 'vitest';
import { mil, mm } from '../src/core/units.js';
import { LibDoc, LibEditor } from '../src/editors/lib-editor.js';
import { padDialog } from '../src/editors/lib-tools.js';
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
