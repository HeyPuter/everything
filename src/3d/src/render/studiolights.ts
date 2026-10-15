// Viewport lighting library: studio lights (up to four view-space lights + ambient) for
// Solid shading, MatCaps (sphere images looked up by the view-space normal) and HDRIs
// (environments for Material Preview and the path tracer's studio lighting). Built-in
// entries are generated in code; Preferences ▸ Lights adds the user's own.
import { CanvasTexture, DataTexture, EquirectangularReflectionMapping, FloatType, LinearFilter, LinearSRGBColorSpace, RGBAFormat, SRGBColorSpace, Vector3, type Texture, type WebGLRenderer, PMREMGenerator } from 'three';

export type Vec3 = [number, number, number];

export interface SolidLight {
  use: boolean;
  /** direction towards the light in view space (x right, y up, z towards the viewer) */
  direction: Vec3;
  diffuse: Vec3;
  specular: Vec3;
  /** 0: sharp terminator and highlight, 1: very soft */
  smooth: number;
}

export interface StudioLightDef {
  id: string;
  name: string;
  builtin?: boolean;
  /** the default look of Solid shading, drawn by the shaders' own formula */
  standard?: boolean;
  ambient: Vec3;
  lights: SolidLight[];
}

export interface MatcapDef {
  id: string;
  name: string;
  builtin?: boolean;
  /** drawn analytically by the shaders (no texture) */
  analytic?: boolean;
  /** user image as a data URL, or a generator for built-ins */
  dataUrl?: string;
  paint?: (nx: number, ny: number, nz: number) => Vec3;
}

