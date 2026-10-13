import { afterEach, describe, expect, it, vi } from 'vitest';
import { allLayers, findLayer, newDocument, type PhotoDocument } from '../src/model/document';
import { History } from '../src/history/history';
import { newPixelLayer } from '../src/model/pixel-layer';
import { Assets } from '../src/model/assets';
import { sourceMimeType } from '../src/model/embedded';
import { deserialize, documentAssetIds, serialize, validateDocument } from '../src/model/serialization';
import { createTimeline, syncTimeline } from '../src/model/video-timeline';
import { footageVideo } from '../src/model/video-layer';
import { contentLength, splitLayers, trimClipStart } from '../src/model/video-timeline-ops';
import {
  audioPlan,
  audioTracks,
  clipSpan,
  dbToGain,
  envelopeAt,
  envelopePoints,
  moveSpan,
  ownTracks,
  snapTime,
  splitAudioClip,
  trimSpanEnd,
  trimSpanStart,
  type AudioClip,
  type AudioSource,
  type PlanItem,
} from '../src/model/audio-timeline';
import { mixPlan, type Pcm } from '../src/imaging/audio/mix';
import { audioPcm, purgeAudioCache } from '../src/features/animation/audio-media';
import { mixDocument } from '../src/features/animation/audio-export';
import type { Editor } from '../src/editor';
import { computePeaks, peakColumns, peakLevelFor, waveformPath } from '../src/imaging/audio/peaks';
import { decodeWav, encodeWav } from '../src/imaging/codecs/wav';
import { ebmlIds, muxWebm, opusHead, opusPreSkip, readEbml, type EbmlNode } from '../src/imaging/codecs/webm';
import { demuxWebm } from '../src/imaging/codecs/webm-demux';

const SR = 1000;
const src = (asset: string, seconds = 10, channels = 1): AudioSource => ({ asset, name: `${asset}.wav`, type: 'audio/wav', seconds, channels, sampleRate: SR });
const clip = (asset: string, start: number, length: number, extra: Partial<AudioClip> = {}): AudioClip => ({ id: crypto.randomUUID(), start, in: 0, length, source: src(asset), ...extra });
/** A constant (DC) source of `value`, or a ramp counting samples. */
const dc = (value: number, seconds = 10): Pcm => ({ sampleRate: SR, channels: [new Float32Array(seconds * SR).fill(value)] });
const ramp = (seconds = 10): Pcm => ({ sampleRate: SR, channels: [Float32Array.from({ length: seconds * SR }, (_, i) => i)] });
function docWith(tracks: { clips: AudioClip[]; volume?: number; muted?: true; solo?: true }[]): PhotoDocument {
  const doc = newDocument(16, 16);
  doc.timeline = createTimeline(10, 10);
  doc.timeline.audio = tracks.map((t, i) => ({ id: `t${i}`, name: `Audio ${i + 1}`, ...t }));
  return doc;
}
const mix = (doc: PhotoDocument, pcm: Record<string, Pcm>, from = 0, to = 4) => mixPlan(audioPlan(doc), (p) => pcm[p.source.asset], from, to, SR);
const close = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps;

