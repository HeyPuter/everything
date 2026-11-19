import { describe, it, expect, vi, afterEach } from 'vitest';
import { runScript, scriptPreview, SCRIPT_EXAMPLES, scriptsDialog } from '../src/commands/scripts.js';

afterEach(() => document.querySelectorAll('.dialog-backdrop').forEach((d) => d.remove()));

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

describe('scripts', () => {
  const app = { documents: [{ kind: 'audio', name: 'a.wav' }, { kind: 'session', name: 's' }], commands: { run: async (id, args) => `${id}:${args?.x}` } };

  it('runs async code with the app, run and log', async () => {
    const r = await runScript(app, "log('files', app.documents.length); const out = await run('fx.test', { x: 2 }); log(out); return 'done';");
    expect(r.ok).toBe(true);
    expect(r.output).toEqual(['files 2', 'fx.test:2', 'done']);
  });

  it('reports errors with the output so far', async () => {
    const r = await runScript(app, "log('before'); throw new Error('boom');");
    expect(r.ok).toBe(false);
    expect(r.error.message).toBe('boom');
    expect(r.output).toEqual(['before']);
    expect((await runScript(app, 'this is not javascript')).ok).toBe(false);
  });

  it('previews the start of a script', () => {
    expect(scriptPreview('a\r\nb\nc', 2)).toBe('a\nb\n...');
    expect(scriptPreview('one line')).toBe('one line');
  });

  it('ships examples that compile', () => {
    for (const ex of SCRIPT_EXAMPLES) expect(() => new AsyncFunction('app', 'run', 'log', 'files', 'effect', 'effects', 'exportFile', 'seconds', 'marker', 'wait', ex.code), ex.name).not.toThrow();
  });
});

describe('script API on the real app', () => {
  async function fullApp() {
    HTMLCanvasElement.prototype.getContext = () => null;
    globalThis.ResizeObserver ??= class {
      observe() {}
      disconnect() {}
    };
    localStorage.clear();
    const { App } = await import('../src/app.js');
    const { FEATURES } = await import('../src/features.js');
    const { AudioFile } = await import('../src/model/audio-file.js');
    const app = new App();
    for (const install of FEATURES) install(app);
    app.syncGraph = () => {};
    const doc = app.addDocument(AudioFile.blank({ name: 'Tone.wav', sampleRate: 1000, channels: 1, seconds: 3 }));
    doc.apply('Fill', { ...doc.state, channels: [doc.state.channels[0].constructor.fromSamples(new Float32Array(3000).fill(0.25))] });
    return { app, doc };
  }

  it('applies effects with their defaults filled in, and explains bad ids or settings', async () => {
    const { app, doc } = await fullApp();
    const run = vi.spyOn(app.commands, 'run');
    const r = await runScript(app, "return await effect('amplify', { left: 6 })");
    expect(r.ok).toBe(true);
    expect(run).toHaveBeenCalledWith('fx.amplify', { values: expect.objectContaining({ left: 6, right: 0, linked: true }) });
    expect((await runScript(app, "await effect('nope')")).error.message).toContain('effects() lists them');
    expect((await runScript(app, "await effect('amplify', { gain: 3 })")).error.message).toContain('left, right, linked');
    const list = await runScript(app, "return effects().find((e) => e.id === 'amplify').params.map((p) => p.id)");
    expect(list.output[0]).toBe(JSON.stringify(['left', 'right', 'linked']));
    expect(doc.kind).toBe('audio');
  });

  it('runs the normalize and marker examples', async () => {
    const { app, doc } = await fullApp();
    const norm = SCRIPT_EXAMPLES.find((e) => e.name === 'Normalize every open file');
    expect((await runScript(app, norm.code)).ok).toBe(true);
    expect(doc.state.channels[0].toArray(0, 1)[0]).toBeCloseTo(10 ** (-1 / 20), 4);
    const marks = SCRIPT_EXAMPLES.find((e) => e.name === 'Marker every 30 seconds');
    // A 3-second file at 1 kHz: one marker per second instead, by editing the example.
    const r = await runScript(app, marks.code.replaceAll('seconds(30)', 'seconds(1)'));
    expect(r.ok).toBe(true);
    expect(doc.state.markers.map((m) => m.start)).toEqual([1000, 2000]);
  });

  it('opens a dialog with the examples, runs the editor content and shows its output', async () => {
    const { app } = await fullApp();
    scriptsDialog(app);
    const dlg = document.querySelector('.scripts-dialog');
    expect(document.activeElement.classList.contains('script-editor')).toBe(true);
    expect(dlg.querySelectorAll('.script-example').length).toBe(SCRIPT_EXAMPLES.length);
    dlg.querySelector('.script-example').click();
    const runBtn = [...dlg.querySelectorAll('.script-bar button')].find((b) => b.textContent === 'Run');
    runBtn.click();
    await vi.waitFor(() => expect(dlg.querySelector('.script-output').textContent).toContain('Tone.wav'));
    // Errors show in the output; the draft is kept for next time.
    dlg.querySelector('.script-editor').value = 'throw new Error("nope")';
    runBtn.click();
    await vi.waitFor(() => expect(dlg.querySelector('.script-output').textContent).toBe('Error: nope'));
    expect(app.prefs.get('scriptDraft')).toBe('throw new Error("nope")');
  });
});
