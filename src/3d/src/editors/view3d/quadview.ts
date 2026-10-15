// Quad View (Ctrl Alt Q): a 3D viewport splits into fixed Top, Front and Right orthographic views
// plus the free user view (top right); toggling again brings back the single viewport.
import { app, registerOperators } from '../../app/app';
import { addKeys } from '../../app/keymap';
import type { Area, Screen } from '../../ui/screen';
import { View3D } from './view3d';

let groupCounter = 0;

function hoveredArea(): Area | null {
  const a = (app.hoverArea ?? app.activeArea) as Area | null;
  return a && a.editor instanceof View3D ? a : null;
}

function enterQuad(area: Area) {
  const screen: Screen = area.screen;
  const main = area.editor as View3D;
  const state = main.serialize();
  // split into a 2×2 grid: [this | B] over [C | D]
  screen.split(area, 'v');
  const bottom = screen.areas[screen.areas.length - 1];
  screen.split(area, 'h');
  const topRight = screen.areas[screen.areas.length - 1];
  screen.split(bottom, 'h');
  const bottomRight = screen.areas[screen.areas.length - 1];
  const group = `quad${Date.now().toString(36)}${groupCounter++}`;
  const setup = (a: Area, role: 'USER' | 'TOP' | 'FRONT' | 'RIGHT') => {
    const v = a.editor as View3D;
    v.nav.load(state.nav);
    Object.assign(v.shading, state.shading);
    Object.assign(v.overlay, state.overlay);
    v.showToolbar = role === 'USER' ? state.toolbar : false;
    v.showSidebar = role === 'USER' ? state.sidebar : false;
    v.quad = { group, role };
    if (role === 'USER') {
      v.cameraView = main.cameraView;
      v.lockCameraToView = main.lockCameraToView;
      v.lockObject = main.lockObject;
      v.lockCursor = main.lockCursor;
      v.clipPlanes = main.clipPlanes;
      v.localView = main.localView;
      return;
    }
    v.lockRotation = true;
    v.cameraView = false;
    v.nav.setAxisView(role);
    v.nav.ortho = true;
  };
  setup(topRight, 'USER');
  setup(area, 'TOP');
  setup(bottom, 'FRONT');
  setup(bottomRight, 'RIGHT');
  for (const a of [area, topRight, bottom, bottomRight]) {
    a.drawHeader();
    a.editor.update(new Set(['doc', 'ui', 'view']));
  }
  app.activeArea = topRight;
  app.hoverArea = topRight;
}

function leaveQuad(area: Area) {
  const screen: Screen = area.screen;
  const group = (area.editor as View3D).quad!.group;
  const members = screen.areas.filter((a) => a.editor instanceof View3D && (a.editor as View3D).quad?.group === group);
  const keep = members.find((a) => (a.editor as View3D).quad!.role === 'USER') ?? area;
  // close the fixed views; the grid collapses back into the user view
  for (const role of ['FRONT', 'RIGHT', 'TOP'] as const) {
    const a = members.find((m) => (m.editor as View3D).quad!.role === role);
    if (a && a !== keep) screen.close(a);
  }
  const v = keep.editor as View3D;
  v.quad = null;
  v.lockRotation = false;
  keep.drawHeader();
  keep.editor.update(new Set(['doc', 'ui', 'view']));
  app.activeArea = keep;
  app.hoverArea = keep;
}

registerOperators([
  {
    idname: 'screen.region_quadview',
    label: 'Toggle Quad View',
    description: 'Split the 3D viewport into fixed top, front and right views plus the free view, or join them again',
    poll: () => !!hoveredArea(),
    exec: () => {
      const a = hoveredArea()!;
      if ((a.editor as View3D).quad) leaveQuad(a);
      else enterQuad(a);
    },
    undo: false,
  },
]);

addKeys('Screen', [{ key: 'Q', ctrl: true, alt: true, op: 'screen.region_quadview' }]);
