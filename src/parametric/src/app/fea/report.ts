// The results summary as a CSV file or a printable report (HTML in a new
// window, printed or saved as PDF by the browser).

import { feaUnits } from '../../model/fea';
import { formatNumber } from '../../model/units';
import { download } from '../../platform/files';
import type { Vec3 } from '../../fea/static';
import { h } from '../../ui/dom';
import { showDialog, toast } from '../../ui/overlay';
import type { App } from '../app';
import type { FeaResult, FeaWorkspace } from './workspace';

interface Line { section: string; name: string; value: string; unit: string }

/** The summary as rows: section, quantity, value (in the part's units), unit. */
export function summaryRows(app: App, ws: FeaWorkspace, r: FeaResult): Line[] {
  const u = feaUnits(app.store.doc.units);
  const s = r.sol.summary, st = r.mesh.stats;
  const out: Line[] = [];
  const add = (section: string, name: string, value: string | number, unit = '') => out.push({ section, name, value: typeof value === 'number' ? String(Number(value.toPrecision(6))) : value, unit });
  const L = (x: number) => x / u.lengthScale, S = (x: number) => x / u.stressScale, F = (x: number) => x / u.forceScale;
  const at = (p: Vec3) => p.map((x) => formatNumber(L(x), app.store.doc.decimals)).join(' ');
  add('Study', 'Part', app.store.doc.name);
  add('Study', 'Study', ws.study?.name ?? '');
  add('Study', 'Type', 'Linear static (small displacements, linear elastic isotropic material)');
  add('Study', 'Solved', new Date(r.when).toISOString());
  add('Study', 'Up to date', ws.state() === 'ok' ? 'yes' : 'no (the part or the study changed since)');
  add('Material', 'Name', r.material);
  add('Material', 'Elastic modulus', S(r.input.E), u.stress);
  add('Material', 'Poisson\'s ratio', r.input.nu);
  add('Material', 'Yield strength', S(r.yield), u.stress);
  add('Material', 'Tensile strength', S(r.uts), u.stress);
  add('Material', 'Density', r.input.density * 1e12, 'kg/m³');
  add('Results', 'Max von Mises stress', S(s.maxVonMises.value), u.stress);
  add('Results', 'Max von Mises stress at', at(s.maxVonMises.at), u.length);
  add('Results', 'Min factor of safety (yield / von Mises)', s.maxVonMises.value > 0 ? r.yield / s.maxVonMises.value : 'infinite');
  add('Results', 'Max displacement', L(s.maxDisplacement.value), u.length);
  add('Results', 'Max displacement at', at(s.maxDisplacement.at), u.length);
  add('Results', 'Max principal stress', S(s.maxP1.value), u.stress);
  add('Results', 'Min principal stress', S(s.minP3.value), u.stress);
  add('Results', 'Max equivalent strain', s.maxStrain.value);
  for (const w of s.warnings ?? []) add('Results', 'Note', w);
  add('Results', 'Yielding', s.maxVonMises.value > r.yield ? 'yes: stress above yield, the linear analysis no longer holds there' : 'no');
  r.loadNames.forEach((n, i) => {
    const ld = r.input.loads[i];
    add('Loads', n, ld.kind === 'gravity' ? 'gravity' : ld.kind === 'pressure' ? `${Number(S(ld.value).toPrecision(6))} ${u.stress} on ${formatNumber(s.loadAreas[i] / u.lengthScale ** 2, 2)} ${u.length}²` : `${Number(F(ld.total).toPrecision(6))} ${u.force} on ${formatNumber(s.loadAreas[i] / u.lengthScale ** 2, 2)} ${u.length}²`);
  });
  for (const [k, v] of [['X', 0], ['Y', 1], ['Z', 2]] as const) add('Forces', `Applied loads (sum) ${k}`, F(s.applied[v]), u.force);
  r.fixtureNames.forEach((n, i) => { for (const [k, v] of [['X', 0], ['Y', 1], ['Z', 2]] as const) add('Forces', `Reaction ${n} ${k}`, F(s.reactions[i][v]), u.force); });
  const total = s.reactions.reduce<Vec3>((a, x) => [a[0] + x[0], a[1] + x[1], a[2] + x[2]], [0, 0, 0]);
  const imbalance = Math.hypot(total[0] + s.applied[0], total[1] + s.applied[1], total[2] + s.applied[2]) / Math.max(Math.hypot(...s.applied), 1e-30);
  add('Forces', 'Equilibrium error (|reactions + loads| / |loads|)', imbalance);
  add('Mesh', 'Element type', '10-node quadratic tetrahedra');
  add('Mesh', 'Element size', L(st.size), u.length);
  add('Mesh', 'Elements', st.elements);
  add('Mesh', 'Nodes', st.nodes);
  add('Mesh', 'Unknowns', s.dofs);
  add('Mesh', 'Worst element quality (mean ratio)', st.minQuality);
  add('Mesh', 'Mean element quality', st.meanQuality);
  add('Mesh', 'Volume against the part', `${((st.volume / st.surfaceVolume - 1) * 100).toFixed(3)}%`);
  add('Solver', 'Method', `Conjugate gradients, ${s.solver}`);
  add('Solver', 'Iterations', s.iterations);
  add('Solver', 'Relative residual', s.residual);
  add('Solver', 'Time', (s.ms.assemble + s.ms.setup + s.ms.solve + s.ms.stress) / 1000, 's');
  return out;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function summaryCsv(rows: Line[]): string {
  return ['Section,Quantity,Value,Unit', ...rows.map((r) => [r.section, r.name, r.value, r.unit].map(csvCell).join(','))].join('\n') + '\n';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function reportHtml(title: string, rows: Line[], image: string | null): string {
  const sections = [...new Set(rows.map((r) => r.section))];
  const body = sections.map((s) => `<h2>${esc(s)}</h2><table>${rows.filter((r) => r.section === s).map((r) => `<tr><th>${esc(r.name)}</th><td>${esc(r.value)}${r.unit ? ` ${esc(r.unit)}` : ''}</td></tr>`).join('')}</table>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:13px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;width:100%}th{text-align:left;font-weight:500;width:45%;padding:3px 8px 3px 0;color:#333}td{padding:3px 0}
img{max-width:100%;border:1px solid #ddd;margin-top:8px}.note{color:#555;font-size:12px;margin-top:18px}
</style></head><body><h1>${esc(title)}</h1>${image ? `<img src="${image}" alt="Result plot">` : ''}${body}
<p class="note">Linear static analysis: small displacements, linear elastic isotropic material, no contact. Stresses at sharp inner corners and at the edges of fixed faces can grow without bound as the mesh is refined (stress singularities); judge them by the stresses a little away from such spots.</p></body></html>`;
}

export async function reportDialog(app: App, ws: FeaWorkspace, r: FeaResult) {
  const rows = summaryRows(app, ws, r);
  const name = `${app.store.doc.name || 'Part'} - ${ws.study?.name ?? 'Static Study'}`;
  const v = await showDialog({
    title: 'Results Report', signal: app.documentSignal,
    body: [h('p', {}, 'Export the study\'s summary: material, loads, reaction forces, the largest stress and displacement, the factor of safety and the mesh.')],
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Download CSV', value: 'csv' }, { label: 'Printable Report', value: 'html', primary: true }],
  });
  if (v === 'csv') download(summaryCsv(rows), `${name}.csv`, 'text/csv');
  if (v === 'html') {
    const image = ws.plotting ? app.renderer.capture(1400) : null;
    const html = reportHtml(name, rows, image);
    const w = window.open('', '_blank');
    if (!w) { download(html, `${name}.html`, 'text/html'); toast({ kind: 'info', message: 'The report was downloaded (the browser blocked the new window): open it and print it.' }); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch { /* the user prints it */ } }, 300);
  }
}
