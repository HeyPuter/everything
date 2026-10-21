/**
 * Analysis dialogs: zones, the heating and cooling load estimate, and the
 * check for duct and pipe ends that connect to nothing.
 */
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { openDialog, toast, promptDialog } from './dialog.js';
import { spaceLoads, spaceType, ZONE_COLORS, disconnects } from '../core/spaces.js';
import { uniqueName } from '../core/ops.js';
import { download } from '../io/storage.js';

const fmt = (n, d = 0) => (Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '');

export function zonesDialog(app) {
  const doc = app.doc;
  const body = h('div');
  const render = () => {
    clear(body);
    const zones = doc.all('zone');
    const tbody = h('tbody');
    for (const z of zones) {
      const members = doc.all('space').filter((s) => s.zoneId === z.id);
      const name = h('input.input.sm', { type: 'text', value: z.name, 'aria-label': 'Zone name' });
      name.addEventListener('change', () => name.value.trim() && app.commit('Rename zone', () => doc.update(z.id, { name: name.value.trim() })));
      const color = h('input.ov-color', { type: 'color', value: z.color || '#4f8fd6', 'aria-label': `${z.name} colour` });
      color.addEventListener('change', () => app.commit('Zone colour', () => doc.update(z.id, { color: color.value })));
      const sp = (k, label) => {
        const inp = h('input.input.sm', { type: 'number', step: '0.5', value: String(z[k] ?? (k === 'heating' ? 21 : 24)), 'aria-label': `${z.name} ${label}`, style: { width: '70px' } });
        inp.addEventListener('change', () => Number.isFinite(+inp.value) && app.commit('Zone setpoint', () => doc.update(z.id, { [k]: +inp.value })));
        return inp;
      };
      tbody.append(
        h('tr',
          h('td', color),
          h('td', name),
          h('td.num', String(members.length)),
          h('td', sp('heating', 'heating setpoint')),
          h('td', sp('cooling', 'cooling setpoint')),
          h('td', h('span.inline',
            h('button.btn.sm', { type: 'button', disabled: !app.selection.size, onClick: () => {
              const ids = [...app.selection].filter((id) => doc.get(id)?.kind === 'space');
              if (!ids.length) return toast('Select spaces to add to the zone.', { kind: 'error' });
              app.commit('Add spaces to zone', () => ids.forEach((id) => doc.update(id, { zoneId: z.id })));
              render();
            } }, 'Add selected'),
            h('button.icon-btn.sm', { type: 'button', 'aria-label': `Delete ${z.name}`, onClick: () => {
              app.commit('Delete zone', () => {
                for (const s of members) doc.update(s.id, { zoneId: null });
                doc.remove(z.id);
              });
              render();
            } }, icon('trash', 14))))),
      );
    }
    body.append(
      zones.length
        ? h('table.vg-table', h('thead', h('tr', h('th', h('span.sr-only', 'Colour')), h('th', 'Zone'), h('th', 'Spaces'), h('th', 'Heat to °C'), h('th', 'Cool to °C'), h('th', h('span.sr-only', 'Actions')))), tbody)
        : h('p.dialog-text', 'Zones group the spaces that one system or thermostat serves. Create a zone, select spaces in a plan, then add them.'),
      h('div', { style: { marginTop: '10px' } }, h('button.btn', { type: 'button', onClick: async () => {
        const n = await promptDialog('New Zone', 'Name', uniqueName(zones.map((z) => z.name), 'Zone 1'), { okLabel: 'Create' });
        if (!n) return;
        const ids = [...app.selection].filter((id) => doc.get(id)?.kind === 'space');
        app.commit('New zone', () => {
          const z = doc.add({ kind: 'zone', name: n, color: ZONE_COLORS[zones.length % ZONE_COLORS.length], heating: 21, cooling: 24 });
          ids.forEach((id) => doc.update(id, { zoneId: z.id }));
        });
        render();
      } }, icon('plus', 14), app.selection.size ? 'New zone from selected spaces' : 'New zone')),
    );
  };
  render();
  return openDialog({ title: 'Zones', body, size: 'lg', actions: [{ label: 'Close', primary: true, value: true }] });
}

