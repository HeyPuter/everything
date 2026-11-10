/** Native sparklines are worksheet decorations, not formula result values. */
import { t } from '../i18n/index.js';
const number = value => Number(value.toFixed(4));
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function nativeSparklineLabel(data) {
  const kind = data.group.type === 'stacked' ? 'winLoss' : data.group.type === 'column' ? 'column' : 'line';
  if (data.unavailable) return t('nativeSparkline.labelUnavailable', { kind });
  if (!data.count) return t('nativeSparkline.labelEmpty', { kind });
  return t('nativeSparkline.label', { kind, count: data.count, min: data.min, max: data.max });
}
export function renderNativeSparklineSvg(data, width, height) {
  const W = Math.max(0, width), H = Math.max(0, height), { group, colors } = data;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(W)} ${number(H)}" width="${number(W)}" height="${number(H)}" aria-hidden="true" focusable="false" style="display:block;overflow:hidden">`];
  if (!data.count || !W || !H) return out.join('') + '</svg>';
  const line = group.type === 'line', winloss = group.type === 'stacked';
  const weight = group.lineWeight * 4 / 3;
  const marked = group.markers || group.high || group.low || group.first || group.last || group.negative;
  const marker = Math.max(weight, 1) * 2;
  const inset = line ? Math.min(Math.max(weight / 2, marked ? marker / 2 : 0), Math.min(W, H) / 2) : 0;
  const innerW = Math.max(0, W - inset * 2), innerH = Math.max(0, H - inset * 2);
  let lo = winloss ? Math.min(0, Math.sign(data.minAxis)) : data.minAxis, hi = winloss ? Math.max(0, Math.sign(data.maxAxis)) : data.maxAxis;
  if (!line && !winloss) {
    if (group.minAxisType !== 'custom') lo = Math.min(0, lo);
    if (group.maxAxisType !== 'custom') hi = Math.max(0, hi);
  }
  // Normalize before subtracting so opposite large finite values cannot
  // overflow the span and turn valid data into NaN SVG coordinates.
  const scale = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
  const y = value => hi === lo ? H / 2 : inset + (1 - (value / scale - lo / scale) / (hi / scale - lo / scale)) * innerH;
  const points = group.dateAxis ? [...data.points].sort((a, b) => a.x - b.x || a.index - b.index) : data.points;
  const first = data.points.find(p => p.value != null)?.index, last = data.points.findLast(p => p.value != null)?.index;
  const pointColor = point => {
    // Specific point flags override the generic marker/negative colors. This
    // ordering is shared by line markers and column fills.
    if (group.high && point.value === data.max) return colors.high;
    if (group.low && point.value === data.min) return colors.low;
    if (group.first && point.index === first) return colors.first;
    if (group.last && point.index === last) return colors.last;
    if (group.negative && point.value < 0) return colors.negative;
    return line ? group.markers ? colors.markers : null : colors.series;
  };
  const minX = points[0].x, maxX = points.at(-1).x;
  // Columns occupy one category slot (or one day on a date axis). A line's
  // first/last category centers occupy the plot endpoints.
  const slotCount = group.dateAxis ? maxX - minX + 1 : points.length;
  const slot = innerW / Math.max(1, slotCount);
  const x = point => {
    const ratio = line ? maxX === minX ? 0.5 : (point.x - minX) / (maxX - minX) : (point.x - minX + 0.5) / Math.max(1, slotCount);
    return inset + (group.rightToLeft ? 1 - ratio : ratio) * innerW;
  };
  if (group.displayXAxis && lo <= 0 && hi >= 0) out.push(`<path d="M${number(inset)},${number(y(0))}H${number(W - inset)}" fill="none" stroke="${escape(colors.axis)}" stroke-width="1"/>`);
  if (line) {
    let path = '', pen = false;
    for (const point of points) {
      if (point.value == null) { if (group.displayEmptyCellsAs !== 'span' || !point.blank) pen = false; continue; }
      path += `${pen ? 'L' : 'M'}${number(x(point))},${number(y(point.value))}`; pen = true;
    }
    if (path && weight > 0) out.push(`<path d="${path}" fill="none" stroke="${escape(colors.series)}" stroke-width="${number(weight)}" stroke-linejoin="round"/>`);
    for (const point of points) {
      if (point.value == null) continue;
      const color = pointColor(point);
      if (color) out.push(`<rect data-point="${point.index}" x="${number(x(point) - marker / 2)}" y="${number(y(point.value) - marker / 2)}" width="${number(marker)}" height="${number(marker)}" fill="${escape(color)}"/>`);
    }
  } else {
    const baseline = y(Math.max(lo, Math.min(hi, 0)));
    for (const point of points) {
      if (point.value == null || point.value === 0) continue;
      const value = winloss ? Math.sign(point.value) : point.value, top = y(value), barWidth = slot * 0.7;
      out.push(`<rect data-point="${point.index}" x="${number(x(point) - barWidth / 2)}" y="${number(Math.min(top, baseline))}" width="${number(barWidth)}" height="${number(Math.abs(baseline - top))}" fill="${escape(pointColor(point))}"/>`);
    }
  }
  return out.join('') + '</svg>';
}
export function nativeSparklineNode(data, width, height, document = globalThis.document) {
  const node = document.createElement('div'); node.className = 'native-sparkline';
  node.setAttribute('role', 'img'); node.setAttribute('aria-label', nativeSparklineLabel(data));
  node.title = nativeSparklineLabel(data);
  node.innerHTML = renderNativeSparklineSvg(data, width, height);
  return node;
}
