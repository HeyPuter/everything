// CAM dialogs: the tool library and post processing to G-code.

import { CamCancelled } from '../../cam/client';
import type { PostJob, PostOperation } from '../../cam/post';
import { type CamController, type CamTool, type CamToolType, CONTROLLER_LABELS, TOOL_TYPE_LABELS, newCamDoc, opFeeds } from '../../model/cam';
import { allocateId } from '../../model/document';
import { UNIT_SYSTEMS } from '../../model/units';
import { download, safeName } from '../../platform/files';
import { h, nextDomId } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { showDialog, toast } from '../../ui/overlay';
import type { App } from '../app';
import { checkbox, numberField, selectField } from '../pm';
import { CamPanel, rateField } from './panels';
import type { PostWorkerResponse } from './post-worker';
import type { CamWorkspace } from './workspace';

const TYPES = Object.entries(TOOL_TYPE_LABELS).map(([value, label]) => ({ value: value as CamToolType, label }));

/** The tool library: add, change and remove the part's cutting tools (one undo step). */
export async function toolLibraryDialog(app: App, ws: CamWorkspace, select?: string) {
  // Without CAM data yet, the starting library (kept only if OK is pressed).
  let fresh = 0;
  const cam = app.store.doc.cam ?? newCamDoc(() => `__new${++fresh}`, app.store.doc.units === 'IPS');
  const tools: CamTool[] = structuredClone(cam.tools);
  const used = (id: string) => cam.setups.flatMap((s) => s.ops).filter((o) => o.tool === id).length;
  let current = tools.find((t) => t.id === select) ?? tools[0] ?? null;
  const ctx = app.unitContext();
  const u = UNIT_SYSTEMS[ctx.units];
  const fs = ctx.units === 'IPS' ? 25.4 : 1, fu = ctx.units === 'IPS' ? 'in/min' : 'mm/min';
  const list = h('div', { class: 'cam-tool-list', role: 'listbox', 'aria-label': 'Tools', tabindex: '0' });
  const form = h('div', { class: 'cam-tool-form' });
  const msg = h('p', { class: 'pm-msg', role: 'status', hidden: true });
  let nextLocal = 0;
  const newId = () => {
    // Ids from the part's counter (taken on OK); until then a placeholder.
    nextLocal++;
    return `__add${nextLocal}`;
  };
  const listId = nextDomId('tools');
  const drawList = () => {
    list.textContent = '';
    list.removeAttribute('aria-activedescendant');
    for (const [k, t] of [...tools].sort((a, b) => a.number - b.number).entries()) {
      // The list keeps the focus; the tool chosen is its active option (read out, kept in view).
      const opt = h('div', { id: `${listId}-${k}`, role: 'option', class: 'cam-tool', 'aria-selected': String(t === current) },
        h('span', { class: 'num' }, `T${t.number}`), h('span', { class: 'grow' }, t.name), h('span', { class: 'muted' }, `${TOOL_TYPE_LABELS[t.type]} · ${formatLen(t.diameter)}`));
      opt.addEventListener('click', () => { current = t; drawList(); drawForm(); });
      list.append(opt);
      if (t === current) list.setAttribute('aria-activedescendant', opt.id);
    }
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  const formatLen = (mm: number) => `${Number((mm / u.scale).toPrecision(6))} ${u.length}`;
  list.addEventListener('keydown', (e) => {
    const sorted = [...tools].sort((a, b) => a.number - b.number);
    const i = current ? sorted.indexOf(current) : -1;
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? sorted.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    current = sorted[Math.max(0, Math.min(sorted.length - 1, to))] ?? null;
    drawList(); drawForm();
  });
  const drawForm = () => {
    form.textContent = '';
    msg.hidden = true;
    const t = current;
    if (!t) { form.append(h('p', { class: 'field-label' }, 'No tools. Add one.')); return; }
    const nameId = nextDomId('tn');
    const name = h('input', { class: 'input', id: nameId, value: t.name }) as HTMLInputElement;
    name.addEventListener('input', () => { t.name = name.value; drawList(); });
    const corner = numberField({ label: 'Corner radius', value: t.cornerRadius ?? 0, kind: 'length', ctx, min: 0, allowExpr: false, onChange: (v) => { t.cornerRadius = Number(v); } });
    const tip = numberField({ label: 'Point angle', value: t.tipAngle ?? (t.type === 'drill' ? 118 : 90), kind: 'angle', ctx, min: 10, max: 179, allowExpr: false, onChange: (v) => { t.tipAngle = Number(v); } });
    corner.hidden = t.type !== 'bull';
    tip.hidden = t.type !== 'drill' && t.type !== 'chamfer';
    form.append(
      h('div', {}, h('label', { class: 'field-label', for: nameId }, 'Name'), name),
      selectField<CamToolType>('Type', t.type, TYPES, (v) => {
        t.type = v;
        if (v === 'drill' || v === 'chamfer') t.tipAngle ??= v === 'drill' ? 118 : 90;
        if (v === 'bull') t.cornerRadius ??= Math.min(1, t.diameter / 4);
        drawList(); drawForm();
      }),
      numberField({ label: 'Tool number', value: t.number, kind: 'count', ctx, min: 0, max: 9999, allowExpr: false, onChange: (v) => { t.number = Number(v); drawList(); } }),
      numberField({ label: 'Diameter', value: t.diameter, kind: 'length', ctx, min: 0.01, allowExpr: false, onChange: (v) => { t.diameter = Number(v); drawList(); } }),
      corner, tip,
      numberField({ label: 'Flute length', value: t.fluteLength, kind: 'length', ctx, min: 0.01, allowExpr: false, onChange: (v) => { t.fluteLength = Number(v); } }),
      numberField({ label: 'Flutes', value: t.flutes, kind: 'count', ctx, min: 1, max: 20, allowExpr: false, onChange: (v) => { t.flutes = Number(v); } }),
      rateField('Spindle speed', t.rpm, 'rpm', 1, (v) => { t.rpm = v ?? t.rpm; }, { whole: true }),
      rateField('Cutting feed', t.feed, fu, fs, (v) => { t.feed = v ?? t.feed; }, { min: 0.001 }),
      rateField('Plunge feed', t.plunge, fu, fs, (v) => { t.plunge = v ?? t.plunge; }, { min: 0.001 }),
      checkbox('Coolant (M8)', t.coolant, (v) => { t.coolant = v; }),
    );
  };
  const addBtn = h('button', { class: 'btn small', type: 'button' }, icon('plus', 14), 'Add');
  addBtn.addEventListener('click', () => {
    const n = Math.max(0, ...tools.map((t) => t.number)) + 1;
    const d = ctx.units === 'IPS' ? 6.35 : 6;
    const t: CamTool = { id: newId(), number: n, name: `${formatLen(d)} flat end mill`, type: 'flat', diameter: d, fluteLength: d * 3, flutes: 3, rpm: 12000, feed: 700, plunge: 240, coolant: true };
    tools.push(t);
    current = t;
    drawList(); drawForm();
  });
  const dupBtn = h('button', { class: 'btn small', type: 'button' }, icon('copy', 14), 'Duplicate');
  dupBtn.addEventListener('click', () => {
    if (!current) return;
    const t = { ...structuredClone(current), id: newId(), number: Math.max(0, ...tools.map((x) => x.number)) + 1, name: `${current.name} (copy)` };
    tools.push(t);
    current = t;
    drawList(); drawForm();
  });
  const delBtn = h('button', { class: 'btn small', type: 'button' }, icon('trash', 14), 'Delete');
  delBtn.addEventListener('click', () => {
    if (!current) return;
    const n = used(current.id);
    if (n) { msg.hidden = false; msg.className = 'pm-msg warn'; msg.textContent = `${current.name} is used by ${n} operation${n === 1 ? '' : 's'}. Choose another tool for ${n === 1 ? 'it' : 'them'} first.`; return; }
    tools.splice(tools.indexOf(current), 1);
    current = tools[0] ?? null;
    drawList(); drawForm();
  });
  drawList();
  drawForm();
  const body = h('div', { class: 'cam-tools' },
    h('div', { class: 'cam-tools-side' }, list, h('div', { class: 'row' }, addBtn, dupBtn, delBtn), msg),
    form);
  const v = await showDialog({
    title: 'Tool Library', body, wide: true, signal: app.documentSignal,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'OK', primary: true, value: 'ok' }],
    onAction: (val) => {
      if (val !== 'ok') return;
      const numbers = tools.map((t) => t.number);
      if (new Set(numbers).size !== numbers.length) { msg.hidden = false; msg.className = 'pm-msg error'; msg.textContent = 'Two tools have the same number. Give each tool its own number.'; return false; }
      if (tools.some((t) => !t.name.trim())) { msg.hidden = false; msg.className = 'pm-msg error'; msg.textContent = 'Every tool needs a name.'; return false; }
      return true;
    },
  });
  if (v !== 'ok') return;
  app.store.change(app.store.doc.cam ? 'Edit tool library' : 'Start CAM', (d) => {
    for (const t of tools) if (t.id.startsWith('__')) t.id = allocateId(d, 't');
    d.cam ??= { ...newCamDoc(() => ''), tools: [] };
    d.cam.tools = tools;
  });
  ws.changed();
  if (app.panel instanceof CamPanel) {
    app.panel.toolsChanged();
    app.refreshPanel();
  }
}

