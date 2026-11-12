import type { Editor } from '../editor';
import { commands, findCommand, interactiveOnly, registerCommand, registerPanel, type Panel } from '../app/registry';
import { escapeXML } from '../model/assets';
import { svg } from '../app/icons';
import { formDialog } from '../ui/dialog';
import { registerBatchStep } from './files/automate-steps';
import { takeDialogCancelled } from './action-settings';
import { modal } from './files/ui';

// Actions record command IDs (with their arguments) and replay them. Commands
// that accept an argument object apply it without a dialog when the step's
// dialog toggle is off, which is what makes actions repeatable in batches.
export type ActionStep = { command: string; arg?: unknown; enabled: boolean; dialog: boolean };
export type Action = { id: string; name: string; steps: ActionStep[]; key?: string };
export type ActionSet = { id: string; name: string; actions: Action[]; open?: boolean };

const storageKey = 'photo-studio-actions';
const defaults = (): ActionSet[] => [
  {
    id: 'defaults',
    name: 'Default Actions',
    open: true,
    actions: [
      { id: 'a-dup-desat', name: 'Desaturated Copy', steps: [step('layer.duplicate'), step('adjust.desaturate')] },
      { id: 'a-flatten-auto', name: 'Flatten and Auto Contrast', steps: [step('layer.flatten'), step('image.auto-contrast')] },
      { id: 'a-stamp', name: 'Stamp Visible to New Layer', steps: [step('layer.stamp-visible')] },
      { id: 'a-mirror', name: 'Mirror Canvas', steps: [step('image.flip-horizontal')] },
      { id: 'a-trim', name: 'Trim Transparent Pixels', steps: [step('image.trim')] },
    ],
  },
];
function step(command: string, arg?: unknown): ActionStep {
  return { command, arg, enabled: true, dialog: false };
}
// Action sets come from stored settings and from files people share, so they
// are rebuilt from checked fields: identifiers end up in panel markup and are
// split on ':' there.
const safeId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const name = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.slice(0, 200) : fallback);
function readStep(v: unknown): ActionStep | undefined {
  const s = v as Partial<ActionStep> | null;
  if (!s || typeof s !== 'object' || typeof s.command !== 'string' || !s.command || s.command.length > 200) return undefined;
  return { command: s.command, ...(s.arg !== undefined ? { arg: s.arg } : {}), enabled: s.enabled !== false, dialog: s.dialog === true };
}
/** Well-formed action sets from stored or imported data; `fresh` gives every
 * set and action a new identifier (an imported file is a copy). */
