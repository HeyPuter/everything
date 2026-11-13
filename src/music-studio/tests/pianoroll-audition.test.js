import { afterEach, describe, expect, it, vi } from 'vitest';
import { PianoRollEditor } from '../src/pianoroll/editor.js';

function setup() {
  let start, fail;
  const ready = new Promise((resolve, reject) => { start = resolve; fail = reject; });
  const engine = { start: vi.fn(() => ready), noteOn: vi.fn(), noteOff: vi.fn() };
  const editor = {
    app: { engine, reportError: vi.fn() }, channel: { id: 'piano' }, auditioning: [], pressed: new Set(),
    audition: PianoRollEditor.prototype.audition,
    stopAudition: PianoRollEditor.prototype.stopAudition,
  };
  return { editor, engine, start, fail };
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

it('clears a failed timed preview and allows another preview', async () => {
  vi.useFakeTimers();
  const { editor, engine, fail } = setup();
  const error = new Error('Audio device unavailable');
  const pending = editor.audition([60, 64], 0.8, { hold: false });
  fail(error);
  await pending;
  expect(editor.pressed.size).toBe(0);
  expect(editor.auditioning).toEqual([]);
  expect(engine.noteOn).not.toHaveBeenCalled();
  expect(editor.app.reportError).toHaveBeenCalledExactlyOnceWith(error);
  engine.start.mockResolvedValue();
  await editor.audition(67, 0.7, { hold: false });
  expect(engine.noteOn).toHaveBeenCalledExactlyOnceWith('piano', 67, 0.7);
  vi.advanceTimersByTime(220);
  expect(editor.pressed.size).toBe(0);
});

it('ignores a canceled preview failure while a new preview is sounding', async () => {
  const { editor, engine, fail } = setup();
  const pending = editor.audition(60);
  engine.start.mockResolvedValue();
  await editor.audition(64);
  fail(new Error('Obsolete audio startup'));
  await pending;
  expect([...editor.pressed]).toEqual([64]);
  expect(editor.auditioning).toEqual([64]);
  expect(editor.app.reportError).not.toHaveBeenCalled();
  editor.stopAudition();
  expect(engine.noteOff).toHaveBeenLastCalledWith('piano', 64);
});
