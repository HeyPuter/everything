// Speaker objects: a sound placed in the scene. During forward playback each speaker plays its
// sound from its start frame, positioned relative to the scene camera (distance attenuation and
// a directional cone along the speaker's -Z axis), with volume and pitch.
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, Matrix4, Quaternion, Vector3 } from 'three';
import { app, onAppReady, registerOperators, type OpContext } from '../app/app';
import { newObject } from '../data/defaults';
import type { ObjectData } from '../data/types';
import { addObjectToScene } from '../ops/object';
import { sceneSyncHooks } from '../render/scene';
import { loadSound, mediaKind, mimeFor } from '../sequencer/media';
import { mixdownSources } from '../sequencer/audio';
import { objectWorldAt } from '../physics/common';
import type { MediaFile } from '../sequencer/types';
import { pickFile } from '../io/native';
import { dataTabDrawers } from '../editors/properties/tabs';
import { h, type Child } from '../ui/h';
import { icon, registerIcons } from '../ui/icons';
import { panel } from '../ui/widgets';
import { bool, num } from '../ui/props';

export interface SpeakerSettings {
  sound: MediaFile | null;
  volume: number;
  pitch: number;
  muted: boolean;
  /** scene frame at which the sound starts */
  frame_start: number;
  distance_reference: number;
  distance_max: number;
  attenuation: number;
  /** full cone angles in radians */
  cone_angle_inner: number;
  cone_angle_outer: number;
  cone_volume_outer: number;
}

export function defaultSpeaker(): SpeakerSettings {
  return {
    sound: null,
    volume: 1,
    pitch: 1,
    muted: false,
    frame_start: 1,
    distance_reference: 1,
    distance_max: 10000,
    attenuation: 1,
    cone_angle_inner: 2 * Math.PI,
    cone_angle_outer: 2 * Math.PI,
    cone_volume_outer: 1,
  };
}

const speakerOf = (ob: ObjectData | null | undefined) => (ob?.type === 'SPEAKER' ? ob.speaker ?? null : null);

registerIcons({
  // a loudspeaker: box with a flaring cone
  outliner_ob_speaker: '<path class="s" d="M2.5 6h3l4-3.5v11l-4-3.5h-3z" fill="none" stroke-width="1.3" stroke-linejoin="round"/><path class="s" d="M11.5 5.5c1 1.4 1 3.6 0 5M13 4c1.8 2.3 1.8 5.7 0 8" fill="none" stroke-width="1.2" stroke-linecap="round"/>',
});

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

