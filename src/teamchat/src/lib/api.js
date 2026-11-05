/**
 * The only channel between the app and its backends: puter.workers.exec()
 * against a Teamchat worker. exec() forwards the signed-in user's Puter
 * token, which is how a worker knows who is calling.
 *
 * There is one worker per workspace owner, so every call names its target:
 * workspace routes take a workspace reference (`{wsId}@{server}`, see
 * refs.js) and resolve the worker from it; account-level routes take the
 * worker URL directly.
 */
import { parseRef } from './refs.js';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code || 'Request failed');
    this.status = status;
    this.code = code || 'error';
  }
}

/**
 * Whether a failure means the workspace's worker predates the route: it was
 * built before the route existed and answers the fall-through's 404 (or, older
 * still, no JSON at all). A 404 the route itself gives (a conversation that is
 * gone) carries its own message and is not that.
 */
export const isOldServer = (e) => e instanceof ApiError && (e.code === 'no_backend' || (e.status === 404 && /No such endpoint/.test(e.message)));

/**
 * Whether a write was refused because the workspace is being moved: the
 * nominee's export is running and the old copy takes no writes until the
 * move completes or is called off (a few minutes at most; see the worker's
 * transfer freeze). Carried as a 423 with code `transferring`, beside the
 * 423 `moved` a copy already moved answers for good; the outbox keeps the
 * message and tries again later rather than dropping it.
 */
export const isTransferring = (e) => e instanceof ApiError && e.status === 423 && e.code === 'transferring';

const TIMEOUT_MS = 20_000;
/** Uploads get longer: a 10 MB attachment on a slow uplink is not a hung server. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** Time for so many bytes to cross a slow link: 20 s to get going, then a budget of roughly 50 KB/s, within a ceiling. */
const budgetFor = (bytes) => (bytes > 0 ? Math.min(UPLOAD_TIMEOUT_MS, TIMEOUT_MS + Math.ceil(bytes / 50)) : TIMEOUT_MS);
/** A JSON body this large (an archive's page, a header of hundreds of members) is an upload in all but name when it times out (see exec). */
const UPLOAD_WORDING_BYTES = 256 * 1024;

/**
 * How long to wait for a request: what is being sent scales it, a body with
 * files or a large JSON one alike. An archive's header for a few hundred
 * members, or a page of its messages, runs to megabytes, and held to the
 * plain timeout a transfer over a slow uplink was cut off at the same step
 * every time it was tried.
 */
export function timeoutFor(form, body = null) {
  let bytes = 0;
  if (form) {
    try {
      for (const [, v] of form) if (v && typeof v.size === 'number') bytes += v.size;
    } catch {
      /* not iterable here */
    }
  } else if (typeof body === 'string') bytes = body.length;
  return budgetFor(bytes);
}

/**
 * How long the bytes of a downloaded file get, once the answer has begun:
 * by the length it declares, as an upload of that size gets, else the same
 * ceiling. The timer that times the answer used to run on through the body,
 * so a 10 MB attachment on a slow downlink was cut off at 20 s every time
 * it was asked for, where its upload had been given five minutes.
 */
export function bodyTimeoutFor(res) {
  const len = Number(res?.headers?.get?.('content-length'));
  return len > 0 ? budgetFor(len) : UPLOAD_TIMEOUT_MS;
}

const timeoutError = () => new DOMException('The request timed out', 'TimeoutError');

/**
 * A JSON answer, read as it comes in. The one timer of a request used to run
 * on through the body, so an answer of a few megabytes (a page of an export,
 * the header of a large workspace) on a slow link was cut off at the plain
 * timeout every time it was asked for, and the export or the transfer failed
 * at the same step on every try. The body is read a piece at a time and the
 * timer re-armed with each (`rearm`): an answer that keeps coming is never
 * given up on, one that stops is, after the plain timeout, as before. An
 * answer with no stream to read (an older runtime's) is taken whole.
 */
