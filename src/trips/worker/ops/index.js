// Worker op registry.
//
// Type hooks, keyed `<kind>/<type>`: `{ reads?(op) → [{t, id}], check({op, before, after, uid, role, perms, kind, space, get}) }`.
// They run after the shared schema rules and throw `DomainError` to reject. `get` sees only the commit's batched read:
// the op's own entities, other ops' entities in the commit and what `reads` lists (from the raw, unvalidated op).
//
// Domain ops, keyed by name (also listed in `DOMAIN_OPS` in src/shared/protocol.js), see `ops/test/touch.js`:
// `{ kinds, validate(args), reads(args) → [{t, id}], plan({args, uid, role, perms, kind, now, can, get}) → [{t, id, put|set|unset|del}] }`.
// `plan` authorizes itself; the engine validates each write, stamps it and records one change.
//
// Handlers, keyed by op name (also listed in `OPS` in src/shared/protocol.js): `(w, ident, input) → result | Response`
// for top-level `/api` ops beyond the engine's own.
// Guards: `(s, action)` run before space writes (`commit`, `files`, `invite`, `join`, `members`) and throw to refuse them.
import msgHook from './trip/msg.js';
import noteHook from './trip/note.js';
import linkHook from './trip/link.js';
import pollHook from './trip/poll.js';
import expHook from './trip/exp.js';
import settleAll from './trip/settle.js';
import res from './trip/res.js';
import tripFile from './trip/file.js';
import tripPlace from './trip/place.js';
import tripCat from './trip/cat.js';
import pack from './trip/pack.js';
import bag from './trip/bag.js';
import todo from './trip/todo.js';
import listMeta from './trip/listMeta.js';
import tripVisit from './trip/visit.js';
import dayRemove from './trip/domain/dayRemove.js';
import visitMove from './trip/domain/visitMove.js';
import collectionMeta from './collection/meta.js';
import collectionSaved from './collection/saved.js';
import collectionLabel from './collection/label.js';
import resMoveToTrip from './trip/domain/res.moveToTrip.js';
import tripMeta from './trip/meta.js';
import tripRedate from './trip/domain/redate.js';
import journeyMeta from './journey/meta.js';
import journeyEntry from './journey/entry.js';
import journeyFile from './journey/file.js';
import * as road from './trip/road.js';
import { transferGuard, transferOps } from './trip/transfer.js';
import { transferImportOps } from './trip/transfer-import.js';
import journeyBook from './journey/book.js';
import journeyBookPage from './journey/bookPage.js';
import collectionFile from './collection/file.js';

export const typeHooks = Object.freeze({
  'trip/exp': expHook,
  'trip/msg': msgHook,
  'trip/note': noteHook,
  'trip/link': linkHook,
  'trip/poll': pollHook,
  'trip/res': res,
  'trip/file': tripFile,
  'trip/place': tripPlace,
  'trip/cat': tripCat,
  'trip/pack': pack,
  'trip/bag': bag,
  'trip/todo': todo,
  'trip/listMeta': listMeta,
  'trip/visit': tripVisit,
  'collection/meta': collectionMeta,
  'collection/saved': collectionSaved,
  'collection/label': collectionLabel,
  'trip/meta': tripMeta,
  'journey/meta': journeyMeta,
  'journey/entry': journeyEntry,
  'journey/file': journeyFile,
  'trip/rtPrefs': road.rtPrefs, 'trip/dayEnd': road.dayEnd, 'trip/via': road.via,
  'journey/book': journeyBook, 'journey/bookPage': journeyBookPage,
  'collection/file': collectionFile,
});

export const domainOps = Object.freeze({
  'costs.settleAll': settleAll,
  'day.remove': dayRemove,
  'visit.move': visitMove,
  'res.moveToTrip': resMoveToTrip,
  'trip.redate': tripRedate,
});

export const handlers = Object.freeze({
  ...transferOps,
  ...transferImportOps,
});

export const guards = Object.freeze([
  transferGuard,
]);
