import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoRollEditor } from '../src/pianoroll/editor.js';

function setup() {
  let start;
  const ready = new Promise((resolve) => { start = resolve; });
  const engine = { start: vi.fn(() => ready), noteOn: vi.fn(), noteOff: vi.fn() };
  const editor = {
    app: { engine }, channel: { id: 'piano' }, auditioning: [], pressed: new Set(),
    audition: PianoRollEditor.prototype.audition,
    stopAudition: PianoRollEditor.prototype.stopAudition,
  };
  return { editor, engine, start };
}

afterEach(() => vi.useRealTimers());

describe('piano-roll audition startup', () => {
  it('does not attack after the key is released during startup', async () => {
    const { editor, engine, start } = setup();
    const pending = editor.audition(60);
    editor.stopAudition();
    start();
    await pending;
    expect(engine.noteOn).not.toHaveBeenCalled();
    expect(editor.pressed.size).toBe(0);
  });

  it('attacks only once when the same key is released and pressed again during startup', async () => {
    const { editor, engine, start } = setup();
    const first = editor.audition(60);
    editor.stopAudition();
    const second = editor.audition(60, 0.5);
    start();
    await Promise.all([first, second]);
    expect(engine.noteOn.mock.calls).toEqual([['piano', 60, 0.5]]);
    editor.stopAudition();
    expect(engine.noteOff).toHaveBeenLastCalledWith('piano', 60);
  });

  it('discards an old chord when the latest preview contains only its first key', async () => {
    const { editor, engine, start } = setup();
    const first = editor.audition([60, 64, 67]);
    const second = editor.audition(60);
    start();
    await Promise.all([first, second]);
    expect(engine.noteOn.mock.calls).toEqual([['piano', 60, 0.8]]);
    expect([...editor.pressed]).toEqual([60]);
  });

  it('plays and releases an uncanceled timed chord preview', async () => {
    vi.useFakeTimers();
    const { editor, engine, start } = setup();
    const pending = editor.audition([60, 64], 0.7, { hold: false });
    start();
    await pending;
    expect(engine.noteOn.mock.calls).toEqual([['piano', 60, 0.7], ['piano', 64, 0.7]]);
    vi.advanceTimersByTime(220);
    expect(engine.noteOff.mock.calls).toEqual([['piano', 60], ['piano', 64]]);
    expect(editor.pressed.size).toBe(0);
  });
});
