/**
 * Broadcast Studio scenes (original). Wirecast/XSplit-inspired — not those products.
 * Local scene graph only; no LIVE RTMP/encoder (DOCUMENTED).
 */

/** @typedef {{ id:string, kind:'camera'|'screen'|'image'|'text', label:string, x:number, y:number, w:number, h:number, z:number }} Layer */
/** @typedef {{ id:string, name:string, layers:Layer[] }} Scene */
/** @typedef {{ scenes:Scene[], activeId:string, programId:string|null, overlays:Layer[] }} Show */

/** @returns {Show} */
export function createShow() {
  const cam = layer('camera', 'Camera 1', 40, 40, 520, 300, 1);
  const lower = layer('text', 'Lower Third', 60, 300, 400, 48, 5);
  const sceneA = { id: 'scene-a', name: 'Interview', layers: [cam, lower] };
  const sceneB = {
    id: 'scene-b',
    name: 'Screen Share',
    layers: [layer('screen', 'Desktop', 20, 20, 560, 340, 1)],
  };
  return {
    scenes: [sceneA, sceneB],
    activeId: sceneA.id,
    programId: null,
    overlays: [layer('text', 'ON AIR badge', 480, 16, 100, 28, 10)],
  };
}

/** @param {Layer['kind']} kind @param {string} label */
function layer(kind, label, x, y, w, h, z) {
  return {
    id: `${kind}-${Math.abs(hash(label))}`,
    kind,
    label,
    x,
    y,
    w,
    h,
    z,
  };
}

/** @param {string} s */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** @param {Show} show @param {string} sceneId */
export function setPreview(show, sceneId) {
  if (!show.scenes.some((s) => s.id === sceneId)) throw new Error('Unknown scene');
  return { ...show, activeId: sceneId };
}

/** Cut preview to program (DOCUMENTED local switcher — not LIVE stream). */
export function cutToProgram(show) {
  return { ...show, programId: show.activeId };
}

/** @param {Show} show */
export function programScene(show) {
  return show.scenes.find((s) => s.id === show.programId) || null;
}

/** @param {Show} show */
export function previewScene(show) {
  return show.scenes.find((s) => s.id === show.activeId) || null;
}

/** Composite layers for canvas: scene layers + global overlays, sorted by z. */
export function compositeLayers(show, scene) {
  if (!scene) return [...show.overlays].sort((a, b) => a.z - b.z);
  return [...scene.layers, ...show.overlays].sort((a, b) => a.z - b.z);
}

/** @param {Show} show @param {string} sceneId @param {Omit<Layer,'id'>} layerIn */
export function addLayer(show, sceneId, layerIn) {
  const scenes = show.scenes.map((s) => {
    if (s.id !== sceneId) return s;
    const id = `L${s.layers.length + 1}`;
    return { ...s, layers: [...s.layers, { id, ...layerIn }] };
  });
  return { ...show, scenes };
}
