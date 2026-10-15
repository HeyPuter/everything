// Constant input nodes shared with Geometry Nodes (Boolean, Integer, Vector): the shader and world
// trees use them too. Their types are registered by the geometry nodes module; the tree types
// are added once every module has loaded.
import { onAppReady } from '../../app/app';
import { getNodeType } from '../registry';
import type { MenuCategory, MenuEntry } from '../types';
import { SHADER_MENU } from './defs';
import { registerGenerator } from './codegen';

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);

registerGenerator('FunctionNodeInputBool', (g) => g.out('Boolean', 'float', g.uniform('float', g.node.props.boolean ? 1 : 0)));
registerGenerator('FunctionNodeInputInt', (g) => g.out('Integer', 'float', g.uniform('float', Math.round(num(g.node.props.integer)))));
registerGenerator('FunctionNodeInputVector', (g) => {
  const v = (g.node.props.vector as number[] | undefined) ?? [0, 0, 0];
  g.out('Vector', 'vec3', g.uniform('vec3', [num(v[0]), num(v[1]), num(v[2])]));
});

registerGenerator('GeometryNodeInputSceneTime', (g) => {
  const s = g.doc.scene;
  const frame = s.frame_current + (s.frame_subframe ?? 0);
  const fps = s.render.fps / (s.render.fps_base || 1) || 24;
  g.out('Frame', 'float', g.uniform('float', frame));
  g.out('Seconds', 'float', g.uniform('float', frame / fps));
});

export const SHADER_SHARED_CONSTANTS = ['FunctionNodeInputBool', 'FunctionNodeInputInt', 'FunctionNodeInputVector'];
/** Input nodes shared with Geometry Nodes (Input menu). */
const SHARED_INPUTS = ['GeometryNodeInputSceneTime'];

/** Constant submenu order: Boolean, Color, Integer, Value, Vector. */
const ORDER = ['FunctionNodeInputBool', 'ShaderNodeRGB', 'FunctionNodeInputInt', 'ShaderNodeValue', 'FunctionNodeInputVector'];

export function shareShaderConstants() {
  const constants = (SHADER_MENU.find((c) => c.label === 'Input')?.items.find((i) => typeof i !== 'string' && 'items' in i && i.label === 'Constant') ?? null) as MenuCategory | null;
  for (const id of SHADER_SHARED_CONSTANTS) {
    const d = getNodeType(id);
    if (!d) continue;
    for (const t of ['SHADER', 'WORLD'] as const) if (!d.treeTypes.includes(t)) d.treeTypes = [...d.treeTypes, t];
    if (constants && !constants.items.some((i) => typeof i !== 'string' && 'idname' in i && i.idname === id)) constants.items.push({ idname: id });
  }
  constants?.items.sort((a, b) => ORDER.indexOf((a as MenuEntry).idname) - ORDER.indexOf((b as MenuEntry).idname));
  const input = SHADER_MENU.find((c) => c.label === 'Input');
  for (const id of SHARED_INPUTS) {
    const d = getNodeType(id);
    if (!d || !input) continue;
    for (const t of ['SHADER', 'WORLD'] as const) if (!d.treeTypes.includes(t)) d.treeTypes = [...d.treeTypes, t];
    if (input.items.some((i) => typeof i !== 'string' && 'idname' in i && i.idname === id)) continue;
    // alphabetical position among the inputs (after Raycast/Point Info, before Tangent)
    const at = input.items.findIndex((i) => typeof i !== 'string' && 'idname' in i && i.idname === 'ShaderNodeTangent');
    input.items.splice(at < 0 ? input.items.length : at, 0, { idname: id });
  }
}
onAppReady(shareShaderConstants);
