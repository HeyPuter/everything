// IR → document conversion shared by all importers.
// Coordinate conversion: every node matrix is conjugated by G = unitScale·Axis
// (L' = G L G⁻¹) and vertex data is multiplied by G, so an object with identity rotation in the
// file keeps identity rotation in the document (the glTF importer's convention).
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { ArmatureData, Bone, DocumentData, FCurve, ID, ImageData, Keyframe, MeshData, ObjectData, ShapeKey } from '../../data/types';
import { newArmature, newCamera, newLight, newMeshData, newObject, newAction, newImage, uid } from '../../data/defaults';
import { buildMesh, type PolyFace } from '../../mesh/mesh';
import { boneRotation, defaultPoseBone } from '../../eval/armature';
import { newModifier } from '../../eval/modifiers';
import { setRotationFromQuaternion } from '../../eval/transform';
import { newKeyframe, calcHandles } from '../../anim/fcurve';
import type { IRChannel, IRMesh, IRNode, IRScene, M4 } from './ir';
import { basisMatrix, decompose, defaultCollection, hasShear, imageSize, uniqueName, withoutScale, applyBasis, sniffMime } from './common';
import { buildMaterial } from './material-nodes';

export interface CommitOptions {
  /** target collection id (default: the active object's collection / first child collection) */
  collection?: ID;
  /** select imported objects and make the first root active (default true) */
  select?: boolean;
  /** merge vertices with identical positions (glTF "Merge Vertices") */
  mergeVertices?: boolean;
  /** shading: derive from normals (default), or force flat/smooth */
  shading?: 'NORMALS' | 'FLAT' | 'SMOOTH';
  /** bone orientation: 'AUTO' picks the joint axis pointing at children; 'Y' keeps the joint's Y axis */
  boneDirection?: 'AUTO' | 'Y';
  /** set the scene frame range to the animation range (default true) */
  setFrameRange?: boolean;
  /** frames per second for converting times (default: scene fps) */
  fps?: number;
  /** when the file stores times in frames already */
  timeIsFrames?: boolean;
}

export interface CommitResult {
  objects: ObjectData[];
  warnings: string[];
}

interface NodeInfo {
  /** doc-space local matrix (static) */
  local: Matrix4;
  /** doc-space world matrix (static) */
  world: Matrix4;
  /** bone name if this node became a bone */
  bone?: string;
  armature?: ArmatureInfo;
}

interface ArmatureInfo {
  object: ObjectData;
  data: ArmatureData;
  /** armature world at import (doc space) */
  A0: Matrix4;
  A0inv: Matrix4;
  /** node index → bone data */
  bones: Map<number, { name: string; rest: Matrix4; restInv: Matrix4; bind: Matrix4; ibm: Matrix4; parentNode: number; length: number }>;
  /** node that the armature object represents (if it was a non-joint root) */
  rootNode: number;
  /** for synthetic armatures: node whose frame the armature sits in (-1 = scene root) */
  parentNode: number;
}

const TMP = new Matrix4();