registerOperators([
  {
    idname: 'object.speaker_add',
    label: 'Add Speaker',
    description: 'Add a speaker that plays a sound positioned in the scene',
    props: [
      { id: 'align', label: 'Align', type: 'enum', default: 'WORLD', items: [['WORLD', 'World'], ['VIEW', 'View'], ['CURSOR', '3D Cursor']] },
      { id: 'location', label: 'Location', type: 'vec3', default: null, subtype: 'distance' },
      { id: 'rotation', label: 'Rotation', type: 'vec3', default: null, subtype: 'angle' },
    ],
    poll: objectMode,
    exec: (ctx, p) => {
      const ob = newObject('Speaker', 'SPEAKER', null);
      ob.speaker = defaultSpeaker();
      if (p.location === null) p.location = [...ctx.doc.scene.cursor.location];
      if (p.rotation === null) delete p.rotation;
      addObjectToScene(ctx.doc, ob, p);
    },
  },
  {
    idname: 'sound.open',
    label: 'Open Sound',
    description: 'Load a sound file into the active speaker',
    props: [{ id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true }],
    poll: () => !!speakerOf(app.activeObject),
    invoke: () => {
      const ob = app.activeObject!;
      void pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.opus').then(async (file) => {
        if (!file) return;
        if (mediaKind(file.name, file.type) !== 'sound') {
          app.report('ERROR', `${file.name} is not a sound file`);
          return;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!(await loadSound(bytes))) {
          app.report('ERROR', `Cannot decode ${file.name}`);
          return;
        }
        const sp = speakerOf(app.doc.objects[ob.id]);
        if (!sp) return;
        sp.sound = { filepath: file.name, mime: mimeFor(file.name, file.type), bytes };
        app.pushUndo('Open Sound');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'sound.unlink',
    label: 'Unlink Sound',
    description: 'Remove the sound from the active speaker',
    poll: () => !!speakerOf(app.activeObject)?.sound,
    exec: () => {
      speakerOf(app.activeObject)!.sound = null;
    },
  },
]);

// ---------------------------------------------------------------------------
// viewport helper

function speakerGeometry(): BufferGeometry {
  const seg: number[] = [];
  const line = (a: number[], b: number[]) => seg.push(...a, ...b);
  // back plate
  const s = 0.2;
  const plate = [
    [-s, -s, 0],
    [s, -s, 0],
    [s, s, 0],
    [-s, s, 0],
  ];
  for (let i = 0; i < 4; i++) line(plate[i], plate[(i + 1) % 4]);
  // cone opening along -Z
  const r = 0.55,
    z = -0.6,
    n = 16;
  const ring = Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r, z]);
  for (let i = 0; i < n; i++) line(ring[i], ring[(i + 1) % n]);
  for (let i = 0; i < 4; i++) line(plate[i], ring[(i * n) / 4 + n / 8]);
  // box behind the plate
  for (const p of plate) line(p, [p[0], p[1], 0.3]);
  for (let i = 0; i < 4; i++) line([plate[i][0], plate[i][1], 0.3], [plate[(i + 1) % 4][0], plate[(i + 1) % 4][1], 0.3]);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(seg, 3));
  return g;
}

sceneSyncHooks.push((_doc, ev, so) => {
  if (ev.ob.type !== 'SPEAKER' || so.helper) return;
  so.helper = new LineSegments(speakerGeometry(), new LineBasicMaterial({ color: 0x000000 }));
  so.helper.userData.id = ev.id;
  so.helper.matrixAutoUpdate = false;
  so.root.add(so.helper);
});

// ---------------------------------------------------------------------------
// properties

dataTabDrawers.SPEAKER = (o: ObjectData): Child => {
  const sp = speakerOf(o);
  if (!sp) return h('div', { class: 'prop-note' }, 'No speaker data');
  const deg = 180 / Math.PI;
  return [
    panel('sp-sound', 'Sound', () => [
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => app.run('sound.open') }, icon('file_folder'), sp.sound ? sp.sound.filepath : 'Open Sound…'),
        sp.sound ? h('button', { class: 'icon-btn', 'data-tip': 'Unlink sound', onclick: () => app.run('sound.unlink') }, icon('x')) : null,
      ),
      bool(sp, 'muted', 'Mute'),
      num(sp, 'volume', 'Volume', { min: 0, max: 1, slider: true }),
      num(sp, 'pitch', 'Pitch', { min: 0.1, max: 10 }),
      num(sp, 'frame_start', 'Start Frame', { int: true }),
    ]),
    panel('sp-distance', 'Distance', () => [num(sp, 'distance_reference', 'Reference', { unit: 'distance', min: 0 }), num(sp, 'distance_max', 'Maximum', { unit: 'distance', min: 0 }), num(sp, 'attenuation', 'Attenuation', { min: 0, max: 100000 })], { closed: true }),
    panel(
      'sp-cone',
      'Cone',
      () => [
        num(sp, 'cone_angle_outer', 'Angle Outer', { unit: 'angle', min: 0, max: 2 * Math.PI }),
        num(sp, 'cone_angle_inner', 'Inner', { unit: 'angle', min: 0, max: 2 * Math.PI }),
        num(sp, 'cone_volume_outer', 'Volume Outer', { min: 0, max: 1, slider: true }),
        h('div', { class: 'prop-note' }, `Directed along the speaker’s −Z axis (${Math.round(sp.cone_angle_outer * deg)}° outer cone).`),
      ],
      { closed: true },
    ),
  ];
};

// ---------------------------------------------------------------------------
// playback