export function readActionSets(value: unknown, fresh: boolean): ActionSet[] {
  if (!Array.isArray(value)) return [];
  const id = (v: unknown) => (!fresh && safeId(v) ? (v as string) : crypto.randomUUID());
  return value
    .filter((v): v is Partial<ActionSet> => !!v && typeof v === 'object')
    .map((v) => ({
      id: id(v.id),
      name: name(v.name, 'Set'),
      ...(typeof v.open === 'boolean' ? { open: v.open } : {}),
      actions: (Array.isArray(v.actions) ? (v.actions as unknown[]) : [])
        .filter((a): a is Partial<Action> => !!a && typeof a === 'object')
        .map((a) => ({
          id: id(a.id),
          name: name(a.name, 'Action'),
          steps: (Array.isArray(a.steps) ? (a.steps as unknown[]) : []).map(readStep).filter((x): x is ActionStep => !!x),
          ...(typeof a.key === 'string' ? { key: a.key.slice(0, 40) } : {}),
        })),
    }));
}
function load(): ActionSet[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(v)) return readActionSets(v, false);
  } catch {
    /* Optional. */
  }
  return defaults();
}
let sets = load();
const save = () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sets));
  } catch {
    /* Optional. */
  }
  syncBatchSteps();
};
// Every action is offered as a step in File > Automate > Batch.
function syncBatchSteps() {
  for (const { action } of allActions())
    registerBatchStep({
      id: `action:${action.id}`,
      label: `Action: ${action.name}`,
      document: async (e) => {
        const current = allActions().find((x) => x.action.id === action.id)?.action;
        if (!current) throw new Error(`The action “${action.name}” no longer exists.`);
        if (!(await playAction(e, current))) throw new Error(`The action “${current.name}” stopped.`);
      },
    });
}
let selected: { set: string; action?: string; step?: number } = { set: sets[0]?.id ?? '' };
let recording: Action | undefined;
let playing = false;
// Set by the Stop button while an action plays; playback ends before the next step.
let stopRequested = false;
// Insert Stop adds a step that pauses playback with a message.
export const STOP_STEP = 'actions.stop-step';
type StopArg = { message: string; allowContinue: boolean };
const stopArg = (arg: unknown): StopArg => {
  const a = (arg && typeof arg === 'object' ? arg : {}) as Partial<StopArg>;
  return { message: typeof a.message === 'string' ? a.message.slice(0, 1000) : '', allowContinue: a.allowContinue !== false };
};
/** Show a Stop step's message; resolves true to go on with the action. */
async function pauseAt(action: Action, arg: unknown) {
  const { message, allowContinue } = stopArg(arg);
  const r = await modal({
    title: 'Action Paused',
    className: 'action-stop',
    body: `<p>${escapeXML(message || `“${action.name}” paused.`)}</p>`,
    submit: allowContinue ? 'Continue' : 'Stop',
    bind: (dialog) => {
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-act="cancel"]')!;
      if (allowContinue) cancel.textContent = 'Stop';
      else cancel.hidden = true;
    },
  });
  r?.close();
  return !!r && allowContinue;
}

