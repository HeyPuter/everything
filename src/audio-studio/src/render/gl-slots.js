// Browsers keep only a few WebGL contexts alive (Chrome: 16) and lose the
// oldest one for good past that. Editor views are cached for every open file,
// each with its renderer, so with many files open the views of earlier files
// came back blank. Past MAX_LIVE renderers, the least recently drawn ones
// whose canvases are out of the page give up their contexts, and ask for them
// back when they draw again (they redraw once the context is restored).
//
// Renderers: { canvas, gl, released } with webglcontextlost / restored handlers
// that call preventDefault() and rebuild their resources.

export const MAX_LIVE = 6;

/** Renderers holding a context, least recently drawn first. */
const live = new Set();

function makeRoom(except) {
  for (const r of live) {
    if (live.size <= MAX_LIVE) return;
    if (r === except || r.canvas.isConnected) continue;
    live.delete(r);
    const ext = r.gl.isContextLost() ? null : r.gl.getExtension('WEBGL_lose_context');
    if (!ext) continue;
    r.released = ext;
    ext.loseContext();
  }
}

/** Registers a renderer that has just created its context. */
export function claimContext(r) {
  live.add(r);
  makeRoom(r);
}

/**
 * Before drawing: asks for a released context back. Returns false while the
 * renderer has to wait for it (it redraws on webglcontextrestored).
 */
export function readyContext(r) {
  live.delete(r);
  live.add(r);
  if (!r.released) return true;
  const ext = r.released;
  r.released = null;
  makeRoom(r);
  ext.restoreContext();
  return false;
}

/** Forgets a disposed renderer. */
export function dropContext(r) {
  live.delete(r);
  r.released = null;
}
