// Pending effects must smooth the same channels they rendered, even if the
// waveform's channel-enable buttons change before the progress modal appears.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import { fakeApp } from './fx-helpers.js';
import { makeSlot, fitSlots } from '../src/effects/rack.js';
import { applyRack, rackFor, setRack } from '../src/effects/rack-panel.js';
import { applyEffectToDoc } from '../src/effects/commands.js';
import { getEffect } from '../src/effects/index.js';

const pending = vi.hoisted(() => ({ release: null }));
vi.mock('../src/engine/offline.js', () => ({
  applyChain: (channels, rate, specs, { start, end }) => new Promise((resolve) => {
    pending.release = () => resolve(channels.map((c) => c.toArray(start, end).map((x) => x * 2)));
  }),
}));

afterEach(() => document.body.replaceChildren());

describe.each(['effect', 'rack'])('pending %s channel smoothing', (kind) => {
  it.each([false, true])('keeps the original render channels when all channels initially selected is %s', async (all) => {
    const app = fakeApp();
    app.prefs.set('smoothEdits', true);
    app.prefs.set('smoothEditsMs', 4);
    const doc = new AudioFile({ name: 'stereo.wav', sampleRate: 1000, channels: [0, 1].map(() => Channel.fromSamples(new Float32Array(32).fill(0.25))) });
    app.active = doc;
    doc.setSelection(8, 24, { channels: [true, all] });
    const before = doc.state;
    setRack(app, doc, { ...rackFor(doc), slots: fitSlots([makeSlot('amplify', { left: 6, right: 6 })]) });
    pending.release = null;
    const done = kind === 'rack' ? applyRack(app) : applyEffectToDoc(app, doc, getEffect('amplify'), { left: 6, right: 6 });
    await vi.waitFor(() => expect(pending.release).toBeTypeOf('function'), { interval: 1 });
    expect(document.querySelector('.fx-progress-dialog')).toBeNull();
    // These are the actual channel-button handlers: enable R, then disable L.
    doc.setChannelEnabled(1, true);
    doc.setChannelEnabled(0, false);
    expect(doc.channelMask).toEqual([false, true]);
    pending.release();
    expect(await done).toBe(true);
    const left = doc.state.channels[0].toArray();
    expect(left[8]).toBe(0.28125); // 4-frame crossfade: 0.25 + (0.5 - 0.25) / 8
    expect(left[23]).toBe(0.28125);
    expect(left[12]).toBe(0.5);
    expect(left[7]).toBe(0.25);
    expect(left[24]).toBe(0.25);
    if (all) expect(doc.state.channels[1].toArray()).toEqual(left);
    else expect(doc.state.channels[1] === before.channels[1]).toBe(true);
    expect(doc.selection.channels).toEqual([false, true]);
    doc.history.undo();
    expect(doc.state === before).toBe(true);
  });
});
