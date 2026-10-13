// Records how each open document is made: the file it was opened from,
// files placed into it (embedded objects, with a SHA-256 of their bytes),
// every new history step (its label and the command or tool that made it),
// AI commands and exports. The record lives beside the history (undo does not
// erase it; undone steps are marked when a different edit replaces them) and
// is saved in .photo projects as a sidecar.
//
// History states are followed as a tree: each recorded step is a node whose
// parent is the state it was made from, so with non-linear history only the
// steps leading to the latest edit count as kept. Nodes are numbers looked up
// weakly from document states, so the recorder keeps no old state alive.
// Shared documents show the merged state as new documents without a new step
// of their own (`SharedBinding.project`); those projections map onto the
// state they show and are never recorded.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { History } from '../../history/history';
import { onAppEvent, openedFiles } from '../../app/app-events';
import { findCommand } from '../../app/registry';
import { allLayers, type Layer, type PhotoDocument } from '../../model/document';
import { projectSidecars } from '../../model/serialization';
import {
  addAI,
  addExport,
  addSource,
  MAX_STEPS,
  newProvenanceRecord,
  sha256Hex,
  validateProvenance,
  type ProvenanceAI,
  type ProvenanceExport,
  type ProvenanceRecord,
  type ProvenanceStep,
} from '../../model/provenance';

type Step = { node: number; label: string; command?: string; tool?: string; when: string };
type Tracking = {
  record: ProvenanceRecord;
  // The state the record last saw, its node, and the history position and
  // number of redoable steps then.
  last: PhotoDocument;
  node: number;
  position: number;
  redoable: number;
  // Parent of each node made by a recorded step; the latest step's node.
  parent: Map<number, number>;
  head: number;
  // Steps recorded here (oldest first) and the record's steps before them.
  log: Step[];
  base: ProvenanceStep[];
  // Shared documents: nodes left by Undo, nearest last (Redo returns to them).
  redo: number[];
  // Embedded contents already looked at.
  embeds: Set<string>;
};
const tracked = new WeakMap<DocumentSession, Tracking>();
// Node of each document state seen (weak: states history dropped are freed).
const nodes = new WeakMap<PhotoDocument, number>();
let nextNode = 1;
// Steps whose kept/undone state can still change; older ones are settled.
const LIVE_STEPS = 1000;
// Records read from projects, until their document becomes a session's.
const loaded = new WeakMap<PhotoDocument, ProvenanceRecord>();
const listeners = new Set<() => void>();
export const onRecordChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());
let editor: Editor | undefined;

export const AI_COMMANDS: Record<string, ProvenanceAI['kind']> = {
  'edit.generate-image': 'generate',
  'edit.edit-with-prompt': 'edit',
  'edit.ai-fill': 'fill',
  'edit.ai-expand': 'expand',
  'image.upscale': 'upscale',
};

function track(s: DocumentSession, origin: ProvenanceRecord['origin'] = 'unknown'): Tracking {
  let t = tracked.get(s);
  if (!t) {
    const from = loaded.get(s.doc);
    const record = from ?? newProvenanceRecord(origin);
    const node = nodeOf(s.doc);
    t = { record, last: s.doc, node, position: s.history.position, redoable: s.history.redoLabels.length, parent: new Map(), head: node, log: [], base: record.steps, redo: [], embeds: new Set(Object.keys(s.doc.embeds ?? {})) };
    tracked.set(s, t);
    // AI content the document starts with (a result opened as a new
    // document) is part of its making; a project's record already lists it.
    if (!from) noteAI(t, [], allLayers(s.doc.layers), editor?.currentCommand, record.created);
  }
  return t;
}
function nodeOf(doc: PhotoDocument): number {
  let n = nodes.get(doc);
  if (n === undefined) nodes.set(doc, (n = nextNode++));
  return n;
}
/** What the recorder keeps for a document (tests). */
export const trackingOf = (s: DocumentSession) => tracked.get(s);
/** The record of a document (created on first use). */
export const recordOf = (s: DocumentSession) => track(s).record;
// Documents that began as a camera capture (their opened file is the capture).
const captured = new WeakSet<DocumentSession>();
/** Mark a document opened from a camera shot as captured. */
export function noteCapture(s: DocumentSession) {
  captured.add(s);
  const t = track(s, 'captured');
  t.record.origin = 'captured';
  for (const x of t.record.sources) if (x.role === 'opened') x.role = 'captured';
  changed();
}
/** Note an export of the session's document. */
export function noteExport(s: DocumentSession, x: ProvenanceExport) {
  addExport(track(s).record, x);
  changed();
}

const formatOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('tif', 'tiff') ?? 'unknown');
async function noteFile(t: Tracking, blob: Blob, name: string, role: 'opened' | 'placed' | 'library' | 'captured', s?: DocumentSession) {
  try {
    const hash = await sha256Hex(blob);
    if (role === 'opened' && s && captured.has(s)) role = 'captured';
    addSource(t.record, { name: name.slice(0, 1024), format: formatOf(name).slice(0, 32), sha256: hash, size: blob.size, when: new Date().toISOString(), role });
    changed();
  } catch {
    /* Hashing unavailable: the source is not recorded. */
  }
}

/** The states a history can return to, without projections of shared documents. */
function reachable(h: History): PhotoDocument[] {
  const shared = (h as History & { binding?: { documents?: () => PhotoDocument[] } }).binding;
  return typeof shared?.documents === 'function' ? [h.oldest, ...shared.documents()] : h.documents.slice(1);
}

/** Look at a new history state of the active document. */
function observe(e: Editor) {
  const s = e.session;
  if (!s.hasDocument) return;
  const t = track(s);
  const doc = s.doc;
  if (doc === t.last) return;
  const h = s.history;
  const before = t.last,
    from = t.node,
    was = t.position,
    redoableWas = t.redoable;
  const position = h.position,
    redoable = h.redoLabels.length;
  t.last = doc;
  t.position = position;
  t.redoable = redoable;
  const known = nodes.get(doc);
  if (known !== undefined) {
    // Undo, redo and jumps to recorded states make no step.
    t.node = known;
    return;
  }
  const states = reachable(h);
  if (!states.includes(doc)) {
    // A projection (shared document): the state it shows is the one Undo or
    // Redo moved to, else the same one (remote edits, a step just written).
    // Redoable steps tell Undo from older steps being forgotten.
    let n = from;
    if (redoable > redoableWas) for (let k = redoable - redoableWas; k > 0 && t.parent.has(n); k--) t.redo.push(n), (n = t.parent.get(n)!);
    else for (let k = redoableWas - redoable; k > 0 && t.redo.length; k--) n = t.redo.pop()!;
    nodes.set(doc, (t.node = n));
    return;
  }
  const label = position > 0 ? (h.labels[position - 1] ?? '') : '';
  if (!label) {
    // A state without an edit (the document was replaced): a new start.
    t.node = nodeOf(doc);
    return;
  }
  if (position === was && from === t.head && t.log.length && !states.includes(before)) {
    // A coalesced edit replaced the latest step's result.
    nodes.set(doc, (t.node = from));
  } else {
    const node = nodeOf(doc);
    t.parent.set(node, from);
    t.node = t.head = node;
    t.redo = [];
    // Commands that finish their work after returning (a worker result)
    // are matched by label.
    const recent = e.lastCommand ? findCommand(e.lastCommand) : undefined;
    const command = e.currentCommand ?? (recent && recent.label.replace(/…$/, '') === label ? recent.id : undefined);
    const tool = !command && e.activeTool?.label === label ? e.tool : undefined;
    const when = new Date().toISOString();
    t.log.push({ node, label: label.slice(0, 256), ...(command ? { command } : {}), ...(tool ? { tool } : {}), when });
    rebuildSteps(t);
    noteAI(t, allLayers(before.layers), allLayers(doc.layers), command, when);
  }
  // Files placed by this edit.
  for (const [id, c] of Object.entries(doc.embeds ?? {})) {
    if (t.embeds.has(id)) continue;
    t.embeds.add(id);
    const asset = c.source ?? c.project;
    if (!asset || !s.assets.has(asset)) continue;
    const role = c.link?.kind === 'library' || e.currentCommand?.startsWith('libraries.') ? 'library' : 'placed';
    void noteFile(t, s.assets.blob(asset), c.sourceName ?? `${c.name}${c.project && !c.source ? '.photo' : ''}`, role);
  }
  changed();
}

