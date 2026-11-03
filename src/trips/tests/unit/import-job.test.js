// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearJob, commitJob, editCandidate, getJob, mergeCandidates, onJob, readyCandidates, restoreJob, setAction, startJob,
} from '../../src/lib/ai/import/job.js';
import { aiErrorCode, extractItems } from '../../src/lib/ai/import/extract.js';
import { listMail, readMail, requestMailAccess } from '../../src/lib/ai/import/mail.js';
import { readInput } from '../../src/lib/ai/import/sources.js';
import { validateEntity } from '../../src/shared/schema/index.js';
import { validateOperation } from '../../src/shared/operations.js';
import { createClock } from '../../src/shared/hlc.js';
import { fakeAiPuter, memoryDb } from './helpers/fake-ai.js';
import { makeZip } from './helpers/zip-writer.js';

const SPACE = 'sp00000000000001';
const V1 = createClock({ node: '0000000000000007', now: () => 1_000_000 }).tick();
let seq = 0;
const makeId = () => `4${String(++seq).padStart(15, '0')}`;
const services = { airports: { byCode: async (code) => ({ LIS: { name: 'Lisbon', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' }, JFK: { name: 'JFK', lat: 40.64, lng: -73.78, tz: 'America/New_York' } })[code] ?? null } };
const flightReply = { bookings: [{ type: 'flight', title: 'Lisbon to New York', provider: 'TAP', code: 'X7K2LM', legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '11:00' }, arr: { date: '2026-05-03', time: '13:30' }, number: 'TP209' }] }] };
const hotelReply = { bookings: [{ type: 'lodging', title: 'Hotel Sol', code: 'HS-4471', start: { date: '2026-05-04' }, end: { date: '2026-05-06' } }] };
const insufficient = { reject: { success: false, error: { code: 'insufficient_funds', message: 'Not enough funding', status: 402 } } };

function stubSpace(reservations = []) {
  const res = new Map(reservations.map((item) => [item.id, item]));
  const applied = [];
  return {
    applied,
    get: (type, id) => (type === 'res' ? res.get(id) : undefined),
    can: () => true,
    ops: {
      create: (t, put) => ({ opId: makeId(), t, id: makeId(), put: structuredClone(put) }),
      patch: (t, id, { set, unset } = {}, { base = false } = {}) => ({ opId: makeId(), t, id, ...(set && Object.keys(set).length ? { set } : {}), ...(unset?.length ? { unset } : {}), ...(base ? { base: V1 } : {}) }),
    },
    async apply(ops, options) {
      for (const op of ops) { validateOperation(op); if (op.put) validateEntity('trip', 'res', op.put); }
      applied.push({ ops, options });
    },
  };
}

afterEach(async () => { await clearJob({ spaceId: SPACE }); });

describe('extraction call', () => {
  it('sends a JSON schema, stages files and deletes them afterwards', async () => {
    const fake = fakeAiPuter({ replies: [flightReply] });
    const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
    const items = await extractItems({ text: 'Booking X7K2LM', files: [{ name: 'ticket.pdf', blob: pdf, kind: 'pdf' }] }, { puter: fake.puter, model: 'gpt-x', trip: { title: 'NYC', start: '2026-05-03' }, people: ['Alice'], today: '2026-04-01', testMode: true });
    expect(items).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.testMode).toBe(true);
    expect(call.options).toMatchObject({ model: 'claude-sonnet-5-5', outputFormat: { type: 'json_schema' } });
    expect(call.messages[0]).toMatchObject({ role: 'system' });
    expect(call.messages[0].content).toContain('untrusted data');
    const parts = call.messages[1].content;
    expect(parts.find((part) => part.type === 'file').puter_path).toMatch(/^\/alice\/AppData\/app-test\/trips-import\/[0-9a-f]+\.pdf$/);
    expect(parts.at(-2).text).toBe('<document>\nBooking X7K2LM\n</document>');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(fake.deleted).toHaveLength(1);
    expect(fake.staged.size).toBe(0);
  });

  it('maps a 402 and other failures to stable codes', async () => {
    const fake = fakeAiPuter({ replies: [insufficient, 'not json'] });
    await expect(extractItems({ text: 'x' }, { puter: fake.puter })).rejects.toMatchObject({ code: 'credit' });
    await expect(extractItems({ text: 'x' }, { puter: fake.puter })).rejects.toMatchObject({ code: 'unreadable' });
    await expect(extractItems({ text: 'x' }, { puter: {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(aiErrorCode({ status: 429 })).toBe('busy');
    expect(aiErrorCode({ error: { code: 'token_auth_failed' } })).toBe('forbidden');
    expect(aiErrorCode({ metadata: { usage_limited: true } })).toBe('credit');
  });
});

describe('import job', () => {
  it('reads inputs in order, checks and dedupes, and stops on 402', async () => {
    const fake = fakeAiPuter({ replies: [flightReply, insufficient] });
    const db = memoryDb();
    const states = [];
    const off = onJob(SPACE, (job) => states.push(job?.status));
    const pass = makeZip([['pass.json', JSON.stringify({ organizationName: 'Arena', eventTicket: { primaryFields: [{ key: 'event', label: 'Event', value: 'Fado' }] }, relevantDate: '2026-05-05T21:00+01:00' })]]);
    const existing = { id: 'r000000000000001', type: 'flight', title: 'Old', status: 'confirmed', code: 'X7K2LM', legs: flightReply.bookings[0].legs };
    await startJob({
      spaceId: SPACE, db, puter: fake.puter,
      inputs: [
        { type: 'paste', label: 'Pasted text', text: 'Your flight X7K2LM' },
        { type: 'file', label: 'fado.pkpass', file: new File([pass], 'fado.pkpass') },
        { type: 'paste', label: 'Hotel', text: 'Hotel Sol HS-4471' },
        { type: 'paste', label: 'Never read', text: 'More' },
      ],
      context: { people: [], services, reservations: () => [existing], fallbackTitle: (type) => type },
    });
    off();
    const job = getJob(SPACE);
    expect(job.status).toBe('review');
    expect(job.error).toBe('credit');
    expect(job.sources.map((source) => [source.state, source.error, source.count])).toEqual([['done', null, 1], ['done', null, 1], ['failed', 'credit', 0], ['skipped', null, 0]]);
    expect(fake.calls).toHaveLength(2);
    const [flight, event] = job.candidates;
    expect(flight).toMatchObject({ kind: 'ai', action: 'skip', duplicate: { resId: existing.id, reason: 'code', strength: 'exact' } });
    expect(flight.draft.legs[0].from).toMatchObject({ name: 'Lisbon', tz: 'Europe/Lisbon' });
    expect(event).toMatchObject({ kind: 'pkpass', action: 'create', draft: { type: 'event', title: 'Fado', start: { date: '2026-05-05', time: '21:00' }, src: { kind: 'pkpass' } } });
    expect(job.sources[1].attach).toHaveLength(1);
    expect(states.at(-1)).toBe('review');
    await vi.waitFor(() => expect(db.map.get(`import:${SPACE}`)).toMatchObject({ status: 'review' }));
  });

  it('fails without candidates when the first call needs credit', async () => {
    const fake = fakeAiPuter({ replies: [insufficient] });
    await startJob({ spaceId: SPACE, puter: fake.puter, inputs: [{ type: 'paste', label: 'x', text: 'y' }], context: {} });
    expect(getJob(SPACE)).toMatchObject({ status: 'failed', error: 'credit' });
  });

  it('edits, merges and commits approved candidates in one batch, then attaches files', async () => {
    const fake = fakeAiPuter({ replies: [flightReply, hotelReply] });
    const pdf = new File(['%PDF-1.4'], 'voucher.pdf', { type: 'application/pdf' });
    await startJob({ spaceId: SPACE, puter: fake.puter, inputs: [{ type: 'file', label: 'voucher.pdf', file: pdf }, { type: 'paste', label: 'hotel', text: 'Hotel' }], context: { services, reservations: () => [] } });
    let job = getJob(SPACE);
    expect(readyCandidates(job)).toHaveLength(2);
    const hotel = job.candidates[1];
    editCandidate(SPACE, hotel.id, { ...hotel.draft, title: 'Hotel Sol Lisboa', stay: { checkInFrom: '15:00' } });
    editCandidate(SPACE, job.candidates[0].id, { ...job.candidates[0].draft, legs: [{ ...job.candidates[0].draft.legs[0], dep: { date: '' } }] });
    job = getJob(SPACE);
    expect(job.candidates[0].issues.length).toBeGreaterThan(0);
    expect(readyCandidates(job).map((candidate) => candidate.draft.title)).toEqual(['Hotel Sol Lisboa']);
    editCandidate(SPACE, job.candidates[0].id, { ...job.candidates[0].draft, legs: [{ ...job.candidates[0].draft.legs[0], dep: { date: '2026-05-03', time: '11:00' } }] });
    const space = stubSpace();
    const uploads = [];
    const result = await commitJob({ space, spaceId: SPACE, history: 'Import', upload: async (file, links) => { uploads.push({ name: file.name, links }); } });
    expect(result).toMatchObject({ created: 2, updated: 0 });
    expect(await result.attachments).toEqual({ attached: 1, failed: 0 });
    expect(space.applied).toHaveLength(1);
    expect(space.applied[0].options).toEqual({ history: 'Import' });
    const [flightOp, hotelOp] = space.applied[0].ops;
    expect(flightOp.put).toMatchObject({ type: 'flight', review: true, src: { kind: 'ai' } });
    expect(hotelOp.put).toMatchObject({ type: 'lodging', title: 'Hotel Sol Lisboa', stay: { checkInFrom: '15:00' } });
    expect(uploads).toEqual([{ name: 'voucher.pdf', links: [{ t: 'res', id: flightOp.id }] }]);
    expect(getJob(SPACE)).toBeNull();
  });

  it('updates a matching booking instead of creating one when asked', async () => {
    const fake = fakeAiPuter({ replies: [{ bookings: [{ ...flightReply.bookings[0], legs: [{ ...flightReply.bookings[0].legs[0], seat: '23A' }] }] }] });
    const existing = { id: 'r000000000000001', v: V1, type: 'flight', title: 'Old', status: 'confirmed', code: 'X7K2LM', legs: [{ from: { code: 'LIS' }, to: { code: 'JFK' }, dep: { date: '2026-05-03', time: '11:00' }, arr: { date: '2026-05-03' }, number: 'TP209' }] };
    await startJob({ spaceId: SPACE, puter: fake.puter, inputs: [{ type: 'paste', label: 'x', text: 'y' }], context: { reservations: () => [existing] } });
    const [candidate] = getJob(SPACE).candidates;
    expect(candidate.action).toBe('skip');
    setAction(SPACE, candidate.id, 'update', { reservations: [existing] });
    const space = stubSpace([existing]);
    const result = await commitJob({ space, spaceId: SPACE });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const [op] = space.applied[0].ops;
    expect(op).toMatchObject({ t: 'res', id: existing.id, base: expect.any(String) });
    expect(op.set['legs']).toEqual([expect.objectContaining({ seat: '23A', number: 'TP209' })]);
    expect(op.set.review).toBe(true);
  });

  it('merges two candidates into one with both legs', async () => {
    const leg = (from, to, time) => ({ type: 'flight', title: 'x', legs: [{ from: { code: from }, to: { code: to }, dep: { date: '2026-05-03', time } }] });
    const fake = fakeAiPuter({ replies: [{ bookings: [leg('JFK', 'LIS', '18:00'), leg('LIS', 'JFK', '08:00')] }] });
    await startJob({ spaceId: SPACE, puter: fake.puter, inputs: [{ type: 'paste', label: 'x', text: 'y' }], context: {} });
    const ids = getJob(SPACE).candidates.map((candidate) => candidate.id);
    mergeCandidates(SPACE, ids);
    const { candidates } = getJob(SPACE);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].draft.legs.map((item) => item.from.code)).toEqual(['LIS', 'JFK']);
    expect(candidates[0].action).toBe('create');
  });

  it('restores a saved job and marks unfinished inputs as interrupted', async () => {
    const db = memoryDb();
    db.map.set(`import:${SPACE}`, { v: 1, id: 'j', spaceId: SPACE, status: 'running', sources: [{ id: 's1', state: 'done' }, { id: 's2', state: 'reading' }], candidates: [{ id: 'c', draft: {} }], error: null });
    const job = await restoreJob({ db, spaceId: SPACE });
    expect(job.status).toBe('review');
    expect(job.sources.map((source) => source.state)).toEqual(['done', 'interrupted']);
  });
});

describe('inputs', () => {
  it('reads EML locally and sends text plus PDF attachments only', async () => {
    const pdf = Buffer.from('%PDF-1.4').toString('base64');
    const eml = ['Subject: Your stay', 'From: Hotel <h@example.com>', 'Content-Type: multipart/mixed; boundary=x', '', '--x', 'Content-Type: text/html', '', '<p>Hotel <b>Sol</b></p>',
      '--x', 'Content-Type: application/pdf; name=v.pdf', 'Content-Transfer-Encoding: base64', '', pdf, '--x', 'Content-Type: image/png; name=logo.png', 'Content-Disposition: inline', 'Content-ID: <logo>', '', 'xx', '--x--'].join('\r\n');
    const result = await readInput({ type: 'file', file: new File([eml], 'stay.eml') });
    expect(result.text).toBe('Subject: Your stay\nFrom: Hotel <h@example.com>\n\nHotel Sol');
    expect(result.files.map((file) => [file.name, file.kind, file.blob.type])).toEqual([['v.pdf', 'pdf', 'application/pdf'], ['logo.png', 'image', 'image/png']]);
    expect(result.attach.map((file) => file.name)).toEqual(['v.pdf']);
    await expect(readInput({ type: 'file', file: new File(['x'], 'a.docx') })).rejects.toMatchObject({ code: 'type' });
    await expect(readInput({ type: 'paste', text: '   ' })).rejects.toMatchObject({ code: 'empty' });
  });

  it('reads Puter mail after asking for access', async () => {
    const fake = fakeAiPuter({ mail: [{ id: 'm1', subject: 'Train ticket', date: '2026-04-01T10:00:00Z', from: { name: 'CP', address: 'cp@example.com' }, text: 'Lisboa 08:00 → Porto 11:00', html: null, attachments: [] }] });
    expect(await requestMailAccess(fake.puter)).toBe(true);
    expect(fake.permissions[0]).toEqual(['fs', { path: '~/.mail', access: 'read' }]);
    const page = await listMail(fake.puter);
    expect(page.items).toEqual([{ id: 'm1', subject: 'Train ticket', date: '2026-04-01T10:00:00Z', size: 100 }]);
    const message = await readMail(fake.puter, 'm1');
    const result = await readInput({ type: 'mail', message });
    expect(result.text).toContain('From: CP cp@example.com');
    expect(result.text).toContain('Lisboa 08:00 → Porto 11:00');
    await expect(readMail(fake.puter, 'missing')).rejects.toMatchObject({ code: 'mail_missing' });
  });
});
