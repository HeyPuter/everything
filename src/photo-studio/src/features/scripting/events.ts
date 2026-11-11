// File → Scripts → Script Events Manager: run an installed script or a
// recorded action when an application event happens.
import './scripting.css';
import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { appEventLabels, type AppEvent } from '../../app/app-events';
import { allActions } from '../actions';
import { eventSettings, findScript, listScripts, saveEvents, updateScript, type EventRule } from './store';
import { confirmScript } from './run';

export function scriptEventsManager(e: Editor): Promise<void> {
  let settings = structuredClone(eventSettings());
  const dialog = document.createElement('dialog');
  dialog.className = 'files-dialog script-events';
  dialog.setAttribute('aria-label', 'Script Events Manager');
  const events = Object.entries(appEventLabels) as [AppEvent, string][];
  const targetName = (r: EventRule) => (r.kind === 'script' ? findScript(r.target)?.name : allActions().find((a) => a.action.id === r.target)?.action.name) ?? 'Missing';
  const options = (kind: 'script' | 'action') =>
    kind === 'script'
      ? listScripts().map((s) => `<option value="${escapeXML(s.id)}">${escapeXML(s.name)}</option>`).join('')
      : allActions().map(({ set, action }) => `<option value="${escapeXML(action.id)}">${escapeXML(`${set.name} › ${action.name}`)}</option>`).join('');
  dialog.innerHTML = `<form method="dialog">
    <h2>Script Events Manager</h2>
    <label class="dialog-field checkbox-field" title="Turn every rule below on or off at once">Run scripts and actions on events<input type="checkbox" name="enabled"></label>
    <ul class="event-rules" aria-label="Event rules"></ul>
    <fieldset class="event-add"><legend>Add a rule</legend>
      <label class="dialog-field">When<select name="event" title="The application event that starts the script or action">${events.map(([id, label]) => `<option value="${id}">${escapeXML(label)}</option>`).join('')}</select></label>
      <label class="dialog-field">Run<select name="kind" title="Run an installed script or a recorded action"><option value="script">Script</option><option value="action">Action</option></select></label>
      <label class="dialog-field">Which<select name="target" title="The script or action to run"></select></label>
      <button type="button" data-act="add" title="Add this rule to the list">Add</button>
    </fieldset>
    <p class="muted event-note">Rules run only installed scripts you have already run once, and only while no other script is running. Events do not fire for documents opened by batch processing.</p>
    <div class="dialog-actions"><button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Done</button></div>
  </form>`;
  document.body.append(dialog);
  const form = dialog.querySelector('form')!;
  const list = dialog.querySelector<HTMLElement>('.event-rules')!;
  const field = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as unknown as T;
  const enabled = field<HTMLInputElement>('enabled');
  const kind = field<HTMLSelectElement>('kind');
  const target = field<HTMLSelectElement>('target');
  const addButton = dialog.querySelector<HTMLButtonElement>('[data-act="add"]')!;
  enabled.checked = settings.enabled;
  const fillTargets = () => {
    target.innerHTML = options(kind.value as 'script' | 'action');
    addButton.disabled = !target.options.length;
    target.disabled = !target.options.length;
  };
  const render = () => {
    list.innerHTML = settings.rules.length
      ? settings.rules
          .map(
            (r, i) => `<li class="${r.enabled ? '' : 'off'}"><input type="checkbox" data-toggle="${i}" ${r.enabled ? 'checked' : ''} aria-label="Enable this rule" title="Enable or pause this rule"><span><b>${escapeXML(appEventLabels[r.event] ?? r.event)}</b> → ${r.kind === 'script' ? 'Script' : 'Action'}: ${escapeXML(targetName(r))}</span><button type="button" class="icon-button" data-remove="${i}" aria-label="Remove this rule" title="Remove this rule">${svg('trash-2', 13)}</button></li>`,
          )
          .join('')
      : '<li class="muted">No rules yet.</li>';
  };
  fillTargets();
  render();
  kind.addEventListener('change', fillTargets);
  list.addEventListener('change', (ev) => {
    const box = (ev.target as HTMLElement).closest<HTMLInputElement>('[data-toggle]');
    if (box) settings.rules[Number(box.dataset.toggle)].enabled = box.checked;
    render();
  });
  list.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-remove]');
    if (!b) return;
    settings.rules.splice(Number(b.dataset.remove), 1);
    render();
  });
  addButton.addEventListener('click', async () => {
    const rule: EventRule = { id: crypto.randomUUID(), event: field<HTMLSelectElement>('event').value as AppEvent, kind: kind.value as 'script' | 'action', target: target.value, enabled: true };
    if (!rule.target) return;
    // A script runs from events only after the user has agreed to run it.
    const script = rule.kind === 'script' ? findScript(rule.target) : undefined;
    if (script && !script.trusted) {
      dialog.close();
      const ok = await confirmScript(script.name, { offerInstall: false });
      dialog.showModal();
      if (!ok) return;
      await updateScript(script.id, { trusted: true });
    }
    settings.rules.push(rule);
    render();
  });
  return new Promise((resolve) => {
    const close = () => {
      dialog.close();
      dialog.remove();
      resolve();
    };
    dialog.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close();
    });
    dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', close);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      settings = { ...settings, enabled: enabled.checked };
      void saveEvents(settings);
      const active = settings.enabled ? settings.rules.filter((r) => r.enabled).length : 0;
      e.message(`${active} event rule${active === 1 ? '' : 's'} active.`);
      close();
    });
    dialog.showModal();
  });
}
