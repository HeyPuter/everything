// The Learn panel's step engine: advancing on commands, edits and checks; Back, Skip and
// Stop; progress kept for resuming; and the shipped tutorials' shape.
import { describe, it, expect, beforeEach } from 'vitest';
import { TutorialRunner, stepSatisfied } from '../src/learn/engine.js';
import { TUTORIALS } from '../src/learn/tutorials.js';
import { calloutPosition, resolveTarget } from '../src/learn/highlight.js';
import { Emitter } from '../src/lib/emitter.js';
import { Prefs } from '../src/lib/prefs.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeApp() {
  const app = new Emitter();
  app.prefs = new Prefs(null);
  const watchers = new Set();
  app.commands = {
    watch(w) {
      watchers.add(w);
      return () => watchers.delete(w);
    },
    run(id) {
      for (const w of watchers) w.after?.(id);
    },
    shortcutLabel: () => '',
  };
  app.active = { kind: 'audio', history: { undoLabel: '', index: 0 } };
  app.edit = (label) => {
    app.active.history = { undoLabel: label, index: app.active.history.index + 1 };
    app.emit('doc-change', app.active, { kind: 'edit' });
  };
  return app;
}

const demo = {
  id: 'demo',
  title: 'Demo',
  steps: [
    { id: 'a', title: 'Run a command', text: '', done: { command: ['x.one', 'x.two'] } },
    { id: 'b', title: 'Make an edit', text: '', done: { edit: 'Normalize' } },
    { id: 'c', title: 'Flip a switch', text: '', done: { check: (app) => app.flag === true } },
    { id: 'd', title: 'Read this', text: '', done: { manual: true } },
  ],
};

describe('tutorial runner', () => {
  let app;
  let runner;
  beforeEach(() => {
    app = fakeApp();
    runner = new TutorialRunner(app, [demo]);
  });

  it('advances as each step is done and finishes', async () => {
    const finished = [];
    runner.on('finished', (t) => finished.push(t.id));
    await runner.start('demo');
    expect(runner.current.index).toBe(0);
    app.commands.run('x.other');
    expect(runner.current.index).toBe(0);
    app.commands.run('x.two');
    expect(runner.current.index).toBe(1);
    // Another edit does not count; the named one does.
    app.edit('Amplify');
    expect(runner.current.index).toBe(1);
    app.edit('Normalize');
    expect(runner.current.index).toBe(2);
    app.flag = true;
    app.emit('tool', 'time');
    expect(runner.current.index).toBe(3);
    // A manual step waits for Next.
    app.commands.run('x.one');
    expect(runner.current.index).toBe(3);
    runner.next();
    expect(runner.current).toBe(null);
    expect(finished).toEqual(['demo']);
    expect(runner.progress('demo')).toMatchObject({ done: true, step: 4, total: 4 });
  });

  it('does not count an edit made before the step began', async () => {
    app.edit('Normalize');
    await runner.start('demo');
    runner.next();
    await flush();
    expect(runner.current.index).toBe(1);
  });

  it('completes a step whose condition already holds when it begins', async () => {
    app.flag = true;
    await runner.start('demo');
    runner.next();
    runner.next();
    await flush();
    expect(runner.current.index).toBe(3);
  });

  it('goes back, skips, stops and resumes where it left off', async () => {
    await runner.start('demo');
    runner.next();
    runner.next();
    expect(runner.current.index).toBe(2);
    runner.back();
    expect(runner.current.index).toBe(1);
    runner.stop();
    expect(runner.current).toBe(null);
    expect(runner.progress('demo')).toMatchObject({ step: 1, done: false, started: true });
    // Commands after stopping do nothing.
    app.commands.run('x.one');
    const again = new TutorialRunner(app, [demo]);
    await again.start('demo');
    expect(again.current.index).toBe(1);
    await again.start('demo', { restart: true });
    expect(again.current.index).toBe(0);
  });

  it('runs the tutorial setup with a context the steps can read', async () => {
    const t = { id: 'ctx', title: 'Ctx', setup: (a, ctx) => (ctx.n = 3), steps: [{ id: 'a', title: '', text: '', done: { check: (a, ctx) => ctx.n === 3 } }] };
    const r = new TutorialRunner(app, [t]);
    const done = [];
    r.on('finished', () => done.push(1));
    await r.start('ctx');
    await flush();
    expect(done).toEqual([1]);
  });

  it('treats a failing check as not done', () => {
    expect(stepSatisfied({ done: { check: () => { throw new Error('x'); } } }, app, {})).toBe(false);
    expect(stepSatisfied({ done: { manual: true } }, app, {})).toBe(false);
    expect(stepSatisfied(null, app, {})).toBe(false);
  });
});

describe('shipped tutorials', () => {
  it('has five or six tutorials, each with steps that say what to do and when they are done', () => {
    expect(TUTORIALS.length).toBeGreaterThanOrEqual(5);
    expect(TUTORIALS.length).toBeLessThanOrEqual(6);
    const ids = new Set();
    for (const t of TUTORIALS) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.title && t.summary && t.minutes > 0).toBeTruthy();
      expect(t.steps.length).toBeGreaterThan(2);
      for (const s of t.steps) {
        expect(s.title && s.text, `${t.id}/${s.id}`).toBeTruthy();
        const d = s.done || {};
        expect(Boolean(d.command || d.edit || d.check || d.manual), `${t.id}/${s.id}`).toBe(true);
        // Something to point at: a target, a command or a menu path.
        expect(Boolean(s.target || s.command || s.menu), `${t.id}/${s.id}`).toBe(true);
      }
    }
  });
});

