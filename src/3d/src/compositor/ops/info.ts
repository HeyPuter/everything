// Input and utility nodes: Image Info, Image Coordinates, Blank Image, Normal, String To Image,
// Sequencer Strip Info, Switch View, the legacy two-image Switch, shared constants and the
// procedural nodes shared with the shader editor (textures, Radial Tiling).
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, IDENTITY, xfApply, type Domain, type Xform } from '../eval/result';
import { runPixelNode, pixelGeneratorFor } from '../eval/pixel';
import { menuValue } from '../nodes/defs';
import { cachedTexture } from '../eval/cache';

const ident = (): Xform => [...IDENTITY] as Xform;

/** Size, resolution and transform of a domain (Image Info). */
export function domainInfo(d: Domain) {
  const [a, b, c, dd, tx, ty] = d.xf;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of [
    [-d.w / 2, -d.h / 2],
    [d.w / 2, -d.h / 2],
    [-d.w / 2, d.h / 2],
    [d.w / 2, d.h / 2],
  ]) {
    const [px, py] = xfApply(d.xf, x, y);
    x0 = Math.min(x0, px);
    y0 = Math.min(y0, py);
    x1 = Math.max(x1, px);
    y1 = Math.max(y1, py);
  }
  const snap = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    dimensions: [Math.ceil(snap(x1)) - Math.floor(snap(x0)), Math.ceil(snap(y1)) - Math.floor(snap(y0))],
    resolution: [d.w, d.h],
    location: [tx, ty],
    rotation: Math.atan2(b, a),
    scale: [Math.hypot(a, b), Math.hypot(c, dd)],
  };
}

registerExec('CompositorNodeImageInfo', (x) => {
  const r = x.input('Image');
  if (!r.domain) {
    for (const id of ['Dimensions', 'Resolution', 'Location', 'Scale']) x.out(id, Result.single('VECTOR', [0, 0, 0]));
    x.out('Rotation', Result.single('FLOAT', 0));
    return;
  }
  const i = domainInfo(r.domain);
  x.out('Dimensions', Result.single('VECTOR', [...i.dimensions, 0]));
  x.out('Resolution', Result.single('VECTOR', [...i.resolution, 0]));
  x.out('Location', Result.single('VECTOR', [...i.location, 0]));
  x.out('Rotation', Result.single('FLOAT', i.rotation));
  x.out('Scale', Result.single('VECTOR', [...i.scale, 0]));
});

const COORDS = `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform vec2 u_size;
void main() {
  vec2 p = gl_FragCoord.xy;
  o0 = vec4((p - u_size * 0.5) / (max(u_size.x, u_size.y) * 0.5), 0.0, 0.0);
  o1 = vec4(p / u_size, 0.0, 0.0);
  o2 = vec4(floor(p), 0.0, 0.0);
}`;

registerExec('CompositorNodeImageCoordinates', (x) => {
  const r = x.input('Image');
  if (!r.domain) {
    for (const id of ['Uniform', 'Normalized', 'Pixel']) x.out(id, Result.single('VECTOR', [0, 0, 0]));
    return;
  }
  const d = r.domain;
  const ts = [x.alloc(d), x.alloc(d), x.alloc(d)];
  x.pass('img-coords', COORDS, ts, { u_size: [d.w, d.h] });
  x.out('Uniform', Result.image('VECTOR', ts[0], d));
  x.out('Normalized', Result.image('VECTOR', ts[1], d));
  x.out('Pixel', Result.image('VECTOR', ts[2], d));
});

const FILL = `
uniform vec4 u_color;
layout(location = 0) out vec4 o0;
void main() { o0 = u_color; }`;

registerExec('CompositorNodeBlankImage', (x) => {
  const [sw, sh] = x.vec('Size', 2).map((v) => Math.max(1, Math.min(16384, Math.round(v))));
  const c = x.vec('Color', 4);
  const d: Domain = { w: sw, h: sh, xf: ident() };
  const t = x.alloc(d);
  x.pass('blank', FILL, t, { u_color: c });
  x.out('Image', Result.image('RGBA', t, d));
});

registerExec('CompositorNodeNormal', (x) => {
  const n = (x.prop('outputs.Normal') as number[] | null) ?? [0, 0, 1];
  x.out('Normal', Result.single('VECTOR', [n[0], n[1], n[2]]));
});

// the compositor composites a single (mono) view
registerExec('CompositorNodeSwitchView', (x) => x.out('Image', x.input('left')));
registerExec('CompositorNodeSwitch', (x) => x.out('Image', x.input(x.bool('Switch') ? 'On' : 'Off')));

// outside a sequencer strip there is no strip: neutral values
registerExec('CompositorNodeSequencerStripInfo', (x) => {
  const s = x.env.doc.scene;
  x.out('Start Frame', Result.single('INT', s.frame_start));
  x.out('End Frame', Result.single('INT', s.frame_end));
  x.out('Location', Result.single('VECTOR', [0, 0, 0]));
  x.out('Rotation', Result.single('FLOAT', 0));
  x.out('Scale', Result.single('VECTOR', [1, 1, 0]));
});

