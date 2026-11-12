// Regression tests for the second Waveform editor review: model, edits, commands, view.
import { describe, it, expect } from 'vitest';
import { AudioFile } from '../src/model/audio-file.js';
import { Channel } from '../src/audio/channel.js';
import * as E from '../src/model/edits.js';

const ramp = (n) => Float32Array.from({ length: n }, (_, i) => ((i % 1000) + 1) / 1000);

describe('channel enables', () => {
  it('keeps a channel enabled when undo returns to fewer channels', () => {
    const doc = new AudioFile({
      name: 'a.wav',
      sampleRate: 48000,
      channels: [Channel.fromSamples(ramp(1000))],
    });
    doc.apply('Convert to Stereo', E.convertChannels(doc.state, 2));
    doc.setChannelEnabled(0, false);
    expect(doc.selection.channels).toEqual([false, true]);
    doc.history.undo();
    expect(doc.selection.channels).toEqual([true]);
    expect(doc.channelMask).toBe(null);
    // Edits act on the mono channel again.
    doc.setSelection(0, 10);
    doc.apply('Silence', E.silenceRange(doc.state, 0, 10, doc.channelMask));
    expect(doc.state.channels[0].toArray(0, 10).every((v) => v === 0)).toBe(true);
  });
});
