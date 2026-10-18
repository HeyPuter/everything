import { afterEach, expect, it } from 'vitest';
import { workbookFromFile } from '../src/core/io.js';

// A date in a web-page table ("05/01/2024", as bank statements and report exports saved as
// .html or .xls write them) was read at local midnight and counted from UTC: east of UTC
// (Berlin, Tokyo) the cell opened as the day before, and west of it with hours added.

const original = process.env.TZ;
afterEach(() => { process.env.TZ = original; });

const read = async (texts) => {
  const html = `<table>${texts.map((t) => `<tr><td>${t}</td></tr>`).join('')}</table>`;
  const wb = await workbookFromFile(new TextEncoder().encode(html), 'statement.html');
  return texts.map((_, r) => wb.getValue(wb.activeSheetId, r, 0));
};

it.each(['UTC', 'Europe/Berlin', 'Asia/Tokyo', 'America/Los_Angeles', 'Pacific/Kiritimati'])('reads the dates a table names as those days in %s', async (zone) => {
  process.env.TZ = zone;
  expect(await read(['05/01/2024', '2024-01-31', '1/5/2024 13:30', '2024-01-31T10:00:00', '2024/02/29']))
    .toEqual([45413, 45322, 45296.5625, 45322 + 10 / 24, 45351]);
});
