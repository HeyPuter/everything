// Input nodes.
import { gn, shared, prop } from './defs';
import { GeometrySet, InstancesComponent, decomposeMat, invertMat, mulMat, identity, type InstanceReference } from '../geometry';
import { transformGeometry } from '../ops/join';
import { ConstField } from '../field';
import {
  attributeField,
  edgeAngleField,
  faceAreaField,
  idField,
  indexField,
  materialIndexField,
  normalField,
  positionField,
  radiusField,
  shadeSmoothField,
  splineParameterField,
  cyclicField,
} from '../inputs';
import { fieldTypeOfEnum } from '../types';
import type { EvalEnv } from '../exec';
import type { NodeData } from '../../data/types';
import { DATA_TYPE_ITEMS } from './common';

// ---------------------------------------------------------------------------
// Object / collection

function objectRef(env: EvalEnv, id: string): InstanceReference {
  return {
    type: 'OBJECT',
    objectId: id,
    geometry: env.objectGeometry(id) ?? GeometrySet.empty(),
    key: `ob:${id}`,
  };
}

gn(
  'GeometryNodeObjectInfo',
  'input',
  {
    exec: (ctx) => {
      const id = ctx.idRef('Object');
      const env = ctx.env;
      const none = {
        Transform: Array.from(identity()),
        Location: [0, 0, 0],
        Rotation: [0, 0, 0],
        Scale: [0, 0, 0],
        Geometry: GeometrySet.empty(),
      };
      if (!id || !env.doc.objects[id]) return none;
      if (env.ob && id === env.ob.id) {
        ctx.warn('Geometry cannot be retrieved from the modifier object');
        return none;
      }
      const world = env.objectWorld(id) ?? identity();
      const relative = prop(ctx.node, 'transform_space') === 'RELATIVE';
      const m = relative ? mulMat(invertMat(env.selfWorld), world) : Float64Array.from(world);
      const d = decomposeMat(m);
      let geometry: GeometrySet;
      if (ctx.bool('As Instance')) {
        const T = new Float32Array(relative ? m : identity());
        geometry = new GeometrySet(undefined, undefined, undefined, new InstancesComponent(T, new Int32Array([0]), [objectRef(env, id)]));
      } else {
        const g = env.objectGeometry(id) ?? GeometrySet.empty();
        geometry = relative ? transformGeometry(g, m) : g;
      }
      return {
        Transform: Array.from(m),
        Location: d.t,
        Rotation: d.r,
        Scale: d.s,
        Geometry: geometry,
      };
    },
    sig: (_n: NodeData, env, ref) => {
      const id = ref('Object');
      return `${id ? env.objectSig(id) : ''}|${Array.from(env.selfWorld)
        .map((x) => x.toFixed(5))
        .join(',')}`;
    },
    deps: (n) => (typeof n.inputs.Object === 'string' ? [n.inputs.Object] : []),
  },
  { propPatch: { transform_space: { expand: true } } },
);

function collectionGeometry(env: EvalEnv, cid: string): GeometrySet {
  const ids = env.collectionObjects(cid);
  const coll = env.doc.collections[cid];
  const off = coll?.instance_offset ?? [0, 0, 0];
  const refs: InstanceReference[] = [];
  const T = new Float32Array(ids.length * 16);
  ids.forEach((id, i) => {
    refs.push(objectRef(env, id));
    const w = Float64Array.from(env.objectWorld(id) ?? identity());
    w[12] -= off[0];
    w[13] -= off[1];
    w[14] -= off[2];
    T.set(w, i * 16);
  });
  return new GeometrySet(
    undefined,
    undefined,
    undefined,
    new InstancesComponent(
      T,
      Int32Array.from(ids, (_, i) => i),
      refs,
    ),
  );
}

