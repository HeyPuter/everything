// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import { bpy } from '../../src/scripting/api';
import { setPyodideSource } from '../../src/scripting/python';
import { runTool, type AssistantHost } from '../../src/assistant/tools';
import { createAgent } from '../../src/assistant/agent';
import type { StreamPart } from '../../src/assistant/ai';

/** A stand-in Python runtime whose scripts add a cube; it arrives when `arrive` is called. */
function slowPython() {
  let arrive!: () => void;
  const ready = new Promise<void>((r) => (arrive = r));
  const inst = {
    version: 'test',
    runPython: (c: string) => (c.includes('sys.version') ? '3.13' : undefined),
    registerJsModule() {},
    setStdout() {},
    setStderr() {},
    FS: { mkdirTree() {}, writeFile() {} },
    pyimport: () => ({
      run_text: () => {
        (bpy.ops as unknown as { mesh: { primitive_cube_add: () => void } }).mesh.primitive_cube_add();
        return 'null';
      },
    }),
  };
  setPyodideSource(async () => {
    await ready;
    return { loadPyodide: async () => inst } as never;
  });
  return arrive;
}

describe('stopping the assistant', () => {
  it('does not change the scene after Stop while the Python runtime was loading', async () => {
    setApp(new App(startupDocument()));
    const host: AssistantHost = { app };
    const arrive = slowPython();
    const replies: StreamPart[][] = [[{ type: 'tool', id: 'a', name: 'run_script', input: { code: 'add a cube', language: 'python', description: 'Add a cube' } }]];
    const agent = createAgent({
      chat: () => { const r = replies.shift() ?? [{ type: 'text', text: 'done' }]; return (async function* () { yield* r; })(); },
      tools: () => [],
      runTool: (name, args, signal) => runTool(host, name, args, signal),
      system: 'S',
      snapshot: () => '',
      model: () => 'm',
    });
    const objects = () => Object.keys(app.doc.objects).length;
    const before = objects();
    const mark = app.undo.mark();
    let running = false;
    const res = agent.send('add a cube', (e) => { if (e.type === 'step' && e.step.status === 'running') running = true; });
    while (!running) await new Promise((r) => setTimeout(r, 1));
    agent.stop();
    const r = await res;
    expect(r.stopped).toBe(true);
    // What the panel does when the exchange ends: the message's changes become one undo step.
    expect(app.undo.isCurrent(mark)).toBe(true);
    arrive();
    await new Promise((r) => setTimeout(r, 20));
    // The user pressed Stop: the script must not run once the runtime arrives, outside any undo step of the message.
    expect(objects()).toBe(before);
    expect(app.undo.isCurrent(mark)).toBe(true);
  });
});
