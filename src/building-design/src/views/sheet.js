/**
 * Sheet view: paper space with the title block and viewports. Viewports
 * are elements ({ kind: 'viewport', viewId: sheet, placedId: view, at })
 * so they select, move and delete like anything else.
 */
import { PlanController } from './plan.js';
import { titleBlock, planViewportGraphics, viewportTitle, sheetSize } from '../core/sheet.js';
import { planContext, PlanBuilder } from '../core/plan.js';
import { renderViewImage } from './snapshot.js';

const IMAGE_DPMM = 6;

export class SheetController extends PlanController {
  constructor(app, view) {
    super(app, view);
    this.images = new Map();
  }

  sync() {
    const sheet = this.view;
    if (!sheet) return;
    const scene = this.scene;
    if (this.syncedVersion === scene.version && this.syncedView === sheet) return;
    const keep = new Set();
    this.grid.clear();
    this.bounds.clear();
    const tb = titleBlock(this.app.doc, sheet);
    this.area = tb.area;
    this.layer.set(`${sheet.id}#tb`, scene.indexOf(`${sheet.id}#tb`), 'grid', tb.builder);
    keep.add(`${sheet.id}#tb`);
    this.modelViewports = [];
    for (const vpEl of this.app.doc.all('viewport')) {
      if (vpEl.viewId !== sheet.id) continue;
      const view = this.app.doc.get(vpEl.placedId);
      if (!view) continue;
      let g;
      let rect;
      if (view.kind === 'plan' || view.kind === 'ceilingPlan') {
        const pc = planContext(this.app.doc, view, scene.walls, scene.rooms);
        const r = planViewportGraphics(scene, view, vpEl, pc);
        g = r.builder;
        rect = r.rect;
        for (const it of r.items) {
          this.layer.set(it.key, scene.indexOf(vpEl.id), it.kind, it.builder);
          keep.add(it.key);
        }
      } else {
        const size = vpEl.size || [180, 120];
        rect = { x0: vpEl.at[0] - size[0] / 2, y0: vpEl.at[1] - size[1] / 2, x1: vpEl.at[0] + size[0] / 2, y1: vpEl.at[1] + size[1] / 2 };
        g = new PlanBuilder();
        g.poly(
          [
            [rect.x0, rect.y0],
            [rect.x1, rect.y0],
            [rect.x1, rect.y1],
            [rect.x0, rect.y1],
          ],
          true,
          1,
          2,
        );
        viewportTitle(g, view, rect, this.app.doc);
        g.pick([
          [rect.x0, rect.y0],
          [rect.x1, rect.y0],
          [rect.x1, rect.y1],
          [rect.x0, rect.y1],
        ]);
        this.modelViewports.push({ el: vpEl, view, rect });
      }
      this.layer.set(vpEl.id, scene.indexOf(vpEl.id), 'detailLine', g);
      keep.add(vpEl.id);
      const b = g.bounds();
      if (b) {
        this.bounds.set(vpEl.id, b);
        this.index(vpEl.id, b);
      }
    }
    for (const el of this.app.doc.items.values()) {
      if (el.viewId !== sheet.id || el.kind === 'viewport') continue;
      const g = scene.planOf(sheet, el, { ...planContext(this.app.doc, { ...sheet, scale: 1 }, scene.walls, scene.rooms), scale: 1, view: sheet });
      if (!g) continue;
      this.layer.set(el.id, scene.indexOf(el.id), el.kind, g);
      keep.add(el.id);
      const b = scene.planBounds(sheet, el.id);
      if (b) {
        this.bounds.set(el.id, b);
        this.index(el.id, b);
      }
    }
    this.layer.retain(keep);
    this.syncedVersion = scene.version;
    this.syncedView = sheet;
    this.featureCache.clear();
    this.imagesDirty = true;
  }

  render(vp) {
    this.sync();
    if (!this.cam) this.zoomExtents(false);
    this.vp.r2.draw(this.layer, this.camera(), vp.theme, { dashScale: 1, spacing: 1.6, thin: this.app.settings.thinLines });
  }

  extents() {
    const { w, h } = sheetSize(this.view);
    return { x0: -10, y0: -10, x1: w + 10, y1: h + 10 };
  }

  zoomExtents(render = true) {
    this.zoomToBox(this.extents(), render);
  }

  /** Images of 3D, elevation and section viewports, rendered when needed. */
  imageFor(m) {
    const key = `${m.el.id}|${this.scene.version}|${m.view === this.app.doc.get(m.view.id)}`;
    const cached = this.images.get(m.el.id);
    if (cached && cached.key === key) return cached.canvas;
    if (this.rendering) return cached?.canvas ?? null;
    // Render after this frame so the main view is not interrupted.
    this.rendering = true;
    setTimeout(() => {
      try {
        const w = (m.rect.x1 - m.rect.x0) * IMAGE_DPMM;
        const h = (m.rect.y1 - m.rect.y0) * IMAGE_DPMM;
        const { canvas } = renderViewImage(this.app, m.view, w, h, { fit: true });
        this.images.set(m.el.id, { key, canvas });
      } catch (err) {
        // Remember the failure so it is not retried on every frame.
        console.warn(err);
        this.images.set(m.el.id, { key, canvas: null });
      }
      this.rendering = false;
      this.vp.requestRender();
    }, 0);
    return cached?.canvas ?? null;
  }

  drawOverlay(ctx, vp) {
    for (const m of this.modelViewports || []) {
      const img = this.imageFor(m);
      if (!img) continue;
      const a = this.modelToScreen([m.rect.x0, m.rect.y1]);
      const b = this.modelToScreen([m.rect.x1, m.rect.y0]);
      ctx.drawImage(img, a.x, a.y, b.x - a.x, b.y - a.y);
    }
    super.drawOverlay(ctx, vp);
  }

  dispose() {
    super.dispose();
    this.images.clear();
  }
}
