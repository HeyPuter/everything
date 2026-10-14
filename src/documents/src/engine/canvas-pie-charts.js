// Original pie painter, also used for doughnuts with legends or rich titles.
// Without a manual plot layout the circle is centered in the space left by the
// automatic title and legend (an application layout choice).
import { doughnutFrame, doughnutSegments } from './canvas-doughnut-charts.js';
import { columnTitleLayout, paintColumnTitle } from './canvas-chart-titles.js';
import { chartLegendLayout, paintChartLegend, resolvedChartText } from './canvas-xy-charts.js';
import { measureCanvasText, setCanvasTextStyle } from './canvas-text.js';

const INSET = 11 * 4 / 3;

export function paintPieChart(ctx, chart, width, height) {
  const rect = (style, x, y, w, h) => {
    if (style?.fill) { ctx.fillStyle = style.fill; ctx.fillRect(x, y, w, h); }
    if (style?.line && (style.lineWidth ?? 1)) { ctx.strokeStyle = style.line; ctx.lineWidth = style.lineWidth ?? 1; ctx.strokeRect(x, y, w, h); }
  };
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  rect(chart.background, 0, 0, width, height);
  const rich = chart.title?.paragraphs ? columnTitleLayout(ctx, chart.title, width) : null;
  const first = chart.series[0];
  const legend = chart.legend && chartLegendLayout(ctx, first.categories.map((name, i) => ({ name, fill: first.points[i]?.fill, line: first.points[i]?.line })),
    resolvedChartText(chart, chart.legendText), chart.legendPosition || 'r', width, height);
  let box;
  if (chart.layout) box = doughnutFrame(chart, width, height);
  else {
    const top = rich ? rich.plotTop : INSET, right = width - INSET - (legend?.position === 'r' ? legend.width + INSET / 2 : 0);
    const bottom = height - INSET - (legend?.position === 'b' ? legend.height + INSET / 2 : 0);
    const w = Math.max(0, right - INSET), h = Math.max(0, bottom - top);
    box = { x: INSET, y: top, width: w, height: h, cx: INSET + w / 2, cy: top + h / 2, radius: Math.min(w, h) / 2 };
  }
  rect(chart.plot, box.x, box.y, box.width, box.height);
  for (const series of doughnutSegments(chart)) for (const segment of series) {
    const { start, end, inner, outer } = segment; if (end <= start || !box.radius) continue;
    const ri = inner * box.radius, ro = outer * box.radius;
    ctx.beginPath(); ctx.arc(box.cx, box.cy, ro, start, end);
    if (!ri) ctx.lineTo(box.cx, box.cy);
    else if (end - start >= Math.PI * 2 - 1e-12) { ctx.closePath(); ctx.moveTo(box.cx + ri * Math.cos(end), box.cy + ri * Math.sin(end)); }
    else ctx.lineTo(box.cx + ri * Math.cos(end), box.cy + ri * Math.sin(end));
    if (ri) ctx.arc(box.cx, box.cy, ri, end, start, true);
    ctx.closePath();
    if (segment.fill) { ctx.fillStyle = segment.fill; ctx.fill(); }
    if (segment.line && segment.lineWidth) { ctx.strokeStyle = segment.line; ctx.lineWidth = segment.lineWidth; ctx.lineJoin = segment.lineJoin || 'round'; ctx.stroke(); }
  }
  if (legend) paintChartLegend(ctx, legend);
  if (rich) paintColumnTitle(ctx, chart.title, rich);
  else if (chart.title) {
    // Generated doughnut titles keep their manual position (see canvas-doughnut-charts.js).
    const { title } = chart, style = title.style, natural = measureCanvasText(ctx, title.text, style);
    const x = title.layout.x * width, y = title.layout.y * height, scale = style.fontSize / 1536;
    rect(title.background, x, y, natural.width + 8, natural.ascent + natural.descent + 4);
    ctx.save(); setCanvasTextStyle(ctx, { ...style, fontSize: 1536, kerning: style.kerning && style.fontSize >= style.kerning ? 1 : 0 });
    ctx.scale(scale, scale); ctx.fillStyle = '#' + style.color; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(title.text, (x + 4) / scale, (y + 2 + natural.ascent) / scale); ctx.restore();
  }
  ctx.restore();
}
