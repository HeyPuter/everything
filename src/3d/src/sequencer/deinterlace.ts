// Deinterlacing of movie frames: interlaced video stores two half-frames (fields) on alternating
// lines; blending each line with the average of its neighbours removes the combing.
import { app, registerOperators } from '../app/app';
import { selectedStrips, hasEditor } from './context';

/** Blend every line with the mean of the lines above and below (RGBA8, in place copy). */
export function deinterlaceRows(src: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - 1) * row,
      b = y * row,
      c = Math.min(h - 1, y + 1) * row;
    for (let i = 0; i < row; i++) out[b + i] = (src[b + i] * 2 + src[a + i] + src[c + i] + 2) >> 2;
  }
  return out;
}

let canvas: OffscreenCanvas | null = null;

/** A deinterlaced copy of a frame as RGBA8 (top-down). */
export function deinterlaceFrame(img: CanvasImageSource, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
  if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.clearRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return { data: deinterlaceRows(g.getImageData(0, 0, w, h).data, w, h), width: w, height: h };
}

registerOperators([
  {
    idname: 'sequencer.deinterlace_selected_movies',
    label: 'Deinterlace Movies',
    description: 'Remove the line combing of interlaced footage in the selected movie strips',
    poll: () => hasEditor() && selectedStrips().some((s) => s.type === 'MOVIE'),
    exec: () => {
      let n = 0;
      for (const s of selectedStrips()) if (s.type === 'MOVIE' && !s.use_deinterlace) ((s.use_deinterlace = true), n++);
      if (!n) return 'CANCELLED';
      app.changed('doc');
    },
  },
]);
