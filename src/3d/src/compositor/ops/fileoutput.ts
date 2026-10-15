// File Output node: every input is saved as an image file for each rendered frame. In the browser
// the files are downloaded: a still render downloads its files (several files as one ZIP), an
// animation collects every frame's files into a ZIP that downloads when the render finishes.
import { h } from '../../ui/h';
import { icon } from '../../ui/icons';
import { app } from '../../app/app';
import { textField, button } from '../../ui/widgets';
import type { DocumentData, NodeData } from '../../data/types';
import { getNodeType } from '../../nodes/registry';
import type { SocketDef } from '../../nodes/types';
import { nodeChanged } from '../../nodes/editor/nodeui';
import { Evaluator, type LayerSource } from '../eval/evaluator';
import { boundingDomain, IDENTITY, type Xform } from '../eval/result';
import { gpu } from '../gpu/gpu';
import { compositingGroup } from '../data';
import { renderPostHooks, encodeRGBA8, download, EXT, type FileFormat, type RenderResult } from '../../render/final/result';
import { renderJob } from '../../render/final/job';
import { ZipWriter } from '../../render/final/zip';
import { toDisplayRGBA8 } from '../../render/final/colormanage';
import { renderSize } from '../../render/final/units';

/** Input names of a File Output node (one file per input). */
export function fileSlots(n: NodeData): string[] {
  const s = n.props.file_slots;
  return (typeof s === 'string' ? s : 'Image').split('\n').filter((x) => x.length);
}

/** File name of an input at a frame: base name, input name and 4-digit frame number. */
export function outputFileName(base: string, slot: string, frame: number, format: FileFormat, single: boolean): string {
  const b = base || 'render';
  const stem = single ? b : `${b}${b.endsWith('_') || b.endsWith('/') ? '' : '_'}${slot}`;
  return `${stem}${String(Math.max(0, frame)).padStart(4, '0')}.${EXT[format]}`.replace(/^\/+/, '');
}

{
  const d = getNodeType('CompositorNodeOutputFile');
  if (d) {
    d.dynamicSockets = (n) => ({
      inputs: fileSlots(n).map((name): SocketDef => ({ name, identifier: name, type: 'RGBA', default: [0, 0, 0, 1] })),
      outputs: [],
    });
    d.bodyHeight = (n) => 24 * (fileSlots(n).length + 1) + 4;
    d.drawBody = (ctx) => {
      const n = ctx.node;
      const slots = fileSlots(n);
      const set = (list: string[], label: string) => {
        n.props.file_slots = list.join('\n');
        nodeChanged(label);
      };
      return h(
        'div',
        { class: 'col' },
        slots.map((s, i) =>
          h(
            'div',
            { class: 'row', key: `slot${i}` },
            textField(`${ctx.key}:slot${i}`, s, (v) => {
              const name = v.trim().replace(/\n/g, ' ');
              if (!name || (name !== s && slots.includes(name))) return;
              const list = [...slots];
              list[i] = name;
              // keep the link of the renamed input
              for (const l of ctx.tree.links) if (l.to_node === n.id && l.to_socket === s) l.to_socket = name;
              set(list, 'Rename Input');
            }),
            button(
              `${ctx.key}:del${i}`,
              icon('x'),
              () => {
                if (slots.length <= 1) return;
                ctx.tree.links = ctx.tree.links.filter((l) => !(l.to_node === n.id && l.to_socket === s));
                set(
                  slots.filter((_, k) => k !== i),
                  'Remove Input',
                );
              },
              { tip: 'Remove this input', disabled: slots.length <= 1 },
            ),
          ),
        ),
        button(
          `${ctx.key}:add`,
          [icon('add'), 'Add Input'],
          () => {
            let nm = 'Image';
            for (let k = 1; slots.includes(nm); k++) nm = `Image_${String(k).padStart(3, '0')}`;
            set([...slots, nm], 'Add Input');
          },
          { tip: 'Add an input saved as its own file' },
        ),
      );
    };
  }
}

const FLIP = `
uniform sampler2D u_src;
layout(location = 0) out vec4 o0;
void main() { ivec2 s = textureSize(u_src, 0); ivec2 p = ivec2(gl_FragCoord.xy); o0 = texelFetch(u_src, ivec2(p.x, s.y - 1 - p.y), 0); }`;

