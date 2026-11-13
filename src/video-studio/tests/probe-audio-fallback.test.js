import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probe } from '../src/media/probe.js';

const media = vi.hoisted(() => ({ canDecode: false, video: null }));
vi.mock('mediabunny', () => ({
  ALL_FORMATS: [], BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack() { return Promise.resolve(media.video); }
    getPrimaryAudioTrack() { return Promise.resolve({ canDecode: async () => media.canDecode }); }
    computeDuration() { return Promise.resolve(2); }
    dispose() { this.disposed = true; }
  },
}));
let elements;
beforeEach(() => {
  media.canDecode = false;
  media.video = null;
  elements = [];
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((name, ...args) => {
    const el = create(name, ...args);
    if (name === 'audio' || name === 'video') elements.push(el);
    return el;
  });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
const file = () => new File(['audio'], 'voice.webm', { type: 'audio/webm' });

describe('audio-only decoder fallback', () => {
  it('uses the browser audio element if WebCodecs cannot decode the audio', async () => {
    const job = probe(file());
    await vi.waitFor(() => expect(elements).toHaveLength(1), { timeout: 150 });
    expect(elements[0].tagName).toBe('AUDIO');
    Object.defineProperty(elements[0], 'duration', { value: 2 });
    elements[0].dispatchEvent(new Event('loadedmetadata'));
    expect(await job).toMatchObject({ kind: 'audio', hasAudio: true, hasVideo: false, decodable: false, duration: 2_000_000 });
  });

  it('rejects audio that neither decoder can open', async () => {
    const result = probe(file()).then((value) => value, (error) => error);
    await vi.waitFor(() => expect(elements).toHaveLength(1), { timeout: 150 });
    elements[0].dispatchEvent(new Event('error'));
    expect(await result).toBeInstanceOf(Error);
    expect(elements[0].hasAttribute('src')).toBe(false);
  });

  it('keeps the normal decoder path for supported audio', async () => {
    media.canDecode = true;
    expect(await probe(file())).toMatchObject({ kind: 'audio', hasAudio: true, decodable: true });
    expect(elements).toHaveLength(0);
  });

  it('keeps a decodable video when only its audio is unsupported', async () => {
    media.video = { canDecode: async () => true, getDisplayWidth: async () => 320, getDisplayHeight: async () => 180, computePacketStats: async () => ({ averagePacketRate: 24 }) };
    expect(await probe(file())).toMatchObject({ kind: 'video', hasVideo: true, hasAudio: false, soundUnsupported: true, decodable: true });
    expect(elements).toHaveLength(0);
  });
});
