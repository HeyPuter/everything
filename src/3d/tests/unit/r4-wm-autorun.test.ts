import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/app/app', () => ({ app: {}, onAppReady: () => {} }));
vi.mock('../../src/io/files', () => ({ fileEvents: { opened: [] } }));
vi.mock('../../src/scripting/runner', () => ({ runJavaScript: () => ({ ok: true }), output: { push: () => {} } }));
vi.mock('../../src/scripting/python', () => ({ loadPython: async () => {}, runPythonText: () => ({ ok: true }) }));
vi.mock('../../src/app/prefs', () => ({ prefs: { autoexec_paths: [] } }));

describe('auto run excluded paths', () => {
  it('matches prefixes and wildcards, case-insensitively', async () => {
    const { globMatch } = await import('../../src/prefs/autorun');
    expect(globMatch('downloads', 'Downloads_scene.p3d')).toBe(true);
    expect(globMatch('*.blend', 'scene.blend')).toBe(true);
    expect(globMatch('*.blend', 'scene.p3d')).toBe(false);
    expect(globMatch('shot_??.p3d', 'SHOT_01.p3d')).toBe(true);
    expect(globMatch('a+b(c)', 'a+b(c).p3d')).toBe(true);
  });
});

describe('auto run while the Python runtime loads', () => {
  it('does not run the scripts of a project that was closed while it loaded', async () => {
    vi.resetModules();
    let arrive!: () => void;
    const runtime = new Promise<void>((r) => (arrive = r));
    const ran: string[] = [];
    const app = { doc: { texts: { t1: { id: 't1', name: 'setup.py', body: 'A', language: 'python', use_module: true } } }, filename: 'a.p3d', report: () => {} };
    const fileEvents = { opened: [] as (() => void)[] };
    vi.doMock('../../src/app/app', () => ({ app, onAppReady: () => {} }));
    vi.doMock('../../src/io/files', () => ({ fileEvents }));
    vi.doMock('../../src/scripting/python', () => ({ loadPython: () => runtime, runPythonText: (body: string) => (ran.push(body), { ok: true }) }));
    vi.doMock('../../src/app/prefs', () => ({ prefs: { autoexec_paths: [], use_scripts_auto_execute: true } }));
    const { runRegisteredTexts } = await import('../../src/prefs/autorun');
    const first = runRegisteredTexts();
    // another project is opened during the download
    app.doc = { texts: { t2: { id: 't2', name: 'other.py', body: 'B', language: 'python', use_module: true } } };
    for (const f of fileEvents.opened) f();
    const second = runRegisteredTexts();
    arrive();
    expect(await first).toBe(0);
    expect(await second).toBe(1);
    // project A's script never ran against project B
    expect(ran).toEqual(['B']);
  });
});