function configurePanner(panner: PannerNode, sp: SpeakerSettings): PannerNode {
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = Math.max(1e-4, sp.distance_reference);
  panner.maxDistance = Math.max(panner.refDistance, sp.distance_max);
  panner.rolloffFactor = Math.max(0, sp.attenuation);
  panner.coneInnerAngle = (sp.cone_angle_inner * 180) / Math.PI;
  panner.coneOuterAngle = (sp.cone_angle_outer * 180) / Math.PI;
  panner.coneOuterGain = sp.cone_volume_outer;
  return panner;
}

interface Voice {
  id: string;
  src: AudioBufferSourceNode;
  panner: PannerNode;
}

let ctx: AudioContext | null = null;
let voices: Voice[] = [];
let active = false;
let starting = false;
let generation = 0;
let startFrame = 0;
let startTime = 0;

function stopAll() {
  for (const v of voices)
    try {
      v.src.stop();
      v.src.disconnect();
      v.panner.disconnect();
    } catch {
      // already stopped
    }
  voices = [];
  active = false;
  generation++;
}

function speakers(): ObjectData[] {
  return Object.values(app.doc.objects).filter((o) => o.type === 'SPEAKER' && o.speaker?.sound && !o.speaker.muted && app.graph.get(o.id)?.visible !== false);
}

const fpsOf = () => app.doc.scene.render.fps / (app.doc.scene.render.fps_base || 1);

/** Place the listener at the scene camera and every voice at its speaker. */
function updateSpatial() {
  if (!ctx) return;
  const L = ctx.listener;
  const cam = app.doc.scene.camera ? app.graph.get(app.doc.scene.camera) : undefined;
  const m = cam?.world ?? new Matrix4();
  const p = new Vector3(),
    q = new Quaternion(),
    s = new Vector3();
  m.decompose(p, q, s);
  const fwd = new Vector3(0, 0, -1).applyQuaternion(q);
  const up = new Vector3(0, 1, 0).applyQuaternion(q);
  const t = ctx.currentTime;
  if (L.positionX) {
    L.positionX.setValueAtTime(p.x, t);
    L.positionY.setValueAtTime(p.y, t);
    L.positionZ.setValueAtTime(p.z, t);
    L.forwardX.setValueAtTime(fwd.x, t);
    L.forwardY.setValueAtTime(fwd.y, t);
    L.forwardZ.setValueAtTime(fwd.z, t);
    L.upX.setValueAtTime(up.x, t);
    L.upY.setValueAtTime(up.y, t);
    L.upZ.setValueAtTime(up.z, t);
  }
  for (const v of voices) {
    const ev = app.graph.get(v.id);
    if (!ev) continue;
    const sp = new Vector3(),
      sq = new Quaternion();
    ev.world.decompose(sp, sq, new Vector3());
    const dir = new Vector3(0, 0, -1).applyQuaternion(sq);
    v.panner.positionX.setValueAtTime(sp.x, t);
    v.panner.positionY.setValueAtTime(sp.y, t);
    v.panner.positionZ.setValueAtTime(sp.z, t);
    v.panner.orientationX.setValueAtTime(dir.x, t);
    v.panner.orientationY.setValueAtTime(dir.y, t);
    v.panner.orientationZ.setValueAtTime(dir.z, t);
  }
}

async function startAt() {
  stopAll();
  const list = speakers();
  if (!list.length) return;
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const gen = ++generation;
  const bufs = await Promise.all(list.map((o) => loadSound(o.speaker!.sound!.bytes)));
  if (gen !== generation || app.playing !== 'forward') return;
  const fps = fpsOf();
  startFrame = app.doc.scene.frame_current;
  startTime = ctx.currentTime + 0.03;
  list.forEach((o, i) => {
    const buf = bufs[i];
    const sp = o.speaker!;
    if (!buf) return;
    const pitch = Math.max(0.1, sp.pitch);
    // seconds into the sound at the current frame
    const offset = ((startFrame - sp.frame_start) / fps) * pitch;
    if (offset >= buf.duration) return;
    const src = ctx!.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    const gain = ctx!.createGain();
    gain.gain.value = Math.max(0, sp.volume);
    const panner = configurePanner(ctx!.createPanner(), sp);
    src.connect(gain).connect(panner).connect(ctx!.destination);
    const delay = offset < 0 ? -offset / pitch : 0;
    src.start(startTime + delay, Math.max(0, offset));
    voices.push({ id: o.id, src, panner });
  });
  updateSpatial();
  active = true;
}

