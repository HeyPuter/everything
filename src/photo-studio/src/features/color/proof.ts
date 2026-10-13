// Soft proofing (View > Proof Setup / Proof Colors) and the gamut warning.
// Proof colors and the duotone preview are a display-only 3D LUT applied by
// the renderer after compositing; the gamut warning is a CPU mask from the
// composite drawn as an overlay image. Neither changes document pixels or
// exports. Proof settings belong to each open document, like a view option.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { formDialog } from '../../ui/dialog';
import {
  bakeLut3D,
  builtinProfile,
  cachedTransform,
  createProofTransform,
  gamutWarning,
  INTENTS,
  type DuotoneInk,
  type Intent,
  type Profile,
  type Lut3D,
} from '../../color/color-management';
import { colorSettings, docGrayProfile, docProfile, ensureProfile, pickIccFile, profileChoices, profileFromRef, profileName, profileReady } from './profiles';
import { composeLut, duotoneLut } from './convert';
import { compositeRGBA } from '../pixels';
import { mapLut, plateGray, simulateVision, VISION_LABELS, type Plate, type VisionKind } from '../../color/vision';

export type ProofSetup = {
  // "plate" shows one or more inks of the working CMYK separation; "vision"
  // simulates a color vision deficiency (ref is unused); "rgb" shows the
  // document's numbers as they look when read in the RGB profile `ref`
  // (no conversion into it), like an untagged image on that display.
  kind: 'cmyk' | 'custom' | 'monitor' | 'plate' | 'vision' | 'rgb';
  ref: string;
  plate?: Plate | 'cmy';
  vision?: VisionKind;
  intent: Intent;
  bpc: boolean;
  paper: boolean;
  ink: boolean;
};
type ProofState = { setup: ProofSetup; on: boolean; gamut: boolean };
const states = new WeakMap<DocumentSession, ProofState>();
let lastCustom: ProofSetup | undefined;

function workingCmykSetup(): ProofSetup {
  const s = colorSettings();
  return { kind: 'cmyk', ref: s.cmyk, intent: s.intent, bpc: s.bpc, paper: false, ink: false };
}
export function proofState(s: DocumentSession): ProofState {
  let st = states.get(s);
  if (!st) {
    st = { setup: workingCmykSetup(), on: false, gamut: false };
    states.set(s, st);
  }
  return st;
}
export const PLATE_LABELS: Record<Plate | 'cmy', string> = {
  c: 'Working Cyan Plate',
  m: 'Working Magenta Plate',
  y: 'Working Yellow Plate',
  k: 'Working Black Plate',
  cmy: 'Working CMY Plates',
};
export function plateSetup(plate: Plate | 'cmy'): ProofSetup {
  return { ...workingCmykSetup(), kind: 'plate', plate };
}
export function visionSetup(vision: VisionKind): ProofSetup {
  return { ...workingCmykSetup(), kind: 'vision', ref: 'builtin:srgb', vision };
}
/** Preview document numbers read in another RGB profile. */
export function rgbSetup(ref: string): ProofSetup {
  return { ...workingCmykSetup(), kind: 'rgb', ref };
}
export function proofLabel(st: ProofState) {
  if (st.setup.kind === 'monitor') return 'Monitor RGB';
  if (st.setup.kind === 'rgb') return profileName(st.setup.ref);
  if (st.setup.kind === 'plate') return PLATE_LABELS[st.setup.plate ?? 'cmy'];
  if (st.setup.kind === 'vision') return VISION_LABELS[st.setup.vision ?? 'deutan'];
  if (st.setup.kind === 'cmyk') return 'Working CMYK';
  return profileName(st.setup.ref);
}

export const INTENT_LABELS: Record<Intent, string> = {
  perceptual: 'Perceptual',
  saturation: 'Saturation',
  relative: 'Relative Colorimetric',
  absolute: 'Absolute Colorimetric',
};

