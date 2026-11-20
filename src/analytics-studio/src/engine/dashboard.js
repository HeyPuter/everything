/**
 * Analytics Studio dashboards (original). Power BI/Tableau-inspired — not those products.
 * Local aggregates only; no LIVE warehouse connectors (DOCUMENTED).
 */

/** @typedef {{ label:string, value:number }} Point */
/** @typedef {{ id:string, title:string, kind:'bar'|'line'|'kpi', field:string }} Widget */
/** @typedef {{ rows:Record<string, string|number>[], widgets:Widget[] }} Dashboard */

/** @returns {Dashboard} */
export function createDashboard() {
  return {
    rows: [
      { region: 'North', product: 'Alpha', revenue: 120, units: 40 },
      { region: 'North', product: 'Beta', revenue: 80, units: 25 },
      { region: 'South', product: 'Alpha', revenue: 95, units: 30 },
      { region: 'South', product: 'Beta', revenue: 110, units: 35 },
      { region: 'East', product: 'Alpha', revenue: 70, units: 20 },
      { region: 'East', product: 'Beta', revenue: 60, units: 18 },
      { region: 'West', product: 'Alpha', revenue: 150, units: 50 },
      { region: 'West', product: 'Beta', revenue: 140, units: 45 },
    ],
    widgets: [
      { id: 'w1', title: 'Revenue by region', kind: 'bar', field: 'revenue' },
      { id: 'w2', title: 'Units by region', kind: 'line', field: 'units' },
      { id: 'w3', title: 'Total revenue', kind: 'kpi', field: 'revenue' },
    ],
  };
}

/**
 * @param {Dashboard} dash
 * @param {string} groupField
 * @param {string} valueField
 * @returns {Point[]}
 */
export function aggregate(dash, groupField, valueField) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of dash.rows) {
    const key = String(row[groupField] ?? '—');
    const val = Number(row[valueField] ?? 0);
    map.set(key, (map.get(key) || 0) + (Number.isFinite(val) ? val : 0));
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** @param {Dashboard} dash @param {string} field */
export function sumField(dash, field) {
  return dash.rows.reduce((acc, row) => acc + (Number(row[field]) || 0), 0);
}

/** @param {Point[]} points */
export function maxValue(points) {
  return points.reduce((m, p) => Math.max(m, p.value), 0);
}

/** Simple SVG bar chart (vector, original). */
export function barChartSvg(points, width = 360, height = 160) {
  const max = Math.max(1, maxValue(points));
  const gap = 8;
  const barW = (width - gap * (points.length + 1)) / Math.max(1, points.length);
  const bars = points
    .map((p, i) => {
      const h = (p.value / max) * (height - 36);
      const x = gap + i * (barW + gap);
      const y = height - 24 - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="#3ecfbf"/><text x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="#93a4b8">${escapeXml(p.label)}</text>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bars}</svg>`;
}

/** @param {string} s */
function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