gn(
  'GeometryNodeCollectionInfo',
  'input',
  {
    exec: (ctx) => {
      const cid = ctx.idRef('Collection');
      const env = ctx.env;
      if (!cid || !env.doc.collections[cid]) return { Instances: GeometrySet.empty() };
      const relative = prop(ctx.node, 'transform_space') === 'RELATIVE';
      const toSelf = relative ? invertMat(env.selfWorld) : identity();
      const coll = env.doc.collections[cid];
      if (ctx.bool('Separate Children')) {
        // one instance per child object / child collection
        const reset = ctx.bool('Reset Children');
        const children: { ref: InstanceReference; m: ArrayLike<number> }[] = [];
        for (const oid of coll.objects) {
          if (!env.doc.objects[oid]) continue;
          const w = env.objectWorld(oid) ?? identity();
          const local = reset ? identity() : w;
          children.push({ ref: objectRef(env, oid), m: mulMat(toSelf, local) });
        }
        for (const ch of coll.children) {
          if (!env.doc.collections[ch]) continue;
          children.push({
            ref: {
              type: 'COLLECTION',
              collectionId: ch,
              geometry: collectionGeometry(env, ch),
              key: `co:${ch}`,
            },
            m: toSelf,
          });
        }
        const T = new Float32Array(children.length * 16);
        children.forEach((c, i) => T.set(c.m, i * 16));
        return {
          Instances: new GeometrySet(
            undefined,
            undefined,
            undefined,
            new InstancesComponent(
              T,
              Int32Array.from(children, (_, i) => i),
              children.map((c) => c.ref),
            ),
          ),
        };
      }
      const ref: InstanceReference = {
        type: 'COLLECTION',
        collectionId: cid,
        geometry: collectionGeometry(env, cid),
        key: `co:${cid}`,
      };
      return {
        Instances: new GeometrySet(undefined, undefined, undefined, new InstancesComponent(new Float32Array(toSelf), new Int32Array([0]), [ref])),
      };
    },
    sig: (_n, env, ref) => {
      const cid = ref('Collection');
      if (!cid) return '';
      return `${env
        .collectionObjects(cid)
        .map((id) => env.objectSig(id))
        .join(';')}|${Array.from(env.selfWorld)
        .map((x) => x.toFixed(5))
        .join(',')}|${JSON.stringify(env.doc.collections[cid]?.instance_offset ?? null)}`;
    },
    deps: (n, doc) => {
      const cid = n.inputs.Collection as string | null;
      if (!cid || !doc.collections[cid]) return [];
      const out: string[] = [];
      const walk = (c: string, d = 0) => {
        const co = doc.collections[c];
        if (!co || d > 32) return;
        out.push(...co.objects);
        for (const ch of co.children) walk(ch, d + 1);
      };
      walk(cid);
      return out;
    },
  },
  { propPatch: { transform_space: { expand: true } } },
);

gn('GeometryNodeSelfObject', 'input', {
  exec: (ctx) => ({ 'Self Object': ctx.env.ob?.id ?? null }),
});
gn('GeometryNodeIsViewport', 'input', {
  exec: (ctx) => ({ 'Is Viewport': !ctx.env.render }),
  sig: (_n, env) => (env.render ? 'R' : 'V'),
});

gn('GeometryNodeInputSceneTime', 'input', {
  exec: (ctx) => ({
    Seconds: ctx.env.frame / (ctx.env.fps || 24),
    Frame: ctx.env.frame,
  }),
  sig: (_n, env) => `${env.frame}/${env.fps}`,
  timeDependent: true,
});

// ---------------------------------------------------------------------------
// Constants

