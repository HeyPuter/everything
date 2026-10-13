// Plans: the steps the model proposes, checked against the registry before
// the user sees them. Every step names a real command or Assistant
// operation; its arguments are coerced to the command's settings; steps that
// need a selection are checked against the selection the earlier steps leave.
// Problems are kept in plain words on each step so the panel can show them
// and refuse to run a plan that still has any. Pure (an environment object
// supplies the registry and document state), so tests drive it directly.
import { AI_COMMANDS, blockedCommand, type CatalogEntry, type InputKind } from './catalog';
import { opById, type SelectionEffect } from './ops';
import { coerceArgs, compactJSON, summarizeArgs, type Param } from './params';

export type RawStep = { action?: unknown; args?: unknown; note?: unknown };
export type RawPlan = { title?: unknown; summary?: unknown; steps?: unknown };
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type Step = {
  key: string;
  // The command or operation ID as resolved (empty when unknown).
  action: string;
  // What the model wrote.
  asked: string;
  kind: 'command' | 'op' | 'unknown';
  label: string;
  note?: string;
  input: InputKind;
  args: Record<string, unknown>;
  params?: Param[];
  notes: string[];
  problems: string[];
  status: StepStatus;
  error?: string;
};
export type Plan = { id: string; request: string; title: string; summary: string; steps: Step[] };

export type CommandInfo = { id: string; label: string; hidden?: boolean };
export interface PlanEnv {
  entry(id: string): CatalogEntry | undefined;
  /** A registered command (renamed IDs resolve to the current one). */
  command(id: string): CommandInfo | undefined;
  /** All commands, to match a step written as a label. */
  commands(): Iterable<CommandInfo>;
  /** Settings schema of a command that takes settings (preloaded). */
  params(id: string): Param[] | undefined;
  needsSelection(id: string): boolean;
  hasDocument: boolean;
  hasSelection: boolean;
}

export const MAX_STEPS = 30;
// Selection effects of commands, for checking a plan before it runs.
const CREATES_SELECTION = new Set(['select.all', 'select.subject', 'select.sky', 'select.color-range', 'select.focus-area', 'select.reselect', 'select.load', 'select.grow', 'select.similar', 'select.mask-refine', 'path.load-selection']);
const CLEARS_SELECTION = new Set(['select.deselect', 'image.crop', 'edit.generate-image', 'edit.edit-with-prompt', 'edit.ai-fill', 'edit.ai-expand', 'layer.mask-reveal-selection', 'layer.mask-hide-selection', 'image.canvas-size', 'image.image-size', 'image.trim']);
// Commands that work without an open document.
const NO_DOCUMENT = (id: string) => /^(file\.(new|open|open-cloud)|window\.|view\.screen|help\.)/.test(id) || id === 'op.set_colors' || id.startsWith('edit.preferences');

let counter = 0;
const nextKey = () => `s${++counter}`;

/** Turn the model's proposal into a checked plan. */
export function buildPlan(raw: RawPlan, request: string, env: PlanEnv): Plan {
  const list = Array.isArray(raw.steps) ? (raw.steps as RawStep[]) : [];
  const steps: Step[] = list.slice(0, MAX_STEPS).map((s) => makeStep(s, env));
  const plan: Plan = {
    id: crypto.randomUUID(),
    request,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : request.slice(0, 120),
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 1200) : '',
    steps,
  };
  if (list.length > MAX_STEPS && steps.length) steps[steps.length - 1].notes.push(`The plan had ${list.length} steps; only the first ${MAX_STEPS} are kept.`);
  validatePlan(plan, env);
  return plan;
}

/** Resolve what a step names: an ID, a panel, or a command label. */
function resolve(asked: string, env: PlanEnv): { id: string; kind: Step['kind']; note?: string; problem?: string } {
  const a = asked.trim();
  if (!a) return { id: '', kind: 'unknown', problem: 'The step does not name a command.' };
  if (opById.has(a)) return { id: a, kind: 'op' };
  const c = env.command(a);
  if (c) return { id: c.id, kind: 'command' };
  if (a.startsWith('panel.') && env.command(`window.${a}`)) return { id: `window.${a}`, kind: 'command' };
  if (a.startsWith('tool.')) {
    const t = env.entry(a);
    return { id: '', kind: 'unknown', problem: t ? `The ${t.label} is used by hand on the canvas; a plan cannot use it.` : `There is no tool “${a.slice(5)}”.` };
  }
  // A label ("Gaussian Blur…", "Image > Crop") instead of an ID.
  const label = a.split('>').pop()!.trim().replace(/…$|\.\.\.$/, '').toLowerCase();
  const byLabel = [...env.commands()].filter((x) => !x.hidden && x.label.replace(/…$/, '').toLowerCase() === label);
  if (byLabel.length === 1) return { id: byLabel[0].id, kind: 'command', note: `Matched “${byLabel[0].label}” by its name.` };
  return { id: '', kind: 'unknown', problem: `There is no command “${a.slice(0, 80)}”.` };
}

function makeStep(raw: RawStep, env: PlanEnv): Step {
  const asked = typeof raw.action === 'string' ? raw.action : String(raw.action ?? '');
  const r = resolve(asked, env);
  const step: Step = {
    key: nextKey(),
    action: r.id,
    asked,
    kind: r.kind,
    label: r.kind === 'op' ? opById.get(r.id)!.label : r.kind === 'command' ? env.command(r.id)!.label.replace(/…$/, '') : asked || 'Unknown step',
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 300) : undefined,
    input: r.kind === 'op' ? 'op' : (env.entry(r.id)?.input ?? 'none'),
    args: {},
    notes: r.note ? [r.note] : [],
    problems: r.problem ? [r.problem] : [],
    status: 'pending',
  };
  setArgs(step, raw.args, env);
  return step;
}

