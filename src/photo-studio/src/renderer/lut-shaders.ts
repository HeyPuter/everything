// Adjustment layers: per-channel tone curves (row 0, 1024 entries) followed by
// a 3D color table packed as an atlas (rows 1..n, x = r + b * n, y = g) and,
// optionally, per-channel curves applied after the table (row n + 1). The
// post curves let kinds that factor into a linear table plus a hard-edged
// tone map (Threshold, Gradient Map) render exactly; a hard step (Threshold)
// is compared instead, since a table blurs it across one entry.
// Uniform u[0]: x = curves on, y = 1 table / 2 table + post curves, z = n, w = clamp;
// u[1]: x = step on, y = step edge (each channel becomes 1 at or above it, else 0).
// Source and target have identical size, so texel and fragment coordinates match.
export const curveEntries = 1024;
export const glLutFragment = `#version 300 es
precision highp float;
uniform sampler2D imageTex;uniform sampler2D lutTex;uniform vec4 u[2];
out vec4 outColor;
float curveAt(float v,int c,int row){float x=clamp(v,0.,1.)*${curveEntries - 1}.;int i=int(floor(x));
 return mix(texelFetch(lutTex,ivec2(i,row),0)[c],texelFetch(lutTex,ivec2(min(i+1,${curveEntries - 1}),row),0)[c],x-float(i));}
vec3 tap(ivec3 p,int n){return texelFetch(lutTex,ivec2(p.r+p.b*n,1+p.g),0).rgb;}
vec3 lut(vec3 c){int n=int(u[0].z);vec3 x=clamp(c,0.,1.)*float(n-1);ivec3 i=ivec3(floor(x));vec3 f=x-vec3(i);ivec3 j=min(i+1,ivec3(n-1));
 vec3 c00=mix(tap(i,n),tap(ivec3(j.r,i.g,i.b),n),f.r),c10=mix(tap(ivec3(i.r,j.g,i.b),n),tap(ivec3(j.r,j.g,i.b),n),f.r);
 vec3 c01=mix(tap(ivec3(i.r,i.g,j.b),n),tap(ivec3(j.r,i.g,j.b),n),f.r),c11=mix(tap(ivec3(i.r,j.g,j.b),n),tap(j,n),f.r);
 return mix(mix(c00,c10,f.g),mix(c01,c11,f.g),f.b);}
void main(){vec4 s=texelFetch(imageTex,ivec2(gl_FragCoord.xy),0);vec3 c=s.rgb;
 if(u[0].x>.5)c=vec3(curveAt(c.r,0,0),curveAt(c.g,1,0),curveAt(c.b,2,0));
 if(u[0].y>.5)c=lut(c);
 if(u[0].y>1.5){int p=int(u[0].z)+1;c=vec3(curveAt(c.r,0,p),curveAt(c.g,1,p),curveAt(c.b,2,p));}
 if(u[1].x>.5)c=vec3(greaterThanEqual(c,vec3(u[1].y)));
 if(u[0].w>.5)c=clamp(c,0.,1.);outColor=vec4(c,s.a);}`;
export const wgslLut = `
struct U{v:vec4f,t:vec4f};@group(0) @binding(0)var imageTex:texture_2d<f32>;@group(0) @binding(1)var lutTex:texture_2d<f32>;@group(0) @binding(2)var<uniform> u:U;
struct V{@builtin(position) position:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:V;o.position=vec4f(p*2.-1.,0,1);return o;}
fn curveAt(v:f32,c:i32,row:i32)->f32{let x=clamp(v,0.,1.)*${curveEntries - 1}.;let i=i32(floor(x));
 return mix(textureLoad(lutTex,vec2i(i,row),0)[c],textureLoad(lutTex,vec2i(min(i+1,${curveEntries - 1}),row),0)[c],x-f32(i));}
fn tap(p:vec3i,n:i32)->vec3f{return textureLoad(lutTex,vec2i(p.r+p.b*n,1+p.g),0).rgb;}
fn lut(c:vec3f)->vec3f{let n=i32(u.v.z);let x=clamp(c,vec3f(0),vec3f(1))*f32(n-1);let i=vec3i(floor(x));let f=x-vec3f(i);let j=min(i+1,vec3i(n-1));
 let c00=mix(tap(i,n),tap(vec3i(j.r,i.g,i.b),n),f.r);let c10=mix(tap(vec3i(i.r,j.g,i.b),n),tap(vec3i(j.r,j.g,i.b),n),f.r);
 let c01=mix(tap(vec3i(i.r,i.g,j.b),n),tap(vec3i(j.r,i.g,j.b),n),f.r);let c11=mix(tap(vec3i(i.r,j.g,j.b),n),tap(j,n),f.r);
 return mix(mix(c00,c10,f.g),mix(c01,c11,f.g),f.b);}
@fragment fn fs(v:V)->@location(0) vec4f{let s=textureLoad(imageTex,vec2i(v.position.xy),0);var c=s.rgb;
 if(u.v.x>.5){c=vec3f(curveAt(c.r,0,0),curveAt(c.g,1,0),curveAt(c.b,2,0));}
 if(u.v.y>.5){c=lut(c);}
 if(u.v.y>1.5){let p=i32(u.v.z)+1;c=vec3f(curveAt(c.r,0,p),curveAt(c.g,1,p),curveAt(c.b,2,p));}
 if(u.t.x>.5){c=select(vec3f(0),vec3f(1),c>=vec3f(u.t.y));}
 if(u.v.w>.5){c=clamp(c,vec3f(0),vec3f(1));}return vec4f(c,s.a);}`;

