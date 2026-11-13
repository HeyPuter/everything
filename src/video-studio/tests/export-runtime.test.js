import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, clip } from './helpers.js';
import { addClip } from '../src/model/timeline.js';

const runtime = vi.hoisted(() => ({
  outputs: [], samples: [], addAudio: vi.fn(), audioTrack: vi.fn(),
}));

vi.mock('../src/engine/compositor.js', () => ({
  Compositor: class {
    resize() {}
    render() { return true; }
    dispose() {}
  },
}));
vi.mock('mediabunny', async (original) => {
  const real = await original();
  return {
    ...real,
    canEncodeAudio: async () => true,
    canEncodeVideo: async () => true,
    Input: class {
      getPrimaryAudioTrack() { return runtime.audioTrack(); }
      dispose() {}
    },
    AudioBufferSink: class {
      async *buffers() {
        yield { timestamp: 0, buffer: {
          sampleRate: 48000, numberOfChannels: 1,
          getChannelData: () => new Float32Array(480).fill(0.1),
        } };
      }
    },
    BufferTarget: class { buffer = new ArrayBuffer(1); },
    Output: class {
      state = 'pending';
      constructor() { runtime.outputs.push(this); }
      addVideoTrack() {}
      addAudioTrack() {}
      setMetadataTags() {}
      async start() { this.state = 'started'; }
      async finalize() { this.state = 'finalized'; }
      async cancel() { this.state = 'canceled'; }
    },
    CanvasSource: class { async add() {} close() {} },
    AudioSampleSource: class { add(sample) { return runtime.addAudio(sample); } close() {} },
    AudioSample: class extends real.AudioSample {
      constructor(options) {
        super(options);
        vi.spyOn(this, 'close');
        runtime.samples.push(this);
      }
    },
  };
});

import { exportProject } from '../src/engine/exporter.js';

beforeEach(() => {
  runtime.outputs.length = 0;
  runtime.samples.length = 0;
  runtime.addAudio.mockReset().mockResolvedValue(undefined);
  runtime.audioTrack.mockReset().mockResolvedValue({ sampleRate: 48000, canDecode: async () => true });
});

function projectWithAudio() {
  const p = fixture();
  addClip(p, clip('audio', 0, 0.01));
  return p;
}

const modes = [{ kind: 'audio', audioFormat: 'm4a' }, { kind: 'audio', audioFormat: 'ogg' }, { kind: 'video' }];

describe('export audio failures', () => {
  it.each(modes)('does not silently drop an unreadable source ($kind / $audioFormat)', async ({ kind, ...settings }) => {
    const library = { mediaBlob: vi.fn().mockRejectedValue(new Error('Audio file is offline')) };
    await expect(exportProject(projectWithAudio(), library, settings, { kind })).rejects.toThrow('Audio file is offline');
    expect(runtime.outputs[0].state).toBe('canceled');
  });

  it.each(modes)('reports an undecodable audio track ($kind / $audioFormat)', async ({ kind, ...settings }) => {
    runtime.audioTrack.mockResolvedValue({ canDecode: async () => false });
    const library = { mediaBlob: async () => new Blob(['x']) };
    await expect(exportProject(projectWithAudio(), library, settings, { kind })).rejects.toThrow(/decodable audio/);
    expect(runtime.outputs[0].state).toBe('canceled');
  });
});

describe('successful audio exports', () => {
  it.each(modes)('exports decodable sound ($kind / $audioFormat)', async ({ kind, ...settings }) => {
    const library = { mediaBlob: async () => new Blob(['x']) };
    const result = await exportProject(projectWithAudio(), library, settings, { kind });
    expect(result.kind).toBe(kind);
    expect(runtime.outputs[0].state).toBe('finalized');
    expect(runtime.addAudio).toHaveBeenCalledTimes(1);
    expect(runtime.samples[0].close).toHaveBeenCalledTimes(1);
    await result.release();
  });

  it.each(modes)('does not read intentionally muted sound ($kind / $audioFormat)', async ({ kind, ...settings }) => {
    const p = projectWithAudio();
    p.tracks.find((t) => t.kind === 'audio').muted = true;
    const library = { mediaBlob: vi.fn().mockRejectedValue(new Error('Should not read muted media')) };
    const result = await exportProject(p, library, settings, { kind });
    expect(result.kind).toBe(kind);
    expect(library.mediaBlob).not.toHaveBeenCalled();
    await result.release();
  });
});
