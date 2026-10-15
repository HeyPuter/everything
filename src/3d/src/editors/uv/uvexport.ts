// Export UV Layout: the UV faces of the edited meshes as an SVG or PNG image.
import { app, registerOperators } from '../../app/app';
import type { MeshData } from '../../data/types';
import { download } from '../../render/final/result';
import { materialSlots } from '../view3d/draw';
import { uvLayers, uvEditPoll } from './uvcontext';
import { operatorDialog } from './dialog';

export interface LayoutFace {
  uvs: number[];
  color: [number, number, number];
}

/** Faces to export: the shown faces, or every unhidden face with `all`. */
export function layoutFaces(all: boolean): LayoutFace[] {
  const out: LayoutFace[] = [];
  for (const layer of uvLayers()) {
    const me = layer.me;
    const slots = materialSlots(app.doc, layer.ob);
    const faces = all ? allFaces(me) : layer.faces;
    for (const f of faces) {
      const uvs: number[] = [];
      for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) uvs.push(me.uvs[c * 2], me.uvs[c * 2 + 1]);
      const ma = slots[me.material_index?.[f] ?? 0];
      const col = ma ? app.doc.materials[ma]?.diffuse_color : undefined;
      out.push({ uvs, color: col ? [col[0], col[1], col[2]] : [0.8, 0.8, 0.8] });
    }
  }
  return out;
}

function allFaces(me: MeshData) {
  const out: number[] = [];
  for (let f = 0; f < me.offsets.length - 1; f++) {
    let hidden = false;
    for (let c = me.offsets[f]; c < me.offsets[f + 1]; c++) if (me.hide_vert?.[me.indices[c]]) hidden = true;
    if (!hidden) out.push(f);
  }
  return out;
}

const hex = (c: [number, number, number]) => '#' + c.map((x) => Math.round(Math.max(0, Math.min(1, x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055)) * 255).toString(16).padStart(2, '0')).join('');

/** SVG document of the layout (V up, like the UV editor). */
export function layoutSVG(faces: LayoutFace[], w: number, h: number, opacity: number): string {
  const polys = faces
    .map((f) => {
      const pts: string[] = [];
      for (let i = 0; i < f.uvs.length; i += 2) pts.push(`${(f.uvs[i] * w).toFixed(3)},${((1 - f.uvs[i + 1]) * h).toFixed(3)}`);
      return `<polygon points="${pts.join(' ')}" fill="${hex(f.color)}" fill-opacity="${opacity}" stroke="#000" stroke-width="1" stroke-linejoin="round"/>`;
    })
    .join('\n');
  return `<?xml version="1.0" standalone="no"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n<desc>UV layout</desc>\n${polys}\n</svg>\n`;
}

export function layoutCanvas(faces: LayoutFace[], w: number, h: number, opacity: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.lineJoin = 'round';
  for (const f of faces) {
    g.beginPath();
    for (let i = 0; i < f.uvs.length; i += 2) {
      const x = f.uvs[i] * w,
        y = (1 - f.uvs[i + 1]) * h;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    if (opacity > 0) {
      g.globalAlpha = opacity;
      g.fillStyle = hex(f.color);
      g.fill();
      g.globalAlpha = 1;
    }
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.stroke();
  }
  return c;
}

registerOperators([
  {
    idname: 'uv.export_layout',
    label: 'Export UV Layout',
    description: 'Save the UV faces as an image to paint over or print',
    props: [
      { id: 'export_all', label: 'All UVs', type: 'bool', default: false },
      { id: 'mode', label: 'Format', type: 'enum', default: 'PNG', items: [['SVG', 'Scalable Vector Graphic (.svg)'], ['PNG', 'PNG Image (.png)']] },
      { id: 'size', label: 'Size', type: 'vec2', default: [1024, 1024], subtype: 'pixel' },
      { id: 'opacity', label: 'Fill Opacity', type: 'float', default: 0.25, min: 0, max: 1, subtype: 'factor' },
      { id: 'filepath', label: 'File Name', type: 'string', default: '' },
    ],
    poll: uvEditPoll,
    undo: false,
    invoke: (ctx) => {
      const ob = app.activeObject;
      operatorDialog('uv.export_layout', { title: 'Export UV Layout', ok: 'Export', props: { filepath: ob ? ob.name : 'uv_layout' }, area: ctx.area });
      return 'CANCELLED';
    },
    exec: (_ctx, p) => {
      const faces = layoutFaces(!!p.export_all);
      if (!faces.length) {
        app.report('WARNING', 'No UV faces to export');
        return 'CANCELLED';
      }
      const [w, h] = (p.size as number[]).map((x) => Math.max(8, Math.min(16384, Math.round(x))));
      const base = String(p.filepath || app.activeObject?.name || 'uv_layout').replace(/\.(png|svg)$/i, '');
      if (p.mode === 'SVG') {
        download(new Blob([layoutSVG(faces, w, h, p.opacity as number)], { type: 'image/svg+xml' }), `${base}.svg`);
      } else {
        const c = layoutCanvas(faces, w, h, p.opacity as number);
        c.toBlob((b) => b && download(b, `${base}.png`), 'image/png');
      }
      app.report('INFO', `Exported UV layout "${base}.${p.mode === 'SVG' ? 'svg' : 'png'}"`);
      return 'FINISHED';
    },
  },
]);
