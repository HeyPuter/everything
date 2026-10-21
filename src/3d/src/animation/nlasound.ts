// NLA sound clips: a speaker's sound placed on its NLA stack. The strip's start is where the
// speaker starts playing (anim/evaluate.ts); its length follows the sound's duration.
import { app, registerOperators, type OpContext } from '../app/app';
import { addKeys } from '../app/keymap';
import type { NlaStrip, ObjectData } from '../data/types';
import { loadSound } from '../sequencer/media';
import { overMain } from './animeditor';
import { NlaEditor } from './nla';
import { newTrack, stripFits, sortStrips } from './actionops';

const nlaEd = (ctx: OpContext) => (ctx.area?.editor instanceof NlaEditor ? ctx.area.editor : null);

/** Speakers with a sound that a sound strip can be added for: the selected ones (or the active). */
function speakers(): ObjectData[] {
  const sel = app.selectedObjects().filter((o) => o.type === 'SPEAKER' && o.speaker?.sound);
  if (sel.length) return sel;
  const a = app.activeObject;
  return a?.type === 'SPEAKER' && a.speaker?.sound ? [a] : [];
}

/** Add a sound strip of `length` frames at `frame` to a speaker (on a free track). */
export function addSoundStrip(ob: ObjectData, frame: number, length: number): NlaStrip {
  ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
  const ad = ob.animation_data;
  const strip: NlaStrip = {
    name: ob.speaker?.sound?.filepath?.split(/[\\\\/]/).pop() || 'Sound',
    type: 'SOUND',
    action: '',
    frame_start: frame,
    frame_end: frame + Math.max(1, length),
    action_frame_start: 0,
    action_frame_end: Math.max(1, length),
    scale: 1,
    repeat: 1,
    blend_type: 'REPLACE',
    blend_in: 0,
    blend_out: 0,
    mute: false,
    select: true,
    extrapolation: 'NOTHING',
  };
  let track = ad.nla_tracks.find((t) => !t.lock && stripFits(t, strip.frame_start, strip.frame_end) && t.strips.every((s) => s.type === 'SOUND'));
  if (!track) {
    track = newTrack(ad, 'SoundTrack');
    ad.nla_tracks.push(track);
  }
  track.strips.push(strip);
  sortStrips(track);
  return strip;
}

registerOperators([
  {
    idname: 'nla.soundclip_add',
    label: 'Add Sound Clip',
    description: 'Add a strip for the sound of the selected speakers at the current frame (the speaker starts playing there)',
    props: [{ id: 'length', label: 'Length', type: 'float', default: 0, hidden: true }],
    poll: (ctx) => !!nlaEd(ctx) && speakers().length > 0,
    invoke: (ctx, p) => {
      if ((p.length as number) > 0) return app.run('nla.soundclip_add', p, { invoke: false, area: ctx.area }) as 'FINISHED';
      const obs = speakers();
      const fps = ctx.doc.scene.render.fps / (ctx.doc.scene.render.fps_base || 1);
      // the strip length follows the sound: decode it first
      void loadSound(obs[0].speaker!.sound!.bytes).then((buf) => {
        const length = buf ? Math.max(1, Math.round(buf.duration * fps)) : 100;
        app.run('nla.soundclip_add', { length }, { invoke: false, area: ctx.area });
      });
      return 'CANCELLED';
    },
    exec: (ctx, p) => {
      const obs = speakers();
      if (!obs.length) return 'CANCELLED';
      for (const ob of obs) addSoundStrip(ob, ctx.doc.scene.frame_current, (p.length as number) || 100);
      nlaEd(ctx)?.refresh();
    },
  },
]);

addKeys('NLA Editor', [{ key: 'K', shift: true, op: 'nla.soundclip_add', when: overMain }]);
