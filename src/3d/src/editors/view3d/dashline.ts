// Screen-space dashed lines (relationship lines): dashes keep the same pixel length at any
// distance. Each segment carries its start point so the pattern starts there.
import { BufferGeometry, Color, Float32BufferAttribute, ShaderMaterial, Vector4, type WebGLRenderer } from 'three';

export const dashedLineMaterial = new ShaderMaterial({
  uniforms: {
    uColor: { value: new Color(0, 0, 0) },
    uOpacity: { value: 0.85 },
    uViewport: { value: new Vector4(0, 0, 1, 1) },
    uDash: { value: 3 },
    uGap: { value: 3 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 lineStart;
    varying vec4 vStart;
    void main() {
      vStart = projectionMatrix * modelViewMatrix * vec4(lineStart, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform vec4 uViewport;
    uniform float uDash;
    uniform float uGap;
    varying vec4 vStart;
    void main() {
      vec2 s = (vStart.xy / vStart.w * 0.5 + 0.5) * uViewport.zw + uViewport.xy;
      float d = length(gl_FragCoord.xy - s);
      if (mod(d, uDash + uGap) > uDash) discard;
      gl_FragColor = vec4(uColor, uOpacity);
      #include <colorspace_fragment>
    }
  `,
  transparent: true,
});

/** Geometry of segments (flat xyz pairs) with each segment's start repeated on both vertices. */
export function dashedSegments(geo: BufferGeometry, seg: number[]) {
  const starts = new Float32Array(seg.length);
  for (let i = 0; i < seg.length; i += 6) for (let k = 0; k < 6; k++) starts[i + k] = seg[i + (k % 3)];
  geo.setAttribute('position', new Float32BufferAttribute(seg, 3));
  geo.setAttribute('lineStart', new Float32BufferAttribute(starts, 3));
  geo.setDrawRange(0, seg.length / 3);
}

/** Point the dash pattern at the renderer's current viewport (device pixels). */
export function syncDashViewport(r: WebGLRenderer, dpr: number) {
  const v = r.getViewport(new Vector4());
  dashedLineMaterial.uniforms.uViewport.value.set(v.x * dpr, v.y * dpr, v.z * dpr, v.w * dpr);
  dashedLineMaterial.uniforms.uDash.value = 3 * dpr;
  dashedLineMaterial.uniforms.uGap.value = 3 * dpr;
}