gn(
  'FunctionNodeInputInt',
  'input',
  {
    exec: (ctx) => ({
      Integer: Math.round(Number(prop(ctx.node, 'integer') ?? 0)),
    }),
  },
  { propPatch: { integer: { noLabel: true } } },
);
gn(
  'FunctionNodeInputVector',
  'input',
  {
    exec: (ctx) => ({
      Vector: [...((prop(ctx.node, 'vector') as number[]) ?? [0, 0, 0])].slice(0, 3),
    }),
  },
  { drop: ['vector_dimensions'], propPatch: { vector: { noLabel: true } } },
);
gn('FunctionNodeInputBool', 'input', {
  exec: (ctx) => ({ Boolean: !!prop(ctx.node, 'boolean') }),
});
gn('FunctionNodeInputString', 'input', { exec: (ctx) => ({ String: String(prop(ctx.node, 'string') ?? '') }) }, { propPatch: { string: { noLabel: true } } });
gn(
  'FunctionNodeInputRotation',
  'input',
  {
    exec: (ctx) => ({
      Rotation: [...((prop(ctx.node, 'rotation_euler') as number[]) ?? [0, 0, 0])].slice(0, 3),
    }),
  },
  { propPatch: { rotation_euler: { noLabel: true, sub: 'EULER' } } },
);
shared('ShaderNodeValue', {
  exec: (ctx) => ({ Value: Number(prop(ctx.node, 'outputs.Value') ?? 0.5) }),
});

// ---------------------------------------------------------------------------
// Field inputs

gn('GeometryNodeInputPosition', 'input', {
  exec: () => ({ Position: positionField() }),
});
gn(
  'GeometryNodeInputNormal',
  'input',
  {
    exec: () => ({
      Normal: normalField(false),
      'True Normal': normalField(true),
    }),
  },
  { drop: ['legacy_corner_normals'] },
);
gn('GeometryNodeInputIndex', 'input', {
  exec: () => ({ Index: indexField() }),
});
gn('GeometryNodeInputID', 'input', { exec: () => ({ ID: idField() }) });
gn('GeometryNodeInputRadius', 'input', {
  exec: () => ({ Radius: radiusField() }),
});
gn('GeometryNodeInputMaterialIndex', 'input', {
  exec: () => ({ 'Material Index': materialIndexField() }),
});
gn('GeometryNodeInputShadeSmooth', 'input', {
  exec: () => ({ Smooth: shadeSmoothField() }),
});
gn('GeometryNodeInputMeshFaceArea', 'input', {
  exec: () => ({ Area: faceAreaField() }),
});
gn('GeometryNodeInputMeshEdgeAngle', 'input', {
  exec: () => ({
    'Unsigned Angle': edgeAngleField(false),
    'Signed Angle': edgeAngleField(true),
  }),
});
gn('GeometryNodeSplineParameter', 'input', {
  exec: () => ({
    Factor: splineParameterField('Factor'),
    Length: splineParameterField('Length'),
    Index: splineParameterField('Index'),
  }),
});
gn('GeometryNodeInputSplineCyclic', 'input', {
  exec: () => ({ Cyclic: cyclicField() }),
});

gn(
  'GeometryNodeInputNamedAttribute',
  'input',
  {
    exec: (ctx) => {
      const name = ctx.string('Name');
      const t = fieldTypeOfEnum(prop(ctx.node, 'data_type'));
      if (!name)
        return {
          Attribute: new ConstField(t, t === 'RGBA' ? [0, 0, 0, 0] : 0),
          Exists: false,
        };
      return {
        Attribute: attributeField(name, t),
        Exists: attributeField(name, t, true),
      };
    },
  },
  {
    items: { data_type: DATA_TYPE_ITEMS },
    dynamicSockets: (node) => {
      const t = fieldTypeOfEnum(prop(node, 'data_type'));
      return {
        inputs: [{ name: 'Name', identifier: 'Name', type: 'STRING', default: '' }],
        outputs: [
          {
            name: 'Attribute',
            identifier: 'Attribute',
            type: t,
            shape: 'DIAMOND',
          },
          {
            name: 'Exists',
            identifier: 'Exists',
            type: 'BOOLEAN',
            shape: 'DIAMOND',
          },
        ],
      };
    },
  },
);
