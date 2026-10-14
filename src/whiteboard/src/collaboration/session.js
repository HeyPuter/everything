import {
  readView,
  validCamera,
  validSession,
  validSlide,
} from "./attention.js";
import { decodeUpdate, mergeUpdates } from "yjs";
import { SharedDocument, LOCAL, REPAIR, rebase } from "./document.js";
import { PeerNetwork } from "./peers.js";
import {
  LIVE_REACTIONS,
  Pace,
  RECEIVE_LIMIT,
  SEND_LIMIT,
  readLower,
  readReaction,
} from "./live.js";
import { presenceInterval } from "./presence.js";
import {
  ASSET,
  canComment,
  canEditContent,
  canManage,
  encode,
  decode,
  hash,
  keyPair,
  verify,
} from "./protocol.js";
import { call } from "./api.js";
import { local } from "../storage.js";
import { sharedCopy } from "../model.js";
import { namedChanges, workshopSettings } from "../facilitation/model.js";
// Encoded update characters the worker accepts in one commit, and a batch
// size below it so merged edits always fit.
const UPDATE_LIMIT = 8_000_000,
  BATCH_SIZE = 6_000_000;
// Others keep showing a finished move, drawing or text until its edit
// arrives: for six seconds, or while its author still says the edit is being
// saved and a few seconds after, never more than twenty.
const SETTLE = 6000,
  SETTLE_GRACE = 4000,
  SETTLE_CAP = 20_000;
// State the worker accepted can hold more objects, tags or workshop
// registers, or longer texts, than one commit may add, after simultaneous
// commits together crossed a limit. It still opens and synchronizes.
const ANY = { get: () => Infinity };
// The worker's refusal of a check-in past the board's participant limit.
const roomFull = (error) =>
  error?.status === 429 &&
  error.message === "This board has reached its participant limit.";
const ACCEPTED = {
  items: Infinity,
  tags: Infinity,
  workshop: Infinity,
  text: ANY,
  cells: ANY,
};

// Queued edits are stored by content hash, so the browser returns them in
// no useful order. Each carries the order it was made in, because the worker
// refuses a batch that builds on edits it has not received yet.
let lastSequence = 0;
const sequence = () => (lastSequence = Math.max(Date.now(), lastSequence + 1));
function queued(rows) {
  const updates = rows.filter((row) => row.kind === "update");
  // Rows saved before sequence numbers follow their Yjs clock instead.
  const clock = (row) => {
    try {
      return decodeUpdate(decode(row.update)).structs[0]?.id.clock ?? Infinity;
    } catch {
      return Infinity;
    }
  };
  const keyed = updates.map((row) => [row.seq ?? 0, clock(row), row]);
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return [
    ...rows.filter((row) => row.kind !== "update"),
    ...keyed.map((entry) => entry[2]),
  ];
}

// The editor changes nested values of the boards it is given, so the
// session's document copies each object it keeps whole.
function sessionDocument(update) {
  const doc = new SharedDocument(update, { merge: true });
  doc.cacheItems({ deep: true });
  doc.watchArrivals();
  return doc;
}

