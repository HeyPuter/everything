// Cache files and sounds: reload an Alembic cache from the session's files, open a sound as mono,
// and the sound animation operators scripts call (sound animation is evaluated live here).
import { app, registerOperators } from '../app/app';
import type { ModifierBase } from '../data/types';
import { alembicMeshPaths } from '../eval/mods/meshseq';
import { setSequencePath } from '../editors/properties/modui/meshcache';
import { loadSound, mimeFor } from '../sequencer/media';
import { encodeWav } from '../sequencer/wav';
import { pickFile } from './native';
import { baseOf, vfsFind, vfsRead } from './vfs';

type Rec = ModifierBase & Record<string, unknown>;

/** Re-read a Mesh Sequence Cache modifier's archive from the session files; false when not found. */
export function reloadCache(m: Rec): boolean {
  const path = String(m.filepath ?? '');
  if (!path) return false;
  const bytes = vfsRead(path) ?? vfsFind(baseOf(path))?.bytes ?? null;
  if (!bytes) return false;
  const paths = alembicMeshPaths(bytes);
  if (!paths.length) return false;
  m._abc_bytes = bytes;
  m._abc_paths = paths.map((p) => p.path);
  const keep = String(m.object_path ?? '');
  setSequencePath(m, paths.some((p) => p.path === keep) ? keep : paths[0].path);
  return true;
}

/** Mix an audio buffer's channels down to one. */
export function downmix(channels: Float32Array[]): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  if (!channels.length) return out;
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

registerOperators([
  {
    idname: 'cachefile.reload',
    label: 'Refresh Archive',
    description: "Read the active object's Alembic cache again (from the files of this session, e.g. one a script just wrote)",
    poll: () => !!app.activeObject?.modifiers.some((m) => m.type === 'MESH_SEQUENCE_CACHE'),
    exec: () => {
      const ob = app.activeObject!;
      let n = 0;
      for (const m of ob.modifiers) if (m.type === 'MESH_SEQUENCE_CACHE' && reloadCache(m as Rec)) n++;
      if (!n) {
        app.report('WARNING', 'The cache file is not among the files of this session (open it again with Open Cache File)');
        return 'CANCELLED';
      }
      app.graph.invalidate(ob.id);
      app.report('INFO', `Reloaded ${n} cache file${n === 1 ? '' : 's'}`);
    },
  },
  {
    idname: 'sound.open_mono',
    label: 'Open Sound Mono',
    description: 'Load a sound file into the active speaker, mixed down to a single channel',
    props: [
      { id: 'filepath', label: 'File Path', type: 'string', default: '', hidden: true },
      { id: 'mono', label: 'Mono', type: 'bool', default: true, hidden: true },
    ],
    poll: () => app.activeObject?.type === 'SPEAKER',
    invoke: () => {
      const id = app.activeObject!.id;
      void pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.opus').then(async (file) => {
        if (!file) return;
        const buf = await loadSound(new Uint8Array(await file.arrayBuffer()));
        if (!buf) {
          app.report('ERROR', `Cannot decode ${file.name}`);
          return;
        }
        const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
        const wav = encodeWav([downmix(chans)], buf.sampleRate);
        const ob = app.doc.objects[id];
        if (!ob?.speaker) return;
        ob.speaker.sound = { filepath: file.name.replace(/\.[^.]+$/, '_mono.wav'), mime: mimeFor('x.wav', 'audio/wav'), bytes: wav };
        app.pushUndo('Open Sound Mono');
        app.changed('doc');
      });
      return 'CANCELLED';
    },
  },
  {
    idname: 'sound.bake_animation',
    label: 'Update Animation Cache',
    description: 'Refresh the audio of animated volume and pitch (they are evaluated live, so this only restarts playback audio)',
    undo: false,
    exec: () => {
      app.changed('frame');
    },
  },
  {
    idname: 'sound.update_animation_flags',
    label: 'Update Animation',
    description: 'Refresh which sound settings are animated (they are evaluated live, so this only redraws)',
    undo: false,
    exec: () => {
      app.changed('frame');
    },
  },
]);