/** Evaluate every File Output node of the compositing tree: name → (top-down pixels, size). */
export function evaluateFileOutputs(doc: DocumentData, layers: LayerSource | null): { node: NodeData; slot: string; data: Float32Array; w: number; h: number }[] {
  const group = compositingGroup(doc);
  const g = gpu();
  if (!group || !g) return [];
  const nodes = group.tree.nodes.filter((n) => n.type === 'CompositorNodeOutputFile' && !n.mute);
  if (!nodes.length) return [];
  const [W, H] = renderSize(doc.scene.render);
  const ev = new Evaluator(g, { doc, renderSize: [W, H], frame: doc.scene.frame_current, fps: doc.scene.render.fps / (doc.scene.render.fps_base || 1), layers, viewer: null, composite: false });
  const out: { node: NodeData; slot: string; data: Float32Array; w: number; h: number }[] = [];
  try {
    const scope = ev.rootScope(group.tree);
    for (const n of nodes)
      for (const slot of fileSlots(n)) {
        if (!ev.isLinked(scope, n, slot)) continue;
        const r = ev.convert(ev.input(scope, n, { name: slot, identifier: slot, type: 'RGBA' }), 'RGBA');
        const d = r.domain ? boundingDomain(r.domain) : { w: W, h: H, xf: [...IDENTITY] as Xform };
        const t = ev.realize(r, d);
        const f = ev.alloc(d.w, d.h, 'flip');
        ev.pass('file-flip', FLIP, f, { u_src: t });
        out.push({ node: n, slot, data: g.read(f), w: d.w, h: d.h });
      }
  } finally {
    ev.finish();
  }
  return out;
}

// ---------------------------------------------------------------------------
// saving after each final frame

let zip: ZipWriter | null = null;
let zipName = '';
let flushTimer = 0;

function flushWhenDone() {
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    if (renderJob()) return flushWhenDone();
    if (zip) download(new Blob(zip.finish() as BlobPart[], { type: 'application/zip' }), zipName, 'application/zip');
    zip = null;
  }, 300);
}

async function saveFrame(r: RenderResult) {
  const doc = app.doc;
  const files = evaluateFileOutputs(doc, { width: r.width, height: r.height, version: `file|${r.version}|${Math.random()}`, passes: r.viewLayer ?? r.passes });
  if (!files.length) return;
  const rs = doc.scene.render;
  const view = { view_transform: rs.view_transform, exposure: rs.exposure, gamma: rs.gamma };
  const encoded: { name: string; bytes: Uint8Array }[] = [];
  for (const f of files) {
    const fmt = (String(f.node.props.file_format ?? 'PNG') as FileFormat) in EXT ? (String(f.node.props.file_format ?? 'PNG') as FileFormat) : 'PNG';
    // "Save as Render" applies the scene's view transform; otherwise values are written as they are
    const asRender = f.node.props.save_as_render !== false;
    const px = toDisplayRGBA8(f.data, f.w, f.h, asRender ? view : { view_transform: 'RAW', exposure: 0, gamma: 1 }, { keepAlpha: true });
    const single = fileSlots(f.node).length === 1;
    const dir = String(f.node.props.directory ?? '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/^\/\//, '');
    encoded.push({
      name: (dir ? `${dir}/` : '') + outputFileName(String(f.node.props.file_name ?? 'render'), f.slot, r.info.frame, fmt, single),
      bytes: await encodeRGBA8(px, f.w, f.h, fmt, { alpha: fmt !== 'JPEG' }),
    });
  }
  const job = renderJob();
  const animation = !!job && job.frameCount > 1;
  if (animation || zip) {
    zip ??= new ZipWriter();
    zipName = `${doc.scene.name || 'render'}_file_output.zip`;
    for (const e of encoded) zip.add(e.name, e.bytes);
    flushWhenDone();
  } else if (encoded.length === 1) download(encoded[0].bytes, encoded[0].name.split('/').pop()!);
  else {
    const z = new ZipWriter();
    for (const e of encoded) z.add(e.name, e.bytes);
    download(new Blob(z.finish() as BlobPart[], { type: 'application/zip' }), `${doc.scene.name || 'render'}_file_output.zip`, 'application/zip');
  }
}

renderPostHooks.push(async (r, ctx) => {
  if (!ctx.final) return;
  try {
    await saveFrame(r);
  } catch (e) {
    app.report('ERROR', `File Output: ${e instanceof Error ? e.message : String(e)}`);
  }
});
