// The scripted puter.ai in dev/fake-puter, driven through the real AI clients (Q4, Q5, Q11, Q12, R11).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import { extractItems } from '../../src/lib/ai/import/extract.js';
import { puterChat } from '../../src/lib/ai/assistant/chat.js';
import { userContent } from '../../src/lib/ai/assistant/prompt.js';
import { requestSummary } from '../../src/views/trip/places/details/summary.js';
import { readReceipt, receiptErrorCode } from '../../src/lib/ai/receipt.js';
import { nameStops } from '../../src/lib/photos/days.js';

const alice = { uuid: '00000000-0000-4000-8000-000000000001', username: 'alice' };
const trip = { title: 'Lisbon', start: '2027-05-10', end: '2027-05-14' };
const today = '2027-05-01';
let fetchSpy;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests')); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); });

function world() {
  const fake = createFakePuter({ users: [alice], ai: true });
  return { fake, puter: fake.client(alice.uuid) };
}
async function collect(iterable) { const parts = []; for await (const part of iterable) parts.push(part); return parts; }
const snapshot = { trip: { title: 'Lisbon', start: '2027-05-10', end: '2027-05-14', days: 2 }, detail: 'full', days: [{ id: '1000000000000001', n: 1, date: '2027-05-10' }] };
const assistantTools = (names) => names.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }));
const turn = (text) => [{ role: 'system', content: 'You are the trip assistant in Trips.' }, { role: 'user', content: userContent(text, snapshot) }];

