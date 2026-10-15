// Cryptomatte: mattes of the objects, materials or assets picked by name, from the cryptomatte
// passes of the render (or, for the legacy node, from linked cryptomatte images). Each pass
// layer stores two (ID, coverage) pairs per pixel; the matte sums the coverage of picked IDs.
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { openMenu } from '../../ui/menu';
import type { NodeData } from '../../data/types';
import { getNodeType } from '../../nodes/registry';
import { nodeChanged } from '../../nodes/editor/nodeui';
import { registerExec, type NodeCtx } from '../eval/evaluator';
import { Result, IDENTITY, type Domain, type Xform } from '../eval/result';
import { cryptoId, latestCryptoManifest, type CryptoLayer } from '../../render/final/extrapasses';
import type { Texture } from '../gpu/gpu';

const MAX_IDS = 32;

/** Names listed in a node's matte (comma separated, quotes optional). */
export function matteNames(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\s*(?:"([^"]*)"|([^,]+))\s*(?:,|$)/g)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

export function setMatteNames(n: NodeData, names: string[]) {
  n.props.matte_id = names.map((x) => (x.includes(',') ? `"${x}"` : x)).join(', ');
}

/** Matte of one pixel from its (ID, coverage) layers (CPU mirror of the GLSL). */
export function cryptoMatte(layers: number[][], ids: number[]): number {
  let m = 0;
  for (const L of layers)
    for (const k of [0, 2]) {
      if (L[k + 1] <= 0) continue;
      if (ids.includes(L[k])) m += L[k + 1];
    }
  return Math.min(1, m);
}

const MATTE = (layers: number) => `
${Array.from({ length: layers }, (_, i) => `uniform sampler2D u_l${i};`).join('\n')}
uniform sampler2D u_img;
uniform float u_ids[${MAX_IDS}];
uniform int u_n;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
bool picked(float id) {
  for (int i = 0; i < ${MAX_IDS}; i++) { if (i >= u_n) break; if (u_ids[i] == id) return true; }
  return false;
}
vec3 pickColor(float id) {
  uint b = floatBitsToUint(id);
  return vec3(float(b & 255u), float((b >> 8) & 255u), float((b >> 16) & 255u)) / 255.0;
}
void main() {
  float m = 0.0;
${Array.from({ length: layers }, (_, i) => `  { vec4 c = cmpPx(u_l${i}); if (c.y > 0.0 && picked(c.x)) m += c.y; if (c.w > 0.0 && picked(c.z)) m += c.w; }`).join('\n')}
  m = min(m, 1.0);
  o0 = cmpPx(u_img) * m;
  o1 = vec4(vec3(m), 1.0);
  vec4 first = cmpPx(u_l0);
  o2 = vec4(first.y > 0.0 ? pickColor(first.x) : vec3(0.0), 1.0);
}`;

function run(x: NodeCtx, layers: Texture[], d: Domain) {
  if (!layers.length) {
    x.out('Image', Result.single('RGBA', [0, 0, 0, 0]));
    x.out('Matte', Result.single('FLOAT', 0));
    x.out('Pick', Result.single('RGBA', [0, 0, 0, 1]));
    return;
  }
  const names = matteNames(x.str('matte_id'));
  const ids = names.slice(0, MAX_IDS).map(cryptoId);
  const out = [x.alloc(d), x.alloc(d), x.alloc(d)];
  const u: Record<string, unknown> = { u_img: x.ev.realize(x.input('Image'), d), u_ids: new Float32Array([...ids, ...new Array(MAX_IDS - ids.length).fill(0)]), u_n: ids.length };
  layers.forEach((t, i) => (u[`u_l${i}`] = t));
  x.pass(`crypto:${layers.length}`, MATTE(layers.length), out, u as never);
  x.out('Image', Result.image('RGBA', out[0], d));
  x.out('Matte', Result.image('FLOAT', out[1], d));
  x.out('Pick', Result.image('RGBA', out[2], d));
}