export function commitScene(doc: DocumentData, ir: IRScene, opts: CommitOptions = {}): CommitResult {
  const warnings = [...ir.warnings];
  const rootMode = ir.unitScaleMode === 'ROOT';
  const X = basisMatrix(ir.axis, ir.unitScale);
  const G = rootMode ? new Matrix4() : X;
  /** root conversion (axis + unit) in ROOT mode */
  const rootScale = rootMode ? X.clone() : null;
  const Ginv = G.clone().invert();
  const Arot = basisMatrix(ir.axis, 1);
  const conj = (m: M4 | Matrix4) => {
    const mm = m instanceof Matrix4 ? m : new Matrix4().fromArray(m);
    return G.clone().multiply(mm).multiply(Ginv);
  };
  const fps = opts.fps ?? doc.scene.render.fps / (doc.scene.render.fps_base || 1);
  const collection = opts.collection && doc.collections[opts.collection] ? opts.collection : defaultCollection(doc);
  const created: ObjectData[] = [];
  const taken = {
    objects: new Set(Object.values(doc.objects).map((o) => o.name)),
  };

  // ---------------------------------------------------------------- images
  // images only used for data (normals, roughness, ...) are non-color unless the file says otherwise
  const colorUse = new Set<number>(),
    dataUse = new Set<number>();
  for (const m of ir.materials) {
    for (const r of [m.baseColorTex, m.emissiveTex]) if (r) colorUse.add(r.image);
    for (const r of [m.metallicRoughnessTex, m.metallicTex, m.roughnessTex, m.normalTex, m.bumpTex, m.occlusionTex, m.alphaTex, m.transmissionTex]) if (r) dataUse.add(r.image);
  }
  ir.images.forEach((im, i) => {
    if (!im.colorspace && dataUse.has(i) && !colorUse.has(i)) im.colorspace = 'Non-Color';
  });
  const imageIds: (ID | null)[] = ir.images.map((im) => {
    let img: ImageData;
    if (im.bytes && im.bytes.length) {
      const { width, height } = imageSize(im.bytes);
      const mime = im.mime && im.mime !== 'application/octet-stream' ? im.mime : sniffMime(im.bytes, im.uri ?? im.name);
      img = {
        id: uid('im'),
        name: uniqueName(doc, im.name || 'Image', 'images'),
        mime,
        bytes: im.bytes,
        width: width || 1,
        height: height || 1,
        source: 'FILE',
        colorspace: im.colorspace ?? 'sRGB',
        alpha_mode: 'STRAIGHT',
        filepath: im.uri ?? '',
        revision: 0,
      };
      if (!width) warnings.push(`Image "${im.name}": unknown or unsupported image format (${mime})`);
    } else {
      img = newImage(uniqueName(doc, im.name || 'Image', 'images'), 64, 64, 'BLANK', [1, 0, 1, 1]);
      img.filepath = im.uri ?? '';
      warnings.push(`Image "${im.uri ?? im.name}" was not found; a placeholder is used`);
    }
    doc.images[img.id] = img;
    return img.id;
  });

  // ---------------------------------------------------------------- materials
  const materialIds: ID[] = ir.materials.map((m) => {
    const ma = buildMaterial(m, imageIds, uniqueName(doc, m.name || 'Material', 'materials'));
    doc.materials[ma.id] = ma;
    if (m.occlusionTex) warnings.push(`Material "${m.name}": ambient occlusion textures are not supported and were ignored`);
    return ma.id;
  });

  // ---------------------------------------------------------------- meshes
  const meshCache = new Map<string, MeshData>();
  /** skinned meshes are in bind (world) space, so the unit scale is always baked into them */
  const meshFor = (index: number, skinned = false): MeshData => {
    const key = `${index}|${skinned && rootMode ? 'S' : ''}`;
    let me = meshCache.get(key);
    if (!me) {
      me = convertMesh(ir.meshes[index], ir, opts, warnings, skinned && rootMode);
      me.name = uniqueName(doc, me.name, 'meshes');
      me.materials = ir.meshes[index].materials.map((i) => (i >= 0 ? (materialIds[i] ?? null) : null));
      doc.meshes[me.id] = me;
      meshCache.set(key, me);
    }
    return me;
  };

  // ---------------------------------------------------------------- static transforms
  const nodes = ir.nodes;
  const children: number[][] = nodes.map(() => []);
  nodes.forEach((n, i) => {
    if (n.parent >= 0 && n.parent < nodes.length) children[n.parent].push(i);
  });
  const info: NodeInfo[] = nodes.map((n) => ({ local: conj(n.matrix), world: new Matrix4() }));
  if (rootScale) nodes.forEach((n, i) => (n.parent < 0 || n.parent >= nodes.length) && info[i].local.premultiply(rootScale));
  const order: number[] = [];
  const visit = (i: number) => {
    order.push(i);
    const p = nodes[i].parent;
    info[i].world.copy(p >= 0 ? TMP.multiplyMatrices(info[p].world, info[i].local) : info[i].local);
    for (const c of children[i]) visit(c);
  };
  nodes.forEach((n, i) => {
    if (n.parent < 0 || n.parent >= nodes.length) visit(i);
  });

  // ---------------------------------------------------------------- armatures from skins
  const animatedRot = new Set<number>();
  for (const a of ir.animations) for (const c of a.channels) if (c.path === 'rotation' || c.path === 'matrix') animatedRot.add(c.node);
  const armatures: ArmatureInfo[] = [];
  const jointArmature = new Map<number, ArmatureInfo>();
  if (ir.skins.length) buildArmatures();

  function ancestors(i: number): number[] {
    const out: number[] = [];
    for (let p = nodes[i].parent; p >= 0; p = nodes[p].parent) out.push(p);
    return out;
  }

  function buildArmatures() {
    // group skins sharing joints (union-find over skins)
    const parent = ir.skins.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const owner = new Map<number, number>();
    ir.skins.forEach((s, si) =>
      s.joints.forEach((j) => {
        const o = owner.get(j);
        if (o === undefined) owner.set(j, si);
        else parent[find(si)] = find(o);
      }),
    );
    const groups = new Map<number, number[]>();
    ir.skins.forEach((_, si) => {
      const r = find(si);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(si);
    });
    for (const skinIdx of groups.values()) {
      const joints = new Set<number>();
      for (const si of skinIdx) for (const j of ir.skins[si].joints) if (j >= 0 && j < nodes.length) joints.add(j);
      if (!joints.size) continue;
      // lowest common ancestor of all joints
      const jl = [...joints];
      let chain = [jl[0], ...ancestors(jl[0])];
      for (const j of jl.slice(1)) {
        const set = new Set([j, ...ancestors(j)]);
        chain = chain.filter((c) => set.has(c));
      }
      const lca = chain.length ? chain[0] : -1;
      // bone set = joints + nodes between joints and the lca
      const boneSet = new Set<number>(jl);
      for (const j of jl) {
        if (j === lca) continue;
        for (const a of ancestors(j)) {
          if (a === lca) break;
          boneSet.add(a);
        }
      }
      // skeleton descendants (e.g. leaf/end bones) join the armature as bones
      const addSkeletonKids = (b: number) => {
        for (const c of children[b])
          if (nodes[c].isBone && !boneSet.has(c) && !jointArmature.has(c)) {
            boneSet.add(c);
            addSkeletonKids(c);
          }
      };
      for (const b of [...boneSet]) addSkeletonKids(b);
      const plain = (i: number) => i >= 0 && nodes[i].mesh === undefined && !nodes[i].camera && !nodes[i].light && nodes[i].skin === undefined;
      let armNode = -1;
      let armParent = -1;
      if (lca >= 0 && !joints.has(lca) && plain(lca)) {
        armNode = lca; // non-joint root becomes the armature object
        boneSet.delete(lca);
      } else if (lca >= 0) {
        boneSet.add(lca);
        // a plain parent of the root joint (e.g. an exported "Armature" node) becomes the armature object
        const p = nodes[lca].parent;
        if (plain(p) && !jointArmature.has(p) && children[p].every((c) => c === lca || boneSet.has(c) || nodes[c].skin !== undefined)) armNode = p;
        else armParent = p;
      }
      const skinName = ir.skins[skinIdx[0]].name;
      const armName = armNode >= 0 ? nodes[armNode].name || 'Armature' : skinName || 'Armature';
      const data = newArmature(uniqueName(doc, armName, 'armatures'));
      doc.armatures[data.id] = data;
      const ob = newObject(uniqueName(doc, armName, 'objects', taken.objects), 'ARMATURE', data.id);
      ob.pose = {};
      const A0 = armNode >= 0 ? info[armNode].world.clone() : armParent >= 0 ? info[armParent].world.clone() : new Matrix4();
      const ai: ArmatureInfo = { object: ob, data, A0, A0inv: A0.clone().invert(), bones: new Map(), rootNode: armNode, parentNode: armNode >= 0 ? -1 : armParent };
      armatures.push(ai);
      if (armNode >= 0) info[armNode].armature = ai;
      // inverse bind matrices (doc space)
      const ibm = new Map<number, Matrix4>();
      for (const si of skinIdx) {
        const s = ir.skins[si];
        s.joints.forEach((j, k) => {
          if (ibm.has(j)) return;
          const m = s.inverseBind[k];
          if (!m) return;
          // world(bind) = Jw · IBM · v ; with the unit scale on roots joint frames carry the scale,
          // so IBM_doc = S⁻¹ · (G_full · IBM · G_full⁻¹)
          // ROOT mode: bind-space vertices are converted by X, so IBM_doc = IBM · X⁻¹
          if (rootScale) ibm.set(j, new Matrix4().fromArray(m).multiply(X.clone().invert()));
          else ibm.set(j, conj(m));
        });
      }
      // bind worlds top-down
      const sorted = order.filter((i) => boneSet.has(i));
      const bind = new Map<number, Matrix4>();
      const names = new Set<string>();
      for (const b of sorted) {
        const p = nodes[b].parent;
        const parentBind = boneSet.has(p) ? bind.get(p)! : A0;
        const ib = ibm.get(b);
        const bw = ib ? ib.clone().invert() : parentBind.clone().multiply(info[b].local);
        if (!Number.isFinite(bw.elements[0]) || Math.abs(bw.determinant()) < 1e-12) bw.copy(parentBind.clone().multiply(info[b].local));
        bind.set(b, bw);
        let name = nodes[b].name || `Bone${b}`;
        if (names.has(name)) {
          let k = 1;
          while (names.has(`${name}.${String(k).padStart(3, '0')}`)) k++;
          name = `${name}.${String(k).padStart(3, '0')}`;
        }
        names.add(name);
        info[b].bone = name;
        info[b].armature = ai;
        jointArmature.set(b, ai);
      }
      // rest matrices, lengths, bones
      const boneOf = (b: number) => ai.bones.get(b);
      for (const b of sorted) {
        const bw = bind.get(b)!;
        const restNoScale = ai.A0inv.clone().multiply(withoutScale(bw));
        // pick the bone axis
        const kids = children[b].filter((c) => boneSet.has(c));
        const head = new Vector3().setFromMatrixPosition(restNoScale);
        const kidHeads = kids.map((c) => new Vector3().setFromMatrixPosition(ai.A0inv.clone().multiply(bind.get(c)!)));
        let fix = new Matrix4();
        let length = 0;
        const axes = [new Vector3(), new Vector3(), new Vector3()];
        restNoScale.extractBasis(axes[0], axes[1], axes[2]);
        if (kidHeads.length) {
          const avg = kidHeads.reduce((acc, v) => acc.add(v), new Vector3()).multiplyScalar(1 / kidHeads.length);
          const dir = avg.clone().sub(head);
          const dist = dir.length();
          if (dist > 1e-6) {
            dir.normalize();
            if (opts.boneDirection !== 'Y') {
              let best = 1,
                bestSign = 1,
                bestDot = -2;
              for (let a = 0; a < 3; a++)
                for (const s of [1, -1]) {
                  const d = axes[a].dot(dir) * s;
                  if (d > bestDot + 1e-6) {
                    bestDot = d;
                    best = a;
                    bestSign = s;
                  }
                }
              fix = axisFix(best, bestSign);
            }
            const yAxis = new Vector3(0, 1, 0).applyMatrix4(new Matrix4().extractRotation(restNoScale.clone().multiply(fix)));
            length = Math.max(Math.abs(yAxis.dot(avg.clone().sub(head))), dist * 0.25);
          }
        }
        const rest = restNoScale.clone().multiply(fix);
        const ib = ibm.get(b) ?? bw.clone().invert();
        ai.bones.set(b, { name: info[b].bone!, rest, restInv: rest.clone().invert(), bind: bw, ibm: ib, parentNode: boneSet.has(nodes[b].parent) ? nodes[b].parent : -1, length });
      }
      // default lengths for leaves: parent's length or a scene-relative size
      let maxLen = 0;
      for (const v of ai.bones.values()) maxLen = Math.max(maxLen, v.length);
      for (const b of sorted) {
        const bd = boneOf(b)!;
        const hint = nodes[b].boneLength;
        if (hint && hint > 0)
          bd.length = hint * (rootMode ? 1 : ir.unitScale); // ROOT mode: armature space keeps source units
        else if (bd.length <= 1e-6) bd.length = (bd.parentNode >= 0 ? boneOf(bd.parentNode)?.length : 0) || maxLen * 0.5 || 0.1;
      }
      for (const b of sorted) {
        const bd = boneOf(b)!;
        const head = new Vector3().setFromMatrixPosition(bd.rest);
        const y = new Vector3(),
          x = new Vector3(),
          z = new Vector3();
        bd.rest.extractBasis(x, y, z);
        const tail = head.clone().addScaledVector(y, bd.length);
        const roll = rollFrom(bd.rest, y);
        const bone: Bone = {
          name: bd.name,
          parent: bd.parentNode >= 0 ? boneOf(bd.parentNode)!.name : null,
          head: [head.x, head.y, head.z],
          tail: [tail.x, tail.y, tail.z],
          roll,
          use_connect: false,
          use_deform: true,
          use_inherit_rotation: true,
          inherit_scale: 'FULL',
          envelope_distance: 0.25,
          head_radius: 0.1,
          tail_radius: 0.05,
          bbone_segments: 1,
        };
        data.bones.push(bone);
        // exact rest matrix as the document will rebuild it from head/tail/roll
        const rebuilt = boneRotation(y, roll);
        rebuilt.setPosition(head);
        bd.rest.copy(rebuilt);
        bd.restInv.copy(rebuilt).invert();
        const pb = defaultPoseBone();
        pb.rotation_mode = 'QUATERNION';
        ob.pose![bd.name] = pb;
      }
      // static pose
      for (const b of sorted) {
        const bd = boneOf(b)!;
        const local = boneLocal(ai, b, info[b].local);
        writePose(ob.pose![bd.name], local);
      }
    }
  }

  function boneLocal(ai: ArmatureInfo, b: number, nodeLocal: Matrix4): Matrix4 {
    const bd = ai.bones.get(b)!;
    const parentBind = bd.parentNode >= 0 ? ai.bones.get(bd.parentNode)!.bind : ai.A0;
    // E = A0⁻¹ · B_parent · L(t) · IBM · A0 ; local = rest⁻¹ · E · rest
    const E = ai.A0inv.clone().multiply(parentBind).multiply(nodeLocal).multiply(bd.ibm).multiply(ai.A0);
    return bd.restInv.clone().multiply(E).multiply(bd.rest);
  }

  // ---------------------------------------------------------------- objects
  // Each created object gets a placement record: local = pre · (node local) · post.
  interface Placement {
    ob: ObjectData;
    node: number;
    pre: Matrix4 | null;
    post: Matrix4 | null;
    /** false: the object sits at the node frame of `node` without its own channel (e.g. bone attachments) */
    useNodeLocal: boolean;
    /** static local override (synthetic armatures, skinned meshes) */
    fixed?: Matrix4;
  }
  const placements: Placement[] = [];
  const meshObjectsByNode = new Map<number, ObjectData>();
  const nodeObject = new Map<number, ObjectData>(); // node → object representing the node frame
  const addObject = (ob: ObjectData) => {
    doc.objects[ob.id] = ob;
    doc.object_order.push(ob.id);
    doc.collections[collection].objects.push(ob.id);
    created.push(ob);
  };

  const makeAttachment = (n: IRNode): ObjectData | null => {
    if (n.camera) {
      const ca = newCamera(uniqueName(doc, n.name || 'Camera', 'cameras'));
      const c = n.camera;
      ca.type = c.type;
      if (c.type === 'PERSP') {
        if (c.lens) {
          ca.lens = c.lens;
          if (c.sensorWidth) ca.sensor_width = c.sensorWidth;
          if (c.sensorHeight) ca.sensor_height = c.sensorHeight;
          ca.sensor_fit = c.sensorFit ?? 'AUTO';
        } else if (c.yfov) {
          ca.sensor_fit = 'VERTICAL';
          ca.lens = ca.sensor_height / 2 / Math.tan(c.yfov / 2);
        }
      } else if (c.orthoScale) ca.ortho_scale = c.orthoScale * (c.scaleClip ? ir.unitScale : 1);
      const k = c.scaleClip ? ir.unitScale : 1;
      if (c.clipStart !== undefined && c.clipStart > 0) ca.clip_start = c.clipStart * k;
      if (c.clipEnd !== undefined && Number.isFinite(c.clipEnd) && c.clipEnd > 0) ca.clip_end = c.clipEnd * k;
      if (c.shiftX) ca.shift_x = c.shiftX;
      if (c.shiftY) ca.shift_y = c.shiftY;
      doc.cameras[ca.id] = ca;
      const ob = newObject(uniqueName(doc, n.name || 'Camera', 'objects', taken.objects), 'CAMERA', ca.id);
      if (!doc.scene.camera) doc.scene.camera = ob.id;
      return ob;
    }
    if (n.light) {
      const l = n.light;
      const la = newLight(l.type, uniqueName(doc, n.name || 'Light', 'lights'));
      la.color = [...l.color];
      la.energy = l.energy;
      if (l.spotSize !== undefined) la.spot_size = Math.min(Math.PI, Math.max(1e-3, l.spotSize));
      if (l.spotBlend !== undefined) la.spot_blend = Math.min(1, Math.max(0, l.spotBlend));
      if (l.radius !== undefined) la.shadow_soft_size = l.radius * ir.unitScale;
      if (l.size !== undefined) la.size = l.size * ir.unitScale;
      if (l.sizeY !== undefined) la.size_y = l.sizeY * ir.unitScale;
      if (l.shape) la.shape = l.shape;
      if (l.range !== undefined && Number.isFinite(l.range) && l.range > 0) {
        la.use_custom_distance = true;
        la.cutoff_distance = l.range * ir.unitScale;
      }
      if (l.castShadow === false) la.use_shadow = false;
      doc.lights[la.id] = la;
      return newObject(uniqueName(doc, n.name || 'Light', 'objects', taken.objects), 'LIGHT', la.id);
    }
    return null;
  };
  const correction = (n: IRNode) => {
    const K = n.attachCorrection ? new Matrix4().fromArray(n.attachCorrection) : new Matrix4();
    // ROOT mode keeps local frames, so the correction stays in source terms
    return rootMode ? K : Arot.clone().multiply(K);
  };
  const newMeshObject = (i: number) => {
    const me = meshFor(nodes[i].mesh!, nodes[i].skin !== undefined && !!ir.skins[nodes[i].skin!]);
    const ob = newObject(uniqueName(doc, nodes[i].name || me.name, 'objects', taken.objects), 'MESH', me.id);
    meshObjectsByNode.set(i, ob);
    return ob;
  };

  for (const ai of armatures) {
    addObject(ai.object);
    if (ai.rootNode >= 0) {
      nodeObject.set(ai.rootNode, ai.object);
      placements.push({ ob: ai.object, node: ai.rootNode, pre: null, post: null, useNodeLocal: true });
    } else placements.push({ ob: ai.object, node: ai.parentNode, pre: null, post: null, useNodeLocal: false, fixed: ai.A0.clone() });
  }

  for (const i of order) {
    const n = nodes[i];
    const inf = info[i];
    if (inf.bone) {
      // attachments on bones become bone-parented objects at the joint frame
      let att: ObjectData | null = null;
      if (n.mesh !== undefined && n.skin === undefined) att = newMeshObject(i);
      else if (n.camera || n.light) att = makeAttachment(n);
      if (att) {
        addObject(att);
        placements.push({ ob: att, node: i, pre: null, post: n.mesh === undefined ? correction(n) : null, useNodeLocal: false });
      }
      continue;
    }
    if (nodeObject.has(i)) continue; // armature root node
    if (n.mesh !== undefined && n.skin !== undefined && ir.skins[n.skin]) {
      const ob = newMeshObject(i);
      const skin = ir.skins[n.skin];
      const firstJoint = skin.joints.find((j) => jointArmature.has(j));
      const ai = firstJoint !== undefined ? jointArmature.get(firstJoint) : undefined;
      const me = doc.meshes[ob.data!];
      addObject(ob);
      if (ai) {
        // skinned vertices are in bind space (= world at import): parent to the armature, world = I
        ob.parent = ai.object.id;
        placements.push({ ob, node: -1, pre: null, post: null, useNodeLocal: false, fixed: ai.A0inv.clone() });
        const mod = newModifier('ARMATURE', uid('md'), ob.modifiers);
        mod.object = ai.object.id;
        ob.modifiers.push(mod);
        me.vertex_groups = me.vertex_groups.map((g, gi) => {
          const j = skin.joints[gi];
          return { name: j !== undefined && info[j]?.bone ? info[j].bone! : g.name };
        });
        mergeDuplicateGroups(me);
      } else placements.push({ ob, node: i, pre: null, post: null, useNodeLocal: true });
      if (children[i].length) {
        const e = newObject(uniqueName(doc, `${n.name || 'Node'}_children`, 'objects', taken.objects), 'EMPTY', null);
        e.empty_display_size = 0.1;
        addObject(e);
        nodeObject.set(i, e);
        placements.push({ ob: e, node: i, pre: null, post: null, useNodeLocal: true });
      }
      continue;
    }
    let ob: ObjectData | null = null;
    let post: Matrix4 | null = null;
    if (n.mesh !== undefined) {
      ob = newMeshObject(i);
      if (n.camera || n.light) {
        const att = makeAttachment(n);
        if (att) {
          att.parent = ob.id;
          addObject(att);
          placements.push({ ob: att, node: -1, pre: null, post: null, useNodeLocal: false, fixed: correction(n) });
        }
      }
    } else if (n.camera || n.light) {
      if (children[i].length) {
        ob = newObject(uniqueName(doc, n.name || 'Empty', 'objects', taken.objects), 'EMPTY', null);
        const att = makeAttachment(n);
        if (att) {
          att.parent = ob.id;
          addObject(att);
          placements.push({ ob: att, node: -1, pre: null, post: null, useNodeLocal: false, fixed: correction(n) });
        }
      } else {
        ob = makeAttachment(n);
        post = correction(n);
      }
    } else {
      ob = newObject(uniqueName(doc, n.name || 'Empty', 'objects', taken.objects), 'EMPTY', null);
    }
    if (!ob) continue;
    if (n.hidden) ob.hide = true;
    if (n.extras) for (const [k, v] of Object.entries(n.extras)) ob.custom[k] = v;
    addObject(ob);
    nodeObject.set(i, ob);
    placements.push({ ob, node: i, pre: null, post, useNodeLocal: true });
  }

  // ---------------------------------------------------------------- parenting + local transforms
  // Resolve parents and the constant `pre` matrices, then compute static locals (parents first).
  for (const pl of placements) {
    const ob = pl.ob;
    if (pl.fixed) {
      if (pl.node >= 0 || (!ob.parent && pl.ob.type === 'ARMATURE')) {
        // synthetic armature: parent to the object of its parent node
        const pn = pl.node;
        const po = pn >= 0 ? nearestObject(pn) : null;
        if (po?.kind === 'object') {
          ob.parent = po.ob.id;
          const pw = info[po.node].world;
          pl.fixed = pw.clone().invert().multiply(pl.fixed);
        } else if (po?.kind === 'bone') {
          const bd = po.ai.bones.get(po.node)!;
          ob.parent = po.ai.object.id;
          ob.parent_type = 'BONE';
          ob.parent_bone = bd.name;
          pl.fixed = boneFrame(po.ai, po.node).invert().multiply(pl.fixed);
        }
      }
      setLocal(ob, pl.fixed);
      continue;
    }
    const i = pl.node;
    if (!pl.useNodeLocal) {
      // bone attachment at the joint frame
      const ai = info[i].armature!;
      const bd = ai.bones.get(i)!;
      ob.parent = ai.object.id;
      ob.parent_type = 'BONE';
      ob.parent_bone = bd.name;
      const m = boneFrame(ai, i).invert().multiply(info[i].world);
      if (pl.post) m.multiply(pl.post);
      setLocal(ob, m);
      continue;
    }
    const p = nodes[i].parent;
    const po = p >= 0 ? nearestObject(p) : null;
    if (po?.kind === 'object') {
      ob.parent = po.ob.id;
      if (po.node !== p) pl.pre = info[po.node].world.clone().invert().multiply(info[p].world);
    } else if (po?.kind === 'bone') {
      const bd = po.ai.bones.get(po.node)!;
      ob.parent = po.ai.object.id;
      ob.parent_type = 'BONE';
      ob.parent_bone = bd.name;
      pl.pre = boneFrame(po.ai, po.node).invert().multiply(info[p].world);
    } else if (p >= 0) pl.pre = info[p].world.clone();
    else if (rootScale) pl.pre = rootScale.clone();
    const m = (pl.pre ? pl.pre.clone() : new Matrix4()).multiply(conj(nodes[i].matrix));
    if (pl.post) m.multiply(pl.post);
    setLocal(ob, m);
    if (animatedRot.has(i)) {
      const q = decompose(m).q;
      ob.rotation_mode = 'QUATERNION';
      ob.rotation_quaternion = [q.w, q.x, q.y, q.z];
    }
    if (hasShear(m)) warnings.push(`"${ob.name}": sheared transforms cannot be represented exactly`);
  }

  /** The object (or bone) that represents the nearest ancestor-or-self node frame. */
  function nearestObject(start: number): { kind: 'object'; ob: ObjectData; node: number } | { kind: 'bone'; ai: ArmatureInfo; node: number } | null {
    for (let p = start; p >= 0; p = nodes[p].parent) {
      if (info[p].bone && info[p].armature) return { kind: 'bone', ai: info[p].armature!, node: p };
      const o = nodeObject.get(p);
      if (o) return { kind: 'object', ob: o, node: p };
    }
    return null;
  }

  /** World frame (at import) of a bone's child space: A0 · rest · T(tail) … expressed so that
   *  world(child) = jointWorld · L  ⇔  boneFrame⁻¹ · jointWorld. */
  function boneFrame(ai: ArmatureInfo, b: number): Matrix4 {
    const bd = ai.bones.get(b)!;
    // world = A(t)·pose·T·local with pose = A⁻¹·Jw·IBM·A0·rest → world = Jw·(IBM·A0·rest·T)·local
    // so in terms of the node world: jointWorld·IBM·A0·rest·T  (= the frame we return, at import)
    return info[b].world
      .clone()
      .multiply(bd.ibm)
      .multiply(ai.A0)
      .multiply(bd.rest)
      .multiply(new Matrix4().makeTranslation(0, bd.length, 0));
  }

  // morph weights
  for (const [i, ob] of meshObjectsByNode) {
    const me = ob.data ? doc.meshes[ob.data] : undefined;
    const w = nodes[i].morphWeights;
    if (me && w) w.forEach((v, k) => me.shape_keys[k + 1] && (me.shape_keys[k + 1].value = v));
  }

  // ---------------------------------------------------------------- animations
  let minFrame = Infinity,
    maxFrame = -Infinity;
  const toFrame = (t: number) => (opts.timeIsFrames ? t : t * fps);
  const objectActions = new Map<string, number>();
  let stashed = 0;
  const placementsByNode = new Map<number, Placement[]>();
  for (const pl of placements)
    if (pl.useNodeLocal && pl.node >= 0) {
      if (!placementsByNode.has(pl.node)) placementsByNode.set(pl.node, []);
      placementsByNode.get(pl.node)!.push(pl);
    }
  const directOk = Math.abs(Math.abs(det3(ir.axis)) - 1) < 1e-6 && ir.axis.every((v) => Math.abs(v) < 1e-9 || Math.abs(Math.abs(v) - 1) < 1e-9);
  ir.animations.forEach((anim, ai) => {
    const perObject = new Map<ObjectData, FCurve[]>();
    const push = (ob: ObjectData, fc: FCurve) => {
      if (!perObject.has(ob)) perObject.set(ob, []);
      perObject.get(ob)!.push(fc);
    };
    const byNode = new Map<number, IRChannel[]>();
    for (const c of anim.channels) {
      if (c.node < 0 || c.node >= nodes.length || !c.times.length) continue;
      if (!byNode.has(c.node)) byNode.set(c.node, []);
      byNode.get(c.node)!.push(c);
      minFrame = Math.min(minFrame, toFrame(c.times[0]));
      maxFrame = Math.max(maxFrame, toFrame(c.times[c.times.length - 1]));
    }
    for (const [ni, chans] of byNode) {
      const inf = info[ni];
      const n = nodes[ni];
      const wc = chans.find((c) => c.path === 'weights');
      if (wc) {
        const ob = meshObjectsByNode.get(ni);
        const me = ob?.data ? doc.meshes[ob.data] : undefined;
        if (ob && me && me.shape_keys.length > 1) {
          const nk = me.shape_keys.length - 1;
          for (let k = 0; k < nk; k++) {
            const fc = componentCurve(wc, k, nk, toFrame, `data.shape_keys.key_blocks["${me.shape_keys[k + 1].name}"].value`, 0, 1);
            simplifyCurve(fc);
            push(ob, fc);
          }
        }
      }
      const tchans = chans.filter((c) => c.path !== 'weights');
      if (!tchans.length) continue;
      const step = tchans.every((c) => c.interpolation === 'STEP');
      if (inf.bone && inf.armature) {
        const arm = inf.armature;
        const curves = makeCurves(`pose.bones["${inf.bone}"]`, inf.bone);
        let prevQ: Quaternion | null = null;
        for (const t of sampleTimes(tchans, fps, opts.timeIsFrames)) {
          const L = conj(sampleNodeLocal(n, tchans, t));
          if (rootScale && n.parent < 0) L.premultiply(rootScale);
          const local = boneLocal(arm, ni, L);
          const { p, q, s } = decompose(local);
          if (prevQ && prevQ.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          prevQ = q.clone();
          addSample(curves, toFrame(t), p, q, s, step ? 'CONSTANT' : 'LINEAR');
        }
        for (const fc of finishCurves(curves, tchans)) push(arm.object, fc);
        continue;
      }
      for (const pl of placementsByNode.get(ni) ?? []) {
        const target = pl.ob;
        if (tchans.some((c) => c.path === 'rotation' || c.path === 'matrix') && target.rotation_mode !== 'QUATERNION') {
          // switch to quaternions (curves are written as quaternions) keeping the static rotation
          const q = new Quaternion().setFromEuler(new Euler(target.rotation_euler[0], target.rotation_euler[1], target.rotation_euler[2], 'ZYX'));
          target.rotation_mode = 'QUATERNION';
          target.rotation_quaternion = [q.w, q.x, q.y, q.z];
        }
        if (!pl.pre && !pl.post && directOk && !tchans.some((c) => c.path === 'matrix')) {
          for (const fc of directCurves(tchans, toFrame, rootMode ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : ir.axis, rootMode ? 1 : ir.unitScale)) push(target, fc);
          continue;
        }
        const curves = makeCurves('', undefined);
        let prevQ: Quaternion | null = null;
        for (const t of sampleTimes(tchans, fps, opts.timeIsFrames)) {
          const m = (pl.pre ? pl.pre.clone() : new Matrix4()).multiply(conj(sampleNodeLocal(n, tchans, t)));
          if (pl.post) m.multiply(pl.post);
          const { p, q, s } = decompose(m);
          if (prevQ && prevQ.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          prevQ = q.clone();
          addSample(curves, toFrame(t), p, q, s, step ? 'CONSTANT' : 'LINEAR');
        }
        for (const fc of finishCurves(curves, tchans)) push(target, fc);
      }
    }
    for (const [ob, fcs] of perObject) {
      if (!fcs.length) continue;
      const base = ir.animations.length > 1 || !anim.name ? `${anim.name || 'Animation'}_${ob.name}` : perObject.size > 1 ? `${anim.name}_${ob.name}` : anim.name;
      const act = newAction(uniqueName(doc, base, 'actions'));
      act.fcurves = fcs;
      act.use_fake_user = true;
      doc.actions[act.id] = act;
      ob.animation_data ??= { action: null, nla_tracks: [], drivers: [] };
      const count = objectActions.get(ob.id) ?? 0;
      if (count === 0) ob.animation_data.action = act.id;
      else {
        let s = Infinity,
          e = -Infinity;
        for (const fc of fcs)
          for (const k of fc.keyframe_points) {
            s = Math.min(s, k.co[0]);
            e = Math.max(e, k.co[0]);
          }
        stashed++;
        ob.animation_data.nla_tracks.push({
          name: anim.name || `Animation ${ai + 1}`,
          mute: true,
          is_solo: false,
          strips: [
            {
              name: act.name,
              action: act.id,
              frame_start: s,
              frame_end: e,
              action_frame_start: s,
              action_frame_end: e,
              scale: 1,
              repeat: 1,
              blend_type: 'REPLACE',
              blend_in: 0,
              blend_out: 0,
              mute: false,
              extrapolation: 'HOLD',
            },
          ],
        });
      }
      objectActions.set(ob.id, count + 1);
    }
  });
  if (stashed) warnings.push(`${stashed} additional action(s) were kept as muted NLA tracks (enable them in the NLA editor)`);
  if (Number.isFinite(minFrame) && opts.setFrameRange !== false) {
    doc.scene.frame_start = Math.floor(minFrame);
    doc.scene.frame_end = Math.max(doc.scene.frame_start + 1, Math.ceil(maxFrame));
  }

  // ---------------------------------------------------------------- selection
  if (opts.select !== false && created.length) {
    for (const o of Object.values(doc.objects)) o.select = false;
    for (const o of created) o.select = true;
    const root = created.find((o) => !o.parent) ?? created[0];
    doc.scene.active_object = root.id;
  }
  return { objects: created, warnings: dedupe(warnings) };
}

function dedupe(a: string[]) {
  return [...new Set(a)];
}

function axisFix(axis: number, sign: number): Matrix4 {
  // rotation mapping +Y onto ±axis
  const target = new Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), target);
  if (axis === 1 && sign < 0) q.setFromAxisAngle(new Vector3(0, 0, 1), Math.PI);
  return new Matrix4().makeRotationFromQuaternion(q);
}

