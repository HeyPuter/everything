/**
 * Small RGBA frames of a clip for analysis (color match, flicker): video
 * frames are decoded with Mediabunny's CanvasSink at given source times,
 * photos are drawn once. Frames are { t, data, width, height }.
 */
import { US, FRAME_SLACK } from '../lib/time.js';
import { sourceTimeAt } from '../model/timeline.js';

/** Analysis frame size: `width` pixels across, height from the asset's shape. */
export function analysisSize(asset, width = 96) {
  const w = Math.max(8, Math.round(width));
  const h = Math.max(8, Math.round((w * (asset?.height || 9)) / (asset?.width || 16)));
  return { width: w, height: h };
}

/** Source times (µs) of n frames spread over a clip: the middle of n equal parts. */
export function spreadTimes(clip, n) {
  const count = clip.freeze ? 1 : Math.max(1, n);
  return Array.from({ length: count }, (_, i) => sourceTimeAt(clip, clip.start + Math.round(((i + 0.5) / count) * clip.duration)));
}

/** RGBA frames of a video blob at source times (µs, ascending), one at a time; i is the index into times. */
export async function* rgbaFrames(blob, times, { width = 96, height = 54, signal } = {}) {
  const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This video can not be decoded here.');
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 1 });
    const cv = new OffscreenCanvas(width, height);
    const g = cv.getContext('2d', { willReadFrequently: true });
    let i = 0;
    // The frame shown at each time, as the preview and export pick it (see FRAME_SLACK).
    for await (const wrapped of sink.canvasesAtTimestamps(times.map((t) => t / US + FRAME_SLACK))) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      if (wrapped) {
        g.drawImage(wrapped.canvas, 0, 0, width, height);
        yield { i, t: times[i], data: g.getImageData(0, 0, width, height).data, width, height };
      }
      i++;
    }
  } finally {
    input.dispose();
  }
}

/** A few small frames spread across a video or photo clip. */
export async function clipFrames(blob, clip, asset, { count = 5, width = 96, signal } = {}) {
  const size = analysisSize(asset, width);
  if (clip.type === 'image') {
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(size.width, size.height);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, size.width, size.height);
    bmp.close?.();
    return [{ t: 0, data: g.getImageData(0, 0, size.width, size.height).data, ...size }];
  }
  const out = [];
  for await (const f of rgbaFrames(blob, spreadTimes(clip, count).sort((a, b) => a - b), { ...size, signal })) out.push(f);
  return out;
}