registerExec('CompositorNodeCryptomatteV2', (x) => {
  const L = x.env.layers;
  const layer = (x.str('layer_name') || 'CryptoObject').replace(/^.*\./, '') as CryptoLayer;
  const keys = L
    ? Object.keys(L.passes)
        .filter((k) => k.startsWith(layer) && /\d\d$/.test(k))
        .sort()
    : [];
  if (!L || !keys.length) {
    x.error(`No ${layer.replace('Crypto', '').toLowerCase()} cryptomatte passes: enable them in View Layer ▸ Cryptomatte and render`);
    x.out('Image', x.input('Image'));
    x.out('Matte', Result.single('FLOAT', 0));
    x.out('Pick', Result.single('RGBA', [0, 0, 0, 1]));
    return;
  }
  const d: Domain = { w: L.width, h: L.height, xf: [...IDENTITY] as Xform };
  const texs = keys.map((k) => {
    const src = L.passes[k]!;
    // top-down rows → bottom-up texture
    const data = new Float32Array(src.length);
    for (let y = 0; y < L.height; y++) data.set(src.subarray((L.height - 1 - y) * L.width * 4, (L.height - y) * L.width * 4), y * L.width * 4);
    const t = x.ev.alloc(L.width, L.height, k);
    const gl = x.gpu.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, L.width, L.height, gl.RGBA, gl.FLOAT, data);
    return t;
  });
  run(x, texs, d);
});

registerExec('CompositorNodeCryptomatte', (x) => {
  const inputs = ['Crypto 00', 'Crypto 01', 'Crypto 02'].map((id) => x.input(id));
  const d = inputs.find((r) => r.domain)?.domain ?? x.input('Image').domain;
  if (!d) {
    x.out('Image', x.input('Image'));
    x.out('Matte', Result.single('FLOAT', 0));
    return;
  }
  run(
    x,
    inputs.filter((r) => x.linked(['Crypto 00', 'Crypto 01', 'Crypto 02'][inputs.indexOf(r)])).map((r) => x.ev.realize(r, d)),
    d,
  );
});

// ---------------------------------------------------------------------------
// Node body: the picked names, with menus of the names found in the last render

function body(n: NodeData) {
  const layer = (String(n.props.layer_name ?? 'CryptoObject').replace(/^.*\./, '') || 'CryptoObject') as CryptoLayer;
  const names = matteNames(String(n.props.matte_id ?? ''));
  const available = Object.keys(latestCryptoManifest[layer] ?? {}).sort();
  const menu = (e: PointerEvent, add: boolean) => {
    e.preventDefault();
    const list = add ? available.filter((x) => !names.includes(x)) : names;
    openMenu(
      list.length
        ? list.map((nm) => ({
            label: nm,
            action: () => {
              setMatteNames(n, add ? [...names, nm] : names.filter((x) => x !== nm));
              nodeChanged(add ? 'Add Cryptomatte' : 'Remove Cryptomatte');
            },
          }))
        : [{ label: add ? 'Render with cryptomatte passes to pick names' : 'Nothing picked', disabled: true }],
      e.currentTarget as HTMLElement,
    );
  };
  return h(
    'div',
    { class: 'cmp-body-col' },
    h(
      'div',
      { class: 'cmp-body-row' },
      h('button', { class: 'btn', 'data-tip': 'Add\nAdd an object, material or asset to the matte', onpointerdown: (e: PointerEvent) => menu(e, true) }, icon('add'), 'Add'),
      h('button', { class: 'btn', 'data-tip': 'Remove\nRemove a name from the matte', onpointerdown: (e: PointerEvent) => menu(e, false) }, icon('remove'), 'Remove'),
    ),
    h('span', { class: 'nd-label prop-note', title: names.join(', ') }, names.length ? names.join(', ') : 'No names picked'),
  );
}

for (const id of ['CompositorNodeCryptomatteV2', 'CompositorNodeCryptomatte']) {
  const d = getNodeType(id);
  if (!d) continue;
  d.bodyHeight = () => 48;
  d.drawBody = (ctx) => body(ctx.node);
}
