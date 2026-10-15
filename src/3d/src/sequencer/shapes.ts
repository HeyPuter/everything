// Circle / lasso selection overlays shared by the timeline and the preview.

/** Overlay shapes drawn while circle / lasso selecting (region-local pixels). */
export type SelectShape = { kind: 'circle'; x: number; y: number; r: number } | { kind: 'lasso'; pts: [number, number][] };

export function drawShape(g: CanvasRenderingContext2D, shape: SelectShape | null) {
  if (!shape) return;
  g.save();
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.beginPath();
  if (shape.kind === 'circle') g.arc(shape.x, shape.y, shape.r, 0, Math.PI * 2);
  else shape.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  if (shape.kind === 'lasso') {
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fill();
  }
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.stroke();
  g.lineDashOffset = 3.5;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.stroke();
  g.restore();
}