function rollFrom(rest: Matrix4, y: Vector3): number {
  const q0 = boneRotation(y, 0);
  const x0 = new Vector3(1, 0, 0).applyMatrix4(new Matrix4().extractRotation(q0));
  const x1 = new Vector3(1, 0, 0).applyMatrix4(new Matrix4().extractRotation(rest));
  const yn = y.clone().normalize();
  return Math.atan2(x0.clone().cross(x1).dot(yn), x0.dot(x1));
}

function setLocal(ob: ObjectData, m: Matrix4) {
  const { p, q, s } = decompose(m);
  ob.location = [p.x, p.y, p.z];
  ob.scale = [s.x, s.y, s.z];
  setRotationFromQuaternion(ob, q);
}

function writePose(pb: ReturnType<typeof defaultPoseBone>, m: Matrix4) {
  const { p, q, s } = decompose(m);
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  pb.location = [clean(p.x), clean(p.y), clean(p.z)];
  pb.rotation_quaternion = [q.w, clean(q.x), clean(q.y), clean(q.z)];
  pb.scale = [s.x, s.y, s.z];
}

function mergeDuplicateGroups(me: MeshData) {
  const seen = new Map<string, number>();
  const groups: MeshData['vertex_groups'] = [],
    weights: Float32Array[] = [];
  me.vertex_groups.forEach((g, i) => {
    const k = seen.get(g.name);
    if (k === undefined) {
      seen.set(g.name, groups.length);
      groups.push(g);
      weights.push(me.weights[i]);
    } else {
      const w = weights[k].slice();
      for (let v = 0; v < w.length; v++) w[v] += me.weights[i][v];
      weights[k] = w;
    }
  });
  me.vertex_groups = groups;
  me.weights = weights;
}

