/**
 * Off-screen rendering of a view into an image (sheets, PNG and PDF
 * export). Renders into a framebuffer of the shared WebGL context, reads
 * the pixels back and draws the view's text on top.
 */
import { ModelController } from './model.js';
import { PlanController } from './plan.js';
import { drawLayerTexts } from './overlay.js';
import { isFlatView } from '../core/doc.js';

/**
 * Render a view to a canvas of w x h pixels. fit: zoom to extents first.
 * opts.camera: a camera to use instead (copied).
 */
export function renderViewImage(app, view, w, h, { fit = true, camera = null, transparent = false, viewPatch = null } = {}) {
  const vp = app.viewport;
  const gl = vp.gl;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const fake = {
    ...vp,
    gl,
    r2: vp.r2,
    r3: vp.r3,
    state: vp.state,
    theme: vp.theme,
    width: w,
    height: h,
    dpr: 1,
    canvas: { width: w, height: h },
    requestRender() {},
  };
  const isPlan = isFlatView(view);
  const C = isPlan ? PlanController : ModelController;
  const saved = app.viewStates.get(view.id);
  const c = new C(app, view);
  c.vp = fake;
  // Render with some view settings changed (style, shadows), without editing the view.
  if (viewPatch) {
    const patched = { ...app.doc.get(view.id), ...viewPatch };
    Object.defineProperty(c, 'view', { get: () => patched });
  }
  if (camera) c.cam = structuredClone(camera);
  else if (fit || !c.cam) {
    if (view.kind !== 'view3d') c.cam = null;
    if (isPlan) {
      c.sync();
      c.zoomExtents(false);
    } else c.zoomExtents(false, !view.camera);
  }
  // Framebuffer.
  const fb = gl.createFramebuffer();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.viewport(0, 0, w, h);
  const bg = vp.theme.bg;
  gl.clearColor(bg[0], bg[1], bg[2], transparent ? 0 : 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  // Draw without selection highlights.
  const sel = app.selection;
  const hover = app.hoverId;
  const activeId = app.activeViewId;
  app.selection = new Set();
  app.hoverId = null;
  app.activeViewId = view.id;
  app.flagsKey = null;
  app.updateStateFlags();
  let pixels;
  try {
    c.render(fake);
    pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } finally {
    app.selection = sel;
    app.hoverId = hover;
    app.activeViewId = activeId;
    app.flagsKey = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    gl.deleteRenderbuffer(depth);
    if (saved) app.viewStates.set(view.id, saved);
    else app.viewStates.delete(view.id);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  // Flip rows (GL origin is bottom-left).
  for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  ctx.putImageData(img, 0, 0);
  // Text of plan graphics and annotations.
  const layer = isPlan ? c.layer : c.annot;
  if (layer) drawLayerTexts(ctx, layer, (p) => c.modelToScreen(p), c.cam.zoom, vp.theme, () => 0);
  if (isPlan) c.layer.dispose();
  else c.annot?.dispose();
  vp.requestRender();
  return { canvas, controller: c };
}
