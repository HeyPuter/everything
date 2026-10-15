// Voxel Size edit (R in Sculpt Mode): drag to set the remesh voxel size with a preview grid of
// voxels drawn on the surface under the cursor.
import { Vector3 } from 'three';
import { app, registerOperators } from '../app/app';
import { h, type VNode } from '../ui/h';
import { editModeHooks } from '../editors/view3d/hooks';
import { activeView3D, type View3D } from '../editors/view3d/view3d';
import { activeMeshData, meshSession } from './session';

const preview = { view: null as View3D | null, x: 0, y: 0, cellPx: 0 };

editModeHooks.svg.push((v) => {
  if (preview.view !== v || preview.cellPx <= 0) return null;
  const n = 8;
  const c = Math.max(1, preview.cellPx);
  const half = (n * c) / 2;
  let d = '';
  for (let i = 0; i <= n; i++) {
    d += `M${preview.x - half + i * c} ${preview.y - half}v${n * c}`;
    d += `M${preview.x - half} ${preview.y - half + i * c}h${n * c}`;
  }
  return h(
    'g',
    { key: 'voxel-grid', 'pointer-events': 'none' },
    h('path', { d, stroke: '#000000', 'stroke-width': 2, opacity: 0.35, fill: 'none' }),
    h('path', { d, stroke: '#ffffff', 'stroke-width': 1, opacity: 0.8, fill: 'none' }),
  ) as VNode;
});

registerOperators([
  {
    idname: 'object.voxel_size_edit',
    label: 'Edit Voxel Size',
    description: 'Drag to change the voxel size used by Voxel Remesh',
    props: [{ id: 'voxel_size', label: 'Voxel Size', type: 'float', default: 0.1, min: 0.0001, max: 10, subtype: 'distance', precision: 4 }],
    poll: () => !!activeMeshData() && (app.doc.mode === 'OBJECT' || (app.doc.mode === 'SCULPT' && !app.doc.scene.tool_settings.sculpt.use_dyntopo)) && !!activeView3D(),
    invoke: (ctx, p) => {
      const v = activeView3D()!;
      const s = meshSession();
      const { me } = activeMeshData()!;
      if (!s) return 'CANCELLED';
      const r = v.el.getBoundingClientRect();
      const x0 = (ctx.event?.x ?? app.pointer.x) - r.left,
        y0 = (ctx.event?.y ?? app.pointer.y) - r.top;
      const hit = s.raycast(v, x0, y0);
      // world size of one pixel at the depth of the surface (or the object origin)
      const at = hit ? hit.world : new Vector3().setFromMatrixPosition(s.world());
      const worldPerPx = s.pixelsToLocal(v, at, 1) * s.scale();
      const start = me.remesh_voxel_size ?? 0.1;
      const before = me.remesh_voxel_size;
      let size = start;
      Object.assign(preview, { view: v, x: x0, y: y0, cellPx: (start * s.scale()) / worldPerPx });
      const apply = (clientX: number, precise: boolean) => {
        const dx = clientX - r.left - x0;
        size = Math.max(0.0001, start * Math.exp((dx / 200) * (precise ? 0.2 : 1)));
        preview.cellPx = (size * s.scale()) / worldPerPx;
        v.drawSvg();
      };
      v.drawSvg();
      app.startModal({
        label: 'Edit Voxel Size',
        cursor: 'ew-resize',
        onPointerMove: (e) => apply(e.clientX, e.shiftKey),
        onPointerDown: (e) => (e.button === 2 ? 'CANCELLED' : 'FINISHED'),
        onKey: (e) => (e.type !== 'keydown' ? true : e.key === 'Escape' ? 'CANCELLED' : e.key === 'Enter' ? 'FINISHED' : true),
        cancel: () => {
          me.remesh_voxel_size = before;
          preview.cellPx = 0;
          v.drawSvg();
        },
        finish: () => {
          me.remesh_voxel_size = Math.round(size * 1e5) / 1e5;
          p.voxel_size = me.remesh_voxel_size;
          preview.cellPx = 0;
          v.drawSvg();
          app.report('INFO', `Voxel Size: ${me.remesh_voxel_size}`);
        },
        header: () => `Voxel Size: ${size.toFixed(4)} · move left / right (Shift: precise), click to apply, Esc cancels`,
        redoOp: { idname: 'object.voxel_size_edit', props: p },
      });
      return 'RUNNING_MODAL';
    },
    exec: (_c, p) => {
      activeMeshData()!.me.remesh_voxel_size = p.voxel_size as number;
    },
  },
]);
