// UV Maps list operators: add (a copy of the active map) and remove the active map.
import { app, registerOperators } from '../app/app';
import type { MeshData } from '../data/types';
import { addUVMap, removeActiveUV, hasActiveUV } from '../mesh/uvmaps';

const activeMesh = (): MeshData | undefined => {
  const ob = app.activeObject;
  return ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
};

registerOperators([
  {
    idname: 'mesh.uv_texture_add',
    label: 'Add UV Map',
    description: 'Add a UV map (a copy of the active one) and make it active',
    poll: () => !!activeMesh()?.indices.length,
    exec: () => {
      addUVMap(activeMesh()!);
      app.changed('doc', 'geometry');
    },
  },
  {
    idname: 'mesh.uv_texture_remove',
    label: 'Remove UV Map',
    description: 'Remove the active UV map',
    poll: () => {
      const me = activeMesh();
      return !!me && hasActiveUV(me);
    },
    exec: () => {
      if (!removeActiveUV(activeMesh()!)) return 'CANCELLED';
      app.changed('doc', 'geometry');
    },
  },
]);
