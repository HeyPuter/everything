import { describe, it, expect } from 'vitest';
import { runScript, scriptPreview } from '../src/commands/scripts.js';

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

  it('previews the start of a script before it runs', () => {
    expect(scriptPreview('a\r\nb\nc', 2)).toBe('a\nb\n...');
    expect(scriptPreview('one line')).toBe('one line');
  });
});