/** Coerce arguments for a step (also used when the user edits a step). */
export function setArgs(step: Step, raw: unknown, env: PlanEnv) {
  const keep = step.problems.filter((p) => p.startsWith('There is no') || p.includes('by hand') || p.includes('does not name'));
  step.problems = keep;
  step.notes = step.notes.filter((n) => n.startsWith('Matched'));
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length ? raw : undefined;
  if (step.kind === 'op') {
    const op = opById.get(step.action)!;
    step.params = op.params;
    const c = coerceArgs(op.params, raw ?? {});
    const n = op.normalize?.(c.value) ?? { args: c.value, notes: [], problems: [] };
    step.args = n.args;
    step.notes.push(...c.notes, ...n.notes);
    step.problems.push(...c.problems, ...n.problems, ...(c.problems.length || n.problems.length ? [] : (op.check?.(n.args) ?? [])));
    return;
  }
  if (step.kind !== 'command') return;
  if (step.input === 'settings' || step.input === 'ai') {
    const params = env.params(step.action);
    step.params = params;
    if (!params) {
      step.args = given ? { ...(given as Record<string, unknown>) } : {};
      return;
    }
    const c = coerceArgs(params, raw ?? {});
    step.args = c.value;
    step.notes.push(...c.notes);
    step.problems.push(...c.problems);
    return;
  }
  step.params = undefined;
  step.args = {};
  if (given) step.notes.push(step.input === 'dialog' ? 'Its settings are chosen in its dialog during the run; the suggested values were left out.' : 'This command takes no settings; the suggested values were left out.');
}

/** Check every step in order (selection and document state carried along). */
export function validatePlan(plan: Plan, env: PlanEnv) {
  let hasSelection = env.hasSelection;
  for (const step of plan.steps) {
    step.problems = step.problems.filter((p) => !p.includes('needs a selection') && !p.startsWith('Open or create a document') && !p.startsWith('The Assistant does not run'));
    if (step.kind === 'unknown') continue;
    if (step.kind === 'command' && blockedCommand(step.action)) step.problems.push(`The Assistant does not run “${step.label}”.`);
    if (!env.hasDocument && !NO_DOCUMENT(step.action)) step.problems.push('Open or create a document first.');
    const effect = selectionEffect(step, env);
    if (effect === 'needs' && !hasSelection) step.problems.push(`“${step.label}” needs a selection, and there is none at this point. Add a step that selects an area first.`);
    // A command can need a selection and then clear it (AI Fill, masking from
    // the selection): the steps after it have none.
    if (effect === 'creates') hasSelection = true;
    else if (effect === 'clears' || clearsSelection(step) || (step.action === 'op.add_adjustment_layer' && hasSelection)) hasSelection = false;
  }
}
const clearsSelection = (step: Pick<Step, 'kind' | 'action'>) => step.kind === 'command' && CLEARS_SELECTION.has(step.action);
/** A step's main selection effect ('needs' wins; see `validatePlan` for commands that also clear it). */
export function selectionEffect(step: Pick<Step, 'kind' | 'action'>, env: Pick<PlanEnv, 'needsSelection'>): SelectionEffect | undefined {
  if (step.kind === 'op') return opById.get(step.action)?.selection === 'needs' ? 'needs' : opById.get(step.action)?.selection;
  if (step.kind !== 'command') return undefined;
  if (env.needsSelection(step.action)) return 'needs';
  if (CREATES_SELECTION.has(step.action)) return 'creates';
  if (clearsSelection(step)) return 'clears';
  return undefined;
}

export const planProblems = (plan: Plan) => plan.steps.reduce((n, s) => n + s.problems.length, 0);
export const usesAI = (plan: Plan) => plan.steps.some((s) => AI_COMMANDS.has(s.action));

/** The argument a command step runs with: recorded settings (defaults for
 * those not given, never the dialog) or a dialog prefill. */
export function commandArg(step: Step): unknown {
  if (step.input === 'settings') return { params: { ...step.args } };
  if (step.input === 'ai') return { prefill: { ...step.args, via: 'assistant' } };
  return undefined;
}

/** A readable account of a step's settings. */
export function stepDetail(step: Step): string {
  if (step.kind === 'op') {
    const op = opById.get(step.action)!;
    return op.describe?.(step.args) || summarizeArgs(op.params, step.args);
  }
  if (step.input === 'ai') return `${step.params ? summarizeArgs(step.params, step.args) : compactJSON(step.args, 120)}. Opens prefilled; you press Generate (uses Puter AI credits).`;
  if (step.input === 'dialog') return 'Opens its dialog so you can choose the settings.';
  if (step.input === 'settings') return Object.keys(step.args).length ? (step.params ? summarizeArgs(step.params, step.args) : compactJSON(step.args, 120)) : 'Default settings';
  return '';
}

/** Plain-text account of a plan for the conversation sent to the model. */
export function planTranscript(plan: Plan, outcome: string): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. ${s.label}${stepDetail(s) ? ` (${stepDetail(s)})` : ''} [${s.status}${s.error ? `: ${s.error}` : ''}]`);
  return `Proposed plan “${plan.title}”:\n${lines.join('\n')}\nOutcome: ${outcome}`;
}
