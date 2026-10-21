// World operators: create a world, and move the world's volume onto a mesh (a box around the
// scene with a material that has the same volume shader), so it can be bounded, moved or keyed.
import { app, registerOperators } from '../../app/app';
import { newWorld, newMaterial, newMeshData, newObject, uid } from '../../data/defaults';
import { addObjectToScene, uniqueName } from '../../ops/object';
import * as prim from '../../mesh/primitives';
import type { DocumentData, NodeTreeData, WorldData } from '../../data/types';
import { h, type Child, type VNode } from '../../ui/h';
import { opButton } from '../../ui/widgets';
import { extendTab } from '../../editors/properties/more/insert';

function worldOutput(tree: NodeTreeData) {
  return tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld' && n.props.is_active_output !== false) ?? tree.nodes.find((n) => n.type === 'ShaderNodeOutputWorld');
}

/** Link into the world output's Volume input, if any. */
export function worldVolumeLink(w: WorldData | null | undefined) {
  const tree = w?.tree;
  if (!tree) return null;
  const out = worldOutput(tree);
  return (out && tree.links.find((l) => l.to_node === out.id && l.to_socket === 'Volume')) ?? null;
}

/** Ids of the nodes feeding `nodeId` (itself included). */
export function upstreamNodes(tree: NodeTreeData, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const l of tree.links) if (l.to_node === id && !out.has(l.from_node)) (out.add(l.from_node), stack.push(l.from_node));
  }
  return out;
}

/** Centre and size of a box around the scene's renderable objects (at least 10 units wide). */
function sceneBox(doc: DocumentData): { center: [number, number, number]; size: [number, number, number] } {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const ob of Object.values(doc.objects)) {
    if (ob.hide_render) continue;
    const ev = app.graph.get(ob.id);
    if (!ev) continue;
    const e = ev.world.elements;
    const p = [e[12], e[13], e[14]];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  if (!isFinite(min[0])) return { center: [0, 0, 0], size: [10, 10, 10] };
  const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2) as [number, number, number];
  const size = [0, 1, 2].map((i) => Math.max(10, (max[i] - min[i]) * 1.5)) as [number, number, number];
  return { center, size };
}

registerOperators([
  {
    idname: 'world.new',
    label: 'New World',
    description: 'Create a new world (a copy of the scene’s world when it has one) and use it in the scene',
    exec: (ctx) => {
      const doc = ctx.doc;
      const cur = doc.scene.world ? doc.worlds[doc.scene.world] : null;
      const w: WorldData = cur ? { ...structuredClone(cur), id: uid('wo') } : newWorld();
      w.name = uniqueName(doc, cur?.name ?? 'World', 'worlds' as never);
      delete (w as { library?: unknown }).library;
      delete (w as { asset_data?: unknown }).asset_data;
      doc.worlds[w.id] = w;
      doc.scene.world = w.id;
      return 'FINISHED';
    },
  },
  {
    idname: 'world.convert_volume_to_mesh',
    label: 'Convert Volume',
    description: 'Move the world’s volume shader onto a box mesh around the scene, so the fog has bounds and can be edited like an object',
    poll: () => {
      const doc = app.doc;
      return doc.mode === 'OBJECT' && !!worldVolumeLink(doc.scene.world ? doc.worlds[doc.scene.world] : null);
    },
    exec: (ctx) => {
      const doc = ctx.doc;
      const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
      const link = worldVolumeLink(w);
      if (!w || !link) return 'CANCELLED';
      const tree = w.tree;
      // the volume shader and everything feeding it, copied into a new material
      const ids = upstreamNodes(tree, link.from_node);
      const ma = newMaterial(uniqueName(doc, w.name, 'materials'));
      const out = ma.tree.nodes.find((n) => n.type === 'ShaderNodeOutputMaterial')!;
      ma.tree.nodes = ma.tree.nodes.filter((n) => n === out);
      ma.tree.links = [];
      const map = new Map<string, string>();
      for (const n of tree.nodes) {
        if (!ids.has(n.id)) continue;
        const c = structuredClone(n);
        c.id = uid('node');
        map.set(n.id, c.id);
        ma.tree.nodes.push(c);
      }
      for (const l of tree.links) if (ids.has(l.from_node) && ids.has(l.to_node)) ma.tree.links.push({ ...structuredClone(l), id: uid('link'), from_node: map.get(l.from_node)!, to_node: map.get(l.to_node)! });
      ma.tree.links.push({ id: uid('link'), from_node: map.get(link.from_node)!, from_socket: link.from_socket, to_node: out.id, to_socket: 'Volume' });
      doc.materials[ma.id] = ma;
      // remove the volume from the world (its nodes stay, unlinked)
      tree.links = tree.links.filter((l) => l !== link);
      // a box around the scene
      const box = sceneBox(doc);
      const me = newMeshData(uniqueName(doc, 'World Volume', 'meshes'), prim.cube(2));
      me.materials = [ma.id];
      doc.meshes[me.id] = me;
      const ob = newObject('World Volume', 'MESH', me.id);
      addObjectToScene(doc, ob, { location: box.center });
      ob.scale = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
      ob.display_type = 'WIRE';
      app.report('INFO', `Converted the world volume to “${ob.name}”`);
      return 'FINISHED';
    },
  },
]);

// World ▸ Volume: the conversion button under the volume shader
extendTab('WORLD', (out) => {
  const doc = app.doc;
  const w = doc.scene.world ? doc.worlds[doc.scene.world] : null;
  if (!worldVolumeLink(w)) return out;
  const list = Array.isArray(out) ? out.flat(4) : [out];
  for (const c of list) {
    const v = c as VNode | null;
    if (!v || typeof v !== 'object' || v.key !== 'wo-volume') continue;
    const body = v.children?.find((x) => (x.attrs?.class as string | undefined) === 'panel-body');
    body?.children.push(h('div', { class: 'btn-row' }, opButton('world.convert_volume_to_mesh', 'Convert Volume', {}, { tip: 'Move the volume onto a box mesh around the scene' })));
  }
  return list as Child[];
});