describe('audio mix', () => {
  it('places clips at sample-accurate offsets with their trim', () => {
    const doc = docWith([{ clips: [clip('a', 0.5, 1, { in: 0.25 })] }]);
    const [l, r] = mix(doc, { a: ramp() });
    expect(l.length).toBe(4 * SR);
    expect(l[499]).toBe(0);
    // Timeline sample 500 plays source sample 250 (0.25 s into the file).
    expect(l[500]).toBe(250);
    expect(l[1499]).toBe(1249);
    expect(l[1500]).toBe(0);
    // A mono source feeds both channels.
    expect(Array.from(r)).toEqual(Array.from(l));
  });

  it('applies clip gain and track volume in dB', () => {
    const doc = docWith([{ clips: [clip('a', 0, 1, { gain: -6 })], volume: -6 }]);
    const [l] = mix(doc, { a: dc(1) });
    expect(close(l[10], dbToGain(-12))).toBe(true);
    expect(close(dbToGain(-6), 0.501187, 1e-6)).toBe(true);
    expect(dbToGain(-60)).toBe(0);
  });

  it('ramps fades in and out linearly', () => {
    const doc = docWith([{ clips: [clip('a', 1, 2, { fadeIn: 0.5, fadeOut: 1 })] }]);
    const [l] = mix(doc, { a: dc(1) });
    expect(l[1000]).toBe(0);
    expect(close(l[1250], 0.5)).toBe(true);
    expect(close(l[1500], 1)).toBe(true);
    expect(close(l[2000], 1)).toBe(true);
    expect(close(l[2500], 0.5)).toBe(true);
    expect(close(l[2999], 0.001)).toBe(true);
    expect(l[3000]).toBe(0);
    // The plan reports the same envelope.
    const [item] = audioPlan(doc);
    expect(envelopeAt(item, 0.25)).toBeCloseTo(0.5);
    expect(envelopeAt(item, 1.5)).toBeCloseTo(0.5);
    expect(envelopePoints(item)).toEqual([[0, 0], [0.5, 1], [1, 1], [2, 0]]);
  });

  it('sums overlapping clips and tracks', () => {
    const doc = docWith([{ clips: [clip('a', 0, 2), clip('b', 1, 2)] }, { clips: [clip('c', 1.5, 1)] }]);
    const [l] = mix(doc, { a: dc(0.1), b: dc(0.2), c: dc(0.4) });
    expect(close(l[500], 0.1)).toBe(true);
    expect(close(l[1200], 0.3)).toBe(true);
    expect(close(l[1700], 0.7)).toBe(true);
    expect(close(l[2200], 0.6)).toBe(true);
    expect(l[3200]).toBe(0);
  });

  it('silences muted tracks and plays only solo tracks when any is solo', () => {
    const pcm = { a: dc(0.1), b: dc(0.2), c: dc(0.4) };
    const muted = docWith([{ clips: [clip('a', 0, 1)], muted: true }, { clips: [clip('b', 0, 1)] }]);
    expect(close(mix(muted, pcm)[0][100], 0.2)).toBe(true);
    const solo = docWith([{ clips: [clip('a', 0, 1)] }, { clips: [clip('b', 0, 1)], solo: true }, { clips: [clip('c', 0, 1)], solo: true }]);
    expect(close(mix(solo, pcm)[0][100], 0.6)).toBe(true);
    // A muted track stays silent even when solo.
    const both = docWith([{ clips: [clip('a', 0, 1)] }, { clips: [clip('b', 0, 1)], solo: true, muted: true }]);
    expect(mix(both, pcm)[0][100]).toBe(0);
    expect(audioPlan(both)).toEqual([]);
  });

  it('mixes a range starting inside a clip and maps stereo sources channel by channel', () => {
    const stereo: Pcm = { sampleRate: SR, channels: [new Float32Array(5000).fill(0.25), new Float32Array(5000).fill(-0.5)] };
    const doc = docWith([{ clips: [{ ...clip('s', 1, 3), source: src('s', 5, 2) }] }]);
    const [l, r] = mixPlan(audioPlan(doc), () => stereo, 2, 5, SR);
    expect(l.length).toBe(3000);
    expect(l[0]).toBe(0.25);
    expect(r[0]).toBe(-0.5);
    expect(l[1999]).toBe(0.25);
    expect(l[2000]).toBe(0);
  });

  it('resamples sources at another rate and stops at the end of the source', () => {
    const half: Pcm = { sampleRate: SR / 2, channels: [Float32Array.from({ length: 500 }, (_, i) => i)] };
    const items: PlanItem[] = [{ source: src('h'), at: 0, offset: 0, length: 2, gain: 1, fadeIn: 0, fadeOut: 0, clip: 'x' }];
    const [l] = mixPlan(items, () => half, 0, 2, SR);
    expect(l[2]).toBe(1);
    expect(l[3]).toBeCloseTo(1.5);
    // The source holds one second: the rest is silent.
    expect(l[1200]).toBe(0);
  });
});

describe('decoded sound', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    purgeAudioCache();
  });

  it('mixes every source even when they do not fit in the cache together', async () => {
    // A stand-in decoder: each file decodes to a constant that reports 600 MB.
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData(data: ArrayBuffer) {
          const ch = new Float32Array(SR).fill(new Uint8Array(data)[0] / 10);
          Object.defineProperty(ch, 'byteLength', { value: 600 * 2 ** 20 });
          return { sampleRate: SR, numberOfChannels: 1, getChannelData: () => ch };
        }
      },
    );
    const session = { assets: { blob: (asset: string) => new Blob([new Uint8Array([asset === 'a' ? 1 : 2])]) } };
    const e = { session, message() {} } as unknown as Editor;
    const doc = docWith([{ clips: [clip('a', 0, 1)] }, { clips: [clip('b', 0, 1)] }]);
    const [l] = await mixDocument(e, doc, 0, 1);
    // The cache kept only one of them, yet both sound.
    expect([audioPcm(src('a')), audioPcm(src('b'))].filter(Boolean)).toHaveLength(1);
    expect(l[480]).toBeCloseTo(0.3, 5);
  });
});

