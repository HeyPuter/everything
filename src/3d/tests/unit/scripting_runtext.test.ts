// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newText } from '../../src/data/defaults';
import { setPyodideSource } from '../../src/scripting/python';
import { runText } from '../../src/scripting/textedit';

describe('running a Python text while the runtime loads', () => {
  it('runs it once however often Run Script is pressed while waiting', async () => {
    setApp(new App(startupDocument()));
    let runs = 0;
    let arrive!: () => void;
    const ready = new Promise<void>((r) => (arrive = r));
    const inst = {
      version: 'test',
      runPython: (c: string) => (c.includes('sys.version') ? '3.13' : undefined),
      registerJsModule() {},
      setStdout() {},
      setStderr() {},
      FS: { mkdirTree() {}, writeFile() {} },
      pyimport: () => ({ run_text: () => (runs++, 'null') }),
    };
    setPyodideSource(async () => {
      await ready;
      return { loadPyodide: async () => inst } as never;
    });
    const t = newText('build.py', 'print(1)', 'python');
    app.doc.texts[t.id] = t;
    // nothing seems to happen during the download: the user presses Run Script again
    const pending = [runText(t), runText(t), runText(t)];
    arrive();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(runs).toBe(1);
    // once loaded, each press runs it
    await runText(t);
    expect(runs).toBe(2);
  });
});
