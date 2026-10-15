// Shader AOVs: materials write extra values with an AOV Output node; the view layer lists the
// AOVs to render (View Layer ▸ Shader AOV). Final renders produce one pass per AOV ("AOV <name>"),
// available as Render Layers outputs in the compositor.
import { Color, DoubleSide, MeshBasicMaterial, type Camera, type Material, type Mesh, type WebGLRenderer } from 'three';
import { defineFromRaw, getNodeType, registerNodeType } from '../../nodes/registry';
import { SHADER_MENU } from '../../nodes/shader/defs';
import { compileMaterial } from '../../nodes/shader/material';
import type { DocumentData, MaterialData, NodeData, NodeTreeData, RenderSettings } from '../../data/types';
import type { RenderScene } from '../final/renderscene';
import { floatTarget, renderOverride } from '../final/gbuffer';
import { materialSlots } from '../../editors/view3d/draw';
import { app, onAppReady } from '../../app/app';
import type { SocketDef } from '../../nodes/types';
import { h, type Child } from '../../ui/h';
import { panel } from '../../ui/widgets';
import { enumProp } from '../../ui/props';
import { uiList } from '../../editors/properties/uilist';

export type AovType = 'COLOR' | 'VALUE';

/** Pass name of an AOV in render results. */
export const aovPassName = (name: string) => `AOV ${name}`;

// ---------------------------------------------------------------------------
// AOV Output node (an output node: it does not take part in the material's shading)

if (!getNodeType('ShaderNodeOutputAOV')) {
  const d = defineFromRaw(
    'ShaderNodeOutputAOV',
    {
      label: 'AOV Output',
      width: 140,
      inputs: [
        ['Color', 'Color', 'RGBA', { d: [0, 0, 0, 1] }],
        ['Value', 'Value', 'FLOAT', { d: 0 }],
      ],
      outputs: [],
      props: [{ id: 'aov_name', name: 'Name', type: 'STRING', d: '' }],
    } as never,
    { category: 'output', treeTypes: ['SHADER'] },
  );
  d.description = 'Write a color and a value into the render pass of a shader AOV (View Layer ▸ Shader AOV)';
  registerNodeType(d);
  const out = SHADER_MENU.find((c) => c.label === 'Output');
  if (out && !out.items.some((i) => typeof i === 'object' && (i as { idname?: string }).idname === 'ShaderNodeOutputAOV')) {
    const at = out.items.findIndex((i) => typeof i === 'object' && (i as { idname?: string }).idname === 'ShaderNodeOutputMaterial');
    out.items.splice(at + 1, 0, { idname: 'ShaderNodeOutputAOV' } as never);
  }
}

/**
 * Tree that shades the material with the AOV's input as emission (only the active output
 * changes). Null when the material has no AOV Output with that name.
 */
export function aovTree(tree: NodeTreeData, name: string, type: AovType): NodeTreeData | null {
  const node = tree.nodes.find((n) => n.type === 'ShaderNodeOutputAOV' && (n.props.aov_name ?? '') === name);
  if (!node) return null;
  const socket = type === 'VALUE' ? 'Value' : 'Color';
  const link = tree.links.find((l) => l.to_node === node.id && l.to_socket === socket);
  const value = node.inputs[socket];
  const color = type === 'VALUE' ? [Number(value ?? 0), Number(value ?? 0), Number(value ?? 0), 1] : ((value as number[] | undefined) ?? [0, 0, 0, 1]);
  const emit: NodeData = { id: 'aovEmitNode', type: 'ShaderNodeEmission', name: 'AOV Emission', location: [0, 0], inputs: { Color: color, Strength: 1 }, props: {} } as NodeData;
  const out: NodeData = { id: 'aovOutputNode', type: 'ShaderNodeOutputMaterial', name: 'AOV Output', location: [200, 0], inputs: {}, props: { is_active_output: true, target: 'ALL' } } as NodeData;
  return {
    ...tree,
    nodes: [...tree.nodes.map((n) => (n.type === 'ShaderNodeOutputMaterial' ? { ...n, props: { ...n.props, is_active_output: false } } : n)), emit, out],
    links: [
      ...tree.links,
      ...(link ? [{ ...link, id: 'aovLink1', to_node: emit.id, to_socket: 'Color' }] : []),
      { id: 'aovLink2', from_node: emit.id, from_socket: 'Emission', to_node: out.id, to_socket: 'Surface' },
    ],
  } as NodeTreeData;
}

