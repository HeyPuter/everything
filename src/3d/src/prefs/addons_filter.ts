// Workspace add-on filter: a workspace can show only the interface (sidebar panels) of the add-ons
// it lists. wm.owner_enable / wm.owner_disable edit the list; the Workspace panel shows it.
import { h } from '../ui/h';
import { app, registerOperators } from '../app/app';
import { checkbox, panel } from '../ui/widgets';
import { panelVisibility } from '../scripting/registry';
import { shellRef } from '../ui/shellref';
import { workspacePanelExtras } from '../ui/workspacepanel';
import { addons } from './addons';

const activeWs = () => {
  const sh = shellRef.current;
  return sh?.workspaces.find((w) => w.name === sh.active) ?? null;
};

/** The add-on that registered a panel or operator. */
export function addonOwnerOf(idname: string): string | null {
  for (const a of addons.values()) if (a.owned.includes(idname)) return a.id;
  return null;
}

/** Whether a panel shows in the active workspace (panels of no add-on always show). */
export function ownerAllowed(idname: string, ws = activeWs()): boolean {
  if (!ws?.use_filter_by_owner) return true;
  const owner = addonOwnerOf(idname);
  return !owner || (ws.owner_ids ?? []).includes(owner);
}

panelVisibility.test = (id) => ownerAllowed(id);

function setOwner(id: string, on: boolean) {
  const ws = activeWs();
  if (!ws) return false;
  const list = new Set(ws.owner_ids ?? []);
  if (on) list.add(id);
  else list.delete(id);
  ws.owner_ids = [...list];
  app.changed('ui');
  return true;
}

registerOperators([
  {
    idname: 'wm.owner_enable',
    label: 'Enable Add-on',
    description: 'Show the interface of an add-on in this workspace (with Filter Add-ons on)',
    undo: false,
    props: [{ id: 'owner_id', label: 'UI Tag', type: 'string', default: '' }],
    poll: () => !!activeWs(),
    exec: (_c, p) => (setOwner(String(p.owner_id), true) ? 'FINISHED' : 'CANCELLED'),
  },
  {
    idname: 'wm.owner_disable',
    label: 'Disable Add-on',
    description: 'Hide the interface of an add-on in this workspace (with Filter Add-ons on)',
    undo: false,
    props: [{ id: 'owner_id', label: 'UI Tag', type: 'string', default: '' }],
    poll: () => !!activeWs(),
    exec: (_c, p) => (setOwner(String(p.owner_id), false) ? 'FINISHED' : 'CANCELLED'),
  },
]);

workspacePanelExtras.push((id) => {
  const ws = activeWs();
  if (!ws) return null;
  const enabled = [...addons.values()].filter((a) => a.enabled);
  return panel(
    `${id}-addons`,
    'Filter Add-ons',
    () =>
      h(
        'div',
        { class: 'ws-addons' },
        enabled.length
          ? enabled.map((a) =>
              checkbox(`${id}-own-${a.id}`, a.info.name, (ws.owner_ids ?? []).includes(a.id), (v) => app.run(v ? 'wm.owner_enable' : 'wm.owner_disable', { owner_id: a.id }), {
                disabled: !ws.use_filter_by_owner,
                tip: 'Show this add-on’s panels in the workspace',
              }),
            )
          : h('div', { class: 'sb-label' }, 'No add-ons enabled'),
      ),
    {
      sub: true,
      closed: true,
      header: checkbox(`${id}-filter`, '', !!ws.use_filter_by_owner, (v) => ((ws.use_filter_by_owner = v), app.changed('ui')), { tip: 'Filter Add-ons\nShow only the panels of the add-ons checked below in this workspace' }),
    },
  );
});
