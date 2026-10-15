// Shader AOVs: materials that render the value written by a material's AOV Output node (one
// render pass per AOV). The node graph is compiled with the regular code generator; the result
// feeds a small unlit shader instead of the surface closure.
import { ShaderMaterial, DoubleSide, Vector4, Uniform, type DataTexture, type Object3D, type BufferGeometry, type Material } from 'three';
import type { DocumentData, MaterialData, NodeData, NodeTreeData } from '../../data/types';
import { Codegen, MATERIAL_CONTEXT } from './codegen';
import { initialValue, materialPreamble, usesObjectBlock } from './material';
import { app } from '../../app/app';
import { hashName } from './util';

/** AOV Output nodes of a tree writing to `name` (top level; the first active one wins). */
export function aovNode(tree: NodeTreeData, name: string): NodeData | null {
  return tree.nodes.find((n) => n.type === 'ShaderNodeOutputAOV' && !n.mute && String(n.props.aov_name ?? '') === name) ?? null;
}

const VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
varying vec3 vNdP;
varying vec3 vNdObj;
varying vec3 vNdObjN;
varying vec2 vNdUV;
varying vec3 vNormal;
void main() {
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  vNormal = normalize(transformedNormal);
  vNdObj = transformed;
  vNdObjN = objectNormal;
  vNdUV = uv;
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
  #endif
  vNdP = (modelMatrix * wp).xyz;
}`;

const OBJECT_UNIFORMS = 'uniform vec4 ndBBoxMin; uniform vec4 ndBBoxMax; uniform vec4 ndObjInfo; uniform vec4 ndObjColor; uniform vec4 ndObjLoc; uniform vec4 ndViewport;';

/** Material rendering AOV `name` of a material (null when the material does not write it); free it with disposeAovMaterial. */
export function aovMaterial(doc: DocumentData, ma: MaterialData, name: string, type: 'COLOR' | 'VALUE'): Material | null {
  if (!ma.use_nodes) return null;
  const node = aovNode(ma.tree, name);
  if (!node) return null;
  const cg = new Codegen(doc, 'MATERIAL', MATERIAL_CONTEXT);
  const scope = cg.root(ma.tree);
  const expr = type === 'COLOR' ? cg.inputExpr(scope, node, 'Color', 'vec4') : `vec4(vec3(${cg.inputExpr(scope, node, 'Value', 'float')}), 1.0)`;
  const f = cg.finish();
  const body = `${f.code}\nvec4 ndAov = ${expr};`;
  const pre = materialPreamble(body).replace(/^vec3 ndBary = vNdBary;$/m, 'vec3 ndBary = vec3(0.0);');
  const objBlock = usesObjectBlock(pre + body);
  const fragment = `
varying vec3 vNdP;
varying vec3 vNdObj;
varying vec3 vNdObjN;
varying vec2 vNdUV;
varying vec3 vNormal;
${objBlock ? OBJECT_UNIFORMS : ''}
${f.decls}
${f.lib}
void main() {
${pre}
${body}
  gl_FragColor = vec4(ndAov.rgb, 1.0);
}`;
  const luts: DataTexture[] = [];
  const uniforms: Record<string, Uniform> = {};
  for (const u of f.uniforms) uniforms[u.name] = new Uniform(initialValue(doc, u, luts));
  if (objBlock) for (const n of ['ndBBoxMin', 'ndBBoxMax', 'ndObjInfo', 'ndObjColor', 'ndObjLoc', 'ndViewport']) uniforms[n] = new Uniform(new Vector4());
  const mat = new ShaderMaterial({ vertexShader: VERTEX, fragmentShader: fragment, uniforms, side: ma.use_backface_culling ? undefined : DoubleSide });
  if (objBlock)
    mat.onBeforeRender = (renderer, _s, _c, geometry: BufferGeometry, object: Object3D) => {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox!;
      (uniforms.ndBBoxMin.value as Vector4).set(bb.min.x, bb.min.y, bb.min.z, 0);
      (uniforms.ndBBoxMax.value as Vector4).set(bb.max.x, bb.max.y, bb.max.z, 0);
      const id = object.userData.id as string | undefined;
      const ob = id ? app?.doc.objects[id] : undefined;
      (uniforms.ndObjInfo.value as Vector4).set(ob ? hashName(ob.name) : 0, ob?.pass_index ?? 0, 0, 0);
      const c = ob?.color ?? [1, 1, 1, 1];
      (uniforms.ndObjColor.value as Vector4).set(c[0], c[1], c[2], c[3] ?? 1);
      const e = object.matrixWorld.elements;
      (uniforms.ndObjLoc.value as Vector4).set(e[12], e[13], e[14], 1);
      renderer.getCurrentViewport(uniforms.ndViewport.value as Vector4);
      mat.uniformsNeedUpdate = true;
    };
  mat.userData.luts = luts;
  return mat;
}

export function disposeAovMaterial(m: Material) {
  m.dispose();
  for (const t of (m.userData.luts as DataTexture[] | undefined) ?? []) t.dispose();
}