export type CompiledLut = {
  // Per-channel tables sampled at `curveEntries` points over [0, 1].
  curves?: { r: Float32Array; g: Float32Array; b: Float32Array };
  lut3d?: { size: number; data: Float32Array };
  // Per-channel tables applied after the 3D table (any length >= 2).
  postCurves?: { r: Float32Array; g: Float32Array; b: Float32Array };
  // Hard step after everything else: channels at or above it become 1, others 0.
  postStep?: number;
};
const sampleTable = (t: Float32Array, x: number) => {
  const p = Math.min(1, Math.max(0, x)) * (t.length - 1),
    k = Math.min(Math.floor(p), t.length - 2);
  return t[k] + (t[k + 1] - t[k]) * (p - k);
};
/** Pack curves and a 3D table into one RGBA float texture for the LUT pass. */
export function packLut(c: CompiledLut) {
  const n = c.lut3d?.size ?? 0;
  if (n && (n < 2 || n > 64 || c.lut3d!.data.length !== n * n * n * 4)) throw new Error('Invalid 3D color table.');
  for (const t of [c.curves, c.postCurves]) if (t && [t.r, t.g, t.b].some((a) => a.length < 2)) throw new Error('Invalid adjustment curve.');
  // Without a 3D table the post curves simply follow the first curves.
  let curves = c.curves;
  const post = n ? c.postCurves : undefined;
  if (!n && c.postCurves) {
    const p = c.postCurves,
      at = (i: number) => i / (curveEntries - 1);
    const fold = (pt: Float32Array, t: Float32Array | undefined) => Float32Array.from({ length: curveEntries }, (_, i) => sampleTable(pt, t ? sampleTable(t, at(i)) : at(i)));
    curves = { r: fold(p.r, curves?.r), g: fold(p.g, curves?.g), b: fold(p.b, curves?.b) };
  }
  const width = Math.max(curveEntries, n * n),
    height = 1 + n + (post ? 1 : 0);
  const data = new Float32Array(width * height * 4);
  const row = (y: number, t: { r: Float32Array; g: Float32Array; b: Float32Array }) => {
    for (let i = 0; i < curveEntries; i++) {
      const x = i / (curveEntries - 1),
        o = (y * width + i) * 4;
      data[o] = sampleTable(t.r, x);
      data[o + 1] = sampleTable(t.g, x);
      data[o + 2] = sampleTable(t.b, x);
      data[o + 3] = 1;
    }
  };
  if (curves) row(0, curves);
  if (n) {
    // Source layout: r fastest, then g, then b.
    const src = c.lut3d!.data;
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) {
          const from = ((b * n + g) * n + r) * 4,
            to = ((1 + g) * width + r + b * n) * 4;
          data[to] = src[from];
          data[to + 1] = src[from + 1];
          data[to + 2] = src[from + 2];
          data[to + 3] = 1;
        }
  }
  if (post) row(1 + n, post);
  const step = c.postStep;
  const uniforms = new Float32Array([curves ? 1 : 0, n ? (post ? 2 : 1) : 0, n, 0]
    .concat([step === undefined ? 0 : 1, step ?? 0, 0, 0]));
  return { width, height, data, uniforms };
}