// constants shared with Geometry Nodes
registerExec('FunctionNodeInputBool', (x) => x.out('Boolean', Result.single('BOOLEAN', !!x.prop('boolean'))));
registerExec('FunctionNodeInputInt', (x) => x.out('Integer', Result.single('INT', Math.round(Number(x.prop('integer') ?? 0)))));
registerExec('FunctionNodeInputString', (x) => x.out('String', Result.single('STRING', String(x.prop('string') ?? ''))));
registerExec('FunctionNodeInputRotation', (x) => {
  const v = (x.prop('rotation_euler') as number[] | null) ?? [0, 0, 0];
  x.out('Rotation', Result.single('VECTOR', [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]));
});
registerExec('FunctionNodeInputVector', (x) => {
  const v = (x.prop('vector') as number[] | null) ?? [0, 0, 0];
  x.out('Vector', Result.single('VECTOR', [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]));
});

// ---------------------------------------------------------------------------
// procedural nodes: an image the size of the compositing resolution when no input is an image

export const PROCEDURAL = [
  'ShaderNodeTexBrick',
  'ShaderNodeTexChecker',
  'ShaderNodeTexGabor',
  'ShaderNodeTexGradient',
  'ShaderNodeTexMagic',
  'ShaderNodeTexNoise',
  'ShaderNodeTexVoronoi',
  'ShaderNodeTexWave',
  'ShaderNodeTexWhiteNoise',
];

function proceduralDomain(x: NodeCtx): Domain {
  const d = x.domain();
  if (d) return d;
  const [w, h] = x.env.renderSize;
  return { w, h, xf: ident() };
}

for (const id of PROCEDURAL)
  registerExec(id, (x) => {
    const gen = pixelGeneratorFor(id);
    if (!gen) throw new Error(`No pixel generator for ${id}`);
    // the texture coordinates are the centred uniform image coordinates unless a vector is linked
    runPixelNode(x, gen, { domain: x.linked('Vector') ? x.domain() : proceduralDomain(x) });
  });
registerExec('ShaderNodeRadialTiling', (x) => runPixelNode(x, pixelGeneratorFor('ShaderNodeRadialTiling')!));

// ---------------------------------------------------------------------------
// String To Image: the text rasterized into a mask the size of the text

const ALIGN_X: Record<string, number> = { Left: 0, Center: 0.5, Right: 1 };

/** Rasterize text into a top-down alpha buffer. */
function rasterText(text: string, size: number, wrapWidth: number | null): { w: number; h: number; alpha: Float32Array; ascent: number; lineHeight: number } {
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = `${size}px Inter, "Helvetica Neue", Arial, sans-serif`;
  g.font = font;
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (!wrapWidth) {
      lines.push(para);
      continue;
    }
    let cur = '';
    for (const w of para.split(/(\s+)/)) {
      const next = cur + w;
      if (cur && g.measureText(next).width > wrapWidth) {
        lines.push(cur.trimEnd());
        cur = w.trimStart();
      } else cur = next;
    }
    lines.push(cur);
  }
  void words;
  const m = g.measureText('Hg');
  const ascent = Math.ceil(m.actualBoundingBoxAscent || size * 0.8);
  const descent = Math.ceil(m.actualBoundingBoxDescent || size * 0.2);
  const lineHeight = Math.ceil(size * 1.2);
  const w = Math.max(1, Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width), 1)));
  const h = Math.max(1, ascent + descent + (lines.length - 1) * lineHeight);
  c.width = w;
  c.height = h;
  g.font = font;
  g.fillStyle = '#ffffff';
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => g.fillText(l, 0, ascent + i * lineHeight));
  const px = g.getImageData(0, 0, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3] / 255;
  return { w, h, alpha, ascent, lineHeight };
}

registerExec('CompositorNodeStringToImage', (x) => {
  const text = String(x.input('String').value ?? '');
  const size = Math.max(1, x.num('Size', 128));
  if (!text.trim()) return x.out('Image', Result.single('FLOAT', 0));
  const wrap = x.bool('Wrap') ? Math.max(1, x.num('Wrap Width', 1920)) : null;
  const key = `str|${text}|${size}|${wrap}`;
  let info: { w: number; h: number; ascent: number } = { w: 1, h: 1, ascent: 0 };
  const tex = cachedTexture(key, () => {
    const r = rasterText(text, size, wrap);
    info = r;
    const data = new Float32Array(r.w * r.h * 4);
    // bottom-up rows
    for (let y = 0; y < r.h; y++)
      for (let i = 0; i < r.w; i++) {
        const a = r.alpha[(r.h - 1 - y) * r.w + i];
        const k = (y * r.w + i) * 4;
        data[k] = data[k + 1] = data[k + 2] = a;
        data[k + 3] = 1;
      }
    const t = x.gpu.upload(data, r.w, r.h, 'string');
    (t as unknown as { textInfo: typeof info }).textInfo = { w: r.w, h: r.h, ascent: r.ascent };
    return t;
  });
  info = (tex as unknown as { textInfo?: typeof info }).textInfo ?? { w: tex.w, h: tex.h, ascent: tex.h };
  // place the text relative to the origin following the alignment
  const ax = ALIGN_X[menuValue(x.node, 'Horizontal Alignment')] ?? 0.5;
  const va = menuValue(x.node, 'Vertical Alignment') || 'Middle';
  const tx = (0.5 - ax) * info.w;
  let ty = 0;
  if (va === 'Top') ty = -info.h / 2;
  else if (va === 'Bottom') ty = info.h / 2;
  else if (va === 'Top Baseline') ty = -info.h / 2 + info.ascent;
  else if (va === 'Bottom Baseline') ty = info.h / 2 - (info.h - info.ascent);
  x.out('Image', Result.image('FLOAT', tex, { w: tex.w, h: tex.h, xf: [1, 0, 0, 1, Math.round(tx), Math.round(ty)] }));
});
