// Node previews (Shift H) in the Shader Editor: a small lit sphere showing what a node outputs,
// drawn above the node. Previews render off-screen with the shared renderer, one per frame and
// only after edits settle, and are cached until the material changes.
import { Mesh, PerspectiveCamera, Scene, SphereGeometry, SRGBColorSpace, WebGLRenderTarget, DirectionalLight } from 'three';
import type { DocumentData, MaterialData, NodeData } from '../../data/types';
import { renderContext } from '../../render/context';
import { app } from '../../app/app';
import { compileMaterial } from '../shader/material';
import { canConvert, getNodeType, nodeSockets } from '../registry';
import { connect, ctxOf, makeNode } from '../tree';
import { hashString } from '../shader/codegen';

const SIZE = 192; // rendered size; shown at node width
const SETTLE_MS = 150;

interface Entry {
  key: string;
  url?: string;
}
interface Job {
  id: string;
  key: string;
  material: string;
  node: string;
}

const entries = new Map<string, Entry>();
const pending = new Map<string, Job>();
const listeners = new Set<() => void>();
let lastRequest = 0;
let installed = false;

/** Called when a preview image is ready (editors redraw). */
export function onPreviewReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether a node can show a preview: it has outputs that can be shown as a surface. */
export function canPreview(node: NodeData, doc: DocumentData, tree: MaterialData['tree']): boolean {
  const def = getNodeType(node.type);
  if (!def || def.layout || node.type === 'ShaderNodeOutputMaterial' || node.type === 'NodeGroupInput' || node.type === 'NodeGroupOutput') return false;
  return nodeSockets(node, ctxOf(doc, tree)).outputs.some((s) => s.type === 'SHADER' || canConvert(s.type, 'RGBA'));
}

/** Content key of a material's tree (and the groups it may use). */
export function previewTreeKey(doc: DocumentData, ma: MaterialData): string {
  // the material's tree and the node groups it uses (directly or nested)
  const used = new Set<string>();
  const walk = (t: MaterialData['tree'], depth: number) => {
    if (depth > 16) return;
    for (const n of t.nodes) {
      const g = typeof n.props.node_tree === 'string' ? doc.node_groups[n.props.node_tree] : undefined;
      if (g && !used.has(g.id)) {
        used.add(g.id);
        walk(g.tree, depth + 1);
      }
    }
  };
  walk(ma.tree, 0);
  return hashString(JSON.stringify(ma.tree) + [...used].map((id) => JSON.stringify(doc.node_groups[id].tree)).join('') + ma.blend_method);
}

/** The preview image URL of a node (possibly from an older state while a new one renders). */
export function nodePreview(doc: DocumentData, ma: MaterialData, node: NodeData, treeKey: string): string | undefined {
  const id = `${ma.id}:${node.id}`;
  const key = `${treeKey}|${node.id}`;
  const e = entries.get(id);
  if (!e || e.key !== key) {
    if (pending.get(id)?.key !== key) {
      pending.set(id, { id, key, material: ma.id, node: node.id });
      lastRequest = performance.now();
    }
    install();
  }
  return e?.url;
}

/** A copy of the material whose output shows the node's first displayable output. */
function probeMaterial(doc: DocumentData, ma: MaterialData, nodeId: string): MaterialData | null {
  const probe: MaterialData = structuredClone(ma);
  probe.id = `__node_preview__${nodeId}`;
  probe.use_nodes = true;
  const tree = probe.tree;
  const ctx = ctxOf(doc, tree);
  const n = tree.nodes.find((x) => x.id === nodeId);
  if (!n) return null;
  n.mute = false;
  for (const o of tree.nodes) if (o.type === 'ShaderNodeOutputMaterial') o.props.is_active_output = false;
  const out = makeNode(tree, 'ShaderNodeOutputMaterial', [n.location[0] + 300, n.location[1]]);
  out.props.is_active_output = true;
  out.props.target = 'ALL';
  tree.nodes.push(out);
  const outs = nodeSockets(n, ctx).outputs;
  const shader = outs.find((s) => s.type === 'SHADER');
  if (shader) connect(ctx, n.id, shader.identifier, out.id, 'Surface');
  else {
    const s = outs.find((x) => canConvert(x.type, 'RGBA'));
    if (!s) return null;
    // values show as an unlit color
    const em = makeNode(tree, 'ShaderNodeEmission', [n.location[0] + 150, n.location[1]]);
    tree.nodes.push(em);
    connect(ctx, n.id, s.identifier, em.id, 'Color');
    connect(ctx, em.id, 'Emission', out.id, 'Surface');
  }
  return probe;
}

let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let mesh: Mesh | null = null;
let target: WebGLRenderTarget | null = null;
let buffer: Uint8Array | null = null;
let canvas: HTMLCanvasElement | null = null;

function setup() {
  scene = new Scene();
  camera = new PerspectiveCamera(30, 1, 0.1, 10);
  camera.position.set(0, -3.6, 0.6);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  mesh = new Mesh(new SphereGeometry(0.9, 48, 32));
  mesh.rotation.x = Math.PI / 2;
  scene.add(mesh);
  const key = new DirectionalLight(0xffffff, 2);
  key.position.set(-2, -3, 4);
  scene.add(key);
  target = new WebGLRenderTarget(SIZE, SIZE);
  target.texture.colorSpace = SRGBColorSpace;
  buffer = new Uint8Array(SIZE * SIZE * 4);
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
}

function renderPreview(ma: MaterialData, doc: DocumentData): string | undefined {
  const rc = renderContext;
  if (!rc || rc.engine.lost) return undefined;
  if (!scene) setup();
  const r = rc.engine.renderer;
  mesh!.material = compileMaterial(doc, ma);
  scene!.environment = rc.studio();
  const prev = r.getRenderTarget();
  const scissor = r.getScissorTest();
  r.setScissorTest(false);
  r.setRenderTarget(target);
  r.setClearColor(0x000000, 0);
  r.clear(true, true, true);
  r.render(scene!, camera!);
  r.readRenderTargetPixels(target!, 0, 0, SIZE, SIZE, buffer!);
  r.setRenderTarget(prev);
  r.setScissorTest(scissor);
  const img = new ImageData(SIZE, SIZE);
  // GL rows are bottom-up
  for (let y = 0; y < SIZE; y++) img.data.set(buffer!.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
  const g = canvas!.getContext('2d')!;
  g.putImageData(img, 0, 0);
  return canvas!.toDataURL();
}

function install() {
  if (installed || !renderContext) return;
  installed = true;
  renderContext.engine.frameCallbacks.add(step);
}

function step() {
  if (!pending.size || performance.now() - lastRequest < SETTLE_MS) return;
  const [id, job] = pending.entries().next().value as [string, Job];
  pending.delete(id);
  let url: string | undefined;
  try {
    // built from the current document (undo may have replaced the data since the request)
    const doc = app.doc;
    const ma = doc.materials[job.material];
    const probe = ma ? probeMaterial(doc, ma, job.node) : null;
    url = probe ? renderPreview(probe, doc) : undefined;
  } catch (e) {
    console.warn('Node preview failed', e);
  }
  entries.set(id, { key: job.key, url });
  for (const fn of listeners) fn();
}