/** Number of speaker sounds currently scheduled (for diagnostics and tests). */
export function speakerVoiceCount() {
  return voices.length;
}

/** Keep speaker audio in step with forward timeline playback. */
export function syncSpeakers() {
  if (app.playing !== 'forward') {
    if (active || voices.length) stopAll();
    return;
  }
  if (!active) {
    if (!starting && speakers().length) {
      starting = true;
      void startAt().finally(() => (starting = false));
    }
    return;
  }
  const expected = startFrame + (ctx!.currentTime - startTime) * fpsOf();
  // loops and jumps restart the voices
  if (Math.abs(app.doc.scene.frame_current - expected) > Math.max(3, fpsOf() * 0.25)) void startAt();
  else updateSpatial();
}

onAppReady((a) => a.subscribe(() => syncSpeakers()));

// ---------------------------------------------------------------------------
// renders (movie audio and mixdown)

mixdownSources.push({
  active: () => speakers().length > 0,
  schedule: async (off, fps, from, to) => {
    const doc = app.doc;
    const list = speakers();
    const bufs = await Promise.all(list.map((o) => loadSound(o.speaker!.sound!.bytes)));
    const cam = doc.scene.camera ? doc.objects[doc.scene.camera] : undefined;
    // listener and speakers follow their (keyframed) transforms frame by frame
    const step = Math.max(1, Math.round((to - from) / 2000));
    const p = new Vector3(),
      q = new Quaternion(),
      s = new Vector3();
    const L = off.listener;
    for (let f = from; f < to; f += step) {
      const t = (f - from) / fps;
      (cam ? objectWorldAt(doc, cam, f) : new Matrix4()).decompose(p, q, s);
      const fwd = new Vector3(0, 0, -1).applyQuaternion(q),
        up = new Vector3(0, 1, 0).applyQuaternion(q);
      if (L.positionX) {
        L.positionX.setValueAtTime(p.x, t);
        L.positionY.setValueAtTime(p.y, t);
        L.positionZ.setValueAtTime(p.z, t);
        L.forwardX.setValueAtTime(fwd.x, t);
        L.forwardY.setValueAtTime(fwd.y, t);
        L.forwardZ.setValueAtTime(fwd.z, t);
        L.upX.setValueAtTime(up.x, t);
        L.upY.setValueAtTime(up.y, t);
        L.upZ.setValueAtTime(up.z, t);
      }
    }
    list.forEach((o, i) => {
      const buf = bufs[i];
      const sp = o.speaker!;
      if (!buf) return;
      const pitch = Math.max(0.1, sp.pitch);
      const offset = ((from - sp.frame_start) / fps) * pitch;
      if (offset >= buf.duration) return;
      const src = off.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = pitch;
      const gain = off.createGain();
      gain.gain.value = Math.max(0, sp.volume);
      const panner = configurePanner(off.createPanner(), sp);
      for (let f = from; f < to; f += step) {
        const t = (f - from) / fps;
        objectWorldAt(doc, o, f).decompose(p, q, s);
        const dir = new Vector3(0, 0, -1).applyQuaternion(q);
        panner.positionX.setValueAtTime(p.x, t);
        panner.positionY.setValueAtTime(p.y, t);
        panner.positionZ.setValueAtTime(p.z, t);
        panner.orientationX.setValueAtTime(dir.x, t);
        panner.orientationY.setValueAtTime(dir.y, t);
        panner.orientationZ.setValueAtTime(dir.z, t);
      }
      src.connect(gain).connect(panner).connect(off.destination);
      src.start(offset < 0 ? -offset / pitch : 0, Math.max(0, offset));
    });
  },
});