describe('audio clips', () => {
  it('moves, trims and splits within the source', () => {
    const c = clip('a', 2, 3, { in: 1, fadeIn: 0.5, fadeOut: 0.5 });
    expect(moveSpan(c, -5).start).toBe(0);
    // Extending the start stops at the start of the source.
    expect(trimSpanStart(c, -3, 0.1)).toMatchObject({ start: 1, in: 0, length: 4 });
    const trimmed = trimSpanStart(c, 4, 0.1);
    expect(trimmed.start).toBeCloseTo(4.9);
    expect(trimmed.in).toBeCloseTo(3.9);
    expect(trimmed.length).toBeCloseTo(0.1);
    expect(trimSpanEnd(c, 20, 0.1, 10).length).toBe(9);
    expect(trimSpanEnd(c, -20, 0.1).length).toBe(0.1);
    const [a, b] = splitAudioClip(c, 3)!;
    expect(a).toMatchObject({ start: 2, in: 1, length: 1, fadeIn: 0.5 });
    expect(a.fadeOut).toBeUndefined();
    expect(b).toMatchObject({ start: 3, in: 2, length: 2, fadeOut: 0.5 });
    expect(b.fadeIn).toBeUndefined();
    expect(b.id).not.toBe(c.id);
    expect(splitAudioClip(c, 1)).toBeNull();
    expect(snapTime(1.02, [0, 1, 2], 0.05)).toBe(1);
    expect(snapTime(1.2, [0, 1, 2], 0.05)).toBe(1.2);
  });

  it('shows one default track until tracks are added', () => {
    const tl = createTimeline(10, 1);
    expect(audioTracks(tl)).toMatchObject([{ name: 'Audio 1', clips: [] }]);
    expect(tl.audio).toBeUndefined();
    ownTracks(tl)[0].clips.push(clip('a', 0, 1));
    expect(tl.audio).toHaveLength(1);
  });
});