const black = new MeshBasicMaterial({ color: new Color(0, 0, 0), side: DoubleSide, toneMapped: false });

function aovMaterial(doc: DocumentData, ma: MaterialData | undefined, name: string, type: AovType): Material {
  const tree = ma?.use_nodes ? aovTree(ma.tree, name, type) : null;
  if (!ma || !tree) return black;
  const m = compileMaterial(doc, { ...ma, id: `${ma.id}#aov:${name}:${type}`, tree, blend_method: 'OPAQUE' });
  m.toneMapped = false;
  return m;
}

function read(renderer: WebGLRenderer, rt: ReturnType<typeof floatTarget>, W: number, H: number, channels: number): Float32Array {
  const buf = new Float32Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const out = new Float32Array(W * H * channels);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4,
        o = (y * W + x) * channels;
      for (let c = 0; c < channels; c++) out[o + c] = buf[i + c];
    }
  return out;
}

/** Render every view layer AOV of the scene (top-down rows; color RGBA, value 1 channel). */
export function aovPasses(renderer: WebGLRenderer, rs: RenderScene, camera: Camera, W: number, H: number, r: RenderSettings, doc: DocumentData): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  const aovs = (r.aovs ?? []).filter((a) => a.name);
  if (!aovs.length) return out;
  const shadows = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  const rt = floatTarget(W, H);
  try {
    for (const aov of aovs) {
      renderOverride(renderer, rs.scene, camera, rt, null, (m: Mesh) => {
        const ob = doc.objects[m.userData.id as string];
        const slots = ob ? materialSlots(doc, ob) : [];
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((_x, i) => aovMaterial(doc, doc.materials[slots[i] ?? ''], aov.name, aov.type));
        return mats.length === 1 ? mats[0] : mats;
      });
      out[aovPassName(aov.name)] = read(renderer, rt, W, H, aov.type === 'VALUE' ? 1 : 4);
    }
  } finally {
    rt.dispose();
    renderer.shadowMap.enabled = shadows;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render Layers outputs and the View Layer ▸ Shader AOV panel

onAppReady(() => {
  const d = getNodeType('CompositorNodeRLayers');
  if (!d || d.dynamicSockets) return;
  const base = d.outputs;
  d.dynamicSockets = () => ({
    inputs: d.inputs,
    outputs: [...base, ...(app.doc.scene.render.aovs ?? []).filter((a) => a.name).map((a) => ({ name: a.name, identifier: aovPassName(a.name), type: a.type === 'VALUE' ? 'FLOAT' : 'RGBA' }) as SocketDef)],
  });
});

const touch = (label: string) => {
  app.pushUndo(label);
  app.changed('doc');
};

/** Unique AOV name in the view layer. */
export function uniqueAovName(aovs: { name: string }[], base = 'AOV'): string {
  if (!aovs.some((a) => a.name === base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(3, '0')}`;
    if (!aovs.some((a) => a.name === n)) return n;
  }
}

export function aovPanel(r: RenderSettings): Child {
  const aovs = (r.aovs ??= []);
  const active = Math.min(Math.max(0, r.active_aov_index ?? 0), Math.max(0, aovs.length - 1));
  const a = aovs[active];
  return panel(
    'vl-aov',
    'Shader AOV',
    () => [
      uiList(
        'vl-aov-list',
        aovs.map((x, i) => ({ key: `${i}`, label: x.name, icon: 'render', right: h('span', { class: 'ul-meta' }, x.type === 'VALUE' ? 'Value' : 'Color') })),
        active,
        (i) => ((r.active_aov_index = i), app.changed('ui')),
        {
          add: () => {
            aovs.push({ name: uniqueAovName(aovs), type: 'COLOR' });
            r.active_aov_index = aovs.length - 1;
            touch('Add Shader AOV');
          },
          remove: () => {
            if (!aovs.length) return;
            aovs.splice(active, 1);
            r.active_aov_index = Math.max(0, active - 1);
            touch('Remove Shader AOV');
          },
          rename: (i, name) => {
            aovs[i].name = uniqueAovName(aovs.filter((_x, k) => k !== i), name.trim() || 'AOV');
            touch('Rename Shader AOV');
          },
        },
      ),
      a ? enumProp(a, 'type', 'Type', [['COLOR', 'Color'], ['VALUE', 'Value']], { tip: 'Whether the pass stores the AOV Output node’s Color or its Value' }) : null,
      h('div', { class: 'prop-note' }, 'Materials write into an AOV with an AOV Output node of the same name.'),
    ],
    { closed: true },
  );
}
