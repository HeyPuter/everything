// Records how each open document is made: the file it was opened from,
// files placed into it (embedded objects, with a SHA-256 of their bytes),
// every new history step (its label and the command or tool that made it),
// AI commands and exports. The record lives beside the history (undo does not
// erase it; undone steps are marked when a different edit replaces them) and
// is saved in .photo projects as a sidecar.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { onAppEvent, openedFiles } from '../../app/app-events';
import { findCommand } from '../../app/registry';
import { allLayers, type PhotoDocument } from '../../model/document';
import { projectSidecars } from '../../model/serialization';
import {
  addAI,
  addExport,
  addSource,
  addStep,
  markUndone,
  newProvenanceRecord,
  sha256Hex,
  validateProvenance,
  type ProvenanceAI,
  type ProvenanceExport,
  type ProvenanceRecord,
} from '../../model/provenance';

type Tracking = {
  record: ProvenanceRecord;
  // The state the record last saw, and the states its kept steps made (in order).
  last: PhotoDocument;
  chain: PhotoDocument[];
  position: number;
  // Embedded contents already looked at.
  embeds: Set<string>;
};
const tracked = new WeakMap<DocumentSession, Tracking>();
// Records read from projects, until their document becomes a session's.
const loaded = new WeakMap<PhotoDocument, ProvenanceRecord>();
const listeners = new Set<() => void>();
export const onRecordChange = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => listeners.forEach((fn) => fn());

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
    const record = loaded.get(s.doc) ?? newProvenanceRecord(origin);
    t = { record, last: s.doc, chain: [], position: s.history.position, embeds: new Set(Object.keys(s.doc.embeds ?? {})) };
    tracked.set(s, t);
  }
  return t;
}
/** The record of a document (created on first use). */
export const recordOf = (s: DocumentSession) => track(s).record;
/** Note an export of the session's document. */
export function noteExport(s: DocumentSession, x: ProvenanceExport) {
  addExport(track(s).record, x);
  changed();
}

const formatOf = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase().replace('jpg', 'jpeg').replace('tif', 'tiff') ?? 'unknown');
async function noteFile(t: Tracking, blob: Blob, name: string, role: 'opened' | 'placed' | 'library' | 'captured') {
  try {
    addSource(t.record, { name: name.slice(0, 1024), format: formatOf(name).slice(0, 32), sha256: await sha256Hex(blob), size: blob.size, when: new Date().toISOString(), role });
    changed();
  } catch {
    /* Hashing unavailable: the source is not recorded. */
  }
}

/** Look at a new history state of the active document. */
function observe(e: Editor) {
  const s = e.session;
  if (!s.hasDocument) return;
  const t = track(s);
  const doc = s.doc;
  if (doc === t.last) return;
  const h = s.history;
  // `documents` lists the current state first, then every state in order;
  // `labels` are the labels of states 1..position.
  const states = h.documents.slice(1);
  const before = t.last;
  t.last = doc;
  const position = h.position;
  const replaced = !states.includes(before) && position === t.position && t.chain.at(-1) === before;
  t.position = position;
  // Redo, undo and jumps to earlier states make no step.
  if (t.chain.includes(doc) || (!replaced && h.redoLabels.length > 0)) return;
  const label = position > 0 ? (h.labels[position - 1] ?? '') : '';
  if (!label) return;
  if (replaced) {
    // A coalesced edit replaced the latest step's result.
    t.chain[t.chain.length - 1] = doc;
  } else {
    // Steps after the state this edit started from were undone.
    const from = t.chain.indexOf(before);
    const undone = t.chain.length - 1 - from;
    if (undone > 0) markUndone(t.record, undone);
    t.chain = [...t.chain.slice(0, from + 1), doc];
    // Commands that finish their work after returning (a worker result)
    // are matched by label.
    const recent = e.lastCommand ? findCommand(e.lastCommand) : undefined;
    const command = e.currentCommand ?? (recent && recent.label.replace(/…$/, '') === label ? recent.id : undefined);
    const tool = !command && e.activeTool?.label === label ? e.tool : undefined;
    const when = new Date().toISOString();
    addStep(t.record, { label: label.slice(0, 256), ...(command ? { command } : {}), ...(tool ? { tool } : {}), when });
    noteAI(e, t, before, doc, command, when);
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

function noteAI(e: Editor, t: Tracking, before: PhotoDocument, doc: PhotoDocument, command: string | undefined, when: string) {
  const had = new Set(allLayers(before.layers).filter((l) => l.generated).map((l) => l.id));
  const fresh = allLayers(doc.layers).filter((l) => l.generated && !had.has(l.id));
  const kind = command ? AI_COMMANDS[command] : undefined;
  if (!fresh.length && (!kind || kind === 'upscale')) return;
  const prompts = e.preferences.provenancePrompts;
  const list = fresh.length ? fresh : [undefined];
  for (const l of list) {
    const g = l?.generated;
    addAI(t.record, {
      command: command ?? 'unknown',
      kind: kind ?? (g?.kind === 'generate' || g?.kind === 'edit' || g?.kind === 'upscale' ? g.kind : 'other'),
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
      const t = track(s, 'opened');
      const file = openedFiles.get(s);
      // A project carries its own record; other files are the record's first source.
      if (file && !fromProject) void noteFile(t, file.blob, file.name, 'opened');
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
