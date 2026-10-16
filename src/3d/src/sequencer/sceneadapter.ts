// Scenes as seen by the sequencer: which scenes a Scene strip can show and making new ones. The
// default adapter knows the document's single scene; a document model with several scenes plugs
// in its own adapter with setSceneAdapter() and the operators below use it unchanged.
import { app, registerOperators } from '../app/app';
import type { MenuItem } from '../ui/menu';
import { activeStrip, hasEditor, afterEdit } from './context';
import { insertPoint } from './ops';

export interface SceneAdapter {
  /** scenes a strip can show (by name, which Scene strips store) */
  list(): string[];
  /** make a new scene; `mode`: NEW (empty), EMPTY, LINK_COPY or FULL_COPY of the current scene. Returns its name. */
  create?(mode: 'NEW' | 'EMPTY' | 'LINK_COPY' | 'FULL_COPY'): string | null;
}

let adapter: SceneAdapter = { list: () => [app.doc.scene.name] };

export function setSceneAdapter(a: SceneAdapter) {
  adapter = a;
}
export const sceneAdapter = () => adapter;

const sceneStrip = () => {
  const s = hasEditor() ? activeStrip() : null;
  return s?.type === 'SCENE' ? s : null;
};

export const NEW_SCENE_TYPES: [string, string][] = [
  ['NEW', 'New'],
  ['EMPTY', 'Copy Settings'],
  ['LINK_COPY', 'Linked Copy'],
  ['FULL_COPY', 'Full Copy'],
];

registerOperators([
  {
    idname: 'sequencer.change_scene',
    label: 'Change Scene',
    description: 'Show another scene in the active Scene strip',
    props: [{ id: 'scene', label: 'Scene', type: 'string', default: '' }],
    poll: () => !!sceneStrip() && adapter.list().length > 1,
    exec: (_c, p) => {
      const s = sceneStrip()!;
      const name = String(p.scene ?? '');
      if (!adapter.list().includes(name) || (s.scene ?? app.doc.scene.name) === name) return 'CANCELLED';
      s.scene = name;
      afterEdit();
    },
  },
  {
    idname: 'sequencer.scene_strip_add_new',
    label: 'Add Strip with a New Scene',
    description: 'Make a new scene and add a Scene strip showing it',
    props: [
      { id: 'type', label: 'Type', type: 'enum', default: 'NEW', items: NEW_SCENE_TYPES },
      { id: 'frame_start', label: 'Start Frame', type: 'int', default: 0 },
      { id: 'channel', label: 'Channel', type: 'int', default: 1, min: 1, max: 128 },
    ],
    poll: () => hasEditor() && !!adapter.create,
    invoke: (_c, p) => {
      const [frame, channel] = insertPoint();
      return app.run('sequencer.scene_strip_add_new', { ...p, frame_start: frame, channel }, { invoke: false });
    },
    exec: (_c, p) => {
      const name = adapter.create?.(String(p.type ?? 'NEW') as 'NEW');
      if (!name) return 'CANCELLED';
      const r = app.run('sequencer.scene_strip_add', { frame_start: p.frame_start, channel: p.channel }, { invoke: false });
      if (r !== 'FINISHED') return 'CANCELLED';
      const s = activeStrip();
      if (s?.type === 'SCENE') s.scene = name;
      afterEdit();
    },
  },
]);

/** Add ▸ Scene menu additions: new-scene entries when the document can have several scenes. */
export function newSceneItems(): MenuItem[] {
  if (!adapter.create) return [];
  return [{ separator: true }, ...NEW_SCENE_TYPES.map(([v, l]) => ({ label: `${l} Scene`, op: 'sequencer.scene_strip_add_new', props: { type: v } }))];
}

/** Strip ▸ Change ▸ Scene items for the active Scene strip. */
export function changeSceneItems(): MenuItem[] {
  const s = sceneStrip();
  const list = adapter.list();
  if (!s || list.length < 2) return [];
  return [{ label: 'Scene', submenu: () => list.map((n) => ({ label: n, active: (s.scene ?? app.doc.scene.name) === n, op: 'sequencer.change_scene', props: { scene: n } })) }];
}