export interface HdriDef {
  id: string;
  name: string;
  builtin?: boolean;
  /** 'room' is the neutral studio environment of the viewport */
  kind: 'room' | 'generated' | 'image';
  /** linear radiance for a world direction (Z up) */
  sky?: (d: Vec3) => Vec3;
  /** user image: equirect pixels (linear float RGBA), Z-up image convention */
  pixels?: { width: number; height: number; data: Float32Array };
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const light = (direction: Vec3, diffuse: number | Vec3, specular: number | Vec3, smooth = 0): SolidLight => ({
  use: true,
  direction: norm(direction),
  diffuse: typeof diffuse === 'number' ? [diffuse, diffuse, diffuse] : diffuse,
  specular: typeof specular === 'number' ? [specular, specular, specular] : specular,
  smooth,
});
const off = (): SolidLight => ({ use: false, direction: [0, 0, 1], diffuse: [0, 0, 0], specular: [0, 0, 0], smooth: 0 });

// ---------------------------------------------------------------------------
// built-ins (original setups)

export const BUILTIN_STUDIO_LIGHTS: StudioLightDef[] = [
  { id: 'default', name: 'Default', builtin: true, standard: true, ambient: [0.11, 0.11, 0.11], lights: [light([-0.398, 0.455, 0.796], 0.293, 0.08), off(), off(), off()] },
  { id: 'soft', name: 'Soft Box', builtin: true, ambient: [0.16, 0.16, 0.17], lights: [light([-0.5, 0.6, 0.62], 0.34, 0.05, 0.6), light([0.7, 0.1, 0.7], 0.14, 0.02, 0.8), light([0.0, -0.8, 0.6], 0.06, 0, 1), off()] },
  { id: 'rim', name: 'Rim Light', builtin: true, ambient: [0.08, 0.08, 0.09], lights: [light([-0.45, 0.4, 0.8], 0.28, 0.07), light([0.8, 0.3, -0.52], 0.32, 0.25, 0.1), light([-0.7, -0.2, -0.68], 0.14, 0.1, 0.2), off()] },
  { id: 'top', name: 'Top Down', builtin: true, ambient: [0.1, 0.1, 0.1], lights: [light([0, 0.95, 0.3], 0.38, 0.1, 0.3), light([0, -0.6, 0.8], 0.06, 0, 1), off(), off()] },
  { id: 'warm_cool', name: 'Warm & Cool', builtin: true, ambient: [0.09, 0.09, 0.1], lights: [light([-0.6, 0.45, 0.66], [0.36, 0.27, 0.18], [0.09, 0.07, 0.05], 0.2), light([0.7, 0.2, 0.68], [0.1, 0.15, 0.24], [0.02, 0.03, 0.06], 0.4), off(), off()] },
];

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const KEY = norm([-0.4, 0.6, 0.7]);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const specAt = (n: Vec3, l: Vec3, p: number) => {
  // reflect(-l, n) . (0,0,1)
  const d = dot(n, l);
  const rz = 2 * d * n[2] - l[2];
  return Math.pow(Math.max(0, rz), p);
};

export const BUILTIN_MATCAPS: MatcapDef[] = [
  { id: 'clay', name: 'Clay', builtin: true, analytic: true },
  {
    id: 'ceramic',
    name: 'Ceramic',
    builtin: true,
    paint: (x, y, z) => {
      const n: Vec3 = [x, y, z];
      const d = clamp01(dot(n, KEY));
      const v = 0.32 + 0.6 * d + 0.12 * Math.pow(1 - z, 3);
      const s = specAt(n, KEY, 60) * 0.9;
      return [v * 0.92 + s, v * 0.9 + s, v * 0.86 + s];
    },
  },
  {
    id: 'chrome',
    name: 'Chrome',
    builtin: true,
    paint: (x, y, z) => {
      // mirror of a horizon: bright sky above, dark band, mid ground below
      const ry = 2 * z * y; // y of the reflected view ray
      const sky = clamp01(ry * 1.4);
      const ground = clamp01(-ry * 1.6);
      const band = Math.exp(-Math.pow(ry * 9, 2));
      const v = 0.18 + 0.8 * sky + 0.25 * ground - 0.15 * band;
      const s = specAt([x, y, z], KEY, 120) * 1.2;
      return [v * 0.95 + s, v * 0.97 + s, v + s];
    },
  },
  {
    id: 'jade',
    name: 'Jade',
    builtin: true,
    paint: (x, y, z) => {
      const n: Vec3 = [x, y, z];
      const d = clamp01(dot(n, KEY) * 0.6 + 0.4);
      const rim = Math.pow(1 - z, 2.2);
      const base = mix3([0.05, 0.28, 0.16], [0.35, 0.78, 0.52], d);
      const c = mix3(base, [0.7, 0.95, 0.8], rim * 0.55);
      const s = specAt(n, KEY, 40) * 0.5;
      return [c[0] + s, c[1] + s, c[2] + s];
    },
  },
  {
    id: 'red_wax',
    name: 'Red Wax',
    builtin: true,
    paint: (x, y, z) => {
      const n: Vec3 = [x, y, z];
      const d = clamp01(dot(n, KEY) * 0.7 + 0.3);
      const c = mix3([0.22, 0.02, 0.02], [0.85, 0.18, 0.14], d);
      const s = specAt(n, KEY, 24) * 0.35;
      const rim = Math.pow(1 - z, 3) * 0.25;
      return [c[0] + s + rim, c[1] + s + rim * 0.4, c[2] + s + rim * 0.3];
    },
  },
  {
    id: 'toon',
    name: 'Toon',
    builtin: true,
    paint: (x, y, z) => {
      const n: Vec3 = [x, y, z];
      const d = dot(n, KEY);
      const v = d > 0.55 ? 0.9 : d > 0.1 ? 0.6 : 0.32;
      const outline = z < 0.22 ? 0.15 : 1;
      const s = specAt(n, KEY, 80) > 0.5 ? 0.25 : 0;
      return [(v + s) * outline, (v + s) * outline, (v * 1.04 + s) * outline];
    },
  },
  { id: 'normals', name: 'Normals', builtin: true, paint: (x, y, z) => [x * 0.5 + 0.5, y * 0.5 + 0.5, z * 0.5 + 0.5] },
];

const sunDir = (az: number, el: number): Vec3 => [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];

export const BUILTIN_HDRIS: HdriDef[] = [
  { id: 'studio', name: 'Studio', builtin: true, kind: 'room' },
  {
    id: 'sky',
    name: 'Clear Sky',
    builtin: true,
    kind: 'generated',
    sky: (d) => {
      const up = d[2];
      const s = sunDir(0.6, 0.75);
      const sun = Math.pow(Math.max(0, dot(d, s)), 600) * 60 + Math.pow(Math.max(0, dot(d, s)), 8) * 0.6;
      if (up < 0) return mix3([0.42, 0.4, 0.36], [0.16, 0.15, 0.13], clamp01(-up * 3)).map((c) => c + sun * 0.2) as Vec3;
      const sky = mix3([0.85, 0.9, 1.0], [0.18, 0.38, 0.85], Math.pow(up, 0.5));
      return [sky[0] + sun, sky[1] + sun * 0.95, sky[2] + sun * 0.85];
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    builtin: true,
    kind: 'generated',
    sky: (d) => {
      const up = d[2];
      const s = sunDir(-0.4, 0.05);
      const toward = Math.max(0, dot([d[0], d[1], 0] as Vec3, norm([s[0], s[1], 0])));
      const sun = Math.pow(Math.max(0, dot(d, s)), 900) * 40 + Math.pow(Math.max(0, dot(d, s)), 6) * 0.9;
      if (up < 0) return mix3([0.32, 0.18, 0.1], [0.05, 0.04, 0.05], clamp01(-up * 4));
      const glow = mix3([1.2, 0.55, 0.22], [0.9, 0.35, 0.3], 1 - toward);
      const sky = mix3(glow, [0.12, 0.14, 0.32], Math.pow(up, 0.45));
      return [sky[0] + sun, sky[1] + sun * 0.6, sky[2] + sun * 0.3];
    },
  },
  {
    id: 'overcast',
    name: 'Overcast',
    builtin: true,
    kind: 'generated',
    sky: (d) => {
      const up = d[2];
      const v = up >= 0 ? 0.55 + 0.45 * Math.pow(up, 0.7) : 0.3 + 0.12 * up;
      return [v * 0.97, v, v * 1.03];
    },
  },
  {
    id: 'night',
    name: 'Night',
    builtin: true,
    kind: 'generated',
    sky: (d) => {
      const up = d[2];
      const m = sunDir(2.2, 0.6);
      const moon = Math.pow(Math.max(0, dot(d, m)), 2000) * 8 + Math.pow(Math.max(0, dot(d, m)), 12) * 0.08;
      if (up < 0) return [0.01, 0.012, 0.02];
      const sky = mix3([0.06, 0.08, 0.14], [0.01, 0.015, 0.04], Math.pow(up, 0.6));
      return [sky[0] + moon * 0.9, sky[1] + moon * 0.95, sky[2] + moon];
    },
  },
];

// ---------------------------------------------------------------------------
// registry (built-ins + user entries)

export const library = {
  studio: [...BUILTIN_STUDIO_LIGHTS] as StudioLightDef[],
  matcaps: [...BUILTIN_MATCAPS] as MatcapDef[],
  hdris: [...BUILTIN_HDRIS] as HdriDef[],
};

const listeners = new Set<() => void>();
export function onLibraryChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function libraryChanged() {
  for (const fn of listeners) fn();
}

export const findStudio = (id?: string) => library.studio.find((s) => s.id === id) ?? library.studio[0];
export const findMatcap = (id?: string) => library.matcaps.find((s) => s.id === id) ?? library.matcaps[0];
export const findHdri = (id?: string) => library.hdris.find((s) => s.id === id) ?? library.hdris[0];

// ---------------------------------------------------------------------------
// shader uniforms shared by every Solid / sculpt material (set per viewport before drawing)

const MAX = 4;
export const studioUniforms = {
  uStudioCustom: { value: 0 },
  uAmbient: { value: new Vector3(0.11, 0.11, 0.11) },
  uLightDir: { value: Array.from({ length: MAX }, () => new Vector3(0, 0, 1)) },
  uLightDiffuse: { value: Array.from({ length: MAX }, () => new Vector3()) },
  uLightSpecular: { value: Array.from({ length: MAX }, () => new Vector3()) },
  uLightSmooth: { value: new Array(MAX).fill(0) as number[] },
  uMatcapOn: { value: 0 },
  uMatcap: { value: null as Texture | null },
};

/** GLSL for the custom studio lights and matcap lookup (uses n, v in view space). */
export const STUDIO_GLSL = /* glsl */ `
  uniform int uStudioCustom;
  uniform vec3 uAmbient;
  uniform vec3 uLightDir[${MAX}];
  uniform vec3 uLightDiffuse[${MAX}];
  uniform vec3 uLightSpecular[${MAX}];
  uniform float uLightSmooth[${MAX}];
  uniform int uMatcapOn;
  uniform sampler2D uMatcap;
  vec3 studioLighting(vec3 base, vec3 n, vec3 v, float specular) {
    vec3 col = base * uAmbient;
    for (int i = 0; i < ${MAX}; i++) {
      float s = uLightSmooth[i];
      float d = max((dot(n, uLightDir[i]) + s) / (1.0 + s), 0.0);
      col += base * uLightDiffuse[i] * d;
      float p = mix(50.0, 6.0, s);
      col += uLightSpecular[i] * pow(max(dot(n, normalize(uLightDir[i] + v)), 0.0), p) * specular;
    }
    return col;
  }
  vec3 matcapLighting(vec3 base, vec3 n) {
    vec2 uv = n.xy * 0.49 + 0.5;
    return base * texture2D(uMatcap, uv).rgb;
  }
`;

const matcapTextures = new Map<string, Texture>();

function matcapTexture(m: MatcapDef): Texture | null {
  if (m.analytic) return null;
  let t = matcapTextures.get(m.id);
  if (t) return t;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  if (m.paint) {
    const img = g.createImageData(S, S);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const x = ((i + 0.5) / S) * 2 - 1,
          y = 1 - ((j + 0.5) / S) * 2;
        const r2 = x * x + y * y;
        const k = (j * S + i) * 4;
        const z = Math.sqrt(Math.max(0, 1 - Math.min(1, r2)));
        const nx = r2 > 1 ? x / Math.sqrt(r2) : x,
          ny = r2 > 1 ? y / Math.sqrt(r2) : y;
        const col = m.paint(nx, ny, z);
        for (let q = 0; q < 3; q++) img.data[k + q] = Math.round(clamp01(col[q]) * 255);
        img.data[k + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  } else if (m.dataUrl) {
    const im = new Image();
    im.onload = () => {
      g.drawImage(im, 0, 0, S, S);
      t!.needsUpdate = true;
      libraryChanged();
    };
    im.src = m.dataUrl;
  }
  t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.minFilter = t.magFilter = LinearFilter;
  matcapTextures.set(m.id, t);
  return t;
}

/** Small preview image (data URL) of a matcap for menus and the preferences list. */
export function matcapPreview(m: MatcapDef): string {
  const tex = matcapTexture(m);
  const src = tex ? (tex.image as HTMLCanvasElement) : null;
  const c = document.createElement('canvas');
  c.width = c.height = 48;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(24, 24, 23, 0, Math.PI * 2);
  g.clip();
  if (src) g.drawImage(src, 0, 0, 48, 48);
  else {
    // analytic clay: approximate with its formula at base 0.8
    const img = g.createImageData(48, 48);
    for (let j = 0; j < 48; j++)
      for (let i = 0; i < 48; i++) {
        const x = ((i + 0.5) / 48) * 2 - 1,
          y = 1 - ((j + 0.5) / 48) * 2;
        const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
        const n: Vec3 = [x, y, z];
        const d = clamp01(dot(n, KEY));
        const rim = Math.pow(1 - Math.max(z, 0), 2);
        const v = 0.8 * (0.25 + 0.75 * d) + 0.25 * rim + 0.25 * specAt(n, KEY, 18);
        const k = (j * 48 + i) * 4;
        const s = Math.round(Math.pow(clamp01(v), 1 / 2.2) * 255);
        img.data[k] = img.data[k + 1] = img.data[k + 2] = s;
        img.data[k + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  }
  return c.toDataURL();
}

export function dropMatcapTexture(id: string) {
  matcapTextures.get(id)?.dispose();
  matcapTextures.delete(id);
}

/** Point the shared uniforms at the studio light and matcap a viewport uses. */
export function applyStudioLighting(sh: { studio_light?: string; studio_matcap?: string }) {
  const s = findStudio(sh.studio_light);
  const u = studioUniforms;
  u.uStudioCustom.value = s.standard ? 0 : 1;
  if (!s.standard) {
    u.uAmbient.value.set(s.ambient[0], s.ambient[1], s.ambient[2]);
    for (let i = 0; i < MAX; i++) {
      const l = s.lights[i];
      const on = !!l?.use;
      const d = l ? norm(l.direction) : ([0, 0, 1] as Vec3);
      u.uLightDir.value[i].set(d[0], d[1], d[2]);
      u.uLightDiffuse.value[i].set(on ? l.diffuse[0] : 0, on ? l.diffuse[1] : 0, on ? l.diffuse[2] : 0);
      u.uLightSpecular.value[i].set(on ? l.specular[0] : 0, on ? l.specular[1] : 0, on ? l.specular[2] : 0);
      u.uLightSmooth.value[i] = on ? clamp01(l.smooth) : 0;
    }
  }
  const tex = matcapTexture(findMatcap(sh.studio_matcap));
  u.uMatcapOn.value = tex ? 1 : 0;
  u.uMatcap.value = tex;
}

// ---------------------------------------------------------------------------
// HDRIs

const W = 256,
  H = 128;
const equirects = new Map<string, DataTexture>();
const pmrems = new Map<string, Texture>();

/** Three's equirect lookup direction for a texel, expressed in our Z-up world. */
function texelDir(u: number, v: number): Vec3 {
  const phi = (u - 0.5) * 2 * Math.PI;
  const theta = (v - 0.5) * Math.PI;
  return [Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi)];
}

/** Z-up equirect coordinates of a direction (images are stored with +Z as up). */
function zUpUV(d: Vec3): [number, number] {
  const u = (Math.atan2(d[1], -d[0]) + Math.PI) / (2 * Math.PI);
  const v = (Math.atan2(d[2], Math.hypot(d[0], d[1])) + Math.PI / 2) / Math.PI;
  return [u - Math.floor(u), Math.min(1, Math.max(0, v))];
}

function sampleImage(p: NonNullable<HdriDef['pixels']>, u: number, v: number): Vec3 {
  const x = Math.min(p.width - 1, Math.max(0, Math.floor(u * p.width)));
  const y = Math.min(p.height - 1, Math.max(0, Math.floor((1 - v) * p.height)));
  const k = (y * p.width + x) * 4;
  return [p.data[k], p.data[k + 1], p.data[k + 2]];
}

/** Float equirect texture of an HDRI in three's lookup convention (null for the room studio). */
export function hdriEquirect(id?: string): DataTexture | null {
  const def = findHdri(id);
  if (def.kind === 'room') return null;
  let t = equirects.get(def.id);
  if (t) return t;
  const w = def.pixels ? Math.min(1024, Math.max(W, def.pixels.width)) : W;
  const h = def.pixels ? w / 2 : H;
  const data = new Float32Array(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const d = texelDir((i + 0.5) / w, (j + 0.5) / h);
      let c: Vec3;
      if (def.sky) c = def.sky(d);
      else {
        const [u, v] = zUpUV(d);
        c = sampleImage(def.pixels!, u, v);
      }
      const k = (j * w + i) * 4;
      data[k] = c[0];
      data[k + 1] = c[1];
      data[k + 2] = c[2];
      data[k + 3] = 1;
    }
  t = new DataTexture(data, w, h, RGBAFormat, FloatType);
  t.colorSpace = LinearSRGBColorSpace;
  t.mapping = EquirectangularReflectionMapping;
  t.minFilter = t.magFilter = LinearFilter;
  t.needsUpdate = true;
  equirects.set(def.id, t);
  return t;
}

/** Pre-filtered environment of an HDRI for Material Preview (null: use the room studio). */
export function hdriEnvironment(renderer: WebGLRenderer, pmrem: PMREMGenerator | null, id?: string): Texture | null {
  const def = findHdri(id);
  if (def.kind === 'room') return null;
  let t = pmrems.get(def.id);
  if (t) return t;
  const eq = hdriEquirect(def.id);
  if (!eq) return null;
  const gen = pmrem ?? new PMREMGenerator(renderer);
  t = gen.fromEquirectangular(eq).texture;
  pmrems.set(def.id, t);
  return t;
}

export function dropHdriTextures(id: string) {
  equirects.get(id)?.dispose();
  equirects.delete(id);
  pmrems.get(id)?.dispose();
  pmrems.delete(id);
}

/** Average colour of an HDRI (for list previews). */
export function hdriPreview(def: HdriDef): string {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  const img = g.createImageData(64, 32);
  for (let j = 0; j < 32; j++)
    for (let i = 0; i < 64; i++) {
      // preview in the image's own (Z-up) layout
      const u = (i + 0.5) / 64,
        v = 1 - (j + 0.5) / 32;
      const phi = u * 2 * Math.PI - Math.PI,
        th = (v - 0.5) * Math.PI;
      const d: Vec3 = [-Math.cos(th) * Math.cos(phi), Math.cos(th) * Math.sin(phi), Math.sin(th)];
      let col: Vec3;
      if (def.kind === 'room') col = d[2] >= 0 ? [0.75, 0.75, 0.75] : [0.4, 0.4, 0.4];
      else if (def.sky) col = def.sky(d);
      else col = sampleImage(def.pixels!, u, v);
      const k = (j * 64 + i) * 4;
      for (let q = 0; q < 3; q++) img.data[k + q] = Math.round(Math.pow(clamp01(col[q] / (1 + col[q])) * 1.6, 1 / 2.2) * 255);
      img.data[k + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c.toDataURL();
}

