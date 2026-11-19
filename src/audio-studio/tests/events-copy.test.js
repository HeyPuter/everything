// Events panel: copying selected events as text and the row menu.
import { it, expect, vi } from 'vitest';
import { eventsPanel, eventsText } from '../src/panels/events.js';
import { EventLog } from '../src/lib/event-log.js';

it('copies the selected events as tab-separated lines', async () => {
  const log = new EventLog({ now: () => 0 });
  log.add({ type: 'error', name: 'a.wav', message: 'Could not save' });
  log.add({ type: 'info', name: 'b.wav', message: 'Opened' });
  const writes = [];
  vi.stubGlobal('navigator', { clipboard: { writeText: async (t) => writes.push(t) } });
  const menus = [];
  const app = { eventLog: log, openMenu: (items) => menus.push(items), setStatus: vi.fn(), notify: vi.fn() };
  const panel = eventsPanel(app);
  document.body.replaceChildren(panel.el);
  const rows = () => [...panel.el.querySelectorAll('tbody tr[data-id]')];
  rows()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(menus[0].map((i) => i.label).filter(Boolean)).toEqual(['Copy', 'Select All', 'Delete Selected Events', 'Clear All']);
  await menus[0][0].run();
  expect(writes[0].split('\t')[0]).toBe('Error');
  expect(writes[0]).toContain('Could not save');
  rows()[0].focus();
  rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
  rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }));
  await vi.waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].split('\n')).toHaveLength(2);
  expect(eventsText([])).toBe('');
  vi.unstubAllGlobals();
});
