import { coordinate, assertActive, text } from './core.js';
export function createAirports({ fetch: fetcher = globalThis.fetch, url = '/data/airports.json' } = {}) {
  let pending;
  const load = () => pending ??= (async () => {
    try {
      const response = await fetcher(url, { credentials: 'omit' }); if (!response.ok) throw new Error('Airports unavailable');
      const input = await response.json(); const rows = Array.isArray(input) ? input : input.airports;
      if (!Array.isArray(rows)) throw new Error('Invalid airports');
      return rows.flatMap(row => {
        try { coordinate(row.lat, row.lng); if (!/^[A-Z]{3}$/.test(row.iata) || typeof row.name !== 'string' || typeof row.tz !== 'string') return []; new Intl.DateTimeFormat('en', { timeZone: row.tz }); return [{ iata: row.iata, name: row.name.slice(0, 300), city: String(row.city ?? '').slice(0, 200), country: String(row.country ?? '').slice(0, 2), lat: row.lat, lng: row.lng, tz: row.tz }]; } catch { return []; }
      });
    } catch { pending = null; return null; }
  })();
  return {
    async search(query, { signal, limit = 20 } = {}) { const q = text(query, 100).toLocaleLowerCase('en'); assertActive(signal); const data = await load(); assertActive(signal); return data?.filter(row => `${row.iata} ${row.name} ${row.city}`.toLocaleLowerCase('en').includes(q)).sort((a, b) => Number(b.iata.toLowerCase() === q) - Number(a.iata.toLowerCase() === q) || a.iata.localeCompare(b.iata)).slice(0, Math.min(50, Math.max(1, limit))) ?? null; },
    async byCode(code, { signal } = {}) { if (!/^[A-Z]{3}$/i.test(code)) throw new RangeError('Invalid IATA code'); assertActive(signal); const data = await load(); assertActive(signal); return data?.find(row => row.iata === code.toUpperCase()) ?? null; },
  };
}
