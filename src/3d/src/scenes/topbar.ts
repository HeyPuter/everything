// Top bar Scene and View Layer selectors: browse (switch), rename, new (menu of the creation
// types) and delete, like the data-block selectors of the property editor.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { textField } from '../ui/widgets';
import { openMenu, type MenuItem } from '../ui/menu';
import { topbarSceneWidgets } from '../ui/shell';
import { app } from '../app/app';
import { allScenes, renameScene, scenesByName } from './scenes';
import { activeLayerIndex, ensureViewLayers, uniqueLayerName } from './viewlayers';
import { sceneNewMenu, switchScene, switchViewLayer, viewLayerAddMenu } from './ops';
import './scenes.css';

function browseButton(cls: string, iconName: string, tip: string, items: () => MenuItem[], title: string): Child {
  return h(
    'button',
    {
      class: `tbid-browse ${cls}`,
      'data-tip': tip,
      'aria-label': tip.split('\n')[0],
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        const list = items();
        openMenu(list.length > 10 ? [{ search: true }, ...list] : list, e.currentTarget as HTMLElement, { title });
      },
    },
    icon(iconName),
    icon('down_arrow_hlt', 'tiny'),
  );
}

function iconButton(cls: string, iconName: string, tip: string, onDown: (e: PointerEvent) => void, disabled = false): Child {
  return h(
    'button',
    {
      class: { 'tbid-btn': true, [cls]: true, disabled },
      'data-tip': tip,
      'aria-label': tip.split('\n')[0],
      disabled,
      onpointerdown: (e: PointerEvent) => {
        e.preventDefault();
        if (!disabled) onDown(e);
      },
    },
    icon(iconName),
  );
}

function sceneSelector(): Child {
  const doc = app.doc;
  const count = allScenes(doc).length;
  return h(
    'div',
    { class: 'tb-scene tb-id tb-id-scene' },
    browseButton(
      'tbid-scene-browse',
      'scene_data',
      'Scene\nBrowse the scenes of this file and pick the one to show',
      () => scenesByName(app.doc).map((s) => ({ label: s.name, icon: 'scene_data', active: s === app.doc.scene, action: () => switchScene(s.id!) })),
      'Scenes',
    ),
    textField('scene-name', doc.scene.name, (v) => {
      renameScene(app.doc, app.doc.scene, v);
      app.pushUndo('Rename Scene');
      app.changed('doc');
    }, { className: 'tbid-name' }),
    iconButton('tbid-scene-new', 'duplicate', 'New Scene\nAdd a new scene (empty, with copied settings, linked or fully copied)', (e) => openMenu(sceneNewMenu(), e.currentTarget as HTMLElement, { title: 'New Scene' })),
    iconButton('tbid-scene-delete', 'x', count > 1 ? 'Delete Scene\nRemove the active scene' : 'Delete Scene\nThe file needs at least one scene', () => app.run('scene.delete'), count < 2),
  );
}

function viewLayerSelector(): Child {
  const sc = app.doc.scene;
  const layers = ensureViewLayers(sc);
  const act = layers[activeLayerIndex(sc)];
  return h(
    'div',
    { class: 'tb-scene tb-id tb-id-layer' },
    browseButton(
      'tbid-layer-browse',
      'view_layer',
      'View Layer\nBrowse the view layers of the scene and pick the active one',
      () => ensureViewLayers(app.doc.scene).map((l, i) => ({ label: l.name, icon: 'view_layer', active: i === app.doc.scene.active_view_layer, action: () => switchViewLayer(i) })),
      'View Layers',
    ),
    textField('view-layer-name', act.name, (v) => {
      const n = v.trim().slice(0, 63);
      if (!n) return app.changed('ui');
      act.name = uniqueLayerName(app.doc.scene, n, act);
      app.pushUndo('Rename View Layer');
      app.changed('doc');
    }, { className: 'tbid-name' }),
    iconButton('tbid-layer-add', 'duplicate', 'Add View Layer\nAdd a view layer (new, with copied settings, or with every collection disabled)', (e) => openMenu(viewLayerAddMenu(), e.currentTarget as HTMLElement, { title: 'Add View Layer' })),
    iconButton('tbid-layer-remove', 'x', layers.length > 1 ? 'Remove View Layer\nRemove the active view layer' : 'Remove View Layer\nThe scene needs at least one view layer', () => app.run('scene.view_layer_remove'), layers.length < 2),
  );
}

topbarSceneWidgets.push(sceneSelector, viewLayerSelector);