// ---------------------------------------------------------------------------
// Mesh conversion

function convertMesh(m: IRMesh, ir: IRScene, opts: CommitOptions, warnings: string[], forceScale = false): MeshData {
  const local = ir.unitScaleMode === 'ROOT' && !forceScale;
  const axis = local ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : ir.axis,
    s = local ? 1 : ir.unitScale;
  let positions = applyBasis(axis, s, m.positions);
  const nv = positions.length / 3;
  let indices = m.indices;
  let remap: Uint32Array | null = null;
  if (opts.mergeVertices) {
    const map = new Map<string, number>();
    remap = new Uint32Array(nv);
    const pos: number[] = [];
    for (let v = 0; v < nv; v++) {
      const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
      let id = map.get(key);
      if (id === undefined) {
        id = pos.length / 3;
        pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        map.set(key, id);
      }
      remap[v] = id;
    }
    if (pos.length / 3 < nv) {
      positions = new Float32Array(pos);
      indices = indices.map((i) => remap![i]);
    } else remap = null;
  }
  const nvOut = positions.length / 3;
  const faces: PolyFace[] = [];
  const keepCorner: number[] = []; // source corner index per output corner
  const keepFace: number[] = [];
  let c = 0,
    dropped = 0;
  for (let f = 0; f < m.faceSizes.length; f++) {
    const n = m.faceSizes[f];
    const verts: number[] = [];
    const corners: number[] = [];
    for (let k = 0; k < n; k++) {
      const v = indices[c + k];
      if (v >= nvOut) continue;
      if (verts.length && verts[verts.length - 1] === v) continue; // collapse repeated corners
      verts.push(v);
      corners.push(c + k);
    }
    while (verts.length > 1 && verts[0] === verts[verts.length - 1]) {
      verts.pop();
      corners.pop();
    }
    c += n;
    if (verts.length < 3 || new Set(verts).size !== verts.length) {
      dropped++;
      continue;
    }
    const uvs = m.uvs ? corners.flatMap((k) => [m.uvs![k * 2], m.uvs![k * 2 + 1]]) : undefined;
    faces.push({ verts, uvs, material: m.materialIndex?.[f] ?? 0 });
    keepCorner.push(...corners);
    keepFace.push(f);
  }
  if (dropped) warnings.push(`Mesh "${m.name}": ${dropped} degenerate face(s) were skipped`);
  if (m.looseEdges) warnings.push(`Mesh "${m.name}": ${m.looseEdges} loose edge(s)/point(s) were not imported`);
  const arrays = buildMesh(positions, faces);
  const me = newMeshData(m.name || 'Mesh', arrays);
  // shading
  const nf = faces.length;
  const smooth = new Uint8Array(nf);
  if (opts.shading === 'SMOOTH') smooth.fill(1);
  else if (opts.shading === 'FLAT') smooth.fill(0);
  else if (m.smooth) for (let f = 0; f < nf; f++) smooth[f] = m.smooth[keepFace[f]] ? 1 : 0;
  else if (m.normals) {
    const nrm = applyBasis(axis, 1, m.normals, true);
    for (let f = 0; f < nf; f++) {
      const a = arrays.offsets[f],
        b = arrays.offsets[f + 1];
      const fx = arrays.normals[a * 3],
        fy = arrays.normals[a * 3 + 1],
        fz = arrays.normals[a * 3 + 2];
      let flat = true;
      for (let k = a; k < b; k++) {
        const sc = keepCorner[k] * 3;
        const d = nrm[sc] * fx + nrm[sc + 1] * fy + nrm[sc + 2] * fz;
        if (d < 0.9999) {
          flat = false;
          break;
        }
      }
      smooth[f] = flat ? 0 : 1;
    }
    // sharp edges where smooth faces disagree on normals at shared vertices (after merging)
    if (opts.mergeVertices && remap) markSharpFromNormals(me, arrays.offsets, nrm, keepCorner);
  }
  me.smooth = smooth;
  if (!m.uvs) me.uvs = new Float32Array(arrays.indices.length * 2);
  if (m.uvName) me.uv_map_name = m.uvName;
  // colors
  if (m.colors?.length) {
    me.color_attributes = m.colors.map((cl) => {
      if (cl.domain === 'CORNER') {
        const d = new Float32Array(keepCorner.length * 4);
        keepCorner.forEach((sc, k) => d.set(cl.data.subarray(sc * 4, sc * 4 + 4), k * 4));
        return { name: cl.name, domain: 'CORNER' as const, data: d };
      }
      if (remap) {
        const d = new Float32Array(nvOut * 4);
        for (let v = 0; v < remap.length; v++) d.set(cl.data.subarray(v * 4, v * 4 + 4), remap[v] * 4);
        return { name: cl.name, domain: 'POINT' as const, data: d };
      }
      return { name: cl.name, domain: 'POINT' as const, data: cl.data };
    });
  }
  // vertex groups
  if (m.groups?.names.length) {
    me.vertex_groups = m.groups.names.map((name) => ({ name }));
    me.weights = m.groups.weights.map((w) => {
      if (!remap) return w;
      const out = new Float32Array(nvOut);
      for (let v = 0; v < remap.length; v++) out[remap[v]] = Math.max(out[remap[v]], w[v]);
      return out;
    });
  }
  // shape keys
  if (m.shapeKeys?.length) {
    const keys: ShapeKey[] = [{ name: 'Basis', data: me.positions, value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: 'Basis' }];
    const names = new Set(['Basis']);
    for (const sk of m.shapeKeys) {
      let p = applyBasis(axis, s, sk.positions);
      if (remap) {
        const out = new Float32Array(nvOut * 3);
        for (let v = 0; v < remap.length; v++) out.set(p.subarray(v * 3, v * 3 + 3), remap[v] * 3);
        p = out;
      }
      let name = sk.name || `Key ${keys.length}`;
      for (let i = 1; names.has(name); i++) name = `${sk.name || 'Key'}.${String(i).padStart(3, '0')}`;
      names.add(name);
      keys.push({ name, data: p, value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: 'Basis' });
    }
    me.shape_keys = keys;
  }
  return me;
}

