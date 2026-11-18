import { it, expect, afterEach, vi } from 'vitest';
import { Library } from '../src/storage/library.js';
import { memoryBackend } from '../src/storage/backends.js';
import { MediaService } from '../src/media/media-service.js';
import { Emitter } from '../src/lib/emitter.js';

vi.mock('../src/media/probe.js', () => ({
  storableFile: async file => file,
  probe: async () => ({ kind: 'video', duration: 2_000_000, width: 320, height: 180, fps: 30, hasAudio: true, hasVideo: true }),
  extOf: () => 'mp4', mediaMime: () => 'video/mp4',
}));
const services = [];
afterEach(() => { services.splice(0).forEach(s => s.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; };
const video = { id: 'video', hash: 'hash', kind: 'video', duration: 2_000_000 };
const pixels = () => ({ close: vi.fn() });
const waveform = () => ({ rate: 100, data: new Float32Array([-.5, .5]), duration: 2 });
function service(library) { const s = new MediaService(library); services.push(s); return s; }
function source() { const lib = new Emitter(); lib.mediaBlob = vi.fn(async () => new Blob(['video'])); return lib; }
function decoder(s) {
  return vi.spyOn(s, '_call').mockImplementation(async (message, partial) => {
    if (message.op === 'peaks') return waveform();
    message.times.forEach((_, index) => partial({ index, bitmap: pixels() }));
  });
}

it.each(['import', 'generated'])('recovers missing posters, waveforms and thumbnails when %s restores a file', async mode => {
  vi.useFakeTimers();
  const backend = memoryBackend(), lib = new Library(backend);
  const file = new File(['recoverable bytes'], 'Video.mp4', { type: 'video/mp4' });
  const original = await lib.importFile(file); await lib.flushUploads();
  backend.files.delete(lib.mediaPath(original)); lib.releaseMedia();
  await lib.missingMedia([original]);
  const s = service(lib); s.missing.add(original.hash); decoder(s);
  expect(await s.poster(original)).toBeNull();
  expect((await s.peaks(original)).data).toHaveLength(0);
  s.thumb(original, 0, 1); await vi.advanceTimersByTimeAsync(16);
  let notifiedPoster;
  s.on('missing', () => { notifiedPoster = s.poster(original); });
  const restored = mode === 'import' ? await lib.importFile(file) : await lib.addMediaBlob({ ...original, id: 'generated' }, file);
  await lib.flushUploads();
  expect(restored.hash).toBe(original.hash);
  expect(s.missing.has(original.hash)).toBe(false);
  expect(await notifiedPoster).toBeTruthy();
  expect(await s.poster(restored)).toBeTruthy();
  expect((await s.peaks(restored)).data).toHaveLength(2);
  s.thumb(restored, 0, 1); await vi.advanceTimersByTimeAsync(16);
  expect(s.thumb(restored, 0, 1)).toBeTruthy();
});

it('retries a pending waveform immediately and ignores its late failed read', async () => {
  vi.useFakeTimers();
  const lib=source(), old=deferred(); lib.mediaBlob.mockImplementationOnce(()=>old.promise);
  const s=service(lib); decoder(s); s.missing.add(video.hash);
  const first=s.peaks(video); await flush();
  lib.emit('media-available', { hash: video.hash });
  const restored=s.peaks(video); await flush();
  expect(lib.mediaBlob).toHaveBeenCalledTimes(2);
  expect((await restored).data).toHaveLength(2);
  const changed=vi.fn();s.on('peaks',changed);
  old.reject(new Error('Old read failed'));await first;
  expect(changed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(s.peaksNow(video).data).toHaveLength(2);
});

it('closes a late discarded poster without replacing the recovered one', async () => {
  const lib=source(), old=deferred(), stale=pixels(), fresh=pixels();
  vi.stubGlobal('createImageBitmap', vi.fn().mockImplementationOnce(()=>old.promise).mockResolvedValue(fresh));
  const s=service(lib), asset={...video,kind:'image'};
  const first=s.poster(asset);await flush();
  lib.emit('media-available',{hash:video.hash});
  const second=s.poster(asset);await flush();
  expect(createImageBitmap).toHaveBeenCalledTimes(2);
  expect(await second).toBe(fresh);
  old.resolve(stale);expect(await first).toBeNull();
  expect(stale.close).toHaveBeenCalledTimes(1);
  expect(fresh.close).not.toHaveBeenCalled();
  expect(s.poster(asset,true)).toBe(fresh);
});

it('frees thumbnail read slots when the restored file replaces two stalled reads', async () => {
  vi.useFakeTimers();
  const lib=source(), a=deferred(), b=deferred();
  lib.mediaBlob.mockImplementationOnce(()=>a.promise).mockImplementationOnce(()=>b.promise);
  const s=service(lib), decode=decoder(s);
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  s.thumb(video,1,1);await vi.advanceTimersByTimeAsync(16);
  expect(s.busy).toBe(2);
  lib.emit('media-available',{hash:video.hash});
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  expect(s.thumb(video,0,1)).toBeTruthy();
  a.resolve(new Blob(['old']));b.reject(new Error('Old read failed'));await flush();
  expect(decode).toHaveBeenCalledTimes(1);
  expect(s.busy).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps successful cached results and unsubscribes on disposal', async () => {
  const lib=source(), s=service(lib), decode=decoder(s);
  const poster=await s.poster(video), peaks=await s.peaks(video);
  const changed=vi.fn();s.on('missing',changed);s.missing.add(video.hash);
  lib.emit('media-available',{hash:video.hash});
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await s.poster(video)).toBe(poster);expect(await s.peaks(video)).toBe(peaks);
  expect(decode).toHaveBeenCalledTimes(2);
  s.dispose();lib.emit('media-available',{hash:video.hash});
  expect(changed).toHaveBeenCalledTimes(1);
  expect(poster.close).toHaveBeenCalledTimes(1);
});

it('closes an obsolete thumbnail decode instead of overwriting a recovered frame', async () => {
  vi.useFakeTimers();
  const lib=source(), s=service(lib), old=deferred();
  let partial;
  const decode=decoder(s);
  decode.mockImplementationOnce((_, callback)=>{partial=callback;return old.promise;});
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  lib.emit('media-available',{hash:video.hash});
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  const fresh=s.thumb(video,0,1), stale=pixels();expect(fresh).toBeTruthy();
  partial({index:0,bitmap:stale});old.resolve();await flush();
  expect(stale.close).toHaveBeenCalledTimes(1);
  expect(s.thumb(video,0,1)).toBe(fresh);
  expect(fresh.close).not.toHaveBeenCalled();
});

it('does not let an old retry remove a new pending thumbnail', async () => {
  vi.useFakeTimers();
  const lib=source(), newRead=deferred();
  lib.mediaBlob.mockRejectedValueOnce(new Error('Offline')).mockImplementationOnce(()=>newRead.promise);
  const s=service(lib);decoder(s);
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  lib.emit('media-available',{hash:video.hash});
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  const changed=vi.fn();s.on('thumb',changed);
  await vi.advanceTimersByTimeAsync(3000);
  expect(changed).not.toHaveBeenCalled();
  s.thumb(video,0,1);await vi.advanceTimersByTimeAsync(16);
  expect(lib.mediaBlob).toHaveBeenCalledTimes(2);
  newRead.resolve(new Blob(['video']));await flush();
  expect(s.thumb(video,0,1)).toBeTruthy();
});
