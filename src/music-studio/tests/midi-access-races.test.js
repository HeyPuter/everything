import { it, expect, vi, afterEach } from 'vitest';
import { MidiInput } from '../src/input/midi.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const access = () => ({ inputs: new Map([['keyboard', { onmidimessage: null }]]), onstatechange: null });
afterEach(() => vi.unstubAllGlobals());

it('does not enable MIDI after it was disabled while browser access was pending', async () => {
  const gate = deferred();
  vi.stubGlobal('navigator', { requestMIDIAccess: () => gate.promise });
  const notify = vi.fn();
  const midi = new MidiInput({ notify }, { releaseAll: vi.fn() });
  const enabling = midi.enable();
  midi.disable();
  const result = access();
  gate.resolve(result);
  expect(await enabling).toBe(false);
  expect(midi.access).toBeNull();
  expect(result.inputs.get('keyboard').onmidimessage).toBeNull();
  expect(result.onstatechange).toBeNull();
  expect(notify).not.toHaveBeenCalled();
});

it('keeps a newer access request when an older canceled request finishes later', async () => {
  const gates = [deferred(), deferred()];
  vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn().mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise) });
  const midi = new MidiInput({ notify: vi.fn() }, { releaseAll: vi.fn() });
  const first = midi.enable();
  midi.disable();
  const second = midi.enable();
  const newest = access();
  gates[1].resolve(newest);
  expect(await second).toBe(true);
  gates[0].resolve(access());
  expect(await first).toBe(false);
  expect(midi.access).toBe(newest);
  midi.disable();
  expect(newest.inputs.get('keyboard').onmidimessage).toBeNull();
});