describe('pointing at the interface', () => {
  it('prefers the command in an open menu, then the menu path, then the target', () => {
    document.body.innerHTML = `
      <button class="menubar-item">Effects</button>
      <div id="t">target</div>`;
    const box = (el) => (el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 }));
    for (const el of document.querySelectorAll('*')) box(el);
    const step = { command: 'fx.normalize', menu: ['Effects', 'Amplitude and Compression'], target: '#t' };
    expect(resolveTarget(step, null, {}).id).toBe('t');
    // Menu closed and no target: the menu bar entry.
    expect(resolveTarget({ ...step, target: null }, null, {}).textContent).toBe('Effects');
    // Submenu open: its row; command row open: that row.
    const menu = document.createElement('div');
    menu.className = 'menu';
    const sub = document.createElement('div');
    sub.className = 'menu-item';
    sub.innerHTML = '<span class="menu-label">Amplitude and Compression</span>';
    menu.append(sub);
    document.body.append(menu);
    box(sub);
    expect(resolveTarget(step, null, {})).toBe(sub);
    const row = document.createElement('div');
    row.className = 'menu-item';
    row._item = { id: 'fx.normalize' };
    menu.append(row);
    box(row);
    expect(resolveTarget(step, null, {})).toBe(row);
  });

  it('keeps the callout on screen', () => {
    expect(calloutPosition({ left: 10, top: 10, right: 50, bottom: 30 }, 100, 20, 800, 600)).toEqual({ left: 10, top: 40 });
    // Near the bottom: above the target.
    expect(calloutPosition({ left: 10, top: 570, right: 50, bottom: 590 }, 100, 20, 800, 600).top).toBe(540);
    // Near the right edge: pulled left.
    expect(calloutPosition({ left: 780, top: 10, right: 800, bottom: 30 }, 100, 20, 800, 600).left).toBe(696);
  });
});

describe('Learn panel', () => {
  it('lists the tutorials, runs one with real commands and resumes it', async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    HTMLCanvasElement.prototype.getContext = () => null;
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { installCore } = await import('../src/features/core.js');
    const { installLearn } = await import('../src/learn/install.js');
    const { learnPanel } = await import('../src/learn/panel.js');
    const app = new App();
    installCore(app);
    installLearn(app);
    expect(app.commands.get('help.learn')).toBeTruthy();
    expect(app.commands.get('window.learn')).toBeTruthy();
    const { el } = learnPanel(app);
    document.body.replaceChildren(el);
    expect(el.querySelectorAll('.learn-item').length).toBe(6);
    const item = el.querySelector('[data-tutorial="export-ranges"]');
    item.querySelector('button').focus();
    item.querySelector('button').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.learn.current.tutorial.id).toBe('export-ranges');
    expect(app.active.name).toBe('Practice Voice.wav');
    // Keyboard focus moves to the step.
    expect(document.activeElement.classList.contains('learn-step-title')).toBe(true);
    const doc = app.active;
    // As Add Range Marker does in the editor.
    const { createMarker, newMarkerName } = await import('../src/model/markers.js');
    doc.apply('Add Range Marker', { ...doc.state, markers: [createMarker({ start: 48000, duration: 48000, name: newMarkerName(doc.state.markers, { range: true }) })] });
    expect(app.learn.current.index).toBe(1);
    expect(doc.state.markers[0].name).toBe('Range 01');
    [...el.querySelectorAll('.learn-run button')].find((b) => b.textContent === 'Stop').click();
    expect(app.learn.current).toBe(null);
    const again = el.querySelector('[data-tutorial="export-ranges"]');
    expect(again.textContent).toContain('1 of 4 steps');
    expect([...again.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Restart', 'Resume']);
    // Resuming reuses the open practice file.
    [...again.querySelectorAll('button')].find((b) => b.textContent === 'Resume').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(app.learn.current.index).toBe(1);
    expect(app.documents.filter((d) => d.name === 'Practice Voice.wav')).toHaveLength(1);
    app.learn.stop();
  });
});

describe('practice audio', () => {
  it('is synthesized with the expected shape: quiet room tone, then speech; clicks; music', async () => {
    const { voiceSamples, clicksSamples, musicSamples, FIRST_CLICK } = await import('../src/learn/media.js');
    const v = voiceSamples(8000, 6);
    expect(v.length).toBe(48000);
    const rms = (a, b) => Math.sqrt(v.subarray(a, b).reduce((s, x) => s + x * x, 0) / (b - a));
    // Room tone in the first second, louder speech after 1.5 s.
    expect(rms(2000, 10000)).toBeLessThan(rms(12000, 30000) / 2);
    const [L] = clicksSamples(8000, 2);
    const at = Math.floor(FIRST_CLICK * 8000);
    expect(Math.abs(L[at] - L[at - 1])).toBeGreaterThan(0.5);
    const [mL, mR] = musicSamples(8000, 2);
    expect(mL.length).toBe(16000);
    expect(mR.some((x) => x !== 0)).toBe(true);
    // Deterministic.
    expect(voiceSamples(8000, 2)).toEqual(voiceSamples(8000, 2));
  });
});