describe('footage sound', () => {
  function videoDoc(assets?: Assets, asset = 'footage') {
    const doc = newDocument(16, 16);
    const l = newPixelLayer('V', doc);
    l.video = footageVideo({ asset, name: 'v.webm', type: 'video/webm', width: 16, height: 16, frames: 20, fps: 10 });
    l.video.audio = { ...src(asset, 2, 2), name: 'v.webm', type: 'video/webm' };
    doc.layers = [l];
    doc.timeline = createTimeline(10, 3);
    doc.timeline.clips[l.id] = { start: 5, in: 4, length: 20 };
    void assets;
    return { doc, l };
  }
  const history = (doc: PhotoDocument) => {
    const h = new History(doc);
    h.normalize = (d, before) => syncTimeline(d, before);
    return h;
  };

  it('links the sound of new video layers and follows their clips', () => {
    const { doc, l } = videoDoc();
    const plain = structuredClone(doc);
    plain.layers = [];
    const h = history(plain);
    h.execute('Add video', (d) => d.layers.push(structuredClone(l)));
    const linked = h.document.timeline!.audio![0].clips[0];
    expect(linked.link).toBe(l.id);
    // The clip starts at frame 5 (0.5 s), skips 0.4 s and is cut to the 2 s of sound.
    expect(clipSpan(h.document, linked)).toMatchObject({ start: 0.5, in: 0.4, length: 1.6, linked: true, muted: false });
    h.execute('Move', (d) => (d.timeline!.clips[l.id].start = 10));
    expect(clipSpan(h.document, h.document.timeline!.audio![0].clips[0])!.start).toBe(1);
    // Muting the layer silences the clip.
    h.execute('Mute', (d) => (findLayer(d.layers, l.id)!.video!.muted = true));
    expect(audioPlan(h.document)).toEqual([]);
    h.execute('Unmute', (d) => delete findLayer(d.layers, l.id)!.video!.muted);
    expect(audioPlan(h.document)).toHaveLength(1);
    // A copy of the layer (as split makes) gets its own linked clip.
    h.execute('Copy', (d) => d.layers.push({ ...structuredClone(findLayer(d.layers, l.id)!), id: 'copy' }));
    expect(h.document.timeline!.audio![0].clips.map((c) => c.link)).toEqual([l.id, 'copy']);
    // Deleting the clip by hand keeps it deleted; deleting the layer drops its clip.
    h.execute('Delete clip', (d) => (d.timeline!.audio![0].clips = d.timeline!.audio![0].clips.filter((c) => c.link !== 'copy')));
    expect(h.document.timeline!.audio![0].clips).toHaveLength(1);
    h.execute('Delete layer', (d) => (d.layers = d.layers.filter((x) => x.id !== l.id)));
    expect(h.document.timeline!.audio![0].clips).toEqual([]);
    expect(allLayers(h.document.layers).map((x) => x.id)).toEqual(['copy']);
  });

  it('splits linked sound with its video clip, fades included, and never brings back unlinked sound', () => {
    const { doc, l } = videoDoc();
    const plain = structuredClone(doc);
    plain.layers = [];
    const h = history(plain);
    h.execute('Add video', (d) => d.layers.push(structuredClone(l)));
    h.execute('Fades', (d) => Object.assign(d.timeline!.audio![0].clips[0], { gain: -3, fadeIn: 0.3, fadeOut: 0.4 }));
    const pcm = { footage: ramp(2) };
    const heard = (d: PhotoDocument) => mix(d, pcm, 0, 3)[0];
    const whole = heard(h.document);
    expect(whole[700]).toBeGreaterThan(0);
    const same = (a: Float32Array, b: Float32Array) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

    // Split at 1 s: the second part's sound follows its clip with the fade out.
    h.execute('Split', (d) => splitLayers(d, [l.id], 10));
    const copy = allLayers(h.document.layers)[1].id;
    const [a, b] = h.document.timeline!.audio![0].clips;
    expect(a).toMatchObject({ link: l.id, gain: -3, fadeIn: 0.3 });
    expect(a.fadeOut).toBeUndefined();
    expect(b).toMatchObject({ link: copy, gain: -3, fadeOut: 0.4 });
    expect(b.fadeIn).toBeUndefined();
    expect(same(heard(h.document), whole)).toBe(true);
    h.undo();

    // Unlinked sound stays one clip: neither part gets linked sound again.
    h.execute('Unlink', (d) => {
      const s = clipSpan(d, d.timeline!.audio![0].clips[0])!;
      d.timeline!.audio![0].clips = [{ id: 'plain', start: s.start, in: s.in, length: s.length, source: s.source, fadeIn: 0.3, fadeOut: 0.4, gain: -3 }];
    });
    h.execute('Split', (d) => splitLayers(d, [l.id], 10));
    expect(allLayers(h.document.layers)).toHaveLength(2);
    expect(h.document.timeline!.audio![0].clips.map((c) => c.id)).toEqual(['plain']);
    expect(same(heard(h.document), whole)).toBe(true);
    expect(h.document.timeline!.soundless).toBeUndefined();
    h.undo();
    h.undo();

    // Sound deleted by hand stays deleted after a split.
    h.execute('Delete sound', (d) => (d.timeline!.audio![0].clips = []));
    h.execute('Split', (d) => splitLayers(d, [l.id], 10));
    expect(h.document.timeline!.audio![0].clips).toEqual([]);
  });

  it('keeps the sound of looping footage extended before its start at the source start', () => {
    const { doc, l } = videoDoc();
    l.video!.loops = 0;
    // Looping footage trims without a content limit: the start goes 0.3 s before the footage.
    doc.timeline!.clips[l.id] = trimClipStart({ start: 5, in: 0, length: 10 }, -3, contentLength(l, 10));
    expect(doc.timeline!.clips[l.id]).toMatchObject({ start: 2, in: -3, length: 13 });
    ownTracks(doc.timeline!)[0].clips.push({ id: 'k', start: 0, in: 0, length: 0, link: l.id });
    // The sound starts where the footage does, never before its first sample.
    expect(clipSpan(doc, doc.timeline!.audio![0].clips[0])).toMatchObject({ start: 0.5, in: 0, length: 1, linked: true });
    const [item] = audioPlan(doc);
    expect(item).toMatchObject({ at: 0.5, offset: 0, length: 1 });
    const [left] = mixPlan([item], () => ramp(2), 0, 2, SR);
    expect(left[499]).toBe(0);
    expect(left[500]).toBe(0);
    expect(left[501]).toBe(1);
    // Trimmed past the end of the sound: nothing plays.
    doc.timeline!.clips[l.id] = { start: 0, in: -40, length: 30 };
    expect(audioPlan(doc)).toEqual([]);
  });

  it('saves audio clips, tracks and footage sound in projects', async () => {
    const assets = new Assets();
    const footage = await assets.add(new Blob([new Uint8Array([9, 8, 7])], { type: sourceMimeType }));
    const wav = await assets.add(new Blob([encodeWav([new Float32Array([0, 0.5, -0.5])], 8000)], { type: sourceMimeType }));
    const { doc, l } = videoDoc(assets, footage);
    l.video!.muted = true;
    doc.timeline!.audio = [
      { id: 'a1', name: 'Music', volume: -3, solo: true, clips: [{ ...clip(wav, 0.5, 1.5, { gain: 2, fadeIn: 0.25 }), id: 'c1' }, { id: 'c2', start: 0, in: 0, length: 0, link: l.id }] },
      { id: 'a2', name: 'Voice', muted: true, clips: [] },
    ];
    // Shared documents upload the same files a project carries.
    expect(documentAssetIds(doc)).toEqual(expect.arrayContaining([footage, wav]));
    const loaded = await deserialize(await serialize(doc, assets));
    expect(loaded.document.timeline!.audio).toEqual(doc.timeline!.audio);
    expect(loaded.document.layers[0].video!.audio).toEqual(l.video!.audio);
    expect(loaded.document.layers[0].video!.muted).toBe(true);
    expect(new Uint8Array(await loaded.assets.blob(wav).arrayBuffer())).toEqual(encodeWav([new Float32Array([0, 0.5, -0.5])], 8000));
    // Projects without audio still load; bad audio records are refused.
    const old = structuredClone(doc);
    delete old.timeline!.audio;
    expect(() => validateDocument(old)).not.toThrow();
    for (const mutate of [
      (d: PhotoDocument) => (d.timeline!.audio![0].clips[0].gain = 99),
      (d: PhotoDocument) => (d.timeline!.audio![0].clips[0].start = -1),
      (d: PhotoDocument) => (d.timeline!.audio![1].id = 'a1'),
      (d: PhotoDocument) => delete d.timeline!.audio![0].clips[0].source,
      (d: PhotoDocument) => (d.timeline!.audio![0].muted = false as unknown as true),
    ]) {
      const bad = structuredClone(doc);
      mutate(bad);
      expect(() => validateDocument(bad)).toThrow(/audio/);
    }
    const badSound = structuredClone(doc);
    badSound.layers[0].video!.audio!.asset = 'other';
    expect(() => validateDocument(badSound)).toThrow(/video layer/);
  });
});

