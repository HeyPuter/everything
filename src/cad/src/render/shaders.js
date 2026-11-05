/**
 * GLSL ES 3.0 programs for the drawing canvas.
 *
 * Positions arrive as float32 high/low pairs; subtracting the camera's
 * high/low pair first keeps full precision near the view at any distance
 * from the origin. Everything after that is in device pixels relative to
 * the viewport centre.
 */

const PRECISION = `#version 300 es
precision highp float;
precision highp int;
`;

/**
 * Depth of a draw-order band: later bands are nearer, band 0 is the far
 * plane. Steps of 2^-21 stay distinct in a 24-bit depth buffer.
 */
const BAND_DEPTH = `
float bandDepth(float band) {
  return 1.0 - min(band, 4194303.0) * 4.76837158203125e-7;
}
`;

/** Instanced anti-aliased segments with lineweights and linetype patterns. */
export const SEG_VS = `${PRECISION}
layout(location = 0) in vec4 a_hi;
layout(location = 1) in vec4 a_lo;
layout(location = 2) in vec2 a_dist;
layout(location = 3) in vec4 a_color;
layout(location = 4) in uvec4 a_style;
layout(location = 5) in float a_band;

uniform vec2 u_camHi;
uniform vec2 u_camLo;
uniform vec2 u_half;        // viewport size in device px / 2
uniform float u_ppu;        // device px per world unit
uniform float u_lwPx[24];   // lineweight index -> device px
uniform float u_minPx;      // thinnest line in device px
uniform float u_hlExtra;    // added width for highlighted segments
uniform mat2 u_xm;          // preview transform (linear part)
uniform vec2 u_xt;          // preview transform translation (camera-relative)
uniform vec2 u_xp;          // preview pivot (camera-relative)

out vec4 v_color;
out float v_along;
out float v_across;
out float v_len;
out float v_hw;
out float v_dist0;
out float v_patScale;
flat out uint v_row;
flat out uint v_flags;
flat out vec4 v_cut;        // joint bisector normals at the start (xy) and end (zw)
flat out vec4 v_joint;      // start (xy) and end (zw) points in window pixels

const float JOIN_STEP = 0.024639942; // 2 PI / 255, see batch.js
${BAND_DEPTH}
void main() {
  vec2 p1 = (a_hi.xy - u_camHi) + (a_lo.xy - u_camLo);
  vec2 p2 = (a_hi.zw - u_camHi) + (a_lo.zw - u_camLo);
  p1 = u_xm * (p1 - u_xp) + u_xp + u_xt;
  p2 = u_xm * (p2 - u_xp) + u_xp + u_xt;
  vec2 s1 = p1 * u_ppu;
  vec2 s2 = p2 * u_ppu;
  vec2 d = s2 - s1;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  uint flags = a_style.x >> 5;
  float w = max(u_lwPx[a_style.x & 31u], u_minPx);
  if ((flags & 1u) != 0u) w += u_hlExtra;
  float hw = w * 0.5 + 1.0;
  // Joints: both segments cut along the same bisector (normal n, pointing
  // from the earlier segment into the later one).
  uint js = len > 1e-4 ? a_style.z : 0u;
  uint je = len > 1e-4 ? a_style.w : 0u;
  // The cut is tested against the window position of the pixel, so both
  // segments compute exactly the same value and no pixel is missed or doubled.
  float ext0 = hw, ext1 = hw;
  v_cut = vec4(0.0);
  v_joint = vec4(s1 + u_half, s2 + u_half);
  if (js != 0u) {
    float a = float(js - 1u) * JOIN_STEP;
    v_cut.xy = normalize(u_xm * vec2(cos(a), sin(a)));
    ext0 = hw * abs(dot(nrm, v_cut.xy)) / max(dot(dir, v_cut.xy), 0.25) + 1.0;
    flags |= 16u;
  }
  if (je != 0u) {
    float a = float(je - 1u) * JOIN_STEP;
    v_cut.zw = normalize(u_xm * vec2(cos(a), sin(a)));
    ext1 = hw * abs(dot(nrm, v_cut.zw)) / max(dot(dir, v_cut.zw), 0.25) + 1.0;
    flags |= 32u;
  }
  int c = gl_VertexID;
  float t = float(c >> 1);
  float side = (c & 1) == 1 ? 1.0 : -1.0;
  float ext = t > 0.5 ? ext1 : -ext0;
  vec2 pos = mix(s1, s2, t) + dir * ext + nrm * side * hw;
  v_along = t * len + ext;
  v_across = side * hw;
  v_len = len;
  v_hw = w * 0.5;
  v_dist0 = a_dist.x;
  v_patScale = a_dist.y;
  v_row = a_style.y;
  v_flags = flags;
  v_color = a_color;
  gl_Position = vec4(pos / u_half, bandDepth(a_band), 1.0);
}
`;

