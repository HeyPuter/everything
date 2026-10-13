// Simulated people on a shared document for multi-client tests: sharing,
// joining, editing through the shared history and settling all clients.
import * as Y from 'yjs';
import { findLayer, layer, newDocument, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { readRGBA, writeRect } from '../src/model/tiles';
import { Assets } from '../src/model/assets';
import { MemoryStore } from '../src/persistence/local-store';
import { RoomClient, type OutboxStores } from '../src/collab/client';
import { call } from '../src/collab/api';
import { openBinding, type SharedBinding } from '../src/collab/shared-history';
import { TileIndex } from '../src/collab/tile-index';
import { environment, owner, until, wait, type User } from './collab-helpers';

export const SERVER = 'https://photo-test.puter.work';
export type Env = ReturnType<typeof environment>;
export type Person = { user: User; client: RoomClient; binding: SharedBinding; assets: Assets; store: MemoryStore<OutboxStores> };
const open: RoomClient[] = [];
/** Close every client opened by `connect` (call after each test). */
export function closeAll() {
  for (const c of open.splice(0)) c.close();
}

export function painted(assets: Assets) {
  const doc = newDocument(600, 400, 'Shared');
  const bg = newPixelLayer('Background', doc);
  const data = new Uint8ClampedArray(300 * 300 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 100, 50, 255], i);
  bg.pixels = writeRect(assets.tiles, bg.pixels!, 0, 0, { width: 300, height: 300, data });
  const top = newPixelLayer('Top', doc);
  doc.layers = [bg, top, layer('solid', 'Fill', 600, 400)];
  return doc;
}
export async function connect(env: Env, user: User, room: string, opts: { token?: string; ydoc?: Y.Doc; assets?: Assets; store?: MemoryStore<OutboxStores>; peers?: boolean; poll?: number } = {}): Promise<Person> {
  const assets = opts.assets ?? new Assets();
  const store = opts.store ?? new MemoryStore<OutboxStores>();
  const client = new RoomClient({ puter: env.sdk(user), server: SERVER, room, token: opts.token, tiles: new TileIndex(assets.tiles), assets, store, ydoc: opts.ydoc, poll: opts.poll ?? 40, noPeers: !opts.peers });
  open.push(client);
  await client.join();
  const binding = await openBinding(client, assets);
  return { user, client, binding, assets, store };
}
export async function share(env: Env, opts: { peers?: boolean; doc?: (assets: Assets) => PhotoDocument } = {}) {
  const assets = new Assets();
  const doc = (opts.doc ?? painted)(assets);
  const ydoc = new Y.Doc();
  const sdk = env.sdk(owner);
  const room = await RoomClient.create({ puter: sdk, server: SERVER, tiles: new TileIndex(assets.tiles), assets, doc, comments: [], ydoc });
  const a = await connect(env, owner, room, { ydoc, assets, peers: opts.peers });
  return { room, a, doc };
}
export async function invite(env: Env, room: string, role: string, review = false) {
  return (await call<{ token: string }>(env.sdk(owner), SERVER, { op: 'invite', room, role, review })).token;
}
export function edit(p: Person, label: string, fn: (d: PhotoDocument) => void) {
  p.binding.history.execute(label, fn);
}
export function paintOn(p: Person, id: string, x: number, y: number, w: number, h: number, value: number) {
  edit(p, 'Brush', (d) => {
    const l = findLayer(d.layers, id)!;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([value, value, value, 255], i);
    l.pixels = writeRect(p.assets.tiles, l.pixels!, x, y, { width: w, height: h, data });
  });
}
export const pixel = (p: Person, id: string, x: number, y: number) => {
  const l = findLayer(p.binding.history.document.layers, id)!;
  return readRGBA(p.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[0];
};
export async function settle(...ps: Person[]) {
  for (const p of ps) {
    await p.binding.idle();
    await p.client.settled();
  }
  for (const p of ps) await p.client.sync();
  await wait(5);
  for (const p of ps) {
    p.binding.project(true);
    await until(async () => {
      await p.binding.idle();
      return p.client.project.missing(p.assets).tiles.size === 0;
    }, 3000, 'tiles');
    p.binding.project(true);
  }
}
export const idOf = (p: Person, name: string) => p.binding.history.document.layers.find((l) => l.name === name)!.id;
