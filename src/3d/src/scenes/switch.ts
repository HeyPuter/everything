// Switching the active scene / view layer from the UI and scripts (undoable, refreshes editors).
import { app } from '../app/app';
import { uiState } from '../app/prefs';
import type { ID } from '../data/types';
import { activateScene, activeSceneId, sceneById } from './scenes';
import { setActiveViewLayer } from './viewlayers';

export const objectMode = () => {
  if (app.doc.mode !== 'OBJECT') app.run('object.mode_set', { mode: 'OBJECT' }, { invoke: false });
  return app.doc.mode === 'OBJECT';
};

/** Everything that depends on the active scene must refresh. */
export function sceneChanged() {
  (uiState as unknown as { activeCollection?: string }).activeCollection = undefined;
  app.changed('doc', 'frame', 'select', 'mode', 'ui');
}

/** Make another scene active (the window's scene). Pushes an undo step. */
export function switchScene(id: ID): boolean {
  if (!sceneById(app.doc, id) || activeSceneId(app.doc) === id) return false;
  if (app.modal) return false;
  if (!objectMode()) return false;
  if (!activateScene(app.doc, id)) return false;
  app.pushUndo('Change Scene');
  sceneChanged();
  return true;
}

/** Make another view layer of the active scene active. Pushes an undo step. */
export function switchViewLayer(index: number): boolean {
  if (app.modal) return false;
  if (!setActiveViewLayer(app.doc, index)) return false;
  app.pushUndo('Change View Layer');
  sceneChanged();
  return true;
}

