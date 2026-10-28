import { it, expect, vi, beforeEach } from 'vitest';

let failure = null;
const forgotten = [];
vi.mock('../src/collab/api.js', async (importOriginal) => ({ ...await importOriginal(), call: async () => { throw failure; } }));
vi.mock('../src/collab/room-memory.js', async (importOriginal) => ({ ...await importOriginal(), rememberRoom: async (path, link) => { forgotten.push([path, link]); } }));
const { reconnect } = await import('../src/collab/live.js');

const saved = { server: 'https://documents-abc.puter.work', room: 'room1' };
const user = { id: 'u0', name: 'Ada' };
beforeEach(() => { forgotten.length = 0; });

it('forgets a room whose sharing was stopped, and opens the document as the owner\'s own', async () => {
  for (const status of [404, 410]) {
    failure = Object.assign(new Error('This shared document is no longer available.'), { status });
    expect(await reconnect('Documents/Plan.docx', user, saved)).toBeNull();
  }
  expect(forgotten).toEqual([['Documents/Plan.docx', null], ['Documents/Plan.docx', null]]);
});

it('says so when the room cannot be reached just now, and keeps it', async () => {
  for (const status of [0, 500, 503]) {
    failure = Object.assign(new Error('Failed to fetch'), { status });
    await expect(reconnect('Documents/Plan.docx', user, saved)).rejects.toThrow('Failed to fetch');
  }
  expect(forgotten).toEqual([]);
});