describe('waveform peaks', () => {
  it('summarizes min and max at several block sizes', () => {
    const n = 64 * 4 * 4 * 40;
    const ch = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 50) * (i < n / 2 ? 0.5 : 1));
    const p = computePeaks([ch, new Float32Array(n)], 1000);
    expect(p.levels.map((l) => l.per)).toEqual([64, 256, 1024, 4096]);
    expect(p.levels[0].min.length).toBe(n / 64);
    expect(p.levels.at(-1)!.min.length).toBeLessThanOrEqual(32 * 4);
    // The second channel (silence) widens every bin to include 0.
    for (const l of p.levels) for (let b = 0; b < l.min.length; b++) expect(l.min[b]).toBeLessThanOrEqual(0);
    expect(peakLevelFor(p, 100).per).toBe(64);
    expect(peakLevelFor(p, 5000).per).toBe(4096);
    const cols = peakColumns(p, 0, n / 1000, 2);
    expect(cols.max[0]).toBeCloseTo(0.5, 2);
    expect(cols.max[1]).toBeCloseTo(1, 2);
    expect(cols.min[1]).toBeCloseTo(-1, 2);
    const path = waveformPath(cols);
    expect(path.startsWith('M0 -0.500L1 -0.500L1 -1.000L2 -1.000L2 1.000L1 1.000L1 0.500L0 0.500Z')).toBe(true);
  });
});

