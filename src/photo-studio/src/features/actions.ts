import type { Editor } from '../editor';
import { commands, interactiveOnly, registerCommand, registerPanel, type Panel } from '../app/registry';
import { escapeXML } from '../model/assets';
import { svg } from '../app/icons';
import { formDialog } from '../ui/dialog';
import { registerBatchStep } from './files/automate-steps';

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
function load(): ActionSet[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(v)) return v;
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

export function allActions() {
  return sets.flatMap((s) => s.actions.map((a) => ({ set: s, action: a })));
}
/** Replay an action's enabled steps; returns false if a step failed. */
export async function playAction(e: Editor, action: Action, from = 0) {
  playing = true;
  try {
    for (let i = from; i < action.steps.length; i++) {
      const s = action.steps[i];
      if (!s.enabled) continue;
      const c = commands.get(s.command);
      if (!c) throw new Error(`The command “${s.command}” is not available.`);
      // Imported action files can name any command.
      if (interactiveOnly(c.id)) throw new Error(`Actions cannot run “${c.label.replace(/…$/, '')}”.`);
      if (c.enabled && !c.enabled(e)) throw new Error(`“${c.label}” is not available in the current state.`);
      // Steps call commands directly so the busy guard does not skip them.
      await c.run(e, s.dialog ? undefined : s.arg);
    }
    return true;
  } catch (error) {
    e.message(`Action stopped: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    playing = false;
    e.update();
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
function label(id: string) {
  return commands.get(id)?.label ?? id;
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
        (s) => `<div class="action-set"><div class="action-row set ${selected.set === s.id && !selected.action ? 'selected' : ''}" data-action-row="${s.id}::"><button class="group-disclosure" data-set-toggle="${s.id}" aria-label="${s.open ? 'Collapse' : 'Expand'} ${escapeXML(s.name)}">${svg(s.open ? 'chevron-down' : 'chevron-right', 13)}</button>${svg('folder', 14)}<span>${escapeXML(s.name)}</span></div>${
          s.open
            ? s.actions
                .map(
                  (a) => `<div class="action-row action ${selected.action === a.id && selected.step === undefined ? 'selected' : ''} ${recording === a ? 'recording' : ''}" data-action-row="${s.id}:${a.id}:"><span class="indent"></span>${svg('play', 12)}<span>${escapeXML(a.name)}</span><small>${a.steps.length}</small></div>${
                    selected.action === a.id
                      ? a.steps
                          .map(
                            (st, i) => `<div class="action-row step ${selected.step === i ? 'selected' : ''}" data-action-row="${s.id}:${a.id}:${i}"><button class="step-check" data-step-toggle="${a.id}:${i}:enabled" aria-label="${st.enabled ? 'Disable' : 'Enable'} step" aria-pressed="${st.enabled}">${st.enabled ? '✓' : ''}</button><button class="step-dialog" data-step-toggle="${a.id}:${i}:dialog" aria-label="Toggle dialog" aria-pressed="${st.dialog}" title="Show dialog during playback">${st.dialog ? svg('ellipsis', 12) : ''}</button><span>${escapeXML(label(st.command))}</span></div>`,
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
    el.innerHTML = `<div class="actions-list">${html}</div><div class="layer-footer"><button data-command="actions.stop" aria-label="Stop recording" title="Stop playing/recording" ${recording ? '' : 'disabled'}>${svg('square', 14)}</button><button data-command="actions.record" class="${recording ? 'recording' : ''}" aria-label="Begin recording" title="Begin recording" ${find().action && !recording ? '' : 'disabled'}>${svg('circle-dot', 14)}</button><button data-command="actions.play" aria-label="Play selection" title="Play selection" ${find().action && !recording ? '' : 'disabled'}>${svg('play', 14)}</button><button data-command="actions.new-set" aria-label="Create new set" title="Create new set">${svg('folder-plus', 14)}</button><button data-command="actions.new" aria-label="Create new action" title="Create new action">${svg('plus', 14)}</button><button data-command="actions.delete" aria-label="Delete" title="Delete">${svg('trash-2', 14)}</button></div>`;
    void e;
  },
  menu: () => ['actions.new', 'actions.new-set', 'actions.duplicate', 'actions.delete', '-', 'actions.play', 'actions.record', 'actions.stop', '-', 'actions.insert-menu-item', '-', 'actions.export', 'actions.import', 'actions.reset'],
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
            for (const s of data.sets) sets.push({ ...s, id: crypto.randomUUID() });
            save();
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
