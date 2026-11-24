// The live app as the assistant's host: its document, the geometry of the
// last rebuild, the selection, the view and the drawing.

import type { AssistantHost, AssistantUI } from '../assistant/host';
import type { MeasureTarget } from '../kernel/protocol';
import type { Id } from '../model/types';
import { type Vec3, dot, sub } from '../math/vec';
import { VIEWS } from '../render/camera';
import type { App } from './app';

export function appHost(app: App): AssistantHost {
  const ui: AssistantUI = {
    selection: () => [...app.selection.items],
    mode: () => ({ sketch: app.sketchEditor?.sketchId ?? null, panel: app.panel?.title ?? null, drawing: app.inDrawing }),
    setView(o) {
      if (o.style) app.commands.run(`style:${o.style}`);
      if (o.orientation) app.viewport.setView(o.orientation);
      if (o.normalTo) app.viewport.normalTo(o.normalTo);
      if (o.fit && !o.orientation && !o.normalTo) app.viewport.zoomToFit();
    },
    capture(o) {
      const r = app.renderer;
      const cam = r.camera;
      const saved = cam.state();
      const savedStyle = r.displayStyle;
      cam.stopAnimation();
      try {
        if (o.orientation) {
          cam.setState(cam.fitState(app.viewport.modelCenter(), app.viewport.modelRadius(), VIEWS[o.orientation]));
          const b = app.bbox;
          if (b) {
            // Frame the bounding box tightly in this orientation (a bounding sphere leaves flat parts small).
            const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
            let ex = 0, ey = 0;
            for (let i = 0; i < 8; i++) {
              const p: Vec3 = [i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]];
              const d = sub(p, c);
              ex = Math.max(ex, Math.abs(dot(d, cam.right)));
              ey = Math.max(ey, Math.abs(dot(d, cam.up)));
            }
            const aspect = cam.width / Math.max(1, cam.height);
            const half = Math.max(ey, ex / aspect, 1e-3) * 1.12;
            cam.setState({ ...cam.state(), target: c, distance: half / Math.tan(cam.fov / 2) });
          }
        }
        if (o.style) r.displayStyle = o.style;
        return r.capture(o.size ?? 1024);
      } finally {
        if (o.orientation) cam.setState(saved);
        r.displayStyle = savedStyle;
        r.requestRender();
      }
    },
    select: (items) => app.selection.set(items),
    showDrawing: (on) => (on ? app.openDrawing() : app.closeDrawing()),
    arrangeDrawing: () => app.drawing.relayout(),
    addDrawingView: (kind) => app.drawing.addView(kind),
    fitDrawingViews(d, oldScale) {
      app.drawing.rescaleViews(d, oldScale);
      app.drawing.keepOnSheet(d);
    },
    runCommand(id) {
      if (!app.commands.get(id) || !app.commands.isEnabled(id)) return false;
      return app.commands.run(id);
    },
  };
  return {
    get store() { return app.store; },
    get faces() { return app.faces; },
    get edges() { return app.edges; },
    get frames() { return app.frames; },
    get bbox() { return app.bbox; },
    featureStatus: (id: Id) => app.featureStatus(id),
    settle: () => app.whenBuilt(),
    massProperties: () => app.kernel.massProperties(),
    measure: (a: MeasureTarget, b: MeasureTarget) => app.kernel.measure(a, b),
    prepareForEdit() {
      // Cancel an open PropertyManager and finish a sketch being edited, without
      // resuming the command that sketch was started for.
      if (app.panel) void app.closePanel(false);
      if (app.sketchEditor) {
        app.pendingAfterSketch = null;
        app.exitSketch(true);
      }
    },
    ui,
  };
}