export class CollaborationSession {
  constructor({
    puter,
    server,
    room,
    user,
    changed,
    activity,
    status,
    viewChanged = () => {},
    attention = () => {},
    reaction = () => {},
    handLowered = () => {},
    rejected = () => {},
    ready = () => {},
    store = local,
  }) {
    Object.assign(this, {
      puter,
      server,
      room,
      user,
      changed,
      activity,
      status,
      viewChanged,
      attention,
      reaction,
      handLowered,
      rejected,
      ready,
      store,
    });
    // What this session last showed, for a save with nothing to upload.
    this.status = (text) => {
      this.shown = text;
      status(text);
    };
    this.scope = `${server}|${room}|${user.uuid}`;
    this.session = crypto.randomUUID();
    this.shared = sessionDocument();
    this.assets = new Map();
    this.assetDownloads = new Map();
    this.assetIds = new Map();
    this.pendingAssets = new Set();
    this.pending = new Map();
    this.people = new Map();
    this.views = new Map();
    this.attentionSequence = new Map();
    this.endedViews = new Set();
    this.lastAction = new Map();
    this.reactionsSent = new Pace(SEND_LIMIT);
    this.reactionsTaken = new Pace(RECEIVE_LIMIT);
    // This person's raised hand, as the time it went up, or null; and when
    // facilitators last lowered each session's hand, or everyone's.
    this.hand = null;
    this.lowered = new Map();
    this.loweredSequence = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.readOnly = true;
    // readOnly already blocks content until a role is known.
    this.contentReadOnly = false;
    this.localWrites = 0;
  }
  // readOnly blocks every write. Commenters may still write comments, so the
  // editor separately checks contentReadOnly before changing board content.
  // An archived board is read-only for everyone but administrators, whatever
  // their role on it.
  applyRole(role, archived = false) {
    const wasReadOnly = this.readOnly;
    this.role = role;
    this.archived = archived;
    this.denied = false;
    // A board holding what only a newer app writes stays read-only here,
    // whatever the role, until this copy can read it again.
    this.readOnly = this.incompatible || archived || !canComment(role);
    this.contentReadOnly =
      this.incompatible || archived || !canEditContent(role);
    // Uploads stop while read-only; send what waited once access returns.
    if (wasReadOnly && !this.readOnly && this.poll && this.pending.size)
      this.scheduleFlush();
    // Edits queued before access was lowered cannot be sent now. Rather
    // than "Saving…" for ever, the status says they wait on this device,
    // where they go out again should access return.
    if (!wasReadOnly && this.readOnly && this.pending.size && !this.closed)
      this.status("Access changed · unsent changes stay on this device");
  }
  // What this person may do on the board as last granted, "edit",
  // "comment" or "view", for the editor to show and to tell when it
  // changes. Unknown until a role is, and while access is refused, which
  // the status says instead.
  get access() {
    if (!this.role || this.denied || this.incompatible) return "";
    return this.archived || !canComment(this.role)
      ? "view"
      : canEditContent(this.role)
        ? "edit"
        : "comment";
  }
  async connectPeers() {
    if (!this.puter.peer?.serve || this.peers || this.closed) return;
    const peers = (this.peers = new PeerNetwork({
      puter: this.puter,
      room: this.room,
      session: this.session,
      keys: this.keys,
      roomKey: this.publicKey,
      receive: (...args) => this.receive(...args),
      // A member left without links checks in, so board events bring the
      // room's edits instead, and catches up on those it missed meanwhile.
      changed: (stranded) =>
        this.heartbeat()
          .then(() => stranded && this.synchronize())
          .catch(() => {}),
      relinked: () => this.synchronize().catch((e) => this.failure(e)),
      now: () => this.now(),
      bounds: (id) => this.shared.items.get(id)?.get?.("geometry"),
      related: (id, out, n) => this.shared.related(id, out, n),
    }));
    await peers.serve().catch(() => {});
    if (this.closed || this.peers !== peers) return void peers.close();
    // Built again after a check-in, as under a new session ID: others can
    // dial it once a check-in publishes its invite, which then comes now.
    if (this.lastBeat && peers.server?.inviteCode)
      this.heartbeat().catch((e) => this.failure(e));
  }
  async request(op, data = {}) {
    const started = performance.now();
    const result = await call(this.puter, this.server, {
      op,
      room: this.room,
      ...data,
    });
    const received = performance.now(),
      elapsed = received - started;
    // The quickest round trip gives the best estimate of the server's clock:
    // a slow one, such as a sync that loads the board and sends it back,
    // can put it seconds out, and the shared timer with it. A sample a few
    // minutes old gives way so the estimate follows drift, and so does one
    // this reply shows to be further out than its own uncertainty, as after
    // the device slept, when the monotonic clock may not have advanced.
    const estimate = result.serverTime + elapsed / 2;
    if (
      Number.isSafeInteger(result.serverTime) &&
      result.serverTime > 0 &&
      elapsed < 10000 &&
      (!this.clock ||
        elapsed <= this.clock.elapsed ||
        received - this.clock.monotonic > 300_000 ||
        Math.abs(estimate - this.now()) > elapsed / 2 + 1000)
    )
      this.clock = { server: estimate, monotonic: received, elapsed };
    return result;
  }
  now() {
    return this.clock
      ? this.clock.server + performance.now() - this.clock.monotonic
      : Date.now();
  }
  async start(token) {
    try {
      return await this.connect(token);
    } catch (error) {
      // Before the outbox listener and timers exist, a partial start must not
      // leave subscriptions or peer links that can make the session writable.
      // Later failures (the initial upload) recover through the running timers.
      if (!this.poll) this.close();
      throw error;
    }
  }
  async connect(token) {
    if (this.closed) return;
    const joined = await this.request("join", { token });
    if (this.closed) return;
    this.applyRole(joined.member.role, joined.archived);
    this.eventDescriptor = joined.events;
    this.settings = joined.settings || null;
    // What the board's organization allows here, kept current by check-ins.
    this.features = joined.features || null;
    // What the board's own organization lets it be shared with.
    this.sharing = joined.sharing || null;
    this.guest = !!joined.member.guest;
    this.publicKey = joined.publicKey;
    const rows = await this.store.collaborationRows(this.scope);
    if (this.closed) return;
    for (const row of queued(rows)) {
      if (row.kind === "asset") {
        this.assets.set(row.asset, row.data);
        this.assetIds.set(row.data, row.asset);
        if (row.pending) this.pendingAssets.add(row.asset);
      }
      if (row.kind === "snapshot")
        this.shared.apply(decode(row.update), "load");
      if (row.kind === "update") {
        this.shared.apply(decode(row.update), "load");
        this.pending.set(row.digest, row);
      }
    }
    this.keys = await keyPair();
    if (this.closed) return;
    await this.connectPeers();
    if (this.closed) return;
    await this.subscribe();
    if (this.closed) return;
    // From here every edit is recorded on this device and uploaded, so the
    // editor can take edits now rather than after the check-in and the
    // upload of what waited, which take a few more round trips. A stroke
    // drawn meanwhile was discarded without a word before. Recording starts
    // before the first synchronization, which may upload what waited.
    this.track();
    await this.synchronize();
    if (this.closed) return;
    this.ready();
    if (this.closed) return;
    // Large rooms check in less often so the board's worker stays within its
    // storage request quota; peers still carry live edits between check-ins.
    // Presence expires after SESSION_TTL, only two check-ins apart in a large
    // room, so a check-in that fails is tried again soon until one succeeds.
    const refused = (e) =>
      e?.status >= 400 &&
      e.status < 500 &&
      e.status !== 429 &&
      e.status !== 408;
    // A full board stays full for a while: its check-in is tried again
    // about once a minute, not every ten seconds by everyone turned away.
    const retry = (e) => {
      this.failure(e);
      if (this.closed || refused(e) || this.checkInTimer) return;
      this.checkInTimer = setTimeout(
        () => {
          this.checkInTimer = null;
          if (!this.closed) checkIn();
        },
        roomFull(e)
          ? 60_000 + Math.random() * 30_000
          : 8000 + Math.random() * 4000,
      );
    };
    const checkIn = () => this.heartbeat().catch(retry);
    // The board is loaded and synchronized by now; a first check-in turned
    // away only for now, as when the worker is busy, is tried again like any
    // other rather than starting the whole join over. Refused access ends it.
    await this.heartbeat().catch((e) => {
      if (refused(e)) throw e;
      retry(e);
    });
    if (this.closed) return;
    const beat = () => {
      this.poll = setTimeout(
        () => {
          if (this.closed) return;
          checkIn();
          this.synchronize().catch((e) => this.failure(e));
          this.flush().catch((e) => this.failure(e));
          beat();
        },
        ((this.roster?.length || 0) > 30 ? 40000 : 20000) +
          Math.random() * 5000,
      );
    };
    beat();
    // Others forget a view 12 seconds after it last arrived, so an idle
    // one is renewed well before that.
    this.viewPulse = setInterval(() => this.renewView(), 1000);
    // Others forget a participant's selection 10 seconds after their last
    // update, and an object's live position during a drag after 2.5
    // seconds; repeat them while someone keeps an object selected or open,
    // or holds it still mid-drag, and, less often, while their pointer
    // rests on the board, which others keep for 15 seconds, so a still
    // cursor stays though one repeat is lost.
    this.presencePulse = setInterval(() => this.pulsePresence(), 1000);
    this.expire = setInterval(() => {
      let viewsChanged = false;
      for (const [id, v] of this.views)
        if (Date.now() - v.received > 12000) {
          this.views.delete(id);
          viewsChanged = true;
        }
      if (viewsChanged) this.viewChanged(this.views, this.roster || []);
      // A pointer at rest is repeated only every 6 seconds, on a channel
      // that may lose a packet, so presence showing nothing else is kept
      // long enough for the repeat after a lost one.
      for (const [id, p] of this.people) {
        const resting =
          p.cursor &&
          !p.selection.length &&
          !p.editing &&
          !p.preview.length &&
          !p.settling;
        if (Date.now() - p.at > (resting ? 15000 : 10000))
          this.people.delete(id);
      }
      this.activity(this.people, this.roster || []);
    }, 2000);
    this.online = () => {
      this.heartbeat().catch((e) => this.failure(e));
      this.synchronize().catch((e) => this.failure(e));
      this.flush().catch((e) => this.failure(e));
    };
    // Losing the network is said at once, not at the next check-in, which
    // can be most of a minute away in a large room.
    this.offline = () => this.failure(Error("The browser is offline."));
    // Hiding the tab sends any edits still waiting, which costs nothing
    // when there are none. Coming back catches up only if the last
    // check-in is a while ago, so switching tabs in a large room does not
    // add a check-in and a synchronization each time.
    this.visibility = () => {
      if (globalThis.document?.visibilityState === "hidden")
        this.flush().catch((e) => this.failure(e));
      else if (Date.now() - (this.lastBeat || 0) >= 10000) this.online();
    };
    globalThis.addEventListener?.("online", this.online);
    globalThis.addEventListener?.("offline", this.offline);
    globalThis.document?.addEventListener("visibilitychange", this.visibility);
    // Joined, synchronized and checking in: live features work even if
    // uploading edits queued offline fails now and is retried later.
    this.connected = true;
    await this.flush();
    if (this.closed) return;
    return joined;
  }
  // Record this browser's document changes in the outbox before uploading.
  track() {
    const shared = this.shared;
    if (shared.tracked) return;
    shared.tracked = true;
    shared.doc.on("update", (update, origin) => {
      if (origin !== LOCAL && origin !== REPAIR && origin !== shared.undo)
        return;
      this.localWrites++;
      this.written = (this.written || 0) + 1;
      this.status("Saving shared changes…");
      this.queue = this.queue
        .then(async () => {
          // Rejection recovery replaced this document and discarded its edits.
          if (this.shared !== shared) return;
          const digest = await hash(update),
            value = encode(update);
          const row = {
            id: `${this.scope}|op:${digest}`,
            scope: this.scope,
            kind: "update",
            digest,
            update: value,
            seq: sequence(),
          };
          this.pending.set(digest, row);
          // Rows are replayed over the snapshot on reload, so the full
          // snapshot is rewritten after uploads rather than per keystroke.
          await this.store.collaborationPut(row);
          this.recoveryFailed = false;
        })
        .catch(() => {
          this.recoveryFailed = true;
          this.status("Local recovery failed. Keep this tab open.");
        })
        .finally(() => {
          this.localWrites--;
        });
      this.scheduleFlush();
    });
  }
  async subscribe() {
    if (
      this.closed ||
      this.subscription ||
      !this.eventDescriptor ||
      !this.puter.events?.onLocal ||
      // Large rooms relay live changes over peers; clients without a peer
      // network, or whose links have not connected, still need events.
      this.relayed()
    )
      return;
    if (this.subscribing) return this.subscribing;
    const d = this.eventDescriptor;
    const subject = d.handle
      ? `kv:${d.handle}:${d.key}`
      : `kv:${d.app}:${d.key}`;
    this.subscribing = (async () => {
      let sub,
        failed = false;
      try {
        sub = await this.puter.events.onLocal(
          subject,
          (payload) => {
            if (this.closed || failed || (sub && this.subscription !== sub))
              return;
            const ids = payload?.event?.value?.ids;
            this.notice(payload?.event?.ts, ids);
            // A signal naming no save is someone joining or leaving.
            if (!Array.isArray(ids) || !ids.length) this.eventPeople = true;
            // A burst of events is handled once, shortly after it starts;
            // restarting the wait would postpone it while events continue.
            if (this.eventTimer) return;
            this.eventTimer = setTimeout(() => {
              this.eventTimer = null;
              // Saves whose edits already arrived, this person's own or
              // over a peer link, need no read of the board, and only
              // people joining or leaving need a check-in.
              if (this.told || this.toldIds?.size)
                this.synchronize().catch((e) => this.failure(e));
              if (this.eventPeople) {
                this.eventPeople = false;
                this.eventCheckIn();
              }
            }, 150);
          },
          {
            // The signal names the records saved; see notice().
            includeValue: true,
            onError: () => {
              if (failed) return;
              failed = true;
              // An old listener's delayed error must not stop a replacement.
              if (this.subscription === sub) this.subscription = null;
              sub?.off();
            },
          },
        );
        // The SDK may report failure before its registration promise settles.
        if (this.closed || failed) sub.off();
        else this.subscription = sub;
      } catch {
        if (!this.closed) this.status("Connected · periodic sync");
      }
    })().finally(() => {
      this.subscribing = null;
    });
    return this.subscribing;
  }
  // Board events signal both edits and people joining or leaving. Checking
  // in on each would cost every participant a presence write per edit, so
  // it happens at most every five seconds, with one more after a burst.
  eventCheckIn() {
    if (this.closed || this.eventBeatTimer) return;
    const wait = (this.lastBeat || 0) + 5000 - Date.now();
    if (wait <= 0) return void this.heartbeat().catch((e) => this.failure(e));
    this.eventBeatTimer = setTimeout(() => {
      this.eventBeatTimer = null;
      if (!this.closed) this.heartbeat().catch((e) => this.failure(e));
    }, wait);
  }
  async heartbeat() {
    if (this.closed) return;
    // Peers connect with the invite code a check-in publishes. One renewed
    // while a check-in is running is published right after it, not at the
    // next poll.
    if (this.beating) return void (this.beatAgain = true);
    this.beating = true;
    this.beatAgain = false;
    this.lastBeat = Date.now();
    let invite = this.peers?.server?.inviteCode;
    try {
      const checkIn = () =>
        this.request("presence", {
          session: this.session,
          publicKey: this.keys.publicKey,
          invite,
          // Lasting peer groups; see topology in protocol.js.
          topology: 2,
        });
      const result = await checkIn().catch((error) => {
        // Another participant took this session's ID after it lapsed, as
        // while the tab slept. Continue under a new session instead.
        if (error?.status !== 409 || this.closed) throw error;
        this.session = crypto.randomUUID();
        this.peers?.close();
        this.peers = null;
        invite = undefined;
        return checkIn();
      });
      if (this.closed) return;
      this.full = false;
      this.applyRole(result.role, result.archived);
      if (result.features) this.features = result.features;
      // Peer links closed when access was refused come back with it.
      if (!this.peers) this.connectPeers().catch(() => {});
      this.roster = result.roster;
      this.peers?.update(result.ticket, result.signature, result.roster);
      if (this.relayed()) {
        this.subscription?.off();
        this.subscription = null;
      }
      for (const id of this.people.keys())
        if (!this.roster.some((p) => p.session === id)) this.people.delete(id);
      for (const id of this.views.keys())
        if (!this.roster.some((p) => p.session === id)) this.views.delete(id);
      this.viewChanged(this.views, this.roster);
      this.activity(this.people, this.roster);
      if (
        !this.eventDescriptor &&
        !this.relayed() &&
        (!this.eventProbe || Date.now() - this.eventProbe > 60000)
      ) {
        this.eventProbe = Date.now();
        this.eventDescriptor = (await this.request("events")).events;
      }
      await this.subscribe();
    } finally {
      this.beating = false;
      // A delayed presence write can finish after close() removed the session.
      if (this.closed)
        await this.request("leave", { session: this.session }).catch(() => {});
      else if (
        this.beatAgain &&
        this.peers?.server?.inviteCode &&
        this.peers.server.inviteCode !== invite
      )
        this.heartbeat().catch((e) => this.failure(e));
      this.beatAgain = false;
    }
  }
  // The copy kept on this device lets a reload show the board without a
  // connection; the board's server holds everything saved. Failing to write
  // it, as when the device's storage is full, must not hold back saving
  // edits or showing others', so callers that go on regardless use this.
  async keepCopy() {
    try {
      await this.cache();
      return true;
    } catch {
      return false;
    }
  }
  async cache() {
    await this.store.collaborationPut({
      id: `${this.scope}|snapshot`,
      scope: this.scope,
      kind: "snapshot",
      update: encode(this.shared.update()),
    });
    await this.forgetAssets();
  }
  // Images and files no longer on the board, such as replaced or deleted
  // ones and those of earlier versions looked at, are not stored on this
  // device; the board's server still has them. Uploads still waiting stay.
  // This session keeps them in memory, so undoing a deletion shows the image
  // again even without a connection.
  async forgetAssets() {
    if (!this.assets.size) return;
    this.unstored ??= new Set();
    const used = new Set();
    for (const entry of this.shared.items.values()) {
      if (!entry?.get) continue;
      for (const value of [
        entry.get("geometry")?.src,
        entry.get("src"),
        entry.get("data"),
      ]) {
        const m = typeof value === "string" && ASSET.exec(value);
        if (m) used.add(m[1]);
      }
    }
    for (const [asset, data] of [...this.assets])
      if (used.has(asset)) {
        // Back on the board, as after an undo: stored again.
        if (this.unstored.delete(asset))
          await this.store.collaborationPut({
            id: `${this.scope}|asset:${asset}`,
            scope: this.scope,
            kind: "asset",
            asset,
            data,
            pending: false,
          });
      } else if (!this.pendingAssets.has(asset) && !this.unstored.has(asset)) {
        this.unstored.add(asset);
        await this.store.collaborationDelete(`${this.scope}|asset:${asset}`);
      }
  }
  async prepare(board) {
    const copy = sharedCopy(board);
    for (const i of copy.items)
      for (const key of ["src", "data"]) {
        if (!i[key] || ASSET.test(i[key])) continue;
        let asset = this.assetIds.get(i[key]);
        if (!asset) {
          asset = await hash(i[key]);
          this.assets.set(asset, i[key]);
          this.assetIds.set(i[key], asset);
          this.pendingAssets.add(asset);
          // The bytes are held in memory until uploaded. Kept on the device
          // too, they survive a reload; a device that cannot keep them, as
          // when its storage is full, still saves the edit while this tab
          // stays open, as with edits it cannot keep (see track).
          try {
            await this.store.collaborationPut({
              id: `${this.scope}|asset:${asset}`,
              scope: this.scope,
              kind: "asset",
              asset,
              data: i[key],
              pending: true,
            });
          } catch {
            this.recoveryFailed = true;
            this.status("Local recovery failed. Keep this tab open.");
          }
        }
        i[key] = "asset:" + asset;
      }
    return copy;
  }
  // Images and files are uploaded a few at a time, as they are downloaded,
  // so a deck of pictures added at once does not wait on each in turn.
  async uploadAssets() {
    // Files added while others upload, as a second picture while the first
    // goes up, are taken in the same pass: the edit adding them may already
    // be on its way.
    const taken = new Set();
    const pick = () => {
      for (const asset of this.pendingAssets)
        if (!taken.has(asset)) {
          taken.add(asset);
          return asset;
        }
    };
    let failed = null;
    const next = async () => {
      for (let asset; !failed && !this.closed && (asset = pick());)
        await this.uploadAsset(asset).catch((error) => {
          failed ??= error;
        });
    };
    await Promise.all(Array.from({ length: 4 }, next));
    if (failed?.status === 429)
      // A person may add only so many files to a board a minute. Nothing is
      // wrong with the connection; the rest go up when the worker allows.
      failed.uploadsWait = true;
    if (failed) throw failed;
  }
  async uploadAsset(asset) {
    try {
      await this.request("asset.put", {
        asset,
        data: this.assets.get(asset),
      });
    } catch (error) {
      // A file the worker refuses for what it is, such as one too large,
      // would be refused on every retry and hold back every later edit.
      // It is given up: the worker then refuses the edit that added it,
      // which is recovered from like any other refused edit.
      if (![400, 413, 422].includes(error.status)) throw error;
      // Said when the edit adding it is refused, rather than a conflict.
      this.refusedFile =
        error.status === 413 && /limit/.test(error.message)
          ? error.message
          : "An image or file could not be saved to the shared board.";
      this.pendingAssets.delete(asset);
      await this.store.collaborationDelete(`${this.scope}|asset:${asset}`);
      return;
    }
    // Uploaded, the file is safe whether or not this device can record
    // that; a row left pending is only uploaded again after a reload.
    await this.store
      .collaborationPut({
        id: `${this.scope}|asset:${asset}`,
        scope: this.scope,
        kind: "asset",
        asset,
        data: this.assets.get(asset),
        pending: false,
      })
      .catch(() => {});
    this.pendingAssets.delete(asset);
  }
  // The board as it stood at an earlier version, with shared media hydrated.
  async versionBoard(at) {
    const { update } = await this.request("history.state", { at });
    const doc = new SharedDocument(decode(update));
    let board;
    try {
      board = doc.snapshot(this.room);
    } finally {
      doc.destroy();
    }
    return this.hydrate(board);
  }
  // Objects added or there before and removed within a version, which
  // neither it nor the version before holds (see history.removed), with
  // their tags and shared media hydrated.
  async removedObjects(at, after) {
    const { items, tags } = await this.request("history.removed", {
      at,
      after,
    });
    return this.hydrate({
      items: Array.isArray(items) ? items : [],
      tags: Array.isArray(tags) ? tags : [],
    });
  }
  materialize() {
    return this.hydrate(this.shared.snapshot(this.room));
  }
  // Files and images replace their asset references. One that cannot be
  // downloaded keeps its reference, so the rest of the board still opens
  // and saves leave the file in place; the next publish tries again.
  async hydrate(board) {
    const wanted = new Set();
    for (const i of board.items)
      for (const key of ["src", "data"]) {
        const m = ASSET.exec(i[key] || "");
        if (m && !this.assets.has(m[1])) wanted.add(m[1]);
      }
    // A few downloads at a time, rather than one after another. Each keeps
    // its own result, so it is used even if unused media is let go of
    // meanwhile.
    const queue = [...wanted],
      downloaded = new Map();
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const asset = queue.shift();
          await this.downloadAsset(asset)
            .then((data) => downloaded.set(asset, data))
            .catch(() => {});
        }
      }),
    );
    for (const i of board.items)
      for (const key of ["src", "data"]) {
        const m = ASSET.exec(i[key] || "");
        const data = m && (this.assets.get(m[1]) ?? downloaded.get(m[1]));
        if (data) i[key] = data;
      }
    return board;
  }
  downloadAsset(asset) {
    if (!this.assetDownloads.has(asset)) {
      const pending = (async () => {
        const { data } = await this.request("asset.get", { asset });
        if ((await hash(data)) !== asset)
          throw Error("Shared asset checksum does not match.");
        this.assets.set(asset, data);
        this.assetIds.set(data, asset);
        await this.store.collaborationPut({
          id: `${this.scope}|asset:${asset}`,
          scope: this.scope,
          kind: "asset",
          asset,
          data,
          pending: false,
        });
        return data;
      })().finally(() => {
        // Failed transfers must be retryable; verified bytes remain in assets.
        this.assetDownloads.delete(asset);
      });
      this.assetDownloads.set(asset, pending);
    }
    return this.assetDownloads.get(asset);
  }
  // Only changed fields enter the document; editor integration serializes calls to this method.
  async commit(board, before) {
    if (this.readOnly || this.closed) return;
    const prepared = await this.prepare(board);
    const baseline = before ? await this.prepare(before) : null;
    if (this.closed || this.readOnly) return;
    let next = baseline
      ? rebase(prepared, baseline, this.shared.snapshot())
      : prepared;
    // Commenters change only comments and workshop registers such as votes.
    // Anything else this device changed, such as text heights measured with
    // its own fonts, stays local instead of getting the whole save refused.
    if (this.contentReadOnly) {
      const { comments, workshop } = next;
      next = this.shared.snapshot();
      delete next.comments;
      delete next.workshop;
      if (comments !== undefined) next.comments = comments;
      if (workshop !== undefined) next.workshop = workshop;
    }
    const written = this.written;
    this.shared.commit(next, { content: !this.contentReadOnly });
    await this.publish();
    await this.queue;
    // A save that changed nothing shared leaves nothing to upload, so the
    // status goes back to what it was rather than "Saving…" until the next
    // check.
    if (
      written === this.written &&
      !this.pending.size &&
      !this.flushing &&
      !this.closed
    )
      this.status(this.shown || this.savedStatus());
  }
  // Uploads are spaced so a room's edits stay within what its worker can
  // store, about eight a second, by how many people uploaded in the last
  // fifteen seconds as their peers announced: 0.4 seconds for a few, 1.25
  // for ten, 12.5 for a hundred, and at most 15 from 120 on. Moves, drawings
  // and typing show live meanwhile, so waiting longer to save them keeps a
  // busy room's worker within its storage quota without slowing what people
  // see. Without peer links, nothing shows until it is saved, so uploads
  // wait at most 3 seconds, and with others' uploads unseen a quarter of a
  // large room counts.
  batchDelay() {
    const now = Date.now();
    let active = 1;
    for (const [id, at] of this.uploaders || [])
      if (now - at < 15_000) active++;
      else this.uploaders.delete(id);
    const people = this.roster?.length || 0;
    if (people > 8 && !this.linked())
      return Math.min(3000, Math.max(400, Math.max(active, people / 4) * 125));
    return Math.min(15_000, Math.max(400, active * 125));
  }
  // The first edit after a quiet spell goes out at once; edits made soon
  // after an upload wait for the rest of the batch delay, so a busy device
  // still uploads at most once per delay.
  scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        this.flush().catch((e) => this.failure(e));
      },
      Math.max(50, (this.uploaded || 0) + this.batchDelay() - Date.now()),
    );
  }
  // This person finished a move, drawing or text. Their presence says it is
  // settling while its edit is on the way: long enough for the edit to
  // reach the outbox and be sent, then until the outbox is empty, as a save
  // can wait for its upload's turn, a retry or a slow worker, but at most
  // twenty seconds. With `false`, a gesture was cancelled: the presence
  // ending its preview says it is not settling, so nobody holds it, and
  // later ones still speak for an earlier edit not yet saved.
  settle(on = true) {
    this.unsettled = !on;
    if (!on) return;
    const now = Date.now();
    this.settleWait = now + 2000 + this.batchDelay();
    this.settleEnd = now + SETTLE_CAP;
  }
  settles() {
    const now = Date.now();
    if (now < (this.settleWait || 0)) return true;
    if (now < (this.settleEnd || 0) && this.unsaved) return true;
    this.settleEnd = 0;
    return false;
  }
  // An upload pass run to completion after this call, including one already
  // running and the pass it queues.
  async flushed() {
    while (this.flushing) await new Promise((r) => setTimeout(r, 10));
    await this.flush();
    while (this.flushing) await new Promise((r) => setTimeout(r, 10));
  }
  async flush() {
    if (this.closed || this.readOnly) return;
    // An edit made during an upload may miss it; send it once it finishes
    // rather than at the next retry.
    if (this.flushing) return void (this.flushAgain = true);
    clearTimeout(this.retryTimer);
    this.flushing = true;
    try {
      await this.queue;
      // Only people who can change content may upload media. Images queued
      // before access was lowered wait for it to return rather than stopping
      // everything else, such as comments, from being saved.
      if (!this.contentReadOnly) await this.uploadAssets();
      // With nothing uploaded the document is unchanged, so the local copy
      // is not rewritten nor the board redrawn, as periodic checks usually
      // find nothing to send.
      let sent = false;
      for (let batch = 0; this.pending.size && batch < 4; batch++) {
        const rows = this.batch();
        this.uploaded = Date.now();
        try {
          await this.send(rows);
          sent = true;
          this.batchRows = 128;
          this.conflicts = 0;
        } catch (error) {
          // The worker has not yet received edits these build on; they are
          // kept and sent again shortly. Edits it can never take, as when a
          // saved copy kept rows it never received, would otherwise hold
          // back every later save, so after several tries they are made
          // again on its state.
          if (error.status === 409 && !this.closed) {
            this.conflicts = (this.conflicts || 0) + 1;
            if (this.conflicts < 8) {
              // A worker short of storage requests refuses many people's
              // edits at once; waiting longer each time, and not all for
              // the same time, lets it catch up.
              this.soon =
                Math.min(8000, 1500 * 2 ** (this.conflicts - 1)) *
                (0.75 + Math.random() / 2);
              break;
            }
            this.conflicts = 0;
          } else if (error.status === 413 && rows.length > 1 && !this.closed) {
            // A batch too large for the worker is sent in halves.
            this.batchRows = Math.ceil(rows.length / 2);
            this.soon = true;
            continue;
          } else if (error.status === undefined && rows.length > 1) {
            // A batch that times out or is cut off on a slow connection
            // would every time; the next try sends half as much.
            this.batchRows = Math.ceil(rows.length / 2);
            throw error;
          } else if (![413, 422].includes(error.status) || this.closed)
            throw error;
          await this.recover(rows, error);
          sent = true;
        }
        if (this.closed) return;
      }

      // A backlog, such as edits made offline, continues at the usual pace
      // once these batches are saved, not after a retry's wait.
      if (sent && this.pending.size) this.flushAgain = true;
      // Each upload already kept the acknowledged state on this device.
      if (!this.closed) {
        this.status(
          this.pending.size ? "Saving shared changes…" : this.savedStatus(),
        );
        if (sent) await this.publish();
      }
    } finally {
      this.flushing = false;
      if (this.pending.size && !this.closed && !this.readOnly)
        this.retryTimer = setTimeout(
          () => this.flush().catch((e) => this.failure(e)),
          this.soon
            ? typeof this.soon === "number"
              ? this.soon
              : 1500
            : this.flushAgain
              ? this.batchDelay()
              : 10000,
        );
      this.soon = this.flushAgain = false;
    }
  }
  // Pending rows in order, up to a count and a total size the worker
  // accepts in one commit; always at least one.
  batch() {
    const rows = [];
    let size = 0;
    for (const row of this.pending.values()) {
      size += row.update.length;
      if (
        rows.length &&
        (rows.length >= (this.batchRows || 128) || size > BATCH_SIZE)
      )
        break;
      rows.push(row);
    }
    return rows;
  }
  async send(rows) {
    // An edit the worker could never accept is handled like a refused one.
    if (rows.some((row) => row.update.length > UPDATE_LIMIT))
      throw Object.assign(Error("This change is too large to save."), {
        status: 413,
      });
    const update = mergeUpdates(rows.map((row) => decode(row.update)));
    const digest = await hash(update);
    const result = await this.request("commit", {
      id: digest,
      update: encode(update),
      vector: encode(this.shared.vector()),
    });
    if (this.closed) return;
    if (result.receipt?.id !== digest)
      throw Error("The server did not acknowledge this edit.");
    this.shared.apply(decode(result.update));
    this.arrived(digest);
    // Keep the acknowledged edits locally before removing their rows. If
    // that copy cannot be written, the rows stay stored, so a reload still
    // has these edits and sends them again, which the worker takes as
    // nothing new; they are saved either way, so the upload moves on.
    const kept = await this.keepCopy();
    for (const row of rows) {
      if (kept) await this.store.collaborationDelete(row.id).catch(() => {});
      this.pending.delete(row.digest);
    }
    this.peers
      ?.broadcast("edit", {
        update: encode(update),
        receipt: result.receipt,
        receiptProof: result.receiptProof,
      })
      .catch(() => {});
    this.peers
      ?.broadcast("committed", { id: digest, at: result.serverTime })
      .catch(() => {});
  }
  // The worker deterministically rejects edits that cannot join the shared
  // state, such as concurrent additions crossing a board limit. Retrying them
  // would block every later save. Later rows continue the rejected row's Yjs
  // clock and cannot be uploaded as they are, so the accepted prefix is saved,
  // the session returns to the authoritative document, and what each later
  // row changed is made again on top of it. Only the rejected edit is lost.
  async recover(rows, why) {
    let refused = rows[0];
    if (rows.length > 1) {
      refused = null;
      for (const row of rows) {
        try {
          await this.send([row]);
        } catch (error) {
          if (![409, 413, 422].includes(error.status)) throw error;
          refused = row;
          why = error;
          break;
        }
        if (this.closed) return;
      }
      // Each row was accepted on its own.
      if (!refused) return;
    }
    const result = await this.request("sync");
    if (this.closed) return;
    await this.queue;
    if (this.closed) return;
    const discarded = [...this.pending.values()],
      later = discarded.slice(discarded.indexOf(refused) + 1),
      previous = this.shared;
    this.pending.clear();
    // A fresh document also receives a fresh client ID for later edits.
    this.shared = sessionDocument(decode(result.update));
    this.track();
    previous.destroy();
    for (const row of discarded) await this.store.collaborationDelete(row.id);
    const remade = this.replay(
      decode(result.update),
      refused,
      later,
      why?.status === 409,
    );
    // Undo history belonged to the replaced document.
    this.shared.undo.clear();
    await this.keepCopy();
    await this.publish();
    // A file the worker refused is what the edit lacked.
    const reason =
      why?.status === 422 && /file that was not uploaded/.test(why.message)
        ? this.refusedFile
        : undefined;
    this.refusedFile = null;
    if (!this.closed) this.rejected({ remade, reason });
  }
  // Commits again what each row changed, read on a copy of the shared state
  // that has the refused row and the rows before it. Changes to anything the
  // refused row added are dropped with it, as the shared state lacks it. A
  // row the worker kept refusing because edits it builds on had not arrived
  // (`remake`) is made again on its state as far as that allows, rather than
  // lost: the edits it lacks may never come, but its own changes are fine.
  // Returns whether the refused row itself was made again.
  replay(state, refused, rows, remake = false) {
    const copy = new SharedDocument(state);
    let remade = false;
    try {
      const base = copy.snapshot(this.room);
      copy.apply(decode(refused.update));
      // A row refused for names on reactions or contributions, saved before
      // this device heard that anonymous input was turned on, is made again
      // without them, as the rebase takes them off. Made again once, it is
      // not repeated if refused for something else.
      const made = copy.snapshot(this.room),
        current = this.shared.snapshot(this.room);
      const named = namedChanges(
        made.workshop,
        base.workshop,
        workshopSettings(current).anonymous,
      ).length;
      if (remake || named) {
        this.shared.commit(rebase(made, base, current), {
          content: !this.contentReadOnly,
        });
        // Changes waiting for edits the state still lacks are left out of
        // it, so a row made again only in part is reported as refused.
        const store = copy.doc.store;
        remade = !!named || !(store.pendingStructs || store.pendingDs);
      }
      for (const row of rows) {
        const before = copy.snapshot(this.room);
        copy.apply(decode(row.update));
        this.shared.commit(
          rebase(
            copy.snapshot(this.room),
            before,
            this.shared.snapshot(this.room),
          ),
          { content: !this.contentReadOnly },
        );
      }
    } finally {
      copy.destroy();
    }
    return remade;
  }
  // This session was told of a save: by a board event, whose value names
  // the records saved, or by a peer's "committed" notice naming its own, or
  // a relay's nudge naming none. A worker instance's copy of the board from
  // before can lack a save made through another instance, so the next
  // synchronization says it follows a notice and names the records it was
  // told of, and the instance lists the log again unless its copy holds
  // them all. Saves whose edits already arrived over a peer link need no
  // such read, including ones that arrive after the notice: an edit and its
  // notice come together, and the notice is often handled first. The save's
  // time, by Puter's clock or the saving instance's, still goes along for
  // workers from before record ids were named; times far from this
  // session's clock, as a peer could send, are ignored.
  // A save whose edits this session already holds, as one of its own or
  // one a peer brought, needs no read when its notice comes.
  arrived(id) {
    (this.delivered ||= new Set()).add(id);
    if (this.delivered.size > 512)
      this.delivered.delete(this.delivered.values().next().value);
    this.toldIds?.delete(id);
  }
  notice(at, ids = null) {
    if (Number.isFinite(at) && Math.abs(at - this.now()) < 60_000)
      this.noticed = Math.max(this.noticed || 0, at);
    const named = Array.isArray(ids)
      ? ids
          .filter((id) => typeof id === "string" && id.length <= 128)
          .slice(0, 64)
      : [];
    // Only a notice naming no record makes the next synchronization ask
    // for a fresh read whatever arrives meanwhile.
    if (!named.length) this.told = true;
    for (const id of named) {
      if (this.delivered?.has(id)) continue;
      (this.toldIds ||= new Set()).add(id);
      if (this.toldIds.size > 256)
        this.toldIds.delete(this.toldIds.values().next().value);
    }
  }
  synchronize() {
    if (this.closed) return Promise.resolve();
    // A change can land after the running request was sent. Run one more pass
    // afterwards instead of dropping this request until the next poll.
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.resync = false;
          await this.synchronizeOnce();
        } while (this.resync && !this.closed);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }
  async synchronizeOnce() {
    const unnamed = this.told,
      ids = [...(this.toldIds || [])],
      told = unnamed || ids.length > 0;
    this.told = false;
    this.toldIds?.clear();
    let result;
    try {
      // A poll says nothing of notices, so the worker instance answers from
      // its copy if that is recent.
      result = await this.request("sync", {
        vector: encode(this.shared.vector()),
        ...(told
          ? {
              noticed: true,
              ...(this.noticed ? { after: this.noticed } : {}),
              ...(ids.length ? { ids } : {}),
            }
          : {}),
      });
    } catch (error) {
      // Asked again by the next attempt.
      if (ids.length) this.notice(null, ids);
      this.told ||= unnamed;
      throw error;
    }
    if (this.closed) return;
    // A record the instance still lacks after listing the log again, as
    // when a listing lags a write, is asked for again shortly, up to three
    // times each.
    const missing = Array.isArray(result.missing)
      ? result.missing.filter(
          (id) => ids.includes(id) && !this.delivered?.has(id),
        )
      : [];
    const tries = (this.missingTries ||= new Map());
    for (const id of ids) if (!missing.includes(id)) tries.delete(id);
    const again = missing.filter((id) => {
      const n = (tries.get(id) || 0) + 1;
      tries.delete(id);
      tries.set(id, n);
      return n <= 3;
    });
    while (tries.size > 256) tries.delete(tries.keys().next().value);
    if (again.length) {
      this.notice(null, again);
      clearTimeout(this.missingTimer);
      this.missingTimer = setTimeout(() => {
        this.missingTimer = null;
        if (!this.closed) this.synchronize().catch((e) => this.failure(e));
      }, 1000);
    }
    // Polls and notices usually bring nothing new. Rewriting the local copy
    // and redrawing the whole board is then skipped, unless access changed.
    let changed = !this.synchronized,
      brought = false;
    const noticed = () => (changed = brought = true);
    const access = [this.role, this.readOnly, this.contentReadOnly].join();
    this.shared.doc.on("update", noticed);
    try {
      this.shared.apply(decode(result.update));
    } finally {
      this.shared.doc.off("update", noticed);
    }
    // Once this document was checked whole, a synchronization checks only
    // what arrived since the last check, from the worker or from peers, as
    // the worker does each save, and the board as a whole: on a large board
    // in a busy room, checking every object each time cost about 15 ms per
    // synchronization, even one bringing nothing. A board found to need a
    // newer app is checked whole until it no longer does.
    const arrived = this.shared.takeArrivals(),
      checked = this.checked === this.shared && !this.incompatible;
    try {
      this.shared.validate(ACCEPTED, checked ? arrived : {});
      this.checked = this.shared;
      this.incompatible = false;
    } catch (error) {
      this.checked = null;
      // An edit queued on this device may no longer fit what others saved
      // meanwhile, as a change to the same object; the worker refuses such
      // an edit, so it is uploaded now and dropped like any refused edit,
      // and the state checked again. Only a state without this device's
      // queued edits holds what only a newer app writes.
      if (this.pending.size && !this.readOnly && !this.closed) {
        await this.flushed();
        if (this.closed) return;
        try {
          this.shared.validate(ACCEPTED);
          this.checked = this.shared;
          this.incompatible = false;
        } catch (again) {
          again.incompatible = true;
          throw again;
        }
      } else {
        // The board holds what only a newer app writes; the person is told
        // to reload rather than shown as offline.
        error.incompatible = true;
        throw error;
      }
    }
    this.applyRole(result.role, result.archived);
    if (access !== [this.role, this.readOnly, this.contentReadOnly].join())
      changed = true;
    // In a large room most people learn of saved edits only from peers. A
    // relay that reads one no peer announced, such as one made through the
    // API or by someone without peer links, asks the others to read it too.
    if (
      brought &&
      this.synchronized &&
      this.peers?.isRelay &&
      this.roster?.length > 8 &&
      Date.now() - (this.nudged || 0) > 2000
    ) {
      this.nudged = Date.now();
      this.peers
        .broadcast("committed", { nudge: true, at: result.serverTime })
        .catch(() => {});
    }
    if (changed) {
      await this.keepCopy();
      await this.publish();
      this.synchronized = true;
    }
    if (!this.pending.size) this.status(this.savedStatus());
  }
  // Changes arrive live through board events or a verified peer link; in
  // large rooms most people have only the latter.
  savedStatus() {
    if (this.full) return "Saved · board full, no live presence";
    return this.subscription || this.linked()
      ? "Saved · live"
      : "Saved · periodic sync";
  }
  linked() {
    return [...(this.peers?.links?.values() || [])].some(
      (link) => link.connected && link.whiteboardAuthorized,
    );
  }
  // Whether others are here but no peer link has brought their cursors and
  // previews for longer than a dropped link takes to come back; their saved
  // edits still arrive through the worker. Asked whenever the participants
  // are shown, at least every two seconds.
  liveUnavailable(now = Date.now()) {
    if (
      this.linked() ||
      !this.roster?.some((p) => p.session !== this.session)
    ) {
      this.unlinked = null;
      return false;
    }
    this.unlinked ??= now;
    return now - this.unlinked >= 10_000;
  }
  // In a large room, a member that relays nothing gets changes from a relay
  // over a connected peer link instead of board events.
  relayed() {
    return (
      this.roster?.length > 8 &&
      !!this.peers &&
      !this.peers.isRelay &&
      this.linked()
    );
  }
  async publish() {
    const generation = (this.publishGeneration =
      (this.publishGeneration || 0) + 1);
    const cached = this.shared.snapshot(this.room);
    let missing = 0;
    for (const item of cached.items)
      for (const key of ["src", "data"]) {
        const match = ASSET.exec(item[key] || "");
        if (!match) continue;
        if (this.assets.has(match[1])) item[key] = this.assets.get(match[1]);
        else missing++;
      }
    if (!this.closed) this.changed(cached);
    if (!missing) return;
    // Images and files still downloading appear when they arrive, rather
    // than holding back every other change, and later saves, until then.
    this.materialize()
      .then((board) => {
        const left = board.items.reduce(
          (n, i) =>
            n +
            ["src", "data"].filter((key) => ASSET.test(i[key] || "")).length,
          0,
        );
        if (
          !this.closed &&
          generation === this.publishGeneration &&
          left < missing
        )
          this.changed(board);
        this.retryAssets(board);
      })
      .catch(() => {});
  }
  // An image or file that could not be downloaded is tried again after a
  // while, waiting longer each time, even when nothing else changes. After
  // several tries, as for one the server no longer has, only later updates
  // to the board try again.
  retryAssets(board) {
    const missing = board.items.some((i) =>
      ["src", "data"].some((key) => ASSET.test(i[key] || "")),
    );
    if (!missing) {
      this.assetDelay = this.assetTries = 0;
      return;
    }
    if (this.assetTimer || this.closed) return;
    if ((this.assetTries || 0) >= 8) return;
    this.assetDelay = Math.min(60_000, (this.assetDelay || 2500) * 2);
    this.assetTimer = setTimeout(() => {
      this.assetTimer = null;
      this.assetTries = (this.assetTries || 0) + 1;
      if (!this.closed) this.publish().catch(() => {});
    }, this.assetDelay);
  }
  // Remember each session's last completed action, bounded like other
  // per-session state and ordered by recent activity.
  acted(session, sequence) {
    const last = Math.max(sequence, this.lastAction.get(session) || 0);
    this.lastAction.delete(session);
    this.lastAction.set(session, last);
    if (this.lastAction.size > 512)
      this.lastAction.delete(this.lastAction.keys().next().value);
  }
  async receive(kind, data, ticket, sequence) {
    if (this.closed || ticket.session === this.session) return;
    if (!data || typeof data !== "object") return;
    if (kind === "view-left") {
      if (
        !Number.isSafeInteger(data.at) ||
        Math.abs(this.now() - data.at) > 15000 ||
        !Number.isSafeInteger(sequence) ||
        sequence <= (this.views.get(ticket.session)?.sequence || 0)
      )
        return;
      this.endedViews.add(ticket.session);
      if (this.endedViews.size > 512)
        this.endedViews.delete(this.endedViews.values().next().value);
      this.views.delete(ticket.session);
      this.viewChanged(this.views, this.roster || []);
      // They left the board: their cursor, selection and editing tag go too,
      // rather than lingering until their presence expires.
      if (this.people.delete(ticket.session))
        this.activity(this.people, this.roster || []);
      return;
    }
    if (kind === "view" || kind === "attention") {
      if (this.endedViews.has(ticket.session)) return;
      if (!Number.isSafeInteger(sequence) || sequence <= 0) return;
      const v = readView(data, this.now());
      if (!v) return;
      // A view renewed before its owner heard a facilitator lower their
      // hand still carries it; it stays down until raised again.
      if (v.hand && v.hand <= this.loweredAt(ticket.session)) delete v.hand;
      if (
        kind === "attention" &&
        (!canEditContent(ticket.role) ||
          !["all", this.session].includes(data.target) ||
          sequence <= (this.attentionSequence.get(ticket.session) || 0))
      )
        return;
      const previous = this.views.get(ticket.session);
      if (kind === "view" && previous && sequence <= previous.sequence) return;
      const person =
        previous && sequence <= previous.sequence
          ? previous
          : { ...ticket, ...v, sequence, received: Date.now() };
      this.views.set(ticket.session, person);
      if (this.views.size > 512)
        this.views.delete(this.views.keys().next().value);
      this.viewChanged(this.views, this.roster || []);
      if (kind === "attention") {
        this.attentionSequence.set(ticket.session, sequence);
        if (this.attentionSequence.size > 512)
          this.attentionSequence.delete(
            this.attentionSequence.keys().next().value,
          );
        this.attention(person);
      }
      return;
    }
    // Owners and facilitators lower someone's raised hand, or everyone's.
    // Each receiver takes the hands raised before the request down at once,
    // and the person whose hand it was lowers it, which their next view
    // says to anyone who missed the request.
    if (kind === "hand") {
      const request = readLower(data, this.now());
      if (
        !request ||
        !canManage(ticket.role) ||
        this.endedViews.has(ticket.session) ||
        !Number.isSafeInteger(sequence) ||
        sequence <= (this.loweredSequence.get(ticket.session) || 0)
      )
        return;
      this.loweredSequence.set(ticket.session, sequence);
      if (this.loweredSequence.size > 512)
        this.loweredSequence.delete(this.loweredSequence.keys().next().value);
      this.noteLowered(request.lower, request.at);
      if (
        [this.session, "all"].includes(request.lower) &&
        this.hand &&
        this.hand <= request.at
      ) {
        this.hand = null;
        this.broadcastView();
        this.handLowered(ticket);
      }
      return;
    }
    // A live reaction is shown and forgotten. One beyond a person's limit
    // is dropped here and, being refused, not passed on by a relay.
    if (kind === "reaction") {
      const reaction = readReaction(data, this.now());
      if (!reaction || this.endedViews.has(ticket.session)) return;
      if (!this.reactionsTaken.take(ticket.session)) return false;
      this.reaction({ ...ticket, type: reaction.type });
      return;
    }
    if (kind === "presence") {
      const prev = this.people.get(ticket.session);
      if (
        this.endedViews.has(ticket.session) ||
        (prev && sequence <= prev.sequence) ||
        sequence <= (this.lastAction.get(ticket.session) || 0)
      )
        return;
      if (
        data.cursor &&
        ![data.cursor.x, data.cursor.y].every(
          (n) => Number.isFinite(n) && Math.abs(n) <= 1e6,
        )
      )
        return;
      const selection = Array.isArray(data.selection)
        ? data.selection.filter((id) => typeof id === "string").slice(0, 100)
        : [];
      let preview = [];
      if (canEditContent(ticket.role) && Array.isArray(data.preview))
        preview = data.preview
          .slice(0, 100)
          .filter(
            (i) =>
              typeof i.id === "string" &&
              [i.x, i.y, i.w, i.h].every(
                (n) => Number.isFinite(n) && Math.abs(n) <= 1e6,
              ),
          )
          .map(({ id, x, y, w, h, type, color, points, rotation }) => ({
            id,
            x,
            y,
            w,
            h,
            ...(Number.isFinite(rotation) && rotation >= -180 && rotation < 180
              ? { rotation }
              : {}),
            ...(["pen", "arrow"].includes(type) &&
            /^#[a-f0-9]{6}$/i.test(color) &&
            Array.isArray(points) &&
            points.length <= 256 &&
            points.every(
              (p) =>
                Array.isArray(p) &&
                p.length === 2 &&
                p.every((n) => Number.isFinite(n) && Math.abs(n) <= 1e6),
            )
              ? { type, color, points }
              : {}),
          }));
      let editing = typeof data.editing === "string" ? data.editing : null,
        text =
          canEditContent(ticket.role) && typeof data.text === "string"
            ? data.text.slice(0, 20000)
            : null,
        settling = null;
      // A finished move, drawing or edit reaches this device after the
      // presence saying it ended. What was last shown stays until the edit
      // arrives rather than jumping back meanwhile: six seconds, or while
      // its author keeps saying it is settling and a few seconds after, so
      // a hold outlasts a slow save without needing frequent packets, and
      // ends soon after they go quiet. Older clients say so for a few
      // seconds after the gesture, whatever the save. Each object is held
      // on its own, so a drawing finished just before the next one starts,
      // as when drawing quickly, stays while the next is drawn.
      const now = Date.now(),
        live = new Set(preview.map((i) => i.id)),
        saving = data.settling === true && !!prev,
        extend = (since, until) =>
          saving
            ? Math.min(since + SETTLE_CAP, Math.max(until, now + SETTLE_GRACE))
            : until;
      const held = (prev?.held || []).filter(
        (h) => now <= h.until && !live.has(h.item.id),
      );
      let settleUntil = null;
      if (saving) {
        for (const h of held) h.until = extend(h.since, h.until);
        for (const item of prev.live || [])
          if (!live.has(item.id) && !held.some((h) => h.item.id === item.id))
            held.push({
              item,
              since: now,
              until: now + SETTLE,
              created: this.creating(item),
            });
        const since = prev.settling || now,
          until = prev.settling ? prev.settleUntil : now + SETTLE;
        if (
          now <= until &&
          editing === null &&
          prev.editing &&
          prev.text !== null
        ) {
          editing = prev.editing;
          text = prev.text;
          settling = since;
          settleUntil = extend(since, until);
        }
      }
      this.people.set(ticket.session, {
        ...ticket,
        cursor: data.cursor,
        selection,
        live: preview,
        held,
        preview: held.length
          ? [...preview, ...held.map((h) => h.item)]
          : preview,
        editing,
        text,
        settling,
        settleUntil,
        sequence,
        at: now,
      });
      this.activity(this.people, this.roster || []);
    } else if (kind === "edit" && canComment(ticket.role)) {
      try {
        const update = decode(data.update, 60000);
        if (
          data.receipt?.room !== this.room ||
          data.receipt.author !== ticket.user ||
          data.receipt.id !== (await hash(update)) ||
          !(await verify(this.publicKey, data.receipt, data.receiptProof)) ||
          this.closed
        )
          return;
        // The receipt shows the worker checked and saved these exact bytes,
        // so they are applied as a synchronization would apply them.
        const { items } = this.shared.applyTracked(update);
        // What it changed, for the previews it ends (see settled).
        const person = this.people.get(ticket.session);
        if (person)
          for (const id of items) (person.edited ??= new Set()).add(id);
        (this.touched ??= new Map()).set(data.receipt.id, items);
        if (this.touched.size > 64)
          this.touched.delete(this.touched.keys().next().value);
        // Complete edits need no synchronization when their save is
        // announced; one waiting on missing edits still does.
        const store = this.shared.doc.store;
        if (!store.pendingStructs && !store.pendingDs)
          this.arrived(data.receipt.id);
        this.acted(ticket.session, sequence);
        this.showEdit(ticket.session);
      } catch {
        /* Malformed or unacknowledged peer packets are ignored. */
      }
    } else if (kind === "committed") {
      // Asking the room to read the board is a relay's part; once the
      // room's relays are known, only theirs is taken up.
      if (
        data.nudge === true &&
        this.peers?.plan &&
        !this.peers.plan.relays.has(ticket.session)
      )
        return;
      this.notice(
        data.at,
        data.nudge === true ? null : [data.id].filter(Boolean),
      );
      // A relay's request to read an edit is not an action of its own.
      if (data.nudge !== true) {
        this.acted(ticket.session, sequence);
        (this.uploaders ||= new Map()).set(ticket.session, Date.now());
        if (this.uploaders.size > 512)
          this.uploaders.delete(this.uploaders.keys().next().value);
      }
      // What they finished stays until the board has their edit; what they
      // are still creating stays too.
      const person = data.nudge !== true && this.people.get(ticket.session);
      if (person) {
        person.live = person.live.filter((i) => this.creating(i));
        this.showPerson(person);
        if (!person.settling) person.text = null;
      }
      if (data.nudge !== true)
        (this.committedPeople ||= new Set()).add(ticket.session);
      (this.committedIds ||= new Set()).add(
        typeof data.id === "string" ? data.id : null,
      );
      // Separate from board events, whose check-in this must not cancel.
      if (!this.committedTimer)
        this.committedTimer = setTimeout(() => {
          this.committedTimer = null;
          const settled = this.committedPeople,
            ids = this.committedIds;
          this.committedPeople = new Set();
          this.committedIds = new Set();
          // What the saves changed, when their edits came over peer links.
          let touched = new Set();
          for (const id of ids)
            if (this.touched?.has(id))
              for (const item of this.touched.get(id)) touched.add(item);
            else touched = null;
          const end = () => {
            let ended = false;
            for (const session of settled) {
              const p = this.people.get(session);
              if (!p || (!p.settling && !p.held.length)) continue;
              this.settled(p, touched);
              ended = true;
            }
            if (ended && !this.closed)
              this.activity(this.people, this.roster || []);
          };
          // Saves whose edits already arrived over a peer link are not read
          // back from the worker: in a busy room every participant would
          // otherwise load the board from it after every save.
          if ([...ids].every((id) => this.delivered?.has(id))) return end();
          this.synchronize()
            .then(end, (e) => {
              end();
              this.failure(e);
            })
            .catch(() => {});
        }, 200);
    }
  }
  // Edits arriving together from several people are shown with one redraw
  // of the board, each person's preview giving way to their edit. A large
  // board takes a while to show again, so edits arriving steadily wait
  // several times that long, up to a second, leaving the device time for
  // everything else; a small one still shows them within a frame or two.
  showEdit(session) {
    (this.shownPeople ||= new Set()).add(session);
    if (this.showTimer) return;
    this.showTimer = setTimeout(
      () => {
        this.showTimer = null;
        for (const id of this.shownPeople) {
          const person = this.people.get(id);
          if (!person) continue;
          this.settled(person, person.edited ?? null);
          person.edited = null;
        }
        this.shownPeople.clear();
        if (this.closed) return;
        const started = performance.now();
        this.publish().catch(() => {});
        this.showCost = performance.now() - started;
      },
      Math.min(1000, Math.max(30, 4 * (this.showCost || 0))),
    );
  }
  // Whether a preview is of a drawing or connector not on the board yet,
  // as someone is creating.
  creating(item) {
    return !!item.type && !this.shared.items.get(item.id)?.get;
  }
  showPerson(person) {
    person.preview = person.held.length
      ? [...person.live, ...person.held.map((h) => h.item)]
      : person.live;
  }
  // Someone's edit arrived: what it changed is shown as the board has it.
  // New objects they finished whose edits have not arrived yet, such as the
  // drawing after the one just saved, stay held, as does anything they are
  // still creating. Given the objects their edits changed (`touched`), as
  // edits arriving over peer links tell, a finished move of any other
  // object stays held too, for as long as holds last, since its own edit
  // may wait for a later upload: busy rooms space uploads seconds apart.
  // Without it, as when the edit was read from the worker, every move gives
  // way; mind-map moves, for one, can save no new position.
  settled(person, touched = null) {
    person.live = person.live.filter((i) => this.creating(i));
    person.held = person.held.filter(
      (h) =>
        (h.created && this.creating(h.item)) ||
        (touched && !touched.has(h.item.id)),
    );
    this.showPerson(person);
    person.text = null;
    person.settling = person.settleUntil = null;
  }
  view(camera, following = null, slide = null) {
    if (
      this.closed ||
      this.viewEnded ||
      !validCamera(camera) ||
      (following !== null && !validSession(following)) ||
      (slide !== null && !validSlide(slide))
    )
      return;
    const next = {
        camera: { ...camera },
        following,
        ...(slide ? { slide: { ...slide } } : {}),
      },
      key = JSON.stringify(next);
    if (this.viewKey === key && Date.now() - (this.lastViewSent || 0) < 3000)
      return;
    const previous = this.latestView;
    this.viewKey = key;
    this.latestView = next;
    // A follower's camera is the followed person's, which everyone already
    // has. Unless someone follows the follower in turn, only whom it follows
    // and the slide shown go at once; renewals carry the camera, so a whole
    // audience does not repeat each move of a presenter.
    if (
      following !== null &&
      previous?.following === following &&
      JSON.stringify(previous.slide ?? null) === JSON.stringify(slide) &&
      !this.followed()
    )
      return;
    if (this.viewTimer) return;
    // A change after a pause goes at once: relays pass on presence near
    // each member's view in full.
    const wait = (this.lastViewSent || 0) + this.viewSpacing() - Date.now();
    if (wait <= 0) return void this.broadcastView();
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.broadcastView();
    }, wait);
  }
  // Everyone receives and verifies everyone's view, so beyond thirty people
  // it is sent five times a second, or ten while someone follows it.
  viewSpacing() {
    if ((this.roster?.length || 0) <= 30 || this.followed()) return 100;
    return 200;
  }
  // An unchanged view is renewed every three seconds, or every five beyond
  // thirty people, which still survives one renewal lost on the way. This
  // runs each second.
  renewView() {
    const every = (this.roster?.length || 0) > 30 ? 5000 : 3000;
    if (Date.now() - (this.lastViewSent || 0) > every - 1000)
      this.broadcastView();
  }
  followed() {
    for (const v of this.views.values())
      if (v.following === this.session) return true;
    return false;
  }
  broadcastView() {
    if (
      this.closed ||
      this.viewEnded ||
      !this.latestView ||
      !this.peers?.ticket
    )
      return;
    this.lastViewSent = Date.now();
    this.peers
      .broadcast("view", {
        ...this.latestView,
        ...(this.hand ? { hand: this.hand } : {}),
        at: Math.round(this.now()),
      })
      .catch(() => {});
  }
  // Raising or lowering this person's hand, for everyone on the board,
  // viewers included. It goes out with the view at once, and with each
  // renewal of it, so people who arrive later see it too. Whether it went:
  // a hand goes up only over a live peer link, without which no one else
  // would see it, and comes down whatever the link.
  raiseHand(raised) {
    if (this.closed || this.viewEnded) return false;
    if (!!this.hand === !!raised) return true;
    if (raised && (!this.latestView || !this.peers?.ticket || !this.linked()))
      return false;
    this.hand = raised ? Math.round(this.now()) : null;
    clearTimeout(this.viewTimer);
    this.viewTimer = null;
    this.broadcastView();
    return true;
  }
  // An owner or facilitator lowers another session's hand, or everyone's,
  // this one's included. Lowering one's own hand needs no role.
  async lowerHand(target = "all") {
    if (target === this.session) return this.raiseHand(false);
    if (
      this.closed ||
      this.viewEnded ||
      this.denied ||
      !canManage(this.role) ||
      !this.peers?.ticket ||
      !this.linked() ||
      (target !== "all" && !this.views.get(target)?.hand)
    )
      return false;
    const at = Math.round(this.now());
    this.noteLowered(target, at);
    if (target === "all" && this.hand) {
      this.hand = null;
      this.broadcastView();
    }
    await this.peers.broadcast("hand", { lower: target, at });
    return true;
  }
  // When facilitators last lowered a session's hand, by its own request or
  // one for everyone.
  loweredAt(session) {
    return Math.max(
      this.lowered.get(session) || 0,
      this.lowered.get("all") || 0,
    );
  }
  noteLowered(target, at) {
    if (at <= (this.lowered.get(target) || 0)) return;
    this.lowered.delete(target);
    this.lowered.set(target, at);
    if (this.lowered.size > 512)
      this.lowered.delete(this.lowered.keys().next().value);
    let changed = false;
    for (const [id, view] of this.views)
      if ((target === "all" || id === target) && view.hand && view.hand <= at) {
        const { hand, ...rest } = view;
        this.views.set(id, rest);
        changed = true;
      }
    if (changed) this.viewChanged(this.views, this.roster || []);
  }
  async finishView() {
    if (this.closed || this.viewEnded) return;
    this.viewEnded = true;
    clearTimeout(this.viewTimer);
    this.viewTimer = null;
    await this.peers
      ?.broadcast("view-left", { at: Math.round(this.now()) })
      .catch(() => {});
  }
  async bring(target = "all") {
    if (
      this.closed ||
      this.viewEnded ||
      this.readOnly ||
      this.contentReadOnly ||
      !this.connected ||
      !this.latestView ||
      !this.peers?.ticket ||
      ![...this.peers.links.values()].some(
        (p) => p.connected && p.whiteboardAuthorized,
      ) ||
      (target !== "all" &&
        (!validSession(target) ||
          target === this.session ||
          !this.roster?.some((p) => p.session === target)))
    )
      return false;
    await this.peers.broadcast("attention", {
      ...this.latestView,
      ...(this.hand ? { hand: this.hand } : {}),
      following: null,
      at: Math.round(this.now()),
      target,
    });
    return true;
  }
  // A live reaction goes to everyone on the board, viewers too, and is
  // never saved. Whether it went: not past this person's limit, and only
  // over a live peer link, without which no one else would see it.
  react(type) {
    if (
      this.closed ||
      this.viewEnded ||
      !LIVE_REACTIONS.includes(type) ||
      !this.peers?.ticket ||
      !this.linked() ||
      !this.reactionsSent.take(this.session)
    )
      return false;
    this.peers
      .broadcast("reaction", { type, at: Math.round(this.now()) })
      .catch(() => {});
    return true;
  }
  // Every participant receives and verifies everyone's live positions, so
  // they are sent less often as a room grows: 25 times a second for up to
  // eight people, 10 up to thirty, and 5 beyond.
  presence(data) {
    this.latestPresence = data;
    if (this.presenceTimer || this.closed) return;
    const people = this.roster?.length || 0;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.sendPresence();
    }, presenceInterval(people));
  }
  // Settling is repeated each second too, so others, who may get one
  // packet a second from someone whose work is out of their view, keep
  // holding what was finished while it is being saved.
  pulsePresence() {
    const p = this.latestPresence,
      quiet = Date.now() - (this.lastPresenceSent || 0);
    if (
      p &&
      !this.presenceTimer &&
      (((p.preview?.length || this.settles()) && quiet >= 750) ||
        ((p.selection?.length || p.editing) && quiet >= 4000) ||
        (p.cursor && quiet >= 6000))
    )
      this.sendPresence();
  }
  sendPresence() {
    this.lastPresenceSent = Date.now();
    let data = {
      ...this.latestPresence,
      settling: !this.unsettled && this.settles(),
    };
    this.unsettled = false;
    // Peers refuse packets over 64 KB. Without the live positions of a
    // large selection, the cursor and selection still reach them.
    if (data.preview?.length && JSON.stringify(data).length > 48_000)
      data = { ...data, preview: [] };
    this.peers?.broadcast("presence", data).catch(() => {});
  }
  failure(error) {
    if (this.closed) return;
    // Past the participant limit, edits still save but nobody sees this
    // person's cursor or presence; that is said, rather than "Offline".
    if (roomFull(error)) {
      this.full = true;
      if (!this.pending.size) this.status(this.savedStatus());
      return;
    }
    if (error.uploadsWait) {
      this.status("Uploading images · waiting for the board's server");
      return;
    }
    if (error.incompatible) {
      this.incompatible = true;
      this.readOnly = true;
      this.contentReadOnly = true;
      this.status("This board needs a newer version of the app · reload");
      return;
    }
    // Refused, or the board deleted (it can be brought back from the trash).
    if (error.status === 403 || error.status === 404) {
      this.readOnly = true;
      this.contentReadOnly = true;
      // The role last granted no longer applies, as after a removal.
      this.denied = true;
      this.peers?.close();
      this.peers = null;
      // Until access returns, nobody else's presence is known; the regular
      // expiry would otherwise show the previous roster again.
      this.roster = [];
      this.people.clear();
      this.views.clear();
      this.viewChanged(this.views, []);
      this.status(
        error.status === 404
          ? "Board unavailable · local changes retained"
          : "Access changed · local changes retained",
      );
      this.activity(this.people, []);
    } else
      this.status(
        this.recoveryFailed
          ? "Local recovery failed. Keep this tab open."
          : "Offline · changes saved on this device",
      );
  }
  get unsaved() {
    return (
      this.localWrites > 0 ||
      this.pending.size > 0 ||
      this.pendingAssets.size > 0
    );
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    for (const timer of [
      this.poll,
      this.expire,
      this.viewPulse,
      this.presencePulse,
    ])
      clearInterval(timer);
    for (const timer of [
      this.flushTimer,
      this.retryTimer,
      this.checkInTimer,
      this.eventBeatTimer,
      this.eventTimer,
      this.committedTimer,
      this.showTimer,
      this.presenceTimer,
      this.viewTimer,
      this.assetTimer,
      this.missingTimer,
    ])
      clearTimeout(timer);
    this.subscription?.off();
    this.peers?.close();
    globalThis.removeEventListener?.("online", this.online);
    globalThis.removeEventListener?.("offline", this.offline);
    globalThis.document?.removeEventListener(
      "visibilitychange",
      this.visibility,
    );
    this.request("leave", { session: this.session }).catch(() => {});
    this.queue.finally(() => this.shared.destroy());
  }
}