function markSharpFromNormals(me: MeshData, offsets: Uint32Array, nrm: Float32Array, keepCorner: number[]) {
  // corners of the same vertex in adjacent faces with different source normals → sharp edge
  const nc = me.indices.length,
    nf = offsets.length - 1,
    nv = me.positions.length / 3;
  const sharp = new Uint32Array(nc);
  const next = new Uint32Array(nc);
  for (let f = 0; f < nf; f++) {
    const a = offsets[f],
      b = offsets[f + 1];
    for (let k = a; k < b; k++) next[k] = k + 1 < b ? k + 1 : a;
  }
  const edgeCorners = new Map<number, number[]>();
  for (let k = 0; k < nc; k++) {
    const v0 = me.indices[k],
      v1 = me.indices[next[k]];
    const key = v0 < v1 ? v0 * nv + v1 : v1 * nv + v0;
    const list = edgeCorners.get(key);
    if (list) list.push(k);
    else edgeCorners.set(key, [k]);
  }
  let any = false;
  const differs = (x: number, y: number) => {
    const a = keepCorner[x] * 3,
      b = keepCorner[y] * 3;
    return nrm[a] * nrm[b] + nrm[a + 1] * nrm[b + 1] + nrm[a + 2] * nrm[b + 2] < 0.9999;
  };
  for (const list of edgeCorners.values()) {
    if (list.length !== 2) continue;
    const [k0, k1] = list;
    // matching vertices: k0 ↔ next(k1), next(k0) ↔ k1
    if (differs(k0, next[k1]) || differs(next[k0], k1)) {
      sharp[k0] = 1;
      sharp[k1] = 1;
      any = true;
    }
  }
  if (any) me.sharp = sharp;
}