export const SEG_FS = `${PRECISION}
in vec4 v_color;
in float v_along;
in float v_across;
in float v_len;
in float v_hw;
in float v_dist0;
in float v_patScale;
flat in uint v_row;
flat in uint v_flags;
flat in vec4 v_cut;
flat in vec4 v_joint;

uniform highp sampler2D u_patterns; // R32F: x=0 count, x=1 total, x=2.. elements
uniform float u_ppu;
uniform vec4 u_hlColor;
uniform float u_alpha;

out vec4 outColor;

void main() {
  // Coverage across, then at each end: an anti-aliased square cap at a free
  // end, or a hard cut along the joint's bisector that the neighbouring
  // segment mirrors, so every pixel of a joint is drawn exactly once.
  float cov = clamp(v_hw + 0.5 - abs(v_across), 0.0, 1.0);
  if ((v_flags & 16u) != 0u) cov *= float(dot(gl_FragCoord.xy - v_joint.xy, v_cut.xy) > 0.0);
  else cov *= clamp(v_hw + 0.5 + min(v_along, 0.0), 0.0, 1.0);
  if ((v_flags & 32u) != 0u) cov *= float(dot(gl_FragCoord.xy - v_joint.zw, v_cut.zw) <= 0.0);
  else cov *= clamp(v_hw + 0.5 - max(v_along - v_len, 0.0), 0.0, 1.0);

  if (v_row > 0u && (v_flags & 2u) == 0u) {
    int row = int(v_row);
    int count = int(texelFetch(u_patterns, ivec2(0, row), 0).r);
    float total = texelFetch(u_patterns, ivec2(1, row), 0).r * v_patScale;
    // Too dense to resolve on screen: draw solid, as plotted output would read.
    if (total * u_ppu > 4.0 && count > 0) {
      float s = v_dist0 + clamp(v_along, 0.0, v_len) / u_ppu;
      float t = mod(s, total);
      float best = 1e9;
      float pos = 0.0;
      for (int i = 0; i < 16; i++) {
        if (i >= count) break;
        float e = texelFetch(u_patterns, ivec2(i + 2, row), 0).r * v_patScale;
        float a = pos;
        float b = pos + max(e, 0.0);
        if (e >= 0.0) {
          for (int k = -1; k <= 1; k++) {
            float tt = t + float(k) * total;
            float dd = max(max(a - tt, tt - b), 0.0);
            best = min(best, dd);
          }
        }
        pos += abs(e);
      }
      float dpx = best * u_ppu;
      cov *= clamp(v_hw + 0.5 - dpx, 0.0, 1.0);
      if (cov <= 0.0) discard;
    }
  }
  if (cov <= 0.0) discard;
  vec4 col = (v_flags & 1u) != 0u ? u_hlColor : v_color;
  outColor = vec4(col.rgb, col.a * cov * u_alpha);
}
`;

/** Solid fills (hatch, arrowheads, solid-filled regions). */
export const TRI_VS = `${PRECISION}
layout(location = 0) in vec4 a_pos;
layout(location = 1) in vec4 a_color;
layout(location = 2) in float a_band;
uniform vec2 u_camHi;
uniform vec2 u_camLo;
uniform vec2 u_half;
uniform float u_ppu;
uniform mat2 u_xm;
uniform vec2 u_xt;
uniform vec2 u_xp;
out vec4 v_color;
${BAND_DEPTH}
void main() {
  vec2 p = (a_pos.xy - u_camHi) + (a_pos.zw - u_camLo);
  p = u_xm * (p - u_xp) + u_xp + u_xt;
  v_color = a_color;
  gl_Position = vec4(p * u_ppu / u_half, bandDepth(a_band), 1.0);
}
`;

export const TRI_FS = `${PRECISION}
in vec4 v_color;
uniform vec4 u_override;  // a > 0: use this color (highlight)
uniform float u_alpha;
out vec4 outColor;
void main() {
  vec4 c = u_override.a > 0.0 ? u_override : v_color;
  outColor = vec4(c.rgb, c.a * u_alpha);
}
`;

/** Procedural grid and axes on a full-screen triangle. */
export const GRID_VS = `${PRECISION}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const GRID_FS = `${PRECISION}
uniform vec2 u_half;
uniform float u_ppu;
uniform vec2 u_offMinor;   // camera position modulo minor spacing (world)
uniform vec2 u_offMajor;
uniform float u_spMinor;
uniform float u_spMajor;
uniform float u_minorFade;
uniform vec4 u_minorColor;
uniform vec4 u_majorColor;
uniform vec4 u_axisX;
uniform vec4 u_axisY;
uniform vec2 u_originPx;   // world origin in device px from the viewport centre
uniform float u_showGrid;
uniform float u_dpr;
out vec4 outColor;

float lineCov(vec2 w, vec2 off, float sp, float px) {
  vec2 q = (w + off) / sp;
  vec2 d = abs(fract(q - 0.5) - 0.5) * sp * u_ppu;
  float m = min(d.x, d.y);
  return clamp(px * 0.5 + 0.5 - m, 0.0, 1.0);
}

// Premultiplied "over" accumulation.
vec4 over(vec4 dst, vec4 c, float cov) {
  float a = c.a * cov;
  return vec4(dst.rgb * (1.0 - a) + c.rgb * a, dst.a * (1.0 - a) + a);
}

void main() {
  vec2 p = gl_FragCoord.xy - u_half;
  vec2 w = p / u_ppu;
  vec4 col = vec4(0.0);
  if (u_showGrid > 0.5) {
    col = over(col, u_minorColor, lineCov(w, u_offMinor, u_spMinor, u_dpr) * u_minorFade);
    col = over(col, u_majorColor, lineCov(w, u_offMajor, u_spMajor, u_dpr));
  }
  col = over(col, u_axisX, clamp(u_dpr * 0.5 + 0.5 - abs(p.y - u_originPx.y), 0.0, 1.0));
  col = over(col, u_axisY, clamp(u_dpr * 0.5 + 0.5 - abs(p.x - u_originPx.x), 0.0, 1.0));
  if (col.a <= 0.001) discard;
  outColor = vec4(col.rgb / col.a, col.a);
}
`;