describe('WAV', () => {
  it('writes and reads 16-bit PCM', () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const r = Float32Array.from([0.25, 0, 0, 0, 0]);
    const bytes = encodeWav([l, r], 48000);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(bytes.length).toBe(44 + 5 * 4);
    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(48000);
    expect(back.channels).toHaveLength(2);
    back.channels[0].forEach((v, i) => expect(v).toBeCloseTo(l[i], 3));
    back.channels[1].forEach((v, i) => expect(v).toBeCloseTo(r[i], 3));
  });
});

describe('WebM audio track', () => {
  const find = (nodes: EbmlNode[], id: number) => nodes.find((n) => n.id === id);
  const uintOf = (d: Uint8Array) => d.reduce((v, x) => v * 256 + x, 0);
  it('writes an Opus track beside the video and interleaves blocks in time order', () => {
    const video = [0, 1, 2, 3, 4, 5].map((k) => ({ data: new Uint8Array([k, 1, 1]), timestampMs: k * 100, key: k % 3 === 0 }));
    const audio = Array.from({ length: 30 }, (_, k) => ({ data: new Uint8Array([0xfc, k]), timestampMs: k * 20, key: true }));
    const bytes = muxWebm(video, { width: 8, height: 8, codec: 'V_VP8', frameRate: 10, audio: { codec: 'A_OPUS', sampleRate: 48000, channels: 2, preSkip: 312, frames: audio } });
    const [, segment] = readEbml(bytes);
    const tracks = find(segment.children!, ebmlIds.Tracks)!.children!.filter((n) => n.id === ebmlIds.TrackEntry);
    expect(tracks).toHaveLength(2);
    const a = tracks[1].children!;
    expect(uintOf(find(a, ebmlIds.TrackNumber)!.data)).toBe(2);
    expect(uintOf(find(a, ebmlIds.TrackType)!.data)).toBe(2);
    expect(new TextDecoder().decode(find(a, ebmlIds.CodecID)!.data)).toBe('A_OPUS');
    const head = find(a, ebmlIds.CodecPrivate)!.data;
    expect(new TextDecoder().decode(head.subarray(0, 8))).toBe('OpusHead');
    expect(opusPreSkip(head)).toBe(312);
    expect(uintOf(find(a, ebmlIds.CodecDelay)!.data)).toBe(6_500_000);
    expect(uintOf(find(a, ebmlIds.SeekPreRoll)!.data)).toBe(80_000_000);
    const audioEl = find(a, ebmlIds.Audio)!.children!;
    expect(new DataView(find(audioEl, ebmlIds.SamplingFrequency)!.data.slice().buffer).getFloat64(0)).toBe(48000);
    expect(uintOf(find(audioEl, ebmlIds.Channels)!.data)).toBe(2);
    // Blocks: track number, absolute time and key flag.
    const clusters = segment.children!.filter((n) => n.id === ebmlIds.Cluster);
    const blocks = clusters.flatMap((c) => {
      const t0 = uintOf(find(c.children!, ebmlIds.Timestamp)!.data);
      return c.children!.filter((n) => n.id === ebmlIds.SimpleBlock).map((b) => ({ track: b.data[0] & 0x7f, t: t0 + new DataView(b.data.buffer, b.data.byteOffset + 1, 2).getInt16(0), key: !!(b.data[3] & 0x80), first: b.data[4] }));
    });
    // Clusters start at video key frames only.
    expect(clusters.map((c) => uintOf(find(c.children!, ebmlIds.Timestamp)!.data))).toEqual([0, 300]);
    expect(blocks.filter((b) => b.track === 2).map((b) => b.t)).toEqual(audio.map((f) => f.timestampMs));
    expect(blocks.filter((b) => b.track === 1).map((b) => b.t)).toEqual(video.map((f) => f.timestampMs));
    expect(blocks.every((b) => b.track === 1 || b.key)).toBe(true);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i].t).toBeGreaterThanOrEqual(blocks[i - 1].t);
    // The video reader still finds the video track and only its frames.
    const demuxed = demuxWebm(bytes);
    expect(demuxed.frames.map((f) => f.data[0])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(demuxed.track.codec).toBe('V_VP8');
    // A given identification header is written as it is.
    const given = opusHead(1, 44100, 0);
    const mono = muxWebm(video, { width: 8, height: 8, codec: 'V_VP8', audio: { codec: 'A_OPUS', sampleRate: 48000, channels: 1, codecPrivate: given, frames: audio.slice(0, 2) } });
    expect(Array.from(mono)).toEqual(expect.arrayContaining(Array.from(given)));
  });
});