/** Per-space and per-zone heating and cooling estimates. */
export function loadsDialog(app) {
  const doc = app.doc;
  const rooms = app.scene.rooms;
  const rows = [];
  for (const s of doc.all('space')) {
    const l = spaceLoads(s, rooms.room(s));
    rows.push({ s, l, zone: doc.get(s.zoneId)?.name || '', level: doc.get(s.levelId)?.name || '' });
  }
  rows.sort((a, b) => a.zone.localeCompare(b.zone) || String(a.s.number).localeCompare(String(b.s.number), undefined, { numeric: true }));
  if (!rows.length) return toast('Place spaces first (Analyze tab, Space).', { kind: 'error' });
  const totals = { area: 0, people: 0, cooling: 0, heating: 0, outdoorAir: 0 };
  const tbody = h('tbody');
  for (const { s, l, zone, level } of rows) {
    if (l) for (const k of Object.keys(totals)) totals[k] += l[k];
    tbody.append(
      h('tr',
        h('td', `${s.number || ''} ${s.name || ''}`.trim()),
        h('td.muted', level),
        h('td', zone),
        h('td', spaceType(s).label),
        h('td.num', l ? fmt(l.area, 1) : 'Not enclosed'),
        h('td.num', l ? fmt(l.people) : ''),
        h('td.num', l ? fmt(l.outdoorAir) : ''),
        h('td.num', l ? fmt(l.cooling / 1000, 1) : ''),
        h('td.num', l ? fmt(l.heating / 1000, 1) : '')),
    );
  }
  tbody.append(h('tr.total-row', h('td', h('strong', 'Total')), h('td'), h('td'), h('td'), h('td.num', fmt(totals.area, 1)), h('td.num', fmt(totals.people)), h('td.num', fmt(totals.outdoorAir)), h('td.num', h('strong', fmt(totals.cooling / 1000, 1))), h('td.num', h('strong', fmt(totals.heating / 1000, 1)))));
  const csv = () => {
    const lines = [['Space', 'Level', 'Zone', 'Type', 'Area m2', 'People', 'Outdoor air l/s', 'Cooling kW', 'Heating kW'].join(',')];
    for (const { s, l, zone, level } of rows) lines.push([`"${`${s.number || ''} ${s.name || ''}`.trim()}"`, `"${level}"`, `"${zone}"`, spaceType(s).label, l ? l.area.toFixed(2) : '', l ? l.people : '', l ? l.outdoorAir : '', l ? (l.cooling / 1000).toFixed(2) : '', l ? (l.heating / 1000).toFixed(2) : ''].join(','));
    download(new Blob([lines.join('\n')], { type: 'text/csv' }), 'heating-and-cooling-loads.csv');
  };
  return openDialog({
    title: 'Heating and Cooling Loads',
    size: 'lg',
    body: h(
      'div',
      h('p.field-hint', 'First estimates from typical gains per floor area, per occupant and for the building fabric, for early sizing. Use a load calculation for design. Set each space\'s type and occupancy in its properties.'),
      h('div.kbd-scroll', h('table.vg-table', h('thead', h('tr', h('th', 'Space'), h('th', 'Level'), h('th', 'Zone'), h('th', 'Type'), h('th.num', 'Area m²'), h('th.num', 'People'), h('th.num', 'Outdoor air l/s'), h('th.num', 'Cooling kW'), h('th.num', 'Heating kW'))), tbody)),
    ),
    actions: [{ label: 'Export CSV', onClick: () => (csv(), false) }, { label: 'Close', primary: true, value: true }],
  });
}

/** Duct and pipe ends that connect to nothing. */
export function checkSystemsDialog(app) {
  const doc = app.doc;
  const list = disconnects(doc);
  if (!list.length) return toast(doc.count('duct') + doc.count('pipe') + doc.count('cableTray') + doc.count('conduit') ? 'Every duct, pipe, cable tray and conduit end connects to another run or to equipment.' : 'There are no ducts or pipes to check.', { kind: 'success' });
  const ul = h('ul.file-list', { role: 'list' });
  for (const d of list) {
    const el = doc.get(d.id);
    ul.append(h('li', h('button.file-item', { type: 'button', onClick: () => {
      document.querySelector('dialog[open]')?._close?.(null);
      app.showElements([d.id]);
    } }, icon('warning', 16), h('span.file-name', `Open end of a ${d.kind === 'cableTray' ? 'cable tray' : d.kind} (${d.system})`), h('span.file-meta', doc.get(el.levelId)?.name || ''))));
  }
  return openDialog({ title: `Systems Check: ${list.length} open end${list.length === 1 ? '' : 's'}`, size: 'md', body: h('div', h('p.field-hint', 'Ends that meet no other run and no fixture, terminal or piece of equipment. Click one to show it.'), ul), actions: [{ label: 'Close', primary: true, value: true }] });
}
