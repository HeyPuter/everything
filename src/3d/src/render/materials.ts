// Viewport materials: solid "studio" shading, flat/object/attribute colors,
// ID pass for picking/outlines, and wireframe/overlay line materials.
import { ShaderMaterial, Color, DoubleSide, FrontSide, Vector3, Vector4, type Side, LineBasicMaterial, MeshBasicMaterial } from 'three';

import { STUDIO_GLSL, studioUniforms } from './studiolights';

const solidVert = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  #include <clipping_planes_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldNormal;
  varying vec4 vColor;
  #ifdef USE_VCOLOR
  attribute vec4 color;
  #endif
  void main() {
    vec3 objectNormal = normal;
    vec3 transformed = position;
    #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(position, 1.0)).xyz;
    objectNormal = mat3(instanceMatrix) * normal;
    #endif
    vNormal = normalize(normalMatrix * objectNormal);
    vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
    vViewPos = mv.xyz;
    vec4 mvPosition = mv;
    #include <clipping_planes_vertex>
    #ifdef USE_VCOLOR
    vColor = color;
    #else
    vColor = vec4(1.0);
    #endif
    gl_Position = projectionMatrix * mv;
  }
`;

const solidFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uSpecular;
  uniform int uLighting; // 0 studio, 1 flat, 2 matcap-ish
  uniform float uCavity;
  ${STUDIO_GLSL}
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldNormal;
  varying vec4 vColor;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    vec3 n = normalize(vNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 base = uColor * vColor.rgb;
    vec3 col;
    if (uLighting == 1) {
      col = base;
    } else if (uLighting == 2 && uMatcapOn == 1) {
      col = matcapLighting(base, n);
    } else if (uLighting == 2) {
      // clay matcap look: view-space normal lookup approximated analytically
      vec3 l1 = normalize(vec3(-0.4, 0.6, 0.7));
      float d = max(dot(n, l1), 0.0);
      float rim = pow(1.0 - max(n.z, 0.0), 2.0);
      col = base * (0.25 + 0.75 * d) + vec3(0.25) * rim + vec3(0.25) * pow(max(dot(reflect(-l1, n), vec3(0.0, 0.0, 1.0)), 0.0), 18.0);
    } else if (uStudioCustom == 1) {
      col = studioLighting(base, n, normalize(-vViewPos), uSpecular);
    } else {
      // studio lighting: a key light fixed relative to the view plus ambient. The weights set
      // the default Solid shading look (face brightness of the default cube from the default view).
      vec3 v = normalize(-vViewPos);
      vec3 L1 = normalize(vec3(-0.398, 0.455, 0.796));
      float d1 = max(dot(n, L1), 0.0);
      vec3 diffuse = base * (0.11 + 0.293 * d1);
      vec3 h1 = normalize(L1 + v);
      float spec = pow(max(dot(n, h1), 0.0), 50.0) * 0.08 * uSpecular;
      col = diffuse + vec3(spec);
    }
    gl_FragColor = vec4(col, uAlpha);
    #include <colorspace_fragment>
  }
`;

const solidCache = new Map<string, ShaderMaterial>();

export interface SolidOptions {
  color: [number, number, number];
  alpha?: number;
  lighting?: 'STUDIO' | 'FLAT' | 'MATCAP';
  vertexColors?: boolean;
  backfaceCulling?: boolean;
  specular?: boolean;
}

export function solidMaterial(o: SolidOptions): ShaderMaterial {
  const key = `${o.color.map((c) => c.toFixed(3)).join(',')}|${o.alpha ?? 1}|${o.lighting ?? 'STUDIO'}|${o.vertexColors ? 1 : 0}|${o.backfaceCulling ? 1 : 0}|${o.specular === false ? 0 : 1}`;
  let m = solidCache.get(key);
  if (m) return m;
  const alpha = o.alpha ?? 1;
  m = new ShaderMaterial({
    vertexShader: solidVert,
    fragmentShader: solidFrag,
    uniforms: {
      uColor: { value: new Color().setRGB(o.color[0], o.color[1], o.color[2]) },
      uAlpha: { value: alpha },
      uSpecular: { value: o.specular === false ? 0 : 1 },
      uLighting: { value: o.lighting === 'FLAT' ? 1 : o.lighting === 'MATCAP' ? 2 : 0 },
      uCavity: { value: 0 },
      // shared objects: Preferences ▸ Lights / the viewport's lighting choice update them per view
      ...studioUniforms,
    },
    defines: o.vertexColors ? { USE_VCOLOR: '' } : {},
    side: o.backfaceCulling ? FrontSide : DoubleSide,
    transparent: alpha < 1,
    depthWrite: alpha >= 1,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    clipping: true,
  });
  solidCache.set(key, m);
  return m;
}