async function readJson(res, rearm) {
  const reader = res.body?.getReader?.();
  if (!reader) return await res.json();
  const dec = new TextDecoder();
  let text = '';
  rearm?.(TIMEOUT_MS);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    rearm?.(TIMEOUT_MS);
  }
  return JSON.parse(text + dec.decode());
}

/**
 * A blob answer (an attachment, a photo, an icon, a preview's picture), read
 * as it comes in with the timer re-armed for each piece, as readJson reads a
 * JSON one: bytes that keep coming are never given up on, and a body that
 * stops coming is, after the plain timeout of silence. Given the time its
 * declared length earned instead (see bodyTimeoutFor), a file on a link
 * slower than the budget assumed was cut off at the same point on every
 * try, and one whose declared length fell short of the body was cut off
 * after the plain timeout however steadily it came. The type is the one the
 * worker sent, as res.blob() would carry it, so a blob handed back to
 * another worker (the icon a move carries across) is taken for what it is.
 * An answer with no stream to read (an older runtime's) is taken whole,
 * within the budget its length earns, as before.
 */
async function readBlob(res, rearm) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    rearm?.(bodyTimeoutFor(res));
    return await res.blob();
  }
  const chunks = [];
  rearm?.(TIMEOUT_MS);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    rearm?.(TIMEOUT_MS);
  }
  return new Blob(chunks, { type: String(res.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase() });
}

async function exec(base, method, path, { body, form, blob, keepalive } = {}) {
  if (!base) throw new ApiError(0, 'no_backend', 'This workspace has no server address');
  const init = { method, headers: {} };
  // A request sent as the page goes (a seat given up on pagehide) outlives it only as keepalive.
  if (keepalive) init.keepalive = true;
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  // One timer for the request, re-armed for a file's bytes once the answer
  // has begun (see bodyTimeoutFor); it is cleared on every way out.
  let ctl = null;
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(timeoutError()), ms);
  };
  try {
    ctl = new AbortController();
    init.signal = ctl.signal;
    arm(timeoutFor(form, init.body));
  } catch {
    ctl = null; /* no AbortController in this runtime */
  }
  let res;
  try {
    res = await puter.workers.exec(base.replace(/\/+$/, '') + path, init);
  } catch (e) {
    clearTimeout(timer);
    // A request that carried a file, or a body the size of an archive's page,
    // and ran out of time before the answer began spent that time on the way
    // up: the upload took too long on this link (the budget scales with the
    // bytes, see timeoutFor, but a link slower than it assumes runs out), as a
    // download that stalls is said to have. Told "the server took too long to
    // answer", as every timed-out request was, a member whose attachment did
    // not make it up a slow line blamed a server that was never asked.
    // An abort is this request's own timer where that fired (a runtime that
    // hands the reason on names it TimeoutError; one that does not names a
    // plain AbortError, and read as the network failing, as it used to be,
    // a request that ran out of time said the server could not be reached).
    // One the page itself cut short (a request sent as the page goes) is not.
    if (e?.name === 'TimeoutError' || (e?.name === 'AbortError' && ctl?.signal?.aborted)) {
      const upload = !!form || (typeof init.body === 'string' && init.body.length > UPLOAD_WORDING_BYTES);
      throw new ApiError(0, 'timeout', upload ? 'The upload took too long to finish; check your connection and try again' : 'The server took too long to answer');
    }
    throw new ApiError(0, 'network', 'Could not reach the workspace server');
  }
  try {
    if (!res.ok) {
      // The refusal's body is small, but the timer still running is the
      // request's, and what is left of it may be next to nothing: an upload
      // that took all but the last moment of its budget and was then refused
      // (too large, over the day's allowance) had its refusal cut off as the
      // timer fired, and the member read "Request failed (413)" in place of
      // the worker's own words. The body gets the plain time, as an answer's
      // does (see readJson).
      if (ctl) arm(TIMEOUT_MS);
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* not json */
      }
      if (res.status === 404 && !data) {
        throw new ApiError(404, 'no_backend', 'No Teamchat server answers at this address');
      }
      // A page in place of the worker's JSON, with a status the platform
      // gives when the worker did not get to answer: a gateway standing in
      // for a worker being redeployed or slow to answer (502, 503, 504), a
      // request timed out on the way (408) or held back for a moment (429,
      // 425). Told "Request failed (502)", as it used to be, a member read a
      // number and nothing of what happened or what to do; the code keeps the
      // status (`http_502`), which is what callers that ask again go by.
      if (!data && (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429)) {
        throw new ApiError(res.status, `http_${res.status}`, res.status === 429 || res.status === 425
          ? `The workspace server is busy right now (${res.status}); try again in a moment`
          : `The workspace server did not answer (${res.status}); try again in a moment`);
      }
      throw new ApiError(
        res.status,
        data?.code || data?.error || `http_${res.status}`,
        data?.message || `Request failed (${res.status})`,
      );
    }
    // An answer with no body at all is no Teamchat worker's either: every
    // route answers JSON, a refusal included, and none answers 204, so a 204
    // is a captive portal's or a gateway's word in the worker's place (see
    // the rule below for a page). Taken for an answer, as it used to be, a
    // queued message sent into one was counted as landed and taken out of
    // the outbox, and never reached anyone.
    if (res.status === 204) throw new ApiError(204, 'no_backend', 'No Teamchat server answers at this address');
    if (!blob) {
      // An answer that is not JSON is not a Teamchat worker's: a host that
      // serves a web page at the address (a parked domain, a worker gone and
      // its name taken by something else) is no backend, and is said to be
      // that, the way a 404 with no JSON is, rather than reported as a
      // parsing error over the page's first bytes. A body cut off by the
      // timer, or by the network, is what those are everywhere else.
      try {
        return await readJson(res, ctl ? arm : null);
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ApiError(0, 'timeout', 'The server took too long to answer');
        if (e instanceof SyntaxError) throw new ApiError(res.status, 'no_backend', 'No Teamchat server answers at this address');
        throw new ApiError(0, 'network', 'The answer was cut off');
      }
    }
    try {
      return await readBlob(res, ctl ? arm : null);
    } catch (e) {
      if (e?.name === 'TimeoutError') throw new ApiError(0, 'timeout', 'The download took too long');
      throw new ApiError(0, 'network', 'The download was cut off');
    }
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

