// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';

const row = { date: '2026-01-01', name: 'New Year', countryCode: 'DE', nationalHoliday: true, subdivisionCodes: null, holidayTypes: ['Public'] };
function fixture(data, options = {}) {
  const fetcher = vi.fn(async () => Response.json(data));
  const services = createServices({ userId: 'alice', cache: createMemoryCache(), fetch: fetcher,
    config: { providers: { publicHolidays: ['nager'] }, nagerVersion: 4 }, retries: 0, sleep: async () => {}, ...options });
  return { services, fetcher };
}

it('normalizes v4 public dates, subdivisions and attribution using the fixed v4 endpoint', async () => {
  const { services, fetcher } = fixture([row,
    { ...row, date: '2026-02-01', name: 'Regional', nationalHoliday: false, subdivisionCodes: ['DE-BY', 'DE-BY', 'DE-BE', null] },
    { ...row, date: '2026-03-01', name: 'Elsewhere', nationalHoliday: false, subdivisionCodes: ['DE-BE'] },
    { ...row, date: '2026-04-01', holidayTypes: ['Observance'] }]);
  const result = await services.holidays.public('DE', 2026, 'DE-BY');
  expect(fetcher.mock.calls[0][0]).toBe('https://nagerholidays.com/api/v4/Holidays/DE/2026');
  expect(result.data).toEqual([
    { date: '2026-01-01', name: 'New Year', localName: 'New Year', global: true, regions: [] },
    { date: '2026-02-01', name: 'Regional', localName: 'Regional', global: false, regions: ['DE-BY', 'DE-BE'] },
  ]);
  expect(result.attribution[0].url).toBe('https://nagerholidays.com/api');
});
it('ignores malformed, wrong-country and wrong-year rows without interpreting names as markup', async () => {
  const { services } = fixture([null, 3, {}, { ...row, date: '2026-02-30' }, { ...row, date: '2027-01-01' },
    { ...row, countryCode: 'AT' }, { ...row, holidayTypes: null }, { ...row, name: ' ' },
    { ...row, name: '<b>Holiday</b>', localName: {}, subdivisionCodes: ['AT-X', 'DE-BY', '<script>'] }]);
  expect((await services.holidays.public('DE', 2026)).data).toEqual([
    { date: row.date, name: '<b>Holiday</b>', localName: '<b>Holiday</b>', global: true, regions: ['DE-BY'] },
  ]);
});
it('separates v3/v4 cache and in-flight requests while permitting explicit rollback', async () => {
  let version = 3;
  let finishV3;
  const cache = createMemoryCache();
  const config = () => ({ providers: { publicHolidays: ['nager'] }, nagerVersion: version });
  const fetcher = vi.fn(url => String(url).includes('/v3/') ? new Promise(resolve => { finishV3 = () => resolve(Response.json([{ date: row.date, name: 'v3', global: true }])); }) : Response.json([{ ...row, name: 'v4' }]));
  const { services } = fixture(null, { config, fetch: fetcher, cache });
  const old = services.holidays.public('DE', 2026);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  version = 4;
  expect((await services.holidays.public('DE', 2026)).data[0].name).toBe('v4');
  finishV3(); expect((await old).data[0].name).toBe('v3');
  expect((await services.holidays.public('DE', 2026)).data[0].name).toBe('v4');
  version = 3;
  expect((await services.holidays.public('DE', 2026)).data[0].name).toBe('v3');
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('serves the selected version offline from cache and returns null after provider disable', async () => {
  let online = true; let disabled = [];
  const { services, fetcher } = fixture([row], { online: () => online,
    config: () => ({ providers: { publicHolidays: ['nager'] }, nagerVersion: 4, disabled }) });
  await services.holidays.public('DE', 2026); online = false;
  expect((await services.holidays.public('DE', 2026)).cached).toBe(true);
  expect(fetcher).toHaveBeenCalledOnce();
  online = true; disabled = ['nager'];
  expect(await services.holidays.public('DE', 2026)).toBeNull();
});
it('retains the v3 observed-date shape including dates across a year boundary', async () => {
  const { services, fetcher } = fixture([{ date: '2021-12-31', name: 'New Year', localName: 'New Year observed', global: true }],
    { config: { providers: { publicHolidays: ['nager'] }, nagerVersion: 3 } });
  expect((await services.holidays.public('US', 2022)).data[0]).toMatchObject({ date: '2021-12-31', localName: 'New Year observed', global: true });
  expect(fetcher.mock.calls[0][0]).toBe('https://date.nager.at/api/v3/PublicHolidays/2022/US');
});
it('rejects malformed envelopes and bounds holiday row counts', async () => {
  const { services, fetcher } = fixture({ holidays: [row] });
  expect(await services.holidays.public('DE', 2026)).toBeNull();
  fetcher.mockImplementation(async () => Response.json(Array.from({ length: 5001 }, () => row)));
  expect(await services.holidays.public('DE', 2026)).toBeNull();
});
it.each([{ error: 'invalid envelope' }, [null, {}]].map(data => ({ data })))('retains stale cache after a malformed refresh: $data', async ({ data }) => {
  let now = 0;
  const { services, fetcher } = fixture([row], { now: () => now });
  await services.holidays.public('DE', 2026);
  now = 366 * 24 * 3_600_000;
  fetcher.mockImplementation(async () => Response.json(data));
  expect(await services.holidays.public('DE', 2026)).toMatchObject({ cached: true, stale: true, data: [{ name: 'New Year' }] });
});
it.each([[], [{ ...row, holidayTypes: ['Observance'] }], [{ ...row, nationalHoliday: false, subdivisionCodes: ['DE-BE'] }]].map(data => ({ data })))('accepts a valid response with no matching public holidays: $data', async ({ data }) => {
  const { services } = fixture(data);
  expect(await services.holidays.public('DE', 2026, 'DE-BY')).toMatchObject({ cached: false, stale: false, data: [] });
});