// ---------------------------------------------------------------------------
// ID pass: object id encoded in RGB (id+1), alpha = 1

const idVert = /* glsl */ `
  #include <clipping_planes_pars_vertex>
  void main() {
    vec3 transformed = position;
    #ifdef USE_INSTANCING
    transformed = (instanceMatrix * vec4(position, 1.0)).xyz;
    #endif
    vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
    #include <clipping_planes_vertex>
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const idFrag = /* glsl */ `
  uniform vec4 uId;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = uId;
  }
`;

const idCache = new Map<number, ShaderMaterial>();
export function idMaterial(id: number, side: Side = DoubleSide): ShaderMaterial {
  const key = id * 4 + side;
  let m = idCache.get(key);
  if (m) return m;
  const v = id + 1;
  m = new ShaderMaterial({
    vertexShader: idVert,
    fragmentShader: idFrag,
    uniforms: { uId: { value: new Vector4((v & 255) / 255, ((v >> 8) & 255) / 255, ((v >> 16) & 255) / 255, 1) } },
    side,
    clipping: true,
  });
  idCache.set(key, m);
  return m;
}

export function decodeId(r: number, g: number, b: number): number {
  return (r | (g << 8) | (b << 16)) - 1;
}

// ---------------------------------------------------------------------------
// Outline post pass: draws selection outlines from the ID buffer.

export const outlineMaterial = new ShaderMaterial({
  uniforms: {
    tId: { value: null },
    tSel: { value: null },
    uSize: { value: new Vector3(1, 1, 1) },
    uSelColor: { value: new Color(0.929, 0.341, 0.0) },
    uActColor: { value: new Color(1.0, 0.627, 0.157) },
    uWidth: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tId;
    uniform sampler2D tSel;
    uniform vec3 uSize;
    uniform vec3 uSelColor;
    uniform vec3 uActColor;
    uniform float uWidth;
    varying vec2 vUv;
    float idAt(vec2 uv) {
      vec4 c = texture2D(tId, uv);
      return floor(c.r * 255.0 + 0.5) + floor(c.g * 255.0 + 0.5) * 256.0 + floor(c.b * 255.0 + 0.5) * 65536.0;
    }
    float selOf(float id) {
      if (id < 0.5) return 0.0;
      float i = id - 1.0;
      float w = 4096.0;
      vec2 uv = vec2((mod(i, w) + 0.5) / w, (floor(i / w) + 0.5) / 64.0);
      return texture2D(tSel, uv).r * 255.0;
    }
    void main() {
      vec2 px = 1.0 / uSize.xy;
      float c = idAt(vUv);
      float sc = selOf(c);
      float best = 0.0;
      float other = 0.0;
      for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
        if (dx == 0 && dy == 0) continue;
        vec2 o = vec2(float(dx), float(dy)) * px * uWidth;
        float n = idAt(vUv + o);
        if (n != c) {
          float sn = selOf(n);
          best = max(best, max(sn, sc));
          if (sc > 0.5 && sn < 0.5) other = 1.0;
        }
      }
      // draw on the selected side of the silhouette edge
      if (best < 0.5 || sc < 0.5) discard;
      vec3 col = sc > 1.5 ? uActColor : uSelColor;
      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
  depthTest: false,
  depthWrite: false,
  transparent: true,
});

export const lineMaterials = {
  wire: new LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 }),
  wireSel: new LineBasicMaterial({ color: 0xed5700 }),
  wireAct: new LineBasicMaterial({ color: 0xffa028 }),
};

export const helperColors = {
  wire: new Color(0, 0, 0),
  selected: new Color(0.929, 0.341, 0.0),
  active: new Color(1.0, 0.627, 0.157),
  light: new Color(0, 0, 0),
};

export function basicMaterial(color: number, opacity = 1) {
  return new MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
}
