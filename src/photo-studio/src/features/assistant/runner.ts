// Running a plan: each step goes through the scripting host (commands with
// their recorded arguments, operations through the API methods), so the run
// is checked like a script and its edits combine into one undo step named
// after the request. Runs can go all at once or a step at a time, and stop
// between steps; a paused run closes its undo step, so edits made while it
// waits are never folded into it.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { findCommand } from '../../app/registry';
import { ScriptHost, type ScriptUI } from '../scripting/host';
import { opById } from './ops';
import { commandArg, type Plan, type Step } from './plan';

/** The undo step's name: the request in the user's words. */
export function runLabel(plan: Pick<Plan, 'title' | 'request'>) {
  const t = (plan.request || plan.title).replace(/\s+/g, ' ').trim();
  return `Assistant: ${t.length > 48 ? `${t.slice(0, 47)}…` : t}`;
}

// The host's dialogs and file pickers are not used by plan steps.
const quietUI = (e: Editor): ScriptUI => ({
  alert: async (m) => e.message(m),
  confirm: async () => false,
  prompt: async () => null,
  form: async () => null,
  progress: () => {},
  openFiles: async () => [],
  saveFiles: async () => false,
});

export class PlanRun {
  // The scripting host of the steps being run now; none while paused.
  private host?: ScriptHost;
  private session?: DocumentSession;
  // Where a pause left the document: going on from there unchanged continues
  // the same undo step.
  private pausedAt?: { session: DocumentSession; doc: PhotoDocument };
  private finished = false;
  stopped = false;
  /** Undo steps the run made so far (more than one when the document was
   * edited between steps). */
  undoSteps = 0;
  constructor(
    private e: Editor,
    readonly plan: Plan,
  ) {}
  /** Index of the next step to run, or -1 when none is left. */
  get next() {
    return this.plan.steps.findIndex((s) => s.status === 'pending');
  }
  get done() {
    return this.finished;
  }
  // Only the active document's edits join the run; edits of other open
  // documents made meanwhile stay their own steps.
  private open(): ScriptHost {
    if (this.host) return this.host;
    const e = this.e, s = e.hasDocument ? e.session : undefined;
    const resume = !!s && this.pausedAt?.session === s && this.pausedAt.doc === s.doc;
    if (!resume) this.pausedAt = undefined;
    this.session = s;
    return (this.host = new ScriptHost(e, quietUI(e), runLabel(this.plan), s ? [s] : [], resume));
  }
  /** Run one step; failures are recorded on the step and rethrown. */
  async step(s: Step) {
    const host = this.open();
    s.status = 'running';
    try {
      if (s.problems.length) throw new Error(s.problems[0]);
      if (s.kind === 'op') {
        const op = opById.get(s.action)!;
        await op.run({ e: this.e, host }, s.args);
      } else if (s.kind === 'command') {
        const c = findCommand(s.action);
        if (!c) throw new Error(`There is no command “${s.action}”.`);
        let enabled = true;
        try {
          enabled = c.enabled ? c.enabled(this.e) : true;
        } catch {
          enabled = false;
        }
        if (!enabled) throw new Error(this.e.hasDocument && !this.e.doc.selection && needsSelectionNow(this.e, s.action) ? `“${s.label}” needs a selection, and there is none.` : `“${s.label}” is not available for the current document or layer.`);
        await host.call('commands.run', [s.action, commandArg(s)]);
      } else throw new Error(s.problems[0] ?? 'Unknown step.');
      s.status = 'done';
      s.error = undefined;
    } catch (error) {
      s.status = 'failed';
      s.error = plainError(error);
      throw error;
    }
  }
  /** Run the remaining steps (or `count` of them); stops at the first failure.
   * A run that leaves steps for later pauses (see `pause`). */
  async run(count = Infinity) {
    for (let n = 0; n < count && !this.stopped; n++) {
      const i = this.next;
      if (i < 0) break;
      await this.step(this.plan.steps[i]);
    }
    if (this.next < 0 || this.stopped) this.finish();
    else this.pause();
  }
  stop() {
    this.stopped = true;
  }
  /** Close the undo step between steps, so edits made by hand (or by others
   * in a shared document) while the plan waits stay their own steps and
   * history is trimmed as usual. Going on unchanged continues this step. */
  pause() {
    const host = this.host, s = this.session;
    if (!host) return 0;
    this.host = this.session = undefined;
    const resumed = !!this.pausedAt;
    const kept = host.finish(runLabel(this.plan));
    if (!resumed && kept) this.undoSteps++;
    else if (resumed && !kept) this.undoSteps = Math.max(0, this.undoSteps - 1);
    this.pausedAt = s && kept ? { session: s, doc: s.doc } : undefined;
    return kept;
  }
  /** Close the run's undo step; marks the steps not run as skipped. */
  finish() {
    if (this.finished) return 0;
    this.finished = true;
    for (const s of this.plan.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
    return this.pause();
  }
}

/** Whether a command is enabled with a selection and not without one. */
export function needsSelectionNow(e: Editor, id: string): boolean {
  const c = findCommand(id);
  if (!c?.enabled || !e.hasDocument) return false;
  const doc = e.doc;
  const probe = (selection: typeof doc.selection) => {
    const d = { ...doc, selection, selectionMask: selection ? doc.selectionMask : null };
    const view = new Proxy(e, { get: (t, k) => (k === 'doc' ? d : Reflect.get(t, k, t)) });
    try {
      return !!c.enabled!(view);
    } catch {
      return false;
    }
  };
  return probe({ x: 0, y: 0, width: doc.width, height: doc.height }) && !probe(null);
}

export function plainError(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  return m.replace(/^(ScriptError|Error):\s*/, '') || 'The step failed.';
}
