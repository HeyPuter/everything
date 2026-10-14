import { describe, it, expect } from 'vitest';
import { createSampleProject } from '../src/core/sample.js';
import { Scene } from '../src/core/scene.js';
import { scheduleRows, scheduleColumns, scheduleTotals, toCSV, formatCell } from '../src/core/schedule.js';

const sample = () => {
  const doc = createSampleProject();
  return { doc, scene: new Scene(doc) };
};

describe('schedules', () => {
  it('lists rooms with live areas, sorted by number', () => {
    const app = sample();
    const view = { kind: 'schedule', category: 'room', sortBy: 'number' };
    const cols = scheduleColumns(app.doc, view);
    expect(cols.map((c) => c.id)).toContain('area');
    const rows = scheduleRows(app, view);
    expect(rows.map((r) => r.values.number)).toEqual(['101', '102', '103', '104']);
    for (const r of rows) expect(r.values.area).toBeGreaterThan(5e6);
    const totals = scheduleTotals(cols, rows);
    expect(totals.area).toBeCloseTo(rows.reduce((s, r) => s + r.values.area, 0));
  });

  it('sorts descending and groups by type with counts', () => {
    const app = sample();
    const desc = scheduleRows(app, { kind: 'schedule', category: 'door', sortBy: 'mark', sortDir: 'desc' });
    expect(desc[0].values.mark).toBe('4');
    const grouped = scheduleRows(app, { kind: 'schedule', category: 'component', fields: ['family', 'type', 'count'], itemize: false });
    const chairs = grouped.find((r) => r.values.family === 'Chair');
    expect(chairs.values.count).toBe(4);
    expect(chairs.ids).toHaveLength(4);
  });

  it('exports CSV with quoting and formatted values', () => {
    const cols = [
      { id: 'name', label: 'Name', type: 'text' },
      { id: 'len', label: 'Length', type: 'length' },
    ];
    const csv = toCSV(cols, [{ values: { name: 'Hall, "main"', len: 1500 } }], { system: 'metric', metric: 'mm' });
    expect(csv).toBe('Name,Length\r\n"Hall, ""main""",1500');
    expect(formatCell({ type: 'area' }, 2e6, { system: 'metric' })).toBe('2.00 m²');
  });
});
