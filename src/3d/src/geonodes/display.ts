// Viewport display of geometry nodes results that the scene mesh does not show: point clouds
// (shaded spheres sized by radius), curves and loose edges next to faces, generated materials
// (Set Material) and the active Viewer's attribute colors.
import { evaluatedCurves } from './curves/curvedata';
import { curvesWithGreasePencil } from './curves/gpdata';
import { Scene, Points, LineSegments, BufferGeometry, BufferAttribute, ShaderMaterial, LineBasicMaterial, Color, Vector4, type Camera } from 'three';
import { app } from '../app/app';
import { viewportExtensions } from '../editors/view3d/hooks';
import { drawHooks } from '../editors/view3d/draw';
import { renderContext } from '../render/context';
import { solidMaterial } from '../render/materials';
import { viewportMaterial } from '../render/pbr';
import { gnResults } from './results';
import type { GeometrySet } from './geometry';
import type { GnEvalMesh } from './convert';

const sphereMaterial = () =>
  new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(0.62, 0.62, 0.62) },
      uHalfH: { value: 400 },
    },
    vertexShader: /* glsl */ `
      attribute float psize;
      uniform float uHalfH;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(2.0 * psize * projectionMatrix[1][1] * uHalfH / max(gl_Position.w, 1e-4), 2.0, 128.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() {
        vec2 d = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(d, d);
        if (r2 > 1.0) discard;
        vec3 n = vec3(d.x, -d.y, sqrt(1.0 - r2));
        float l = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.5, 0.8))), 0.0);
        gl_FragColor = vec4(uColor * l, 1.0);
      }`,
  });

interface Entry {
  geo: GeometrySet;
  objs: (Points | LineSegments)[];
}

const scene = new Scene();
scene.matrixWorldAutoUpdate = false;
const entries = new Map<string, Entry>();
const vp = new Vector4();

function build(g: GeometrySet, hasFaces: boolean): (Points | LineSegments)[] {
  const out: (Points | LineSegments)[] = [];
  if (g.points?.count) {
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(g.points.positions, 3));
    const r = g.points.attrs.get('radius');
    pg.setAttribute('psize', new BufferAttribute(r ? (r.data as Float32Array) : new Float32Array(g.points.count).fill(0.01), 1));
    const p = new Points(pg, sphereMaterial());
    p.frustumCulled = false;
    out.push(p);
  }
  const seg: number[] = [];
  const dc = curvesWithGreasePencil(g);
  if (dc) {
    const c = evaluatedCurves(dc);
    for (let k = 0; k < c.curveCount; k++) {
      const s = c.curveOffsets[k],
        e = c.curveOffsets[k + 1];
      for (let i = s; i + 1 < e; i++) seg.push(...c.positions.subarray(i * 3, i * 3 + 6));
      if (c.cyclic[k] && e - s > 2) seg.push(...c.positions.subarray((e - 1) * 3, e * 3), ...c.positions.subarray(s * 3, s * 3 + 3));
    }
  }
  if (g.mesh && hasFaces && g.mesh.looseEdges.length) {
    const P = g.mesh.positions,
      L = g.mesh.looseEdges;
    for (let i = 0; i < L.length; i += 2) seg.push(P[L[i] * 3], P[L[i] * 3 + 1], P[L[i] * 3 + 2], P[L[i + 1] * 3], P[L[i + 1] * 3 + 1], P[L[i + 1] * 3 + 2]);
  }
  if (seg.length) {
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(seg), 3));
    const l = new LineSegments(lg, new LineBasicMaterial({ color: 0x000000 }));
    l.frustumCulled = false;
    out.push(l);
  }
  return out;
}

function dispose(e: Entry) {
  for (const o of e.objs) {
    scene.remove(o);
    o.geometry.dispose();
    (o.material as ShaderMaterial).dispose();
  }
}

function sync(localView: Set<string> | null) {
  const seen = new Set<string>();
  for (const [id, r] of gnResults) {
    const ev = app.graph.get(id);
    if (!ev || ev.mesh !== r.evalMesh || !ev.visible || (localView && !localView.has(id))) continue;
    const shown = r.viewer ?? r.geometry;
    seen.add(id);
    let e = entries.get(id);
    if (!e || e.geo !== shown) {
      if (e) dispose(e);
      e = { geo: shown, objs: build(shown, !!shown.mesh?.faceCount) };
      for (const o of e.objs) {
        o.matrixAutoUpdate = false;
        scene.add(o);
      }
      entries.set(id, e);
    }
    const ob = ev.ob;
    const active = app.doc.scene.active_object === id && ob.select;
    const lineColor = active ? new Color(1, 0.627, 0.157) : ob.select ? new Color(0.929, 0.341, 0) : new Color(0, 0, 0);
    for (const o of e.objs) {
      o.visible = true;
      o.matrixWorld.copy(ev.world);
      if (o instanceof LineSegments) (o.material as LineBasicMaterial).color.copy(lineColor).convertSRGBToLinear();
    }
  }
  for (const [id, e] of entries)
    if (!seen.has(id)) {
      if (!gnResults.has(id) || app.graph.get(id)?.mesh !== gnResults.get(id)!.evalMesh) {
        dispose(e);
        entries.delete(id);
      } else for (const o of e.objs) o.visible = false;
    }
}

viewportExtensions.push((v) => {
  const draw = (_s: Scene, camera: Camera) => {
    if (!gnResults.size && !entries.size) return;
    const r = renderContext?.engine.renderer;
    if (!r) return;
    sync(v.localView);
    if (!scene.children.some((c) => c.visible)) return;
    r.getCurrentViewport(vp);
    for (const c of scene.children) if (c instanceof Points) (c.material as ShaderMaterial).uniforms.uHalfH.value = vp.w / 2;
    r.render(scene, camera);
  };
  v.extraOverlays.push(draw);
  return () => {
    const i = v.extraOverlays.indexOf(draw);
    if (i >= 0) v.extraOverlays.splice(i, 1);
  };
});

// generated materials (Set Material) and viewer colors on the object's main mesh
drawHooks.materials.push((so, mode, view, mats) => {
  const r = gnResults.get(so.ev.ob.id);
  if (!r || so.ev.mesh !== r.evalMesh) return;
  const em = so.ev.mesh as GnEvalMesh;
  const sh = view.shading;
  if (r.viewer && em.colors && mode !== 'WIREFRAME') {
    const m = solidMaterial({
      color: [1, 1, 1],
      lighting: sh.light,
      vertexColors: true,
      backfaceCulling: sh.show_backface_culling,
      specular: false,
    });
    for (let i = 0; i < mats.length; i++) mats[i] = m;
    return;
  }
  if (!em.gnMaterials) return;
  const doc = app.doc;
  for (let i = 0; i < mats.length; i++) {
    const id = em.gnMaterials[i] ?? null;
    if (mode === 'SOLID') {
      if (sh.color_type !== 'MATERIAL') continue;
      const ma = id ? doc.materials[id] : undefined;
      mats[i] = solidMaterial({
        color: ma ? [ma.diffuse_color[0], ma.diffuse_color[1], ma.diffuse_color[2]] : [0.8, 0.8, 0.8],
        lighting: sh.light,
        backfaceCulling: sh.show_backface_culling,
        specular: sh.show_specular_highlight,
      });
    } else if (mode === 'MATERIAL' || mode === 'RENDERED') mats[i] = viewportMaterial(doc, id);
  }
});
