// Final output: F12 / Ctrl F12 render the sequencer when Post Processing ▸ Sequencer is enabled and
// the scene has strips; WebM animations get the mixed-down audio; Render ▸ Render Audio (sound.mixdown)
// writes a WAV file.
import { app, registerOperators } from '../app/app';
import { h } from '../ui/h';
import { panel } from '../ui/widgets';
import { bool } from '../ui/props';
import { propertiesTabs } from '../editors/properties/properties';
import { finalRenderHooks, renderSceneForJob } from '../render/final/job';
import { download } from '../render/final/result';
import { srgbDecode } from '../render/final/colormanage';
import type { RenderSettings } from '../data/types';
import { withCompositor, SequencerRender } from './render';
import { atSceneFrame, displayImage, renderScenePreview } from './scene';
import { mixdown, hasSound } from './audio';
import { encodeWav, type WavFormat } from './wav';
import { createAVWriter } from './webmav';
import { MIX_RATE } from './media';
import { isVisual, allStrips } from './strips';

export function useSequencer(r: RenderSettings) {
  return r.use_sequencer !== false;
}

/** Whether the scene's final render goes through the sequencer. */
export function sequencerActive(): boolean {
  const s = app.doc.scene;
  const ed = s.sequence_editor;
  return !!ed && useSequencer(s.render) && allStrips(ed.strips).some((x) => isVisual(x));
}

// sRGB byte → linear lookup
const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) LUT[i] = srgbDecode(i / 255);

/** Render the sequencer output at `frame` (W×H) as straight sRGB RGBA8. */
export async function renderSequencerRGBA8(frame: number, W: number, H: number, final: boolean): Promise<Uint8ClampedArray> {
  const s = app.doc.scene;
  const ed = s.sequence_editor!;
  return withCompositor(async (comp) => {
    const sr = new SequencerRender(comp, {
      W,
      H,
      k: 1,
      live: false,
      fps: s.render.fps / (s.render.fps_base || 1),
      sceneStart: s.frame_start,
      sceneImage: final
        ? (sf, cam, w, hh) =>
            atSceneFrame(sf, async () => {
              const out = await renderSceneForJob(w, hh, cam);
              return displayImage(out.combined, w, hh);
            })
        : renderScenePreview,
    });
    const t = await sr.render(ed, frame);
    const px = comp.read(t);
    comp.release(t);
    return px;
  });
}

finalRenderHooks.active = sequencerActive;
finalRenderHooks.renderFrame = async (frame, W, H) => {
  const px = await renderSequencerRGBA8(frame, W, H, true);
  const transparent = app.doc.scene.render.film_transparent;
  const n = W * H;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const a = px[k + 3] / 255;
    out[k] = LUT[px[k]] * a;
    out[k + 1] = LUT[px[k + 1]] * a;
    out[k + 2] = LUT[px[k + 2]] * a;
    // without film transparency the result is composited over black
    out[k + 3] = transparent ? a : 1;
  }
  return { combined: out, view: { view_transform: 'STANDARD', exposure: 0, gamma: 1 } };
};
finalRenderHooks.createVideoWriter = async (W, H, fps, frames) => {
  const ed = app.doc.scene.sequence_editor;
  if (!hasSound(ed) || !frames.length) return null;
  // with a frame step the video plays faster than real time: no matching audio
  if (frames.length > 1 && frames[1] - frames[0] !== 1) return null;
  const buf = await mixdown(ed, fps, frames[0], frames[frames.length - 1] + 1, MIX_RATE, 2).catch(() => null);
  if (!buf) return null;
  const w = await createAVWriter(W, H, fps, buf);
  if (!w) app.report('WARNING', 'This browser cannot encode audio: the WebM has no sound (use Render ▸ Render Audio)');
  return w;
};

// ---------------------------------------------------------------------------
// Render Audio

registerOperators([
  {
    idname: 'sound.mixdown',
    label: 'Mixdown',
    description: 'Mix the scene’s audio to a sound file',
    undo: false,
    props: [
      { id: 'container', label: 'Container', type: 'enum', default: 'WAV', items: [['WAV', 'WAV']] },
      { id: 'codec', label: 'Codec', type: 'enum', default: 'PCM', items: [['PCM', 'PCM']] },
      {
        id: 'format',
        label: 'Format',
        type: 'enum',
        default: 'S16',
        items: [
          ['U8', 'U8'],
          ['S16', 'S16'],
          ['S24', 'S24'],
          ['S32', 'S32'],
          ['F32', 'F32'],
        ],
      },
      { id: 'mixrate', label: 'Samplerate', type: 'int', default: MIX_RATE, min: 8000, max: 192000 },
      { id: 'channels', label: 'Channels', type: 'enum', default: 'STEREO', items: [['MONO', 'Mono'], ['STEREO', 'Stereo']] },
      { id: 'filename', label: 'File Name', type: 'string', default: '' },
    ],
    poll: () => hasSound(app.doc.scene.sequence_editor),
    exec: (_c, p) => {
      const s = app.doc.scene;
      const fps = s.render.fps / (s.render.fps_base || 1);
      const ed = s.sequence_editor;
      const name = (p.filename as string) || `${s.name || 'Scene'}.wav`;
      app.report('INFO', 'Mixing down audio…');
      void mixdown(ed, fps, s.frame_start, s.frame_end + 1, p.mixrate as number, p.channels === 'MONO' ? 1 : 2)
        .then((buf) => {
          const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
          download(encodeWav(chans, buf.sampleRate, p.format as WavFormat), name.endsWith('.wav') ? name : `${name}.wav`, 'audio/wav');
          app.report('INFO', `Saved "${name}" (${(buf.duration).toFixed(2)} s)`);
        })
        .catch((e) => app.report('ERROR', `Mixdown failed: ${e instanceof Error ? e.message : String(e)}`));
      return 'CANCELLED';
    },
  },
]);

// ---------------------------------------------------------------------------
// Output properties ▸ Post Processing

const output = propertiesTabs.find((t) => t.id === 'OUTPUT');
if (output) {
  const draw = output.draw;
  output.draw = (p) => [
    draw(p),
    panel('out-post', 'Post Processing', () => [
      void ensureRenderDefaults(),
      h('div', { class: 'sub-label' }, 'Pipeline'),
      bool(app.doc.scene.render as RenderSettings & { use_sequencer: boolean }, 'use_sequencer', 'Sequencer', { tip: 'Process the render result through the Video Sequencer pipeline, if sequencer strips exist' }),
    ]),
  ];
}

/** Defaults for documents created before the sequencer existed. */
export function ensureRenderDefaults() {
  const r = app.doc.scene.render;
  if (r.use_sequencer === undefined) r.use_sequencer = true;
}
