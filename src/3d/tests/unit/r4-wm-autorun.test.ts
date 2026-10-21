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