// ---------------------------------------------------------------------------
// Animation helpers

function lerpSampler(c: IRChannel, t: number, comps: number, out: number[]) {
  const times = c.times,
    v = c.values,
    n = times.length;
  const cubic = c.interpolation === 'CUBICSPLINE';
  const stride = cubic ? comps * 3 : comps;
  const off = cubic ? comps : 0;
  if (t <= times[0] || n === 1) {
    for (let k = 0; k < comps; k++) out[k] = v[off + k];
    return out;
  }
  if (t >= times[n - 1]) {
    for (let k = 0; k < comps; k++) out[k] = v[(n - 1) * stride + off + k];
    return out;
  }
  let i = 0;
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  i = lo;
  const t0 = times[i],
    t1 = times[i + 1],
    dt = t1 - t0,
    u = dt > 0 ? (t - t0) / dt : 0;
  if (c.interpolation === 'STEP') {
    for (let k = 0; k < comps; k++) out[k] = v[i * stride + k];
    return out;
  }
  if (cubic) {
    const u2 = u * u,
      u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1,
      h10 = u3 - 2 * u2 + u,
      h01 = -2 * u3 + 3 * u2,
      h11 = u3 - u2;
    for (let k = 0; k < comps; k++) {
      const p0 = v[i * stride + comps + k],
        m0 = v[i * stride + 2 * comps + k] * dt,
        p1 = v[(i + 1) * stride + comps + k],
        m1 = v[(i + 1) * stride + k] * dt;
      out[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    if (c.path === 'rotation') normalize4(out);
    return out;
  }
  if (c.path === 'rotation') {
    const a = new Quaternion(v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 3]),
      b = new Quaternion(v[i * 4 + 4], v[i * 4 + 5], v[i * 4 + 6], v[i * 4 + 7]);
    a.slerp(b, u);
    out[0] = a.x;
    out[1] = a.y;
    out[2] = a.z;
    out[3] = a.w;
    return out;
  }
  for (let k = 0; k < comps; k++) out[k] = v[i * stride + k] * (1 - u) + v[(i + 1) * stride + k] * u;
  return out;
}

function normalize4(o: number[]) {
  const l = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
  for (let k = 0; k < 4; k++) o[k] /= l;
}

/** Node local matrix (source space) at time t: animated TRS over the static matrix. */
function sampleNodeLocal(n: IRNode, chans: IRChannel[], t: number): Matrix4 {
  const mc = chans.find((c) => c.path === 'matrix');
  if (mc) return new Matrix4().fromArray(lerpSampler(mc, t, 16, new Array(16)));
  const { p, q, s } = decompose(new Matrix4().fromArray(n.matrix));
  const tmp: number[] = [0, 0, 0, 0];
  for (const c of chans) {
    if (c.path === 'translation') {
      lerpSampler(c, t, 3, tmp);
      p.set(tmp[0], tmp[1], tmp[2]);
    } else if (c.path === 'rotation') {
      lerpSampler(c, t, 4, tmp);
      q.set(tmp[0], tmp[1], tmp[2], tmp[3]).normalize();
    } else if (c.path === 'scale') {
      lerpSampler(c, t, 3, tmp);
      s.set(tmp[0], tmp[1], tmp[2]);
    }
  }
  return new Matrix4().compose(p, q, s);
}

function sampleTimes(chans: IRChannel[], fps: number, timeIsFrames?: boolean): number[] {
  const set = new Set<number>();
  let lo = Infinity,
    hi = -Infinity;
  let bake = false;
  for (const c of chans) {
    for (const t of c.times) set.add(t);
    lo = Math.min(lo, c.times[0]);
    hi = Math.max(hi, c.times[c.times.length - 1]);
    if (c.interpolation === 'CUBICSPLINE' || c.path === 'matrix') bake = true;
  }
  if (bake && Number.isFinite(lo)) {
    const step = timeIsFrames ? 1 : 1 / fps;
    for (let t = lo; t <= hi + 1e-9; t += step) set.add(Math.min(hi, t));
  }
  return [...set].sort((a, b) => a - b);
}

interface CurveSet {
  loc: FCurve[];
  rot: FCurve[];
  scale: FCurve[];
}

function fcurve(path: string, index: number, group?: string): FCurve {
  return { data_path: path, array_index: index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], group, color_mode: 'AUTO_RAINBOW' };
}