const sameStep = (a: ProvenanceStep, b: Step, undone: boolean) => a.label === b.label && a.command === b.command && a.tool === b.tool && !!a.undone === undone;
/** The record's steps: earlier ones, then this session's, kept when they lead
 * to the latest edit and undone otherwise (repeats grouped). Steps too old to
 * change are settled into the earlier ones. */
function rebuildSteps(t: Tracking) {
  const settle = t.log.length > 2 * LIVE_STEPS ? t.log.length - LIVE_STEPS : 0;
  const oldestLive = t.log[settle]?.node ?? t.head;
  // Ancestors of the latest edit (parents are always older nodes).
  const kept = new Set<number>();
  for (let n: number | undefined = t.head; n !== undefined && n >= oldestLive; n = t.parent.get(n)) kept.add(n);
  const group = (out: ProvenanceStep[], list: Step[]) => {
    for (const x of list) {
      const undone = !kept.has(x.node);
      const prev = out.at(-1);
      if (prev && sameStep(prev, x, undone)) {
        prev.count = (prev.count ?? 1) + 1;
        prev.last = x.when;
      } else out.push({ label: x.label, ...(x.command ? { command: x.command } : {}), ...(x.tool ? { tool: x.tool } : {}), when: x.when, ...(undone ? { undone: true } : {}) });
    }
    return out;
  };
  if (settle) {
    t.base = group([...t.base], t.log.slice(0, settle));
    for (const x of t.log.slice(0, settle)) t.parent.delete(x.node);
    t.log = t.log.slice(settle);
  }
  const steps = group([...t.base], t.log);
  if (steps.length > MAX_STEPS) {
    const drop = steps.length - MAX_STEPS;
    steps.splice(0, drop);
    t.base = t.base.slice(Math.min(drop, t.base.length));
  }
  t.record.steps = steps;
}

const AI_KINDS: Record<string, ProvenanceAI['kind']> = { generate: 'generate', edit: 'edit', upscale: 'upscale', fill: 'fill', expand: 'expand' };
/** AI layers in `after` that `before` did not have, or the AI command itself. */
function noteAI(t: Tracking, before: Layer[], after: Layer[], command: string | undefined, when: string) {
  const had = new Set(before.filter((l) => l.generated).map((l) => l.id));
  const fresh = after.filter((l) => l.generated && !had.has(l.id));
  const kind = command ? AI_COMMANDS[command] : undefined;
  if (!fresh.length && (!kind || kind === 'upscale')) return;
  const prompts = editor?.preferences.provenancePrompts;
  const list = fresh.length ? fresh : [undefined];
  for (const l of list) {
    const g = l?.generated;
    addAI(t.record, {
      command: command ?? 'unknown',
      kind: kind ?? (g ? (AI_KINDS[g.kind] ?? 'other') : 'other'),
      when,
      ...(prompts && g?.prompt ? { prompt: g.prompt.slice(0, 10_000) } : {}),
      ...(g?.model ? { model: g.model.slice(0, 256) } : {}),
      ...(l ? { layer: l.name.slice(0, 256) } : {}),
    });
  }
}

/** Find the open document a state belongs to (for saving its record). */
function sessionOf(e: Editor, doc: PhotoDocument) {
  return e.sessions.find((s) => s.doc === doc || s.saved === doc) ?? e.sessions.find((s) => s.history.documents.includes(doc));
}

export function installRecorder(e: Editor) {
  editor = e;
  e.onUpdate(observe);
  onAppEvent((event, s) => {
    if (!s) return;
    if (event === 'new-document') {
      tracked.delete(s);
      track(s, 'new');
      changed();
    } else if (event === 'open-document') {
      tracked.delete(s);
      const fromProject = loaded.has(s.doc);
      const t = track(s, captured.has(s) ? 'captured' : 'opened');
      const file = openedFiles.get(s);
      // A project carries its own record; other files are the record's first source.
      if (file && !fromProject) void noteFile(t, file.blob, file.name, 'opened', s);
      changed();
    }
  });
  projectSidecars.push({
    key: 'provenance',
    write: (doc) => {
      const s = sessionOf(e, doc);
      const t = s && tracked.get(s);
      return t ? t.record : undefined;
    },
    read: (doc, value) => loaded.set(doc, validateProvenance(structuredClone(value))),
  });
}
