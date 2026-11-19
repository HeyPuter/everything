// Develop profiles: starting looks applied under the sliders. A profile is a
// set of offsets to the same settings the panels expose (so it costs nothing
// extra per pixel) scaled by the profile amount; the monochrome profiles
// convert to black and white with their own gray mix. Natural changes
// nothing, so an image opens looking as it is.
import type { ParamValues } from '../../types';
import { developSpec, isMonoProfile, PANELS, panelOn, type PanelId } from './params';

type Look = Record<string, number>;
const LOOKS: Record<string, Look> = {
  natural: {},
  vivid: { contrast: 14, saturation: 16, vibrance: 14, curveShadows: -6, curveHighlights: 4 },
  portrait: {
    contrast: -6,
    vibrance: 6,
    satOrange: -10,
    lumOrange: 8,
    satRed: -6,
    lumRed: 4,
    curveShadows: 4,
    gradeHighlightHue: 40,
    gradeHighlightSat: 6,
  },
  landscape: {
    contrast: 12,
    vibrance: 14,
    satGreen: 14,
    satBlue: 12,
    lumBlue: -8,
    satAqua: 10,
    hueGreen: -8,
    curveHighlights: -6,
    clarity: 6,
  },
  neutral: { contrast: -16, saturation: -8, highlights: -12, shadows: 10, curveShadows: 6 },
  faded: {
    contrast: -12,
    saturation: -18,
    curveShadows: 30,
    curveHighlights: -12,
    gradeShadowHue: 210,
    gradeShadowSat: 10,
    gradeHighlightHue: 45,
    gradeHighlightSat: 8,
  },
  mono: {},
  'mono-contrast': {
    contrast: 30,
    curveShadows: -10,
    curveHighlights: 8,
    grayRed: 25,
    grayOrange: 20,
    grayBlue: -30,
    grayAqua: -15,
  },
  'mono-soft': { contrast: -18, highlights: -15, shadows: 12, grayOrange: 10, grayBlue: 10 },
  'mono-warm': {
    contrast: 6,
    gradeGlobalHue: 34,
    gradeGlobalSat: 14,
    gradeShadowHue: 25,
    gradeShadowSat: 8,
    grayRed: 10,
    grayOrange: 10,
  },
};
// Hue settings are angles, not amounts: the profile sets them as given.
const ANGLES = new Set([
  'gradeShadowHue',
  'gradeMidtoneHue',
  'gradeHighlightHue',
  'gradeGlobalHue',
]);
const panelOf = new Map(PANELS.flatMap((x) => x.keys.map((k) => [k, x.id] as [string, PanelId])));

/** Settings with the panels that are switched off at their defaults and the
 * profile's look added on top. `mono` says whether to render in black and
 * white. */
export function resolveDevelop(p: ParamValues): { params: ParamValues; mono: boolean } {
  const out: ParamValues = { ...p };
  for (const panel of PANELS)
    if (!panelOn(p, panel.id))
      for (const k of panel.keys) {
        const s = developSpec(k);
        if (s) out[k] = Array.isArray(s.default) ? [] : (s.default as ParamValues[string]);
      }
  const profile = typeof p.profile === 'string' ? p.profile : 'natural';
  const look = LOOKS[profile] ?? {};
  const amount = (typeof p.profileAmount === 'number' ? p.profileAmount : 100) / 100;
  for (const [k, v] of Object.entries(look)) {
    const s = developSpec(k);
    if (!s || s.type !== 'number') continue;
    // A look's offsets belong to panels; a switched-off panel drops them too.
    const panel = panelOf.get(k);
    if (panel && !panelOn(p, panel)) continue;
    const cur = typeof out[k] === 'number' ? (out[k] as number) : s.default;
    if (ANGLES.has(k)) {
      // Keep a user's own hue; otherwise use the look's.
      const satKey = k.replace('Hue', 'Sat');
      if (!(typeof p[satKey] === 'number' && (p[satKey] as number) > 0)) out[k] = v;
      continue;
    }
    // Profiles may push a little past a slider's range.
    const span = s.max - s.min;
    out[k] = Math.max(s.min - span / 4, Math.min(s.max + span / 4, cur + v * amount));
  }
  return { params: out, mono: isMonoProfile(profile) };
}
export const profileLook = (id: string): Readonly<Look> => LOOKS[id] ?? {};