/** Split a workspace reference into its worker URL and the id path segment. */
function target(ref) {
  const r = parseRef(ref);
  if (!r) throw new ApiError(400, 'bad_ref', 'That workspace address is not valid');
  return { base: r.url, ws: enc(r.id) };
}

const get = (ref, p) => { const t = target(ref); return exec(t.base, 'GET', p(t.ws)); };
const post = (ref, p, body) => { const t = target(ref); return exec(t.base, 'POST', p(t.ws), { body }); };
const put = (ref, p, body) => { const t = target(ref); return exec(t.base, 'PUT', p(t.ws), { body }); };
const del = (ref, p, opts = {}) => { const t = target(ref); return exec(t.base, 'DELETE', p(t.ws), opts); };

export const api = {
  /* ---- per worker (url) ------------------------------------------------- */
  health: (url) => exec(url, 'GET', '/health'),
  server: (url) => exec(url, 'GET', '/api/server'),
  updateServer: (url, patch) => exec(url, 'PUT', '/api/server', { body: patch }),
  me: (url) => exec(url, 'GET', '/api/me'),
  updateMe: (url, patch) => exec(url, 'PUT', '/api/me', { body: patch }),
  uploadAvatar: (url, blob) => {
    const form = new FormData();
    form.append('file', blob, 'avatar');
    return exec(url, 'POST', '/api/me/avatar', { form });
  },
  removeAvatar: (url) => exec(url, 'DELETE', '/api/me/avatar'),
  avatarBlob: (ref, uuid) => {
    const t = target(ref);
    return exec(t.base, 'GET', `/api/ws/${t.ws}/members/${enc(uuid)}/avatar`, { blob: true });
  },
  createWorkspace: (url, name, profile) => exec(url, 'POST', '/api/workspaces', { body: { name, profile } }),
  createSampleWorkspace: (url, profile) => exec(url, 'POST', '/api/workspaces/sample', { body: { profile } }),
  join: (url, code, profile) => exec(url, 'POST', '/api/join', { body: { code, profile } }),
  /* Shared channels: what a share link leads to, accepting it for a workspace, joining and disconnecting on the host. */
  connectPreview: (url, code) => exec(url, 'GET', `/api/connect/preview?code=${enc(code)}`),
  connectAccept: (url, body) => exec(url, 'POST', '/api/connect/accept', { body }),
  connectJoin: (url, body) => exec(url, 'POST', '/api/connect/join', { body }),
  connectDisconnect: (url, body) => exec(url, 'POST', '/api/connect/disconnect', { body }),
  // A partner's word that one of its people is out (removed, or made a guest): carried to the host so their seat in the shared channel ends now rather than when their standing lapses.
  connectRevoke: (url, body) => exec(url, 'POST', '/api/connect/revoke', { body }),

  /* ---- per workspace (ref) --------------------------------------------- */
  // `heartbeat` marks the caller present as the workspace opens (see the sync poll's hb).
  workspace: (ref, { heartbeat = false, state = null } = {}) => get(ref, (ws) => `/api/ws/${ws}${heartbeat ? `?hb=1${state ? `&st=${enc(state)}` : ''}` : ''}`),
  updateWorkspace: (ref, patch) => put(ref, (ws) => `/api/ws/${ws}`, patch),
  uploadWorkspaceIcon: (ref, blob) => {
    const form = new FormData();
    form.append('file', blob, 'icon');
    const t = target(ref);
    return exec(t.base, 'POST', `/api/ws/${t.ws}/icon`, { form });
  },
  removeWorkspaceIcon: (ref) => del(ref, (ws) => `/api/ws/${ws}/icon`),
  workspaceIconBlob: (ref) => {
    const t = target(ref);
    return exec(t.base, 'GET', `/api/ws/${t.ws}/icon`, { blob: true });
  },
  deleteWorkspace: (ref) => del(ref, (ws) => `/api/ws/${ws}`),
  removeMember: (ref, uuid) => del(ref, (ws) => `/api/ws/${ws}/members/${enc(uuid)}`),
  setRole: (ref, uuid, role) => post(ref, (ws) => `/api/ws/${ws}/members/${enc(uuid)}/role`, { role }),
  // The tab is going: its person is away from now (sent keepalive from pagehide).
  presenceBye: (ref, { keepalive = false } = {}) => del(ref, (ws) => `/api/ws/${ws}/presence`, { keepalive }),
  sync: (ref, since, heartbeat, state = null) => get(ref, (ws) => `/api/ws/${ws}/sync?since=${since}${heartbeat ? '&hb=1' : ''}${heartbeat && state ? `&st=${enc(state)}` : ''}`),

  createChannel: (ref, data) => post(ref, (ws) => `/api/ws/${ws}/channels`, data),
  updateChannel: (ref, ch, patch) => put(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}`, patch),
  deleteChannel: (ref, ch) => del(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}`),
  joinChannel: (ref, ch) => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/join`),
  leaveChannel: (ref, ch) => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/leave`),
  addChannelMembers: (ref, ch, uuids) => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/members`, { uuids }),
  channelMembers: (ref, ch) => get(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/members`),
  channelInvite: (ref, ch, inviteTtl) => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/invites`, { inviteTtl }),
  revokeChannelInvite: (ref, ch) => del(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/invites`),
  /* Shared channels, host side: the share link, and ending a connection. Partner side: the entry, and attestations. */
  connectInvite: (ref, ch, inviteTtl) => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/connect/invites`, { inviteTtl }),
  revokeConnectInvite: (ref, ch) => del(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/connect/invites`),
  disconnectPartner: (ref, ch, conn) => del(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/connections/${enc(conn)}`),
  restoreRemoved: (ref, uuid) => del(ref, (ws) => `/api/ws/${ws}/removed/${enc(uuid)}`),
  addSharedChannel: (ref, body) => post(ref, (ws) => `/api/ws/${ws}/channels/shared`, body),
  attest: (ref, ch, kind = 'join') => post(ref, (ws) => `/api/ws/${ws}/channels/${enc(ch)}/attest`, { kind }),
  guests: (ref) => get(ref, (ws) => `/api/ws/${ws}/guests`),
  pushUnsubscribe: (ref, endpoint) => { const t = target(ref); return exec(t.base, 'DELETE', `/api/ws/${t.ws}/push`, { body: { endpoint } }); },
  pushRegister: (ref, body) => post(ref, (ws) => `/api/ws/${ws}/pn`, body),
  pushUnregister: (ref) => del(ref, (ws) => `/api/ws/${ws}/pn`),
  exportPage: (ref, cursor) => get(ref, (ws) => `/api/ws/${ws}/export${cursor ? `?cursor=${enc(JSON.stringify(cursor))}` : ''}`),
  importCreate: (url, header, from, profile) => exec(url, 'POST', '/api/workspaces/import', { body: { header, from, profile } }),
  importPage: (ref, page) => post(ref, (ws) => `/api/ws/${ws}/import`, page),
  importFile: (ref, id, blob, name, owner) => {
    const form = new FormData();
    form.append('file', blob, name);
    form.append('id', id);
    form.append('name', name);
    if (owner) form.append('owner', owner);
    const t = target(ref);
    return exec(t.base, 'POST', `/api/ws/${t.ws}/import/file`, { form });
  },
  importFinish: (ref) => post(ref, (ws) => `/api/ws/${ws}/import/finish`),
  transfer: (ref, body) => post(ref, (ws) => `/api/ws/${ws}/transfer`, body),
  /* The freeze around a move: the nominee pauses writes on the old copy before exporting (and renews with the same call, naming the same session `sid`, so a freeze another of their sessions holds is refused rather than taken), lets them go if the move fails, and completes as before, which clears it. */
  transferBegin: (ref, sid = null) => post(ref, (ws) => `/api/ws/${ws}/transfer/begin`, sid ? { sid } : undefined),
  transferCancel: (ref) => post(ref, (ws) => `/api/ws/${ws}/transfer/cancel`),
  transferComplete: (ref, to) => post(ref, (ws) => `/api/ws/${ws}/transfer/complete`, { to }),
  integrations: (ref) => get(ref, (ws) => `/api/ws/${ws}/webhooks`),
  createWebhook: (ref, data) => post(ref, (ws) => `/api/ws/${ws}/webhooks`, data),
  rotateWebhook: (ref, id) => post(ref, (ws) => `/api/ws/${ws}/webhooks/${enc(id)}/rotate`),
  deleteWebhook: (ref, id) => del(ref, (ws) => `/api/ws/${ws}/webhooks/${enc(id)}`),
  createBot: (ref, data) => post(ref, (ws) => `/api/ws/${ws}/bots`, data),
  updateBot: (ref, id, patch) => put(ref, (ws) => `/api/ws/${ws}/bots/${enc(id)}`, patch),
  rotateBot: (ref, id) => post(ref, (ws) => `/api/ws/${ws}/bots/${enc(id)}/rotate`),
  deleteBot: (ref, id) => del(ref, (ws) => `/api/ws/${ws}/bots/${enc(id)}`),

  openDm: (ref, members) => post(ref, (ws) => `/api/ws/${ws}/dms`, { members }),

  messages: (ref, conv, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
    const qs = q.toString();
    return get(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages${qs ? `?${qs}` : ''}`);
  },
  send: (ref, conv, data) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages`, data),
  edit: (ref, conv, seq, text) => put(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages/${seq}`, { text }),
  remove: (ref, conv, seq) => del(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages/${seq}`),
  react: (ref, conv, seq, reaction, on) =>
    post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages/${seq}/reactions`, { reaction, on }),
  markRead: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/read`, { seq }),
  markUnread: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/read`, { seq, back: true }),
  inbox: (ref, kind) => get(ref, (ws) => `/api/ws/${ws}/inbox${kind && kind !== 'all' ? `?kind=${enc(kind)}` : ''}`),
  inboxRead: (ref) => post(ref, (ws) => `/api/ws/${ws}/inbox/read`),
  threads: (ref) => get(ref, (ws) => `/api/ws/${ws}/threads`),
  saved: (ref) => get(ref, (ws) => `/api/ws/${ws}/saved`),
  save: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/saved`, { conv, seq }),
  unsave: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/saved`, { conv, seq, remove: true }),
  saveDone: (ref, conv, seq, done) => post(ref, (ws) => `/api/ws/${ws}/saved`, { conv, seq, done }),
  setNotify: (ref, conv, patch) => put(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/notify`, patch),
  schedule: (ref, data) => post(ref, (ws) => `/api/ws/${ws}/scheduled`, data),
  remind: (ref, data) => post(ref, (ws) => `/api/ws/${ws}/reminders`, data),
  scheduled: (ref) => get(ref, (ws) => `/api/ws/${ws}/scheduled`),
  updateScheduled: (ref, id, patch) => put(ref, (ws) => `/api/ws/${ws}/scheduled/${enc(id)}`, patch),
  deleteScheduled: (ref, id) => del(ref, (ws) => `/api/ws/${ws}/scheduled/${enc(id)}`),
  unfurl: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages/${seq}/unfurl`),
  removeUnfurl: (ref, conv, seq) => del(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/messages/${seq}/unfurl`),
  unfurlImageBlob: (ref, hash) => {
    const t = target(ref);
    return exec(t.base, 'GET', `/api/ws/${t.ws}/unfurl-image/${enc(hash)}`, { blob: true });
  },
  pins: (ref, conv) => get(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/pins`),
  pin: (ref, conv, seq) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/pins`, { seq }),
  unpin: (ref, conv, seq) => del(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/pins/${seq}`),
  // `first` marks the write that starts a typing burst, the one the worker
  // signals events subscribers on (see the design doc's events signalling
  // section); every other write in the burst leaves it unset.
  typing: (ref, conv, stop = false, first = false) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/typing`, stop ? { stop: true } : (first ? { first: true } : {})),
  // A fresh events handle for the caller alone, when the one they hold is refused (see the worker's events route).
  remintEvents: (ref) => post(ref, (ws) => `/api/ws/${ws}/events/handle`),
  /*
   * Huddles: take (or keep) a seat in the conversation's huddle under one's
   * own peer invite; give it up. `sid` names the tab, and `join` its first
   * post, so a heartbeat from a tab whose seat another tab took is refused
   * rather than taking it back, and a leave gives up only this tab's seat.
   */
  huddleJoin: (ref, conv, invite, { sid = null, join = false } = {}) => post(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/huddle`, { invite, sid: sid || undefined, join }),
  huddleLeave: (ref, conv, { sid = null, keepalive = false } = {}) => del(ref, (ws) => `/api/ws/${ws}/conv/${enc(conv)}/huddle${sid ? `?sid=${enc(sid)}` : ''}`, { keepalive }),

  search: (ref, params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    return get(ref, (ws) => `/api/ws/${ws}/search?${q.toString()}`);
  },
  reindex: (ref, state) => post(ref, (ws) => `/api/ws/${ws}/search/reindex`, { state }),

  upload: (ref, file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    const t = target(ref);
    return exec(t.base, 'POST', `/api/ws/${t.ws}/files`, { form });
  },
  fileBlob: (ref, id) => {
    const t = target(ref);
    return exec(t.base, 'GET', `/api/ws/${t.ws}/files/${enc(id)}`, { blob: true });
  },
  // The uploader takes back an upload nothing names yet (a file picked into the box and taken out again before sending).
  deleteFile: (ref, id) => del(ref, (ws) => `/api/ws/${ws}/files/${enc(id)}`),
};