describe('fake puter.ai', () => {
  it('is only present when the world asks for it', () => {
    expect(createFakePuter({ users: [alice] }).client(alice.uuid).ai).toBeUndefined();
    expect(createFakePuter({ users: [alice] }).ai).toBeNull();
    expect(typeof world().puter.ai.chat).toBe('function');
  });

  it('extracts bookings from pasted text and from staged files (Q4)', async () => {
    const { fake, puter } = world();
    const [flight] = await extractItems({ text: 'Your flight TP1351 LIS → OPO on 2027-05-11, 07:05 to 08:00. Booking reference: QX7KLM' }, { puter, trip, today });
    expect(flight).toMatchObject({ type: 'flight', title: 'LIS → OPO', code: 'QX7KLM', legs: [{ from: { code: 'LIS' }, to: { code: 'OPO' }, dep: { date: '2027-05-11', time: '07:05' }, arr: { time: '08:00' }, number: 'TP1351' }] });
    const [stay] = await extractItems({ files: [{ kind: 'pdf', name: 'stay.pdf', blob: new Blob(['Hotel Aurora Lisboa. Check-in 2027-05-11, check-out 2027-05-13.']) }] }, { puter, trip, today });
    expect(stay).toMatchObject({ type: 'lodging', title: 'Hotel Aurora Lisboa', start: { date: '2027-05-11' }, end: { date: '2027-05-13' } });
    expect(await extractItems({ text: 'Thanks for subscribing to our newsletter.' }, { puter, trip, today })).toEqual([]);
    expect(fake.ai.calls().map((call) => [call.kind, call.files])).toEqual([['import', 0], ['import', 1], ['import', 0]]);
  });

  it('lets a script keyed by content win over the built-in reply, for a number of calls', async () => {
    const { fake, puter } = world();
    fake.ai.script({ kind: 'import', match: 'fado', times: 1, reply: { json: { bookings: [{ type: 'event', title: 'Fado night', start: { date: '2027-05-12', time: '21:00' } }] } } });
    expect(await extractItems({ text: 'Fado tickets' }, { puter, trip, today })).toMatchObject([{ type: 'event', title: 'Fado night' }]);
    expect(await extractItems({ text: 'Fado tickets' }, { puter, trip, today })).toEqual([]);
  });

  it('streams assistant text and tool calls, answers tool results, and offers viewers no proposals (Q5)', async () => {
    const { puter } = world();
    const chat = puterChat(puter);
    const tools = assistantTools(['get_trip_summary', 'propose_add_packing_items', 'propose_add_visits']);
    const parts = await collect(chat(turn('What should I pack?'), { tools }));
    const call = parts.find((part) => part.type === 'tool');
    expect(call).toMatchObject({ name: 'propose_add_packing_items', input: { items: expect.arrayContaining([expect.objectContaining({ name: 'Passport' })]) } });
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text).join('')).toBe('Here are a few things to pack.');

    const answered = [...turn('What should I pack?'), { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] },
      { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ status: 'applied', created: {} }) }];
    const reply = await collect(chat(answered, { tools }));
    expect(reply.length).toBeGreaterThan(1);
    expect(reply.map((part) => part.text).join('')).toBe('Done. The change is in the trip.');

    const visits = await collect(chat(turn('Plan the first day for me'), { tools }));
    expect(visits.find((part) => part.type === 'tool')).toMatchObject({ name: 'propose_add_visits', input: { day: '1000000000000001' } });
    const viewer = await collect(chat(turn('Plan the first day for me'), { tools: assistantTools(['get_trip_summary']) }));
    expect(viewer.some((part) => part.type === 'tool')).toBe(false);
  });

  it('summarizes a place as checked plain text (Q11)', async () => {
    const { puter } = world();
    const result = await requestSummary({ chat: (messages, options) => puter.ai.chat(messages, options), model: 'gpt-5-nano', place: { name: 'Belém Tower', cc: 'PT', lat: 38.6916, lng: -9.216 }, view: {}, categoryName: 'Attraction' });
    expect(result.text).toContain('Belém Tower');
    expect(result.mismatch).toBe(false);
  });

  it('reads a receipt with the vision model, then through OCR when the first answer is unusable (Q12)', async () => {
    const { fake, puter } = world();
    const image = 'data:image/jpeg;base64,AAAA';
    expect(await readReceipt(image, { puter, tripCurrency: 'EUR', today })).toMatchObject({ source: 'vision', receipt: { name: 'Café Central', amount: 1850, currency: 'EUR', date: today, items: [{ label: 'Coffee', amount: 600 }, { label: 'Pastries', amount: 1250 }] } });
    fake.ai.script({ kind: 'receipt', match: (request) => request.images.length > 0, times: 1, reply: 'I cannot read this.' });
    expect(await readReceipt(image, { puter, tripCurrency: 'EUR', today })).toMatchObject({ source: 'ocr', receipt: { amount: 1850 } });
    expect(fake.ai.calls().slice(-3).map((call) => call.kind)).toEqual(['receipt', 'ocr', 'receipt']);
  });

  it('names photo stops (R11)', async () => {
    const { puter } = world();
    const names = await nameStops({ chat: (messages, options) => puter.ai.chat(messages, options), stops: [{ date: '2027-05-10', name: 'Belém, Lisbon', lat: 38.69, lng: -9.21, photos: [] }], categories: ['attraction', 'restaurant'] });
    expect(names.get(0)).toEqual({ name: 'Belém', cat: 'attraction' });
  });

  it('fails with credit, offline and usage errors each client understands', async () => {
    const { fake, puter } = world();
    const chat = puterChat(puter);
    fake.ai.fail('credit');
    await expect(extractItems({ text: 'flight' }, { puter, trip, today })).rejects.toMatchObject({ code: 'credit' });
    await expect(collect(chat(turn('hi'), {}))).rejects.toMatchObject({ kind: 'credit' });
    await expect(requestSummary({ chat: (m, o) => puter.ai.chat(m, o), place: { name: 'X' }, view: {} })).rejects.toMatchObject({ code: 'credit' });
    expect(receiptErrorCode(await readReceipt('data:image/jpeg;base64,AAAA', { puter, tripCurrency: 'EUR', today }).catch((error) => error))).toBe('credit');

    fake.ai.fail('offline');
    await expect(extractItems({ text: 'flight' }, { puter, trip, today })).rejects.toMatchObject({ code: 'offline' });
    await expect(collect(chat(turn('hi'), {}))).rejects.toMatchObject({ kind: 'offline' });
    expect(receiptErrorCode(await readReceipt('data:image/jpeg;base64,AAAA', { puter, tripCurrency: 'EUR', today }).catch((error) => error))).toBe('offline');

    fake.ai.fail('usage', { times: 1 });
    await expect(collect(chat(turn('hi'), {}))).rejects.toMatchObject({ kind: 'usage' });
    expect((await collect(chat(turn('hi'), {}))).length).toBeGreaterThan(0);

    // The world's own switches reach AI calls too.
    fake.failNext({ method: 'ai.chat' });
    await expect(collect(chat(turn('hi'), {}))).rejects.toMatchObject({ kind: 'credit' });
    fake.setOffline(alice.uuid);
    await expect(collect(chat(turn('hi'), {}))).rejects.toMatchObject({ kind: 'offline' });
    fake.setOffline(alice.uuid, false);
    fake.ai.fail(null);
    expect(fake.counters().calls['ai.chat']).toBeGreaterThan(0);
  });
});
