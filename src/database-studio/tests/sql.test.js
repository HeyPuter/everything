import { describe, expect, it } from 'vitest';
import { listTables, runQuery, seedCatalog } from '../src/engine/sql.js';

describe('database studio sql', () => {
  const cat = seedCatalog();

  it('lists tables', () => {
    expect(listTables(cat)).toEqual(['depts', 'employees']);
  });

  it('selects all columns', () => {
    const r = runQuery(cat, 'SELECT * FROM employees');
    expect(r.columns).toEqual(['id', 'name', 'dept', 'salary']);
    expect(r.rows).toHaveLength(4);
  });

  it('filters with where', () => {
    const r = runQuery(cat, "SELECT name FROM employees WHERE dept = 'Eng'");
    expect(r.rows.map((x) => x.name).sort()).toEqual(['Ada', 'Grace']);
  });

  it('rejects unknown tables', () => {
    expect(() => runQuery(cat, 'SELECT * FROM missing')).toThrow(/Unknown table/);
  });
});