function makeCurves(base: string, group?: string): CurveSet {
  const p = base ? `${base}.` : '';
  const g = group ?? 'Object Transforms';
  return {
    loc: [0, 1, 2].map((i) => fcurve(`${p}location`, i, g)),
    rot: [0, 1, 2, 3].map((i) => fcurve(`${p}rotation_quaternion`, i, g)),
    scale: [0, 1, 2].map((i) => fcurve(`${p}scale`, i, g)),
  };
}

function key(frame: number, value: number, interp: Keyframe['interpolation']): Keyframe {
  const k = newKeyframe(frame, value, interp);
  return k;
}

function addSample(c: CurveSet, frame: number, p: Vector3, q: Quaternion, s: Vector3, interp: Keyframe['interpolation']) {
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
  [p.x, p.y, p.z].forEach((v, i) => c.loc[i].keyframe_points.push(key(frame, clean(v), interp)));
  [q.w, q.x, q.y, q.z].forEach((v, i) => c.rot[i].keyframe_points.push(key(frame, clean(v), interp)));
  [s.x, s.y, s.z].forEach((v, i) => c.scale[i].keyframe_points.push(key(frame, v, interp)));
}

/** Keep only the channel kinds that were animated; drop constant curves for unanimated kinds. */
function finishCurves(c: CurveSet, chans: IRChannel[]): FCurve[] {
  const has = (p: IRChannel['path']) => chans.some((x) => x.path === p || x.path === 'matrix');
  const out: FCurve[] = [];
  if (has('translation')) out.push(...c.loc);
  if (has('rotation')) out.push(...c.rot);
  if (has('scale')) out.push(...c.scale);
  for (const fc of out) {
    simplifyCurve(fc);
    calcHandles(fc);
  }
  return out;
}