export function allActions() {
  return sets.flatMap((s) => s.actions.map((a) => ({ set: s, action: a })));
}
function dialogArg(arg: unknown) {
  const params = arg && typeof arg === 'object' ? (arg as { params?: unknown }).params : undefined;
  return params && typeof params === 'object' ? { initial: params } : undefined;
}
/** Replay an action's enabled steps; returns false if a step failed. */
export async function playAction(e: Editor, action: Action, from = 0) {
  playing = true;
  stopRequested = false;
  takeDialogCancelled();
  // Enables the Stop button.
  e.dock?.update();
  try {
    for (let i = from; i < action.steps.length; i++) {
      const s = action.steps[i];
      if (!s.enabled) continue;
      if (stopRequested) {
        e.message(`Stopped “${action.name}”.`);
        return false;
      }
      if (s.command === STOP_STEP) {
        if (!(await pauseAt(action, s.arg))) {
          e.message(`Stopped “${action.name}”.`);
          return false;
        }
        continue;
      }
      // Steps recorded before a command was renamed run the current one.
      const c = findCommand(s.command);
      if (!c) throw new Error(`The command “${s.command}” is not available.`);
      // Imported action files can name any command; an Actions panel
      // command would play an action from inside one (itself, forever).
      if (interactiveOnly(c.id) || c.id.startsWith('actions.')) throw new Error(`Actions cannot run “${c.label.replace(/…$/, '')}”.`);
      if (c.enabled && !c.enabled(e)) throw new Error(`“${c.label}” is not available in the current state.`);
      // Steps call commands directly so the busy guard does not skip them.
      // A step with its dialog on opens the dialog, showing the recorded
      // settings ({ initial }) where the command has any.
      await c.run(e, s.dialog ? dialogArg(s.arg) : s.arg);
      // Cancelling a step's dialog stops the action, as Stop does.
      if (takeDialogCancelled()) {
        e.message(`Stopped “${action.name}”: ${c.label.replace(/…$/, '')} was cancelled.`);
        return false;
      }
    }
    return true;
  } catch (error) {
    e.message(`Action stopped: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    playing = false;
    stopRequested = false;
    e.update();
    e.dock?.update();
  }
}
function find(): { set?: ActionSet; action?: Action } {
  const set = sets.find((s) => s.id === selected.set);
  return { set, action: set?.actions.find((a) => a.id === selected.action) };
}
function startRecording(e: Editor, action: Action) {
  recording = action;
  e.recorder = (id, arg) => {
    const c = commands.get(id);
    if (!recording || playing || !c || c.recordable === false || id.startsWith('actions.')) return;
    recording.steps.push(step(id, arg));
    save();
    e.dock.update();
  };
  e.dock.update();
}
function stopRecording(e: Editor) {
  recording = undefined;
  e.recorder = undefined;
  e.dock.update();
}
function label(id: string, arg?: unknown) {
  if (id === STOP_STEP) {
    const { message } = stopArg(arg);
    return message ? `Stop: ${message}` : 'Stop';
  }
  return findCommand(id)?.label ?? id;
}

const actionsPanel: Panel = {
  id: 'actions',
  title: 'Actions',
  icon: 'play',
  location: 'strip',
  shortcut: 'Alt+F9',
  mount: (e, el) => {
    el.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      // Stop runs here, not as a command: commands wait while an action plays.
      if (t.closest('[data-actions-stop]')) {
        if (playing) stopRequested = true;
        else if (recording) stopRecording(e);
        return;
      }
      const toggle = t.closest<HTMLElement>('[data-step-toggle]');
      if (toggle) {
        const { action } = find();
        const [aid, i, kind] = toggle.dataset.stepToggle!.split(':');
        const a = sets.flatMap((s) => s.actions).find((x) => x.id === aid) ?? action;
        const s = a?.steps[Number(i)];
        if (s) {
          if (kind === 'enabled') s.enabled = !s.enabled;
          else s.dialog = !s.dialog;
          save();
          e.dock.update();
        }
        return;
      }
      const disclose = t.closest<HTMLElement>('[data-set-toggle]');
      if (disclose) {
        const s = sets.find((x) => x.id === disclose.dataset.setToggle);
        if (s) s.open = !s.open;
        save();
        e.dock.update();
        return;
      }
      const row = t.closest<HTMLElement>('[data-action-row]');
      if (row) {
        const [setId, actionId, stepIndex] = row.dataset.actionRow!.split(':');
        selected = { set: setId, action: actionId || undefined, step: stepIndex ? Number(stepIndex) : undefined };
        e.dock.update();
      }
    });
    el.addEventListener('dblclick', async (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-action-row]');
      if (!row) return;
      const { action } = find();
      if (action && selected.step === undefined) {
        const v = await formDialog('Action Options', [{ name: 'name', label: 'Name', value: action.name }], 'OK');
        if (v) {
          action.name = v.name;
          save();
          e.dock.update();
        }
      }
    });
  },
  update: (e, el) => {
    const html = sets
      .map(
        (s) => `<div class="action-set"><div class="action-row set ${selected.set === s.id && !selected.action ? 'selected' : ''}" data-action-row="${escapeXML(s.id)}::"><button class="group-disclosure" data-set-toggle="${escapeXML(s.id)}" aria-label="${s.open ? 'Collapse' : 'Expand'} ${escapeXML(s.name)}">${svg(s.open ? 'chevron-down' : 'chevron-right', 13)}</button>${svg('folder', 14)}<span>${escapeXML(s.name)}</span></div>${
          s.open
            ? s.actions
                .map(
                  (a) => `<div class="action-row action ${selected.action === a.id && selected.step === undefined ? 'selected' : ''} ${recording === a ? 'recording' : ''}" data-action-row="${escapeXML(s.id)}:${escapeXML(a.id)}:"><span class="indent"></span>${svg('play', 12)}<span>${escapeXML(a.name)}</span><small>${a.steps.length}</small></div>${
                    selected.action === a.id
                      ? a.steps
                          .map(
                            (st, i) => `<div class="action-row step ${selected.step === i ? 'selected' : ''}" data-action-row="${escapeXML(s.id)}:${escapeXML(a.id)}:${i}"><button class="step-check" data-step-toggle="${escapeXML(a.id)}:${i}:enabled" aria-label="${st.enabled ? 'Disable' : 'Enable'} step" aria-pressed="${st.enabled}">${st.enabled ? '✓' : ''}</button><button class="step-dialog" data-step-toggle="${escapeXML(a.id)}:${i}:dialog" aria-label="Toggle dialog" aria-pressed="${st.dialog}" title="Show dialog during playback">${st.dialog ? svg('ellipsis', 12) : ''}</button><span>${escapeXML(label(st.command, st.arg))}</span></div>`,
                          )
                          .join('')
                      : ''
                  }`,
                )
                .join('')
            : ''
        }</div>`,
      )
      .join('');
    el.innerHTML = `<div class="actions-list">${html}</div><div class="layer-footer"><button data-actions-stop aria-label="${playing ? 'Stop playing' : 'Stop recording'}" title="Stop playing/recording" ${recording || playing ? '' : 'disabled'}>${svg('square', 14)}</button><button data-command="actions.record" class="${recording ? 'recording' : ''}" aria-label="Begin recording" title="Begin recording" ${find().action && !recording ? '' : 'disabled'}>${svg('circle-dot', 14)}</button><button data-command="actions.play" aria-label="Play selection" title="Play selection" ${find().action && !recording ? '' : 'disabled'}>${svg('play', 14)}</button><button data-command="actions.new-set" aria-label="Create new set" title="Create new set">${svg('folder-plus', 14)}</button><button data-command="actions.new" aria-label="Create new action" title="Create new action">${svg('plus', 14)}</button><button data-command="actions.delete" aria-label="Delete" title="Delete">${svg('trash-2', 14)}</button></div>`;
    void e;
  },
  menu: () => ['actions.new', 'actions.new-set', 'actions.duplicate', 'actions.delete', '-', 'actions.play', 'actions.record', 'actions.stop', '-', 'actions.insert-menu-item', 'actions.insert-stop', '-', 'actions.export', 'actions.import', 'actions.reset'],
};

export function installActions(e: Editor) {
  registerPanel(actionsPanel);
  syncBatchSteps();
  registerCommand(
    {
      id: 'actions.new',
      label: 'New Action…',
      recordable: false,
      run: async (e) => {
        const set = sets.find((s) => s.id === selected.set) ?? sets[0];
        if (!set) return;
        const v = await formDialog('New Action', [{ name: 'name', label: 'Name', value: `Action ${set.actions.length + 1}` }], 'Record');
        if (!v) return;
        const a: Action = { id: crypto.randomUUID(), name: v.name, steps: [] };
        set.actions.push(a);
        set.open = true;
        selected = { set: set.id, action: a.id };
        save();
        e.dock.show('actions');
        startRecording(e, a);
      },
    },
    {
      id: 'actions.new-set',
      label: 'New Set…',
      recordable: false,
      run: async (e) => {
        const v = await formDialog('New Set', [{ name: 'name', label: 'Name', value: `Set ${sets.length + 1}` }], 'OK');
        if (!v) return;
        sets.push({ id: crypto.randomUUID(), name: v.name, actions: [], open: true });
        save();
        e.dock.update();
      },
    },
    {
      id: 'actions.record',
      label: 'Start Recording',
      recordable: false,
      enabled: () => !!find().action && !recording,
      run: (e) => startRecording(e, find().action!),
    },
    { id: 'actions.stop', label: 'Stop Recording', recordable: false, enabled: () => !!recording, run: (e) => stopRecording(e) },
    {
      id: 'actions.play',
      label: 'Play',
      recordable: false,
      enabled: (e) => !!find().action && !recording && e.hasDocument,
      run: async (e) => {
        const { action } = find();
        if (!action) return;
        // Playing from a selected step starts there, so the rest of an action can be replayed.
        const ok = await playAction(e, action, selected.step ?? 0);
        if (ok) e.message(`Played “${action.name}”.`);
      },
    },
    {
      id: 'actions.duplicate',
      label: 'Duplicate',
      recordable: false,
      enabled: () => !!find().action,
      run: (e) => {
        const { set, action } = find();
        if (!set || !action) return;
        set.actions.push({ ...structuredClone(action), id: crypto.randomUUID(), name: `${action.name} copy` });
        save();
        e.dock.update();
      },
    },
    {
      id: 'actions.delete',
      label: 'Delete',
      recordable: false,
      run: (e) => {
        const { set, action } = find();
        // Deleting the action being recorded (or its set) ends the recording.
        const removed = action ? (selected.step === undefined ? [action] : []) : (set?.actions ?? []);
        if (recording && removed.includes(recording)) stopRecording(e);
        if (action && selected.step !== undefined) action.steps.splice(selected.step, 1);
        else if (set && action) set.actions = set.actions.filter((a) => a !== action);
        else if (set) sets = sets.filter((s) => s !== set);
        selected = { set: sets[0]?.id ?? '' };
        save();
        e.dock.update();
      },
    },
    {
      id: 'actions.insert-menu-item',
      label: 'Insert Menu Item…',
      recordable: false,
      enabled: () => !!find().action,
      run: async (e) => {
        const { action } = find();
        if (!action) return;
        const options = [...commands.values()].filter((c) => !c.hidden && c.recordable !== false && !c.id.startsWith('actions.') && !c.id.startsWith('window.') && !c.id.startsWith('view.')).sort((a, b) => a.label.localeCompare(b.label)).map((c) => [c.id, `${c.label} (${c.id.split('.')[0]})`] as [string, string]);
        const v = await formDialog('Insert Menu Item', [{ name: 'command', label: 'Menu item', value: options[0]?.[0] ?? '', type: 'select', options }], 'Insert');
        if (!v) return;
        action.steps.splice((selected.step ?? action.steps.length - 1) + 1, 0, { ...step(v.command), dialog: true });
        save();
        e.dock.update();
      },
    },
    {
      id: 'actions.insert-stop',
      label: 'Insert Stop…',
      recordable: false,
      enabled: () => !!find().action,
      run: async (e) => {
        const { action } = find();
        if (!action) return;
        const v = await formDialog('Insert Stop', [
          { name: 'message', label: 'Message', value: '', type: 'textarea' },
          { name: 'allowContinue', label: 'Allow Continue', value: 'yes', type: 'checkbox' },
        ], 'Insert', 'Playback pauses at this step and shows the message.');
        if (!v) return;
        const at = (selected.step ?? action.steps.length - 1) + 1;
        action.steps.splice(at, 0, step(STOP_STEP, { message: v.message.trim(), allowContinue: v.allowContinue === 'yes' }));
        selected = { ...selected, step: at };
        save();
        e.dock.update();
      },
    },
    {
      id: 'actions.export',
      label: 'Save Actions',
      recordable: false,
      run: () => {
        const blob = new Blob([JSON.stringify({ format: 'photo-studio-actions', version: 1, sets }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'actions.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    },
    {
      id: 'actions.import',
      label: 'Load Actions…',
      recordable: false,
      run: (e) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = async () => {
          try {
            const data = JSON.parse(await input.files![0].text());
            if (data?.format !== 'photo-studio-actions' || !Array.isArray(data.sets)) throw new Error('Not an actions file.');
            const loaded = readActionSets(data.sets, true);
            sets.push(...loaded);
            save();
            e.message(`Loaded ${loaded.length} action set${loaded.length === 1 ? '' : 's'}.`);
            e.dock.update();
          } catch (error) {
            e.message(String(error instanceof Error ? error.message : error));
          }
        };
        input.click();
      },
    },
    {
      id: 'actions.reset',
      label: 'Reset Actions',
      recordable: false,
      run: (e) => {
        sets = defaults();
        selected = { set: sets[0].id };
        save();
        e.dock.update();
      },
    },
  );
  void e;
}