const EXTENSIONS: Record<CamController, string> = { fanuc: 'nc', haas: 'nc', mach3: 'tap', linuxcnc: 'ngc', grbl: 'gcode' };

/** G-code writing in a worker; a newer request stops the one still running. */
class PostWriter {
  private worker: Worker | null = null;

  write(job: PostJob): Promise<{ code: string; lines: number; head: string }> {
    this.stop();
    const w = new Worker(new URL('./post-worker.ts', import.meta.url), { type: 'module', name: 'cam-post' });
    this.worker = w;
    return new Promise((resolve, reject) => {
      const done = () => { w.terminate(); if (this.worker === w) this.worker = null; };
      w.onmessage = (ev: MessageEvent<PostWorkerResponse>) => {
        done();
        if ('error' in ev.data) reject(new Error(ev.data.error));
        else resolve(ev.data);
      };
      w.onerror = (ev) => {
        ev.preventDefault();
        done();
        reject(new Error(ev.message || 'The G-code could not be written.'));
      };
      w.postMessage(job);
    });
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Writes the G-code of the setups for a controller and downloads it. */
export async function postDialog(app: App, ws: CamWorkspace) {
  const cam = ws.cam;
  if (!cam?.setups.some((s) => s.ops.some((o) => !o.suppressed))) { toast({ kind: 'info', message: 'Add a setup with operations first (CAM tab).' }); return; }
  const why = ws.ready();
  if (why) { toast({ kind: 'warning', message: why }); return; }
  const post = structuredClone(cam.post);
  const units = post.units ?? (app.store.doc.units === 'IPS' ? 'in' : 'mm');
  let unitsSel: 'mm' | 'in' = units;
  const chosen = new Set(cam.setups.map((s) => s.id));
  const preview = h('pre', { class: 'cam-gcode', tabindex: '0', 'aria-label': 'G-code preview' }, 'Generating toolpaths...');
  const status = h('p', { class: 'pm-msg', role: 'status', hidden: true });
  let code = '';
  // Each change writes the program again; only the newest one is shown and written out.
  let seq = 0;
  const make = async () => {
    const mine = ++seq;
    status.hidden = true;
    try {
      await ws.generate(cam.setups.filter((s) => chosen.has(s.id)).map((s) => s.id));
    } catch (e) {
      if (e instanceof CamCancelled) return;
    }
    if (mine !== seq) return;
    const now = ws.cam!;
    const setups = now.setups.filter((s) => chosen.has(s.id)).map((s) => {
      const ops: PostOperation[] = [];
      for (const o of s.ops) {
        if (o.suppressed) continue;
        const r = ws.result(o.id), tool = ws.toolOf(o);
        if (!tool || !r?.toolpath || ws.state(s, o) !== 'ok') { status.hidden = false; status.className = 'pm-msg error'; status.textContent = `${o.name} has no toolpath${r?.error ? `: ${r.error}` : ''}. It is left out.`; continue; }
        const f = opFeeds(o, tool);
        ops.push({ name: o.name, tool, rpm: f.rpm, feed: f.feed, plunge: f.plunge, toolpath: r.toolpath });
      }
      return { name: s.name, workOffset: s.workOffset, ops };
    }).filter((s) => s.ops.length);
    const date = new Date().toISOString().slice(0, 10);
    let out = { code: '', lines: 0, head: '' };
    if (setups.length) {
      try {
        out = await writer.write({ name: app.store.doc.name, post: { ...post, units: unitsSel }, units: unitsSel, setups, notes: [`Parametric CAM, ${date}`, `Post: ${CONTROLLER_LABELS[post.controller]}`] });
      } catch (e) {
        if (mine !== seq) return;
        status.hidden = false; status.className = 'pm-msg error'; status.textContent = (e as Error).message;
      }
    }
    // Settings changed while it was written: the newer request shows its program.
    if (mine !== seq) return;
    code = out.code;
    preview.textContent = code ? out.head : 'Nothing to post.';
    count.textContent = code ? `${out.lines} lines` : '';
  };
  const writer = new PostWriter();
  const count = h('span', { class: 'field-label' });
  let pending = Promise.resolve();
  const refresh = () => { preview.textContent = 'Writing...'; pending = make(); };
  const setupChecks = cam.setups.map((s) => checkbox(s.name, true, (v) => { if (v) chosen.add(s.id); else chosen.delete(s.id); refresh(); }));
  const progNum = h('input', { class: 'input', id: nextDomId('prog'), inputmode: 'numeric', value: String(post.program) }) as HTMLInputElement;
  progNum.addEventListener('change', () => { const n = Math.round(Number(progNum.value)); if (n >= 1 && n <= 99999) { post.program = n; refresh(); } });
  const body = h('div', { class: 'cam-post' },
    h('div', { class: 'cam-post-side' },
      selectField<CamController>('Machine controller', post.controller, Object.entries(CONTROLLER_LABELS).map(([value, label]) => ({ value: value as CamController, label })), (v) => { post.controller = v; refresh(); }),
      selectField<'mm' | 'in'>('Units', unitsSel, [{ value: 'mm', label: 'Millimetres (G21)' }, { value: 'in', label: 'Inches (G20)' }], (v) => { unitsSel = v; refresh(); }),
      h('div', {}, h('label', { class: 'field-label', for: progNum.id }, 'Program number'), progNum),
      checkbox('Arcs (G2/G3)', post.arcs, (v) => { post.arcs = v; refresh(); }),
      checkbox('Drilling cycles (G81/G83)', post.cannedCycles, (v) => { post.cannedCycles = v; refresh(); }),
      checkbox('Line numbers', post.lineNumbers, (v) => { post.lineNumbers = v; refresh(); }),
      h('div', { class: 'field-label' }, 'Setups'), ...setupChecks,
      status),
    h('div', { class: 'cam-post-main' }, preview, count));
  pending = make();
  const v = await showDialog({
    title: 'Post Process', body, wide: true, signal: app.documentSignal,
    buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Copy', value: 'copy' }, { label: 'Download G-code', primary: true, value: 'ok' }],
    onAction: async (val) => {
      if (val === 'cancel') return;
      // Settings just changed: what is written is the program for them.
      await pending;
      if (!code) { status.hidden = false; status.className = 'pm-msg error'; status.textContent = 'There is no G-code to write.'; return false; }
      if (val === 'copy') {
        try { await navigator.clipboard.writeText(code); toast({ kind: 'success', message: 'G-code copied' }); } catch { toast({ kind: 'error', message: 'Could not copy to the clipboard' }); }
        return false;
      }
      return true;
    },
  });
  writer.stop();
  if (v !== 'ok' || !code) return;
  // Keep the post settings with the part (units only when they differ from the part's).
  const next = { ...post };
  delete next.units;
  if (unitsSel !== (app.store.doc.units === 'IPS' ? 'in' : 'mm')) next.units = unitsSel;
  if (JSON.stringify(next) !== JSON.stringify(cam.post)) app.store.change('Post settings', (d) => { if (d.cam) d.cam.post = next; });
  download(code, `${safeName(app.store.doc.name)}.${EXTENSIONS[post.controller]}`, 'text/plain');
  toast({ kind: 'success', message: `G-code written for ${CONTROLLER_LABELS[post.controller]}` });
}