/** Remove keys that linear interpolation reproduces exactly (baked curves stay light). */
function simplifyCurve(fc: FCurve) {
  const k = fc.keyframe_points;
  if (k.length < 3 || k.some((x) => x.interpolation !== 'LINEAR')) return;
  const out = [k[0]];
  for (let i = 1; i < k.length - 1; i++) {
    const a = out[out.length - 1],
      b = k[i],
      c = k[i + 1];
    const u = (b.co[0] - a.co[0]) / (c.co[0] - a.co[0] || 1);
    const pred = a.co[1] + (c.co[1] - a.co[1]) * u;
    if (Math.abs(pred - b.co[1]) > 1e-6) out.push(b);
  }
  out.push(k[k.length - 1]);
  fc.keyframe_points = out;
}

/** Direct (unbaked) object channel conversion: keys and tangents are kept. */
function directCurves(chans: IRChannel[], toFrame: (t: number) => number, axis: number[], unitScale: number): FCurve[] {
  const out: FCurve[] = [];
  const g = 'Object Transforms';
  // permutation of axis (signed): doc[i] = sign * src[perm[i]]
  const perm = [0, 1, 2].map((r) => [0, 1, 2].find((c) => Math.abs(axis[r * 3 + c]) > 0.5) ?? r);
  const sign = [0, 1, 2].map((r) => Math.sign(axis[r * 3 + perm[r]]) || 1);
  for (const c of chans) {
    if (c.path === 'translation') {
      for (let i = 0; i < 3; i++) out.push(componentCurve(c, perm[i], 3, toFrame, 'location', i, sign[i] * unitScale, g));
    } else if (c.path === 'scale') {
      for (let i = 0; i < 3; i++) out.push(componentCurve(c, perm[i], 3, toFrame, 'scale', i, 1, g));
    } else if (c.path === 'rotation') {
      // quaternion (x,y,z,w) → document (w,x,y,z) with the vector part rotated by the axis
      const w = componentCurve(c, 3, 4, toFrame, 'rotation_quaternion', 0, 1, g);
      const xs = [0, 1, 2].map((i) => componentCurve(c, perm[i], 4, toFrame, 'rotation_quaternion', i + 1, sign[i] * det3(axis), g));
      // ensure sign continuity across keys (shortest path like slerp)
      const n = w.keyframe_points.length;
      for (let k = 1; k < n && c.interpolation !== 'CUBICSPLINE'; k++) {
        const d = w.keyframe_points[k].co[1] * w.keyframe_points[k - 1].co[1] + xs.reduce((acc, fc) => acc + fc.keyframe_points[k].co[1] * fc.keyframe_points[k - 1].co[1], 0);
        if (d < 0)
          for (const fc of [w, ...xs]) {
            const kp = fc.keyframe_points[k];
            kp.co[1] = -kp.co[1];
            kp.handle_left[1] = -kp.handle_left[1];
            kp.handle_right[1] = -kp.handle_right[1];
          }
      }
      out.push(w, ...xs);
    }
  }
  return out;
}

function det3(a: number[]) {
  return a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
}

function componentCurve(c: IRChannel, comp: number, comps: number, toFrame: (t: number) => number, path: string, index: number, mul: number, group?: string): FCurve {
  const fc = fcurve(path, index, group);
  const cubic = c.interpolation === 'CUBICSPLINE';
  const stride = cubic ? comps * 3 : comps;
  const n = c.times.length;
  for (let i = 0; i < n; i++) {
    const frame = toFrame(c.times[i]);
    const v = c.values[i * stride + (cubic ? comps : 0) + comp] * mul;
    const k = key(frame, v, c.interpolation === 'STEP' ? 'CONSTANT' : cubic ? 'BEZIER' : 'LINEAR');
    if (cubic) {
      const inT = c.values[i * stride + comp] * mul,
        outT = c.values[i * stride + 2 * comps + comp] * mul;
      const dtPrev = i > 0 ? c.times[i] - c.times[i - 1] : 0,
        dtNext = i < n - 1 ? c.times[i + 1] - c.times[i] : 0;
      const fPrev = i > 0 ? frame - toFrame(c.times[i - 1]) : 1,
        fNext = i < n - 1 ? toFrame(c.times[i + 1]) - frame : 1;
      k.handle_left = [frame - fPrev / 3, v - (inT * dtPrev) / 3];
      k.handle_right = [frame + fNext / 3, v + (outT * dtNext) / 3];
      k.handle_left_type = 'FREE';
      k.handle_right_type = 'FREE';
    }
    fc.keyframe_points.push(k);
  }
  if (!cubic) calcHandles(fc);
  return fc;
}