// ----- Display LUT -----
let appliedKey = '';
let lutCache: { key: string; lut: Lut3D | null } | undefined;
function duotoneInks(doc: PhotoDocument): DuotoneInk[] {
  return (doc.modeData?.inks ?? []).map((i) => ({
    name: i.name,
    color: [1, 3, 5].map((k) => parseInt(i.color.slice(k, k + 2), 16)) as [number, number, number],
    curve: i.curve,
  }));
}
function displayKey(doc: PhotoDocument, st: ProofState) {
  const duo = doc.mode === 'duotone' && doc.modeData?.inks?.length ? JSON.stringify([doc.modeData.inks, doc.modeData.profile]) : '';
  const proof = st.on ? JSON.stringify(st.setup) : '';
  if (!duo && !proof) return '';
  return `${docProfile(doc).key}|${doc.bitsPerChannel ?? 8}|${duo}|${proof}`;
}
export function displayLut(doc: PhotoDocument, st: ProofState): Lut3D | null {
  const key = displayKey(doc, st);
  if (!key) return null;
  if (lutCache?.key === key) return lutCache.lut;
  const dp = docProfile(doc);
  const srgb = builtinProfile('srgb');
  const base = doc.mode === 'duotone' && doc.modeData?.inks?.length ? duotoneLut(dp, docGrayProfile(doc), duotoneInks(doc)) : null;
  let lut: Lut3D;
  if (st.on && st.setup.kind === 'monitor') {
    // Monitor RGB: document numbers sent to the display without conversion.
    lut = base ?? identityLut(17);
  } else if (st.on && st.setup.kind === 'rgb') {
    // The numbers stay; only their interpretation changes.
    const toSrgb = cachedTransform(profileFromRef(st.setup.ref), srgb, 'relative');
    lut = base ? composeLut(base, toSrgb) : bakeLut3D(toSrgb, 33);
  } else if (st.on && st.setup.kind === 'vision') {
    const toSrgb = cachedTransform(dp, srgb, 'relative');
    const kind = st.setup.vision ?? 'deutan';
    lut = mapLut(base ? composeLut(base, toSrgb) : bakeLut3D(toSrgb, 33), (rgb, out) => void simulateVision(kind, rgb, out));
  } else if (st.on && st.setup.kind === 'plate') {
    lut = plateLut(dp, profileFromRef(st.setup.ref), st.setup, base);
  } else if (st.on) {
    const { transform } = createProofTransform(dp, profileFromRef(st.setup.ref), srgb, {
      intent: st.setup.intent,
      bpc: st.setup.bpc,
      simulatePaper: st.setup.paper,
      simulateBlackInk: st.setup.ink,
    });
    lut = base ? composeLut(base, transform) : bakeLut3D(transform, 33);
  } else lut = composeLut(base!, cachedTransform(dp, srgb, 'relative'));
  lutCache = { key, lut };
  return lut;
}
// Separate document colors into the working CMYK inks, then show one ink as
// a gray plate, or the cyan, magenta and yellow inks printed without black.
function plateLut(dp: Profile, cmyk: Profile, setup: ProofSetup, base: Lut3D | null): Lut3D {
  const toInk = cachedTransform(dp, cmyk, setup.intent, { bpc: setup.bpc });
  const plate = setup.plate ?? 'cmy';
  const source = base ?? identityLut(33);
  const total = source.size ** 3;
  const rgb = new Float32Array(total * 3);
  for (let i = 0; i < total; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = source.data[i * 4 + c];
  const ink = new Float32Array(total * 4);
  toInk.apply(rgb, ink, total);
  if (plate === 'cmy') {
    for (let i = 0; i < total; i++) ink[i * 4 + 3] = 0;
    const shown = new Float32Array(total * 3);
    cachedTransform(cmyk, builtinProfile('srgb'), 'relative', { bpc: setup.bpc }).apply(ink, shown, total);
    const data = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) data.set([shown[i * 3], shown[i * 3 + 1], shown[i * 3 + 2], 1], i * 4);
    return { size: source.size, outChannels: 3, data };
  }
  const data = new Float32Array(total * 4);
  for (let i = 0; i < total; i++) {
    const v = plateGray(ink.subarray(i * 4, i * 4 + 4), plate);
    data.set([v, v, v, 1], i * 4);
  }
  return { size: source.size, outChannels: 3, data };
}
function identityLut(n: number): Lut3D {
  const data = new Float32Array(n * n * n * 4);
  for (let b = 0, i = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++, i += 4) data.set([r / (n - 1), g / (n - 1), b / (n - 1), 1], i);
  return { size: n, outChannels: 3, data };
}
/** Force the next sync to push the LUT again (after a temporary preview). */
export function resetDisplay() {
  appliedKey = '\u0000';
}
/** Push the current session's display LUT to the renderer when it changes. */
export function syncDisplay(e: Editor) {
  if (!e.renderer) return;
  const st = proofState(e.session);
  if (st.on && st.setup.kind !== 'monitor' && !profileReady(st.setup.ref)) {
    // Never show the previous proof under the new name while preparing.
    if (appliedKey !== 'preparing') {
      e.renderer.setDisplayLut(null);
      appliedKey = 'preparing';
      e.preview(e.displayDoc);
    }
    void ensureProfile(st.setup.ref).then(() => e.update());
    return;
  }
  const key = displayKey(e.doc, st);
  if (key === appliedKey) return;
  try {
    e.renderer.setDisplayLut(displayLut(e.doc, st));
    appliedKey = key;
  } catch (error) {
    st.on = false;
    appliedKey = '';
    e.renderer.setDisplayLut(null);
    e.message(`Proof colors are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ----- Gamut warning overlay -----
let gamutOverlay: { doc: PhotoDocument; key: string; url: string; width: number; height: number } | undefined;
let gamutTimer = 0;
let gamutJob = 0;
export function gamutOverlaySvg(e: Editor): string {
  const st = proofState(e.session);
  if (!st.gamut || !e.hasDocument) return '';
  const key = gamutKey(e, st);
  if (!gamutOverlay || gamutOverlay.doc !== e.doc || gamutOverlay.key !== key) scheduleGamut(e, key);
  if (!gamutOverlay || gamutOverlay.key !== key || gamutOverlay.width !== e.doc.width || gamutOverlay.height !== e.doc.height) return '';
  return `<image class="gamut-warning-overlay" href="${gamutOverlay.url}" x="0" y="0" width="${gamutOverlay.width}" height="${gamutOverlay.height}" preserveAspectRatio="none" style="image-rendering:pixelated;pointer-events:none"/>`;
}
function gamutKey(e: Editor, st: ProofState) {
  const s = colorSettings();
  return `${st.setup.ref}|${docProfile(e.doc).key}|${s.gamutColor}|${s.gamutOpacity}`;
}
function scheduleGamut(e: Editor, key: string) {
  clearTimeout(gamutTimer);
  gamutTimer = window.setTimeout(async () => {
    const job = ++gamutJob;
    const doc = e.doc;
    const st = proofState(e.session);
    try {
      await ensureProfile(st.setup.ref);
      const img = await compositeRGBA(e, doc);
      if (job !== gamutJob || !st.gamut) return;
      const mask = gamutWarning(img, docProfile(doc), profileFromRef(st.setup.ref));
      const { gamutColor, gamutOpacity } = gamutAppearance();
      const [r, g, b] = [1, 3, 5].map((k) => parseInt(gamutColor.slice(k, k + 2), 16));
      const a = Math.round((gamutOpacity / 100) * 255);
      const px = new Uint8ClampedArray(img.width * img.height * 4);
      for (let p = 0, i = 0; p < mask.data.length; p++, i += 4)
        if (mask.data[p]) {
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
          px[i + 3] = a;
        }
      const canvas = new OffscreenCanvas(img.width, img.height);
      canvas.getContext('2d')!.putImageData(new ImageData(px, img.width, img.height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (job !== gamutJob) return;
      if (gamutOverlay) URL.revokeObjectURL(gamutOverlay.url);
      gamutOverlay = { doc, key, url: URL.createObjectURL(blob), width: img.width, height: img.height };
      e.overlay();
    } catch (error) {
      e.message(`Gamut warning failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 250);
}
export function gamutAppearance() {
  const s = colorSettings();
  return { gamutColor: /^#[0-9a-f]{6}$/i.test(s.gamutColor) ? s.gamutColor : '#808080', gamutOpacity: Math.max(0, Math.min(100, s.gamutOpacity)) };
}

// ----- Commands -----
async function prepare(e: Editor, st: ProofState) {
  if (st.setup.kind === 'monitor' || profileReady(st.setup.ref)) return;
  e.message(`Preparing ${profileName(st.setup.ref)}…`);
  await ensureProfile(st.setup.ref);
}
export async function setProof(e: Editor, setup: ProofSetup, turnOn = true) {
  const st = proofState(e.session);
  st.setup = setup;
  if (turnOn) st.on = true;
  e.update();
  if (st.on) {
    await prepare(e, st);
    e.update();
    e.message(`Proof colors: ${proofLabel(st)}`);
  }
}
export async function toggleProof(e: Editor) {
  const st = proofState(e.session);
  st.on = !st.on;
  e.update();
  if (st.on) await prepare(e, st);
  e.update();
  e.message(st.on ? `Proof colors: ${proofLabel(st)}` : 'Proof colors off');
}
export function toggleGamut(e: Editor) {
  const st = proofState(e.session);
  st.gamut = !st.gamut;
  e.update();
  if (st.gamut) e.message(`Gamut warning for ${proofLabel(st) === 'Working CMYK' ? profileName(st.setup.ref) : proofLabel(st)}`);
}

export async function customProofDialog(e: Editor) {
  const st = proofState(e.session);
  const base = st.setup.kind === 'custom' ? st.setup : (lastCustom ?? workingCmykSetup());
  for (;;) {
    const choices = profileChoices('any');
    const v = await formDialog('Customize Proof Condition', [
      { name: 'ref', label: 'Device to simulate', value: base.ref, type: 'select', options: [...choices, ['load', 'Load profile file…']] },
      { name: 'intent', label: 'Rendering intent', value: base.intent, type: 'select', options: INTENTS.map((i) => [i, INTENT_LABELS[i]]) },
      { name: 'bpc', label: 'Black point compensation', value: base.bpc ? 'yes' : 'no', type: 'checkbox' },
      { name: 'paper', label: 'Simulate paper color', value: base.paper ? 'yes' : 'no', type: 'checkbox' },
      { name: 'ink', label: 'Simulate black ink', value: base.ink ? 'yes' : 'no', type: 'checkbox' },
    ], 'OK', 'Proof colors preview how the document reproduces on another device. Paper color implies black ink.');
    if (!v) return;
    if (v.ref === 'load') {
      const got = await pickIccFile();
      if (got) base.ref = got.ref;
      continue;
    }
    const setup: ProofSetup = { kind: 'custom', ref: v.ref, intent: v.intent as Intent, bpc: v.bpc === 'yes', paper: v.paper === 'yes', ink: v.ink === 'yes' || v.paper === 'yes' };
    lastCustom = setup;
    await setProof(e, setup);
    return;
  }
}

export function proofBadge(s: DocumentSession) {
  const st = states.get(s);
  return st?.on ? `Proof: ${proofLabel(st)}` : '';
}
export { workingCmykSetup };
