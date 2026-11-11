// Effects Rack Apply: the render is asynchronous, so rack settings changed
// while it runs (power, gains, the process range) are kept afterwards.
import { describe, it, expect, vi } from 'vitest';
import { Channel } from '../src/audio/channel.js';
import { AudioFile } from '../src/model/audio-file.js';
import { makeSlot, fitSlots } from '../src/effects/rack.js';
import { fakeApp, filled } from './fx-helpers.js';

let release = null;
vi.mock('../src/engine/offline.js', () => ({
  applyChain: (channels, rate, specs, { start, end }) =>
    new Promise((resolve) => {
      release = () => resolve(channels.map((c) => c.toArray(start, end)));
    }),
}));

const { applyRack, rackFor, setRack } = await import('../src/effects/rack-panel.js');
await import('../src/effects/index.js');

describe('Effects Rack Apply', () => {
  it('keeps rack changes made while it renders', async () => {
    const app = fakeApp();
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 1000,
      channels: [Channel.fromSamples(filled(1000, 0.5))],
    });
    app.active = doc;
    setRack(app, doc, {
      ...rackFor(doc),
      slots: fitSlots([makeSlot('amplify', { left: -6, right: -6 })]),
      process: 'file',
    });
    const done = applyRack(app);
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toBeTypeOf('function');
    // While the render runs: switch the rack off and change the output gain.
    setRack(app, doc, { ...rackFor(doc), power: false, output: -3 });
    release();
    expect(await done).toBe(true);
    const after = rackFor(doc);
    expect(after.slots.some(Boolean)).toBe(false);
    expect(after.power).toBe(false);
    expect(after.output).toBe(-3);
    expect(after.process).toBe('file');
    expect(doc.history.undoLabel).toBe('Effects Rack');
  });
});
