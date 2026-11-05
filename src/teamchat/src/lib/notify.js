/**
 * Browser notifications, opt-in, and only when the tab is hidden so they
 * never duplicate what is already on screen — and the notification sound,
 * which also plays with the tab in view when the news is from a
 * conversation other than the open one. The policy that decides whether a
 * given event should notify lives here as pure functions (shouldNotify,
 * inQuietHours) so it can be tested without a browser.
 */

/** Default level per kind of conversation: a direct message is always wanted. */
export function defaultLevel(kind) {
  return kind === 'dm' ? 'all' : 'mentions';
}

/**
 * shouldNotify({ event, setting, kind })
 *   event: 'message' (any new message), 'mention' (of the reader, including
 *          broadcasts), 'reply' (in a followed thread)
 *   setting: { level, mute } for the conversation (level may be absent)
 *   kind: 'channel' | 'dm' | 'thread'
 * Muting silences everything, whatever the level. Otherwise `all` hears
 * every message, `mentions` hears mentions (and followed-thread replies,
 * which are an opt-in of their own), and `nothing` hears nothing.
 */
export function shouldNotify({ event, setting = {}, kind = 'channel' }) {
  if (setting.mute) return false;
  const level = setting.level || defaultLevel(kind);
  if (level === 'nothing') return false;
  if (event === 'message') return level === 'all';
  return true; // mention or reply
}

/**
 * Is `now` inside a from–to window given as "HH:MM" strings in local time?
 * A window may cross midnight (22:00 to 08:00). Equal times mean no window.
 */
export function inQuietHours(dnd, now = Date.now()) {
  if (!dnd || !dnd.enabled || !dnd.from || !dnd.to || dnd.from === dnd.to) return false;
  const minutes = (hm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm));
    return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : null;
  };
  const from = minutes(dnd.from);
  const to = minutes(dnd.to);
  if (from == null || to == null) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** Notifications are paused by an explicit pause or by quiet hours. */
export function notificationsPaused(prefs = {}, now = Date.now()) {
  if (prefs.pauseUntil && prefs.pauseUntil > now) return true;
  return inQuietHours(prefs.dnd, now);
}

/** Local-midnight tomorrow, for "pause until tomorrow". */
export function startOfTomorrow(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function notificationsSupported() {
  return typeof Notification !== 'undefined';
}

export function notificationsGranted() {
  return notificationsSupported() && Notification.permission === 'granted';
}

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const res = await Notification.requestPermission();
  return res === 'granted';
}

/* ---- sound ---------------------------------------------------------------- */

let audio = null; // one AudioContext for the life of the page
let lastChime = 0;
/**
 * When a chime last played anywhere in this browser: every tab notes its
 * own here, so two tabs of the app (both in the background, or one of
 * them on another conversation) ring once for one message between them
 * rather than each on its own. This tab's memory serves where storage is
 * not to be had.
 */
const CHIME_KEY = 'teamchat:chime';
function lastChimeAnywhere() {
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(CHIME_KEY)) || 0;
  } catch {
    /* storage unavailable */
  }
  return Math.max(lastChime, stored);
}
function noteChime(at) {
  lastChime = at;
  try {
    localStorage.setItem(CHIME_KEY, String(at));
  } catch {
    /* storage unavailable */
  }
}

/**
 * What was chimed for lately, in every tab of this browser: `[key, at]`
 * pairs under one storage key, kept for a minute. Two tabs poll on clocks
 * of their own, seconds apart, so the two-second quiet after a chime (see
 * chime) told them apart only when their polls happened to land together:
 * both in the background, they rang twice for one message more often than
 * once. Named by the news itself (a caller's `key`: the message's
 * conversation and number), the second tab finds it rung and stays quiet.
 */
const CHIMED_KEY = 'teamchat:chimed';
const CHIMED_FOR_MS = 60_000;
const CHIMED_MAX = 50;
let chimed = []; // this tab's memory, where storage is not to be had
function chimedAlready(key, now) {
  let list = chimed;
  try {
    const stored = JSON.parse(localStorage.getItem(CHIMED_KEY) || '[]');
    if (Array.isArray(stored)) list = stored;
  } catch {
    /* storage unavailable */
  }
  list = list.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && now - e[1] < CHIMED_FOR_MS && e[1] <= now + CHIMED_FOR_MS);
  if (list.some((e) => e[0] === key)) return true;
  list.push([key, now]);
  chimed = list.slice(-CHIMED_MAX);
  try {
    localStorage.setItem(CHIMED_KEY, JSON.stringify(chimed));
  } catch {
    /* storage unavailable */
  }
  return false;
}

/**
 * A soft two-note chime, synthesized so there is no file to load. At most
 * one every two seconds: a busy channel must not turn into a bell choir.
 * A context the browser keeps suspended (no user gesture yet, autoplay
 * blocked) skips the chime rather than queueing it — a resumed context
 * would play every held-back ding at once. With `key` naming the news (a
 * message by its conversation and number), the same news rings once in
 * the browser, whichever tab hears of it first (see chimedAlready).
 */
export function playNotificationSound({ key = null } = {}) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio = audio || new AC();
    if (audio.state === 'running') chime(key);
    else {
      // resume() on a context the browser is still blocking (no gesture
      // yet) parks its promise until the first qualifying gesture and then
      // resolves — minutes later, that would play a stale ding for news
      // long since read. Only a resume that comes back promptly counts.
      const asked = Date.now();
      audio.resume().then(() => { if (audio.state === 'running' && Date.now() - asked < 1000) chime(key); }).catch(() => {});
    }
  } catch { /* no audio here is no reason to break the notification */ }
}

function chime(key = null) {
  const now = Date.now();
  // A note from a moment still to come is the clock's doing, not a chime
  // just rung: the device stood ahead when it was written (an hour, a day)
  // and has been set right since. Held to, it kept every tab of the
  // browser quiet until the clock caught up with it; it is written over.
  const last = lastChimeAnywhere();
  if (last <= now && now - last < 2000) return;
  if (key && chimedAlready(String(key), now)) return;
  noteChime(now);
  const t0 = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = 0.5;
  master.connect(audio.destination);
  const note = (freq, at, dur, peak) => {
    const o = audio.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = audio.createGain();
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(peak, t0 + at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0 + at);
    o.stop(t0 + at + dur + 0.05);
  };
  // G#5 then C#6, a fourth apart, the second with a faint octave shimmer.
  note(830.6, 0, 0.35, 0.22);
  note(1108.7, 0.09, 0.5, 0.2);
  note(2217.5, 0.09, 0.3, 0.045);
}
