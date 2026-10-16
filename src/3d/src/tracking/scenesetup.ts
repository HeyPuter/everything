// Scene setup from a solved clip: footage behind the camera, a camera following the solve,
// foreground / background collections with a shadow catching ground and compositing nodes that
// put the render over the footage.
import { app, registerOperators } from '../app/app';
import { newObject, newMeshData, newLight, newCollection } from '../data/defaults';
import { uniqueName } from '../io/formats/common';
import * as prim from '../mesh/primitives';
import { addNode } from '../nodes/tree';
import { uid } from '../data/defaults';
import { compositingGroup, newCompositingGroup } from '../compositor/data';
import type { DocumentData, ObjectData } from '../data/types';
import { contextClip } from './ops';
import { ensureCameraSolver, ensureSceneCamera, copyLensToCamera } from './solveops';
import { setClipBackground } from './camerabg';
import { isCameraActive, type MovieClipData } from './types';
import './camerabg';

function childCollection(doc: DocumentData, name: string): string {
  const master = doc.collections[doc.scene.collection];
  const existing = master.children.find((id) => doc.collections[id]?.name === name);
  if (existing) return existing;
  const col = newCollection(name);
  doc.collections[col.id] = col;
  master.children.push(col.id);
  return col.id;
}

/** Add an object to a collection (not the active one), keeping the selection. */
function placeObject(doc: DocumentData, ob: ObjectData, collection: string) {
  ob.name = uniqueName(doc, ob.name);
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[collection].objects.push(ob.id);
}

function moveToCollection(doc: DocumentData, id: string, collection: string) {
  for (const c of Object.values(doc.collections)) c.objects = c.objects.filter((o) => o !== id);
  doc.collections[collection].objects.push(id);
}

function meshObject(doc: DocumentData, name: string, arrays: ReturnType<typeof prim.cube>): ObjectData {
  const me = newMeshData(uniqueName(doc, name, 'meshes'), arrays);
  doc.meshes[me.id] = me;
  return newObject(name, 'MESH', me.id);
}

/** Compositing: footage under the render (Movie Clip → Alpha Over ← Render Layers). */
function setupCompositing(doc: DocumentData, clip: MovieClipData) {
  const g = compositingGroup(doc) ?? newCompositingGroup(doc);
  const tree = g.tree;
  if (tree.nodes.some((n) => n.type === 'CompositorNodeMovieClip' && n.props.clip === clip.id)) return;
  const rl = tree.nodes.find((n) => n.type === 'CompositorNodeRLayers');
  const out = tree.nodes.find((n) => n.type === 'NodeGroupOutput');
  if (!rl || !out) return;
  const mc = addNode(tree, 'CompositorNodeMovieClip', [rl.location[0], rl.location[1] + 260], { clip: clip.id });
  const over = addNode(tree, 'CompositorNodeAlphaOver', [rl.location[0] + 320, rl.location[1] + 80]);
  const link = (a: string, as: string, b: string, bs: string) => tree.links.push({ id: uid('link'), from_node: a, from_socket: as, to_node: b, to_socket: bs });
  // whatever fed the output now goes through the Alpha Over as foreground
  const outLinks = tree.links.filter((l) => l.to_node === out.id);
  tree.links = tree.links.filter((l) => l.to_node !== out.id && !(l.from_node === rl.id && l.from_socket === 'Image'));
  link(mc.id, 'Image', over.id, 'Background');
  link(rl.id, 'Image', over.id, 'Foreground');
  const socket = outLinks[0]?.to_socket ?? 'Socket_1';
  link(over.id, 'Image', out.id, socket);
  const viewer = tree.nodes.find((n) => n.type === 'CompositorNodeViewer');
  if (viewer) {
    tree.links = tree.links.filter((l) => l.to_node !== viewer.id);
    link(over.id, 'Image', viewer.id, 'Image');
  }
  doc.scene.render.film_transparent = true;
}

registerOperators([
  {
    idname: 'clip.set_viewport_background',
    label: 'Set as Background',
    description: "Show the clip behind the scene camera in the 3D viewport's camera view",
    poll: (ctx) => !!contextClip(ctx),
    exec: (ctx) => {
      const c = contextClip(ctx)!;
      const ob = ensureSceneCamera(ctx.doc);
      const ca = ctx.doc.cameras[ob.data!];
      if (!ca) return 'CANCELLED';
      setClipBackground(ca, c.id);
      app.report('INFO', `"${c.name}" is shown behind camera "${ob.name}"`);
    },
  },
  {
    idname: 'clip.setup_tracking_scene',
    label: 'Setup Tracking Scene',
    description: 'Prepare the scene for compositing 3D objects into the footage: camera following the solve, footage background, foreground and background collections, a shadow catching ground and compositing nodes',
    poll: (ctx) => {
      const c = contextClip(ctx);
      return !!c && c.size[0] > 0 && isCameraActive(c) && ctx.doc.mode === 'OBJECT';
    },
    exec: (ctx) => {
      const doc = ctx.doc;
      const c = contextClip(ctx)!;
      doc.scene.active_clip = c.id;
      // frames and resolution follow the footage
      doc.scene.frame_start = c.frame_start;
      doc.scene.frame_end = c.frame_start + Math.max(1, c.frame_duration) - 1;
      if (c.fps > 0) doc.scene.render.fps = Math.round(c.fps);
      doc.scene.render.resolution_x = c.size[0];
      doc.scene.render.resolution_y = c.size[1];
      // camera
      const cam = ensureSceneCamera(doc);
      ensureCameraSolver(cam);
      copyLensToCamera(doc, c, cam);
      setClipBackground(doc.cameras[cam.data!], c.id);
      // collections
      const fg = childCollection(doc, 'foreground');
      const bg = childCollection(doc, 'background');
      const scene = Object.values(doc.objects);
      if (!scene.some((o) => o.name.startsWith('Ground') && o.type === 'MESH')) {
        const ground = meshObject(doc, 'Ground', prim.plane(8));
        ground.is_shadow_catcher = true;
        placeObject(doc, ground, bg);
      }
      if (!scene.some((o) => o.type === 'LIGHT')) {
        const la = newLight('SUN');
        doc.lights[la.id] = la;
        const sun = newObject('Sun', 'LIGHT', la.id);
        sun.location = [4, -4, 8];
        sun.rotation_euler = [0.6, 0.2, 0.5];
        placeObject(doc, sun, fg);
      }
      // objects of the scene's root collection that render (meshes) move to the foreground
      const master = doc.collections[doc.scene.collection];
      for (const id of [...master.objects]) {
        const o = doc.objects[id];
        if (o && o.type !== 'CAMERA' && o.type !== 'LIGHT') moveToCollection(doc, id, fg);
      }
      setupCompositing(doc, c);
      for (const id of Object.keys(doc.objects)) app.graph.invalidate(id);
      app.report('INFO', 'Tracking scene set up: camera follows the solve, footage is the background');
    },
  },
]);
