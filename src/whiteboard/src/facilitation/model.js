// Workshop facilitation state: reactions, dot votes, polls, private mode,
// board locks, staged frames, agenda runs, attendance, and result history.
// Everything lives in one flat map of atomic JSON registers, outside drawing
// Undo/Redo. Participant-owned registers carry the owner's account ID in
// their key, so concurrent votes and reactions from different people merge,
// and the worker can check that each person only changes their own entries.
import { ROLES, canEditContent, canManage } from "../collaboration/protocol.js";
import {
  isConnector,
  lockedPlaces,
  orderedFrames,
  updateConnectors,
} from "../scene.js";
import { setObjectHeight } from "../geometry.js";
import { timerPhase } from "../timer.js";
import { canonicalLanguage } from "../accessibility/language-tag.js";
import { sliceTextRuns, validateTextRuns } from "../rich-text.js";
import { sameJSON } from "../same-json.js";

export const REACTIONS = [
  ["thumbs", "👍", "Thumbs up"],
  ["heart", "❤️", "Heart"],
  ["laugh", "😂", "Laugh"],
  ["celebrate", "🎉", "Celebrate"],
  ["idea", "💡", "Idea"],
  ["question", "❓", "Question"],
  ["plus", "➕", "Plus one"],
  ["eyes", "👀", "Eyes"],
];
const REACTION_KEYS = new Set(REACTIONS.map((r) => r[0]));
export const WORKSHOP_LIMITS = {
  keys: 20000,
  reactions: 10000,
  ballots: 2000,
  answers: 2000,
  contributions: 5000,
  participants: 512,
  history: 50,
  votes: 20,
  targets: 5000,
  options: 12,
  steps: 60,
  hidden: 500,
  protected: 5000,
  results: 5000,
};
// Late ballots queued while offline are rejected shortly after the deadline.
export const VOTE_GRACE = 5000;
const MANAGED = new Set([
  "settings",
  "session",
  "agenda",
  "run",
  "vote",
  "poll",
]);
const LOCKS = ["open", "contribute", "frozen"];

const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v, allowed) =>
  object(v) && Object.keys(v).every((k) => allowed.includes(k));
const text = (v, max) =>
  typeof v === "string" && v.length > 0 && v.length <= max;
const token = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const actor = (v) => text(v, 200);
const objectId = (v) => text(v, 256);
const time = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;
const count = (v, max = 1e9) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const same = sameJSON;
const unique = (list) => new Set(list).size === list.length;
const list = (v, max, check) =>
  Array.isArray(v) && v.length <= max && v.every(check);

// Keys are unambiguous for any identifier: the prefix names the register kind
// and the rest is a JSON array of its identity.
const keyOf = (kind, parts) => `${kind}:${JSON.stringify(parts)}`;
export const voteKey = (vote, by) => keyOf("v", [vote, by]);
export const answerKey = (poll, by) => keyOf("a", [poll, by]);
export const reactionKey = (by, target) => keyOf("r", [by, ...target]);
export const contributionKey = (id) => keyOf("c", [id]);
export const participantKey = (by) => keyOf("p", [by]);
export const historyKey = (id) => `h:${id}`;
export const objectTarget = (id) => ["o", id];
export const messageTarget = (thread, message) => ["m", thread, message];
export function keyKind(key) {
  if (MANAGED.has(key)) return key;
  const kind = key.slice(0, 2);
  return ["v:", "a:", "r:", "c:", "p:", "h:"].includes(kind) ? kind[0] : null;
}
const validTarget = (t) =>
  Array.isArray(t) &&
  ((t.length === 2 && t[0] === "o" && objectId(t[1])) ||
    (t.length === 3 && t[0] === "m" && text(t[1], 128) && text(t[2], 128)));
const targetText = (t) => JSON.stringify(t);
const validTextLanguage = (text, lang, runs) => {
  try {
    if (lang !== undefined && !canonicalLanguage(lang)) return false;
    validateTextRuns(text, runs);
    return !runs?.some((run) =>
      Object.keys(run.style).some((key) => key !== "lang"),
    );
  } catch {
    return false;
  }
};

function validRegister(key, v) {
  const kind = keyKind(key);
  if (kind === "settings")
    return (
      only(v, ["lock", "private", "anonymous", "stage", "hide", "protect"]) &&
      (v.hide === undefined ||
        v.hide === null ||
        (list(v.hide, WORKSHOP_LIMITS.hidden, objectId) && unique(v.hide))) &&
      (v.protect === undefined ||
        v.protect === null ||
        (list(v.protect, WORKSHOP_LIMITS.protected, objectId) &&
          unique(v.protect))) &&
      (v.lock === undefined || LOCKS.includes(v.lock)) &&
      (v.private === undefined || v.private === null || token(v.private)) &&
      (v.anonymous === undefined || typeof v.anonymous === "boolean") &&
      (v.stage === undefined ||
        v.stage === null ||
        (only(v.stage, ["frames", "shown"]) &&
          list(v.stage.frames, WORKSHOP_LIMITS.steps, objectId) &&
          unique(v.stage.frames) &&
          count(v.stage.shown, v.stage.frames.length)))
    );
  if (kind === "session")
    return (
      only(v, ["id", "state", "startedAt", "endedAt"]) &&
      token(v.id) &&
      ["active", "ended"].includes(v.state) &&
      time(v.startedAt) &&
      (v.endedAt === undefined || time(v.endedAt))
    );
  if (kind === "agenda")
    return (
      only(v, ["steps"]) &&
      list(
        v.steps,
        WORKSHOP_LIMITS.steps,
        (s) =>
          only(s, ["frame", "minutes", "text", "skip", "lang", "textRuns"]) &&
          objectId(s.frame) &&
          (s.minutes === undefined || count(s.minutes, 600)) &&
          (s.text === undefined || text(s.text, 1000)) &&
          validTextLanguage(s.text || "", s.lang, s.textRuns) &&
          (s.skip === undefined || typeof s.skip === "boolean"),
      ) &&
      unique(v.steps.map((s) => s.frame))
    );
  if (kind === "run")
    return (
      only(v, ["id", "state", "step", "frame", "startedAt", "stepAt"]) &&
      token(v.id) &&
      ["running", "ended"].includes(v.state) &&
      count(v.step, 1000) &&
      (v.frame === undefined || objectId(v.frame)) &&
      time(v.startedAt) &&
      time(v.stepAt)
    );
  if (kind === "vote")
    return (
      only(v, [
        "id",
        "title",
        "titleLang",
        "titleRuns",
        "votes",
        "multiple",
        "anonymous",
        "hidden",
        "targets",
        "state",
        "revealed",
        "startedAt",
        "endsAt",
        "endedAt",
      ]) &&
      token(v.id) &&
      text(v.title, 200) &&
      validTextLanguage(v.title, v.titleLang, v.titleRuns) &&
      Number.isSafeInteger(v.votes) &&
      v.votes >= 1 &&
      v.votes <= WORKSHOP_LIMITS.votes &&
      ["multiple", "anonymous", "hidden", "revealed"].every(
        (k) => typeof v[k] === "boolean",
      ) &&
      list(v.targets, WORKSHOP_LIMITS.targets, objectId) &&
      v.targets.length > 0 &&
      unique(v.targets) &&
      ["active", "ended"].includes(v.state) &&
      time(v.startedAt) &&
      time(v.endsAt) &&
      (v.endedAt === undefined || time(v.endedAt))
    );
  if (kind === "poll")
    return (
      only(v, [
        "id",
        "question",
        "questionLang",
        "questionRuns",
        "options",
        "multiple",
        "anonymous",
        "hidden",
        "state",
        "revealed",
        "startedAt",
        "endedAt",
      ]) &&
      token(v.id) &&
      text(v.question, 300) &&
      validTextLanguage(v.question, v.questionLang, v.questionRuns) &&
      list(
        v.options,
        WORKSHOP_LIMITS.options,
        (o) =>
          only(o, ["id", "text", "lang", "textRuns"]) &&
          token(o.id) &&
          text(o.text, 200) &&
          validTextLanguage(o.text, o.lang, o.textRuns),
      ) &&
      v.options.length >= 2 &&
      unique(v.options.map((o) => o.id)) &&
      ["multiple", "anonymous", "hidden", "revealed"].every(
        (k) => typeof v[k] === "boolean",
      ) &&
      ["open", "closed"].includes(v.state) &&
      time(v.startedAt) &&
      (v.endedAt === undefined || time(v.endedAt))
    );
  if (kind === "h")
    return (
      only(v, [
        "kind",
        "id",
        "title",
        "titleLang",
        "titleRuns",
        "startedAt",
        "endedAt",
        "anonymous",
        "hidden",
        "participants",
        "targets",
        "results",
      ]) &&
      key === historyKey(v.id) &&
      (v.hidden === undefined || typeof v.hidden === "boolean") &&
      token(v.id) &&
      ["vote", "poll"].includes(v.kind) &&
      text(v.title, 300) &&
      validTextLanguage(v.title, v.titleLang, v.titleRuns) &&
      time(v.startedAt) &&
      time(v.endedAt) &&
      typeof v.anonymous === "boolean" &&
      count(v.participants, 100000) &&
      (v.targets === undefined ||
        (v.kind === "vote" && count(v.targets, WORKSHOP_LIMITS.targets))) &&
      list(
        v.results,
        WORKSHOP_LIMITS.results,
        (r) =>
          only(r, ["id", "label", "count", "voters", "lang", "textRuns"]) &&
          objectId(r.id) &&
          typeof r.label === "string" &&
          r.label.length <= 300 &&
          validTextLanguage(r.label, r.lang, r.textRuns) &&
          count(r.count) &&
          (r.voters === undefined ||
            (!v.anonymous && list(r.voters, 512, (n) => text(n, 100)))),
      )
    );
  const named = (r) => r.name === undefined || text(r.name, 100);
  if (kind === "v")
    return (
      only(v, ["vote", "by", "ids", "at", "name"]) &&
      key === voteKey(v.vote, v.by) &&
      token(v.vote) &&
      actor(v.by) &&
      list(v.ids, WORKSHOP_LIMITS.votes, objectId) &&
      time(v.at) &&
      named(v)
    );
  if (kind === "a")
    return (
      only(v, ["poll", "by", "ids", "at", "name"]) &&
      key === answerKey(v.poll, v.by) &&
      token(v.poll) &&
      actor(v.by) &&
      list(v.ids, WORKSHOP_LIMITS.options, token) &&
      unique(v.ids) &&
      time(v.at) &&
      named(v)
    );
  if (kind === "r")
    return (
      only(v, ["by", "target", "types", "at", "name"]) &&
      actor(v.by) &&
      validTarget(v.target) &&
      key === reactionKey(v.by, v.target) &&
      list(v.types, REACTIONS.length, (k) => REACTION_KEYS.has(k)) &&
      v.types.length > 0 &&
      unique(v.types) &&
      time(v.at) &&
      named(v)
    );
  if (kind === "c") {
    let id;
    try {
      [id] = JSON.parse(key.slice(2));
    } catch {
      return false;
    }
    return (
      only(v, ["by", "at", "name", "round", "anonymous"]) &&
      objectId(id) &&
      key === contributionKey(id) &&
      actor(v.by) &&
      time(v.at) &&
      named(v) &&
      (v.round === undefined || token(v.round)) &&
      (v.anonymous === undefined || v.anonymous === true) &&
      !(v.anonymous && v.name !== undefined)
    );
  }
  if (kind === "p")
    return (
      only(v, ["by", "name", "role", "session", "first", "last"]) &&
      actor(v.by) &&
      key === participantKey(v.by) &&
      text(v.name, 100) &&
      text(v.role, 20) &&
      (v.session === undefined || token(v.session)) &&
      time(v.first) &&
      time(v.last) &&
      v.last >= v.first
    );
  return false;
}

// Register keys by kind, as validateWorkshop counts them against its limits.
export function workshopCounts(keys) {
  const tally = { keys: 0, r: 0, v: 0, a: 0, c: 0, p: 0, h: 0 };
  for (const key of keys) {
    tally.keys++;
    const kind = keyKind(key);
    if (kind in tally) tally[kind]++;
  }
  return tally;
}
// `allowed` raises each limit to a count the board already holds, from
// workshopCounts, or to any count given Infinity.
export function validateWorkshop(workshop, allowed = {}) {
  if (workshop === undefined) return;
  if (!object(workshop)) throw Error("Invalid workshop state.");
  const floor = (kind) =>
    typeof allowed === "number" ? allowed : (allowed?.[kind] ?? 0);
  const keys = Object.keys(workshop);
  if (keys.length > Math.max(WORKSHOP_LIMITS.keys, floor("keys")))
    throw Error("This board has reached its workshop activity limit.");
  for (const key of keys)
    if (!validRegister(key, workshop[key]))
      throw Error("Invalid workshop state.");
  const tally = workshopCounts(keys);
  const over = (kind, limit) => tally[kind] > Math.max(limit, floor(kind));
  if (
    over("r", WORKSHOP_LIMITS.reactions) ||
    over("v", WORKSHOP_LIMITS.ballots) ||
    over("a", WORKSHOP_LIMITS.answers) ||
    over("c", WORKSHOP_LIMITS.contributions) ||
    over("p", WORKSHOP_LIMITS.participants) ||
    over("h", WORKSHOP_LIMITS.history)
  )
    throw Error("This board has reached its workshop activity limit.");
}

// Queued local changes win per register; untouched registers take the remote
// value, so concurrent ballots and reactions from others survive.
export function rebaseWorkshop(local, before, remote) {
  // Registers are replaced, never edited, so the remote ones are shared.
  const result = { ...(remote || {}) };
  for (const key of new Set([
    ...Object.keys(local || {}),
    ...Object.keys(before || {}),
  ]))
    if (!same(local?.[key], before?.[key])) {
      if (stale(key, local?.[key], before?.[key], remote?.[key])) continue;
      const base =
        key === "settings" && before?.[key] === undefined && plain(local?.[key])
          ? firstSettings(local[key])
          : before?.[key];
      if (local?.[key] === undefined) delete result[key];
      else if (fieldwise(key, local[key], base, remote?.[key]))
        result[key] = rebaseFields(local[key], base, remote[key], key);
      else result[key] = structuredClone(local[key]);
    }
  for (const key of namedChanges(local, before, result.settings?.anonymous))
    if (result[key]?.name !== undefined)
      result[key] = unnamed(key, result[key]);
  return Object.keys(result).length ? result : undefined;
}
// A device that had not yet heard that anonymous input was turned on, such
// as one offline, puts names on the reactions and contributions it records.
// The worker refuses them, so they are taken off as its changes join the
// board, leaving the reactions and the new objects themselves.
const nameable = (key) => ["r", "c"].includes(keyKind(key));
export function namedChanges(local, before, anonymous) {
  if (!anonymous) return [];
  return Object.keys(local || {}).filter(
    (key) =>
      nameable(key) &&
      local[key]?.name !== undefined &&
      !same(local[key], before?.[key]),
  );
}
function unnamed(key, record) {
  const { name: _, ...rest } = record;
  return keyKind(key) === "c" ? { ...rest, anonymous: true } : rest;
}
// A board's first settings are written in full, with the defaults for the
// fields no one changed, so they merge with another facilitator's first
// settings as changes from the defaults.
function firstSettings(local) {
  const defaults = workshopSettings();
  return Object.fromEntries(
    Object.keys(local)
      .filter((field) => field in defaults)
      .map((field) => [field, defaults[field]]),
  );
}
// Board settings, and the running vote or poll, hold independent fields that
// different facilitators change: locking the board must not undo a reveal
// made meanwhile. They merge field by field while they are the same session.
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function fieldwise(key, local, before, remote) {
  if (![local, before, remote].every(plain)) return false;
  if (key === "settings") return true;
  return (
    ["vote", "poll"].includes(key) &&
    local.id === before.id &&
    remote.id === before.id
  );
}
// A change to a vote or poll that another facilitator has since replaced or
// cleared is stale: revealing or ending it must not bring it back, and
// clearing it must not remove the one that replaced it.
// Likewise, moving through an agenda run that another facilitator has since
// ended or restarted must not bring the old run back.
const stale = (key, local, before, remote) =>
  (["vote", "poll"].includes(key) &&
    plain(before) &&
    (local === undefined || (plain(local) && local.id === before.id)) &&
    remote?.id !== before.id) ||
  (key === "run" &&
    plain(before) &&
    plain(local) &&
    local.id === before.id &&
    local.state === "running" &&
    (remote?.id !== before.id || remote.state !== "running"));
// Staged frames revealed one at a time, shown frames first. Going to an
// agenda step reveals its frame out of turn by moving it up to those shown,
// so a reveal is the same frames with every frame shown before still shown.
const shownFrames = (stage) => stage.frames.slice(0, stage.shown);
function revealOf(after, before) {
  if (!plain(after) || !plain(before)) return false;
  if (after.frames.length !== before.frames.length) return false;
  const frames = new Set(after.frames),
    shown = new Set(shownFrames(after));
  return (
    before.frames.every((id) => frames.has(id)) &&
    shownFrames(before).every((id) => shown.has(id))
  );
}
// Two reveals at once show every frame either showed; the frames still to
// come keep the other facilitator's order.
function mergeReveals(local, remote) {
  const shown = new Set([...shownFrames(remote), ...shownFrames(local)]);
  return {
    frames: [...shown, ...remote.frames.filter((id) => !shown.has(id))],
    shown: shown.size,
  };
}
function rebaseFields(local, before, remote, key) {
  const result = structuredClone(remote);
  for (const field of new Set([...Object.keys(local), ...Object.keys(before)]))
    if (!same(local[field], before[field])) {
      // Revealing a frame of a stage another facilitator has since revealed
      // in full or replaced changes nothing, and two reveals at once both
      // stay.
      if (
        key === "settings" &&
        field === "stage" &&
        revealOf(local.stage, before.stage)
      ) {
        if (revealOf(remote.stage, before.stage))
          result.stage = mergeReveals(local.stage, remote.stage);
        continue;
      }
      if (key === "settings" && (field === "hide" || field === "protect")) {
        const merged = rebaseSet(
          local[field],
          before[field],
          remote[field],
          field === "hide" ? WORKSHOP_LIMITS.hidden : WORKSHOP_LIMITS.protected,
        );
        if (merged) {
          result[field] = merged;
          continue;
        }
      }
      if (local[field] === undefined) delete result[field];
      else result[field] = structuredClone(local[field]);
    }
  return result;
}
// Hidden and facilitator-locked objects are sets that facilitators add to
// and take from, so two facilitators hiding or locking different objects at
// once both keep theirs. Returns null when the merged set would pass its
// limit.
function rebaseSet(local, before, remote, limit) {
  const mine = new Set(local || []),
    had = new Set(before || []);
  const merged = [
    ...(remote || []).filter((id) => mine.has(id) || !had.has(id)),
    ...(local || []).filter((id) => !had.has(id)),
  ];
  const out = [...new Set(merged)];
  return out.length > limit ? null : out;
}

// Imports and duplicates start without a live workshop. The agenda, completed
// results, reactions, and the objects facilitators hid or locked remain as
// reusable, reviewable board content.
export function portableWorkshop(workshop) {
  if (!workshop) return undefined;
  const kept = {};
  for (const [key, value] of Object.entries(workshop))
    if (["agenda", "h", "r"].includes(keyKind(key)))
      kept[key] = structuredClone(value);
  // What the facilitator hid or locked is how the activity was prepared,
  // so a copy for the next session keeps it hidden and locked.
  const settings = {};
  for (const field of ["hide", "protect"])
    if (workshop.settings?.[field]?.length)
      settings[field] = [...workshop.settings[field]];
  if (Object.keys(settings).length) kept.settings = settings;
  return Object.keys(kept).length ? kept : undefined;
}

// Sharing a personal board gives this device's entries the owner's account,
// and its saved results name this device's votes by the owner's name.
export function adoptWorkshop(workshop, from, user, fromName) {
  if (!workshop) return workshop;
  const result = {};
  const name = user.username || "Member";
  const rename = (voters) =>
    [...new Set(voters.map((n) => (n === fromName ? name : n)))].sort();
  for (const [key, value] of Object.entries(workshop)) {
    const kind = keyKind(key);
    if (kind === "h") {
      result[key] = value.results.some((r) => r.voters?.includes(fromName))
        ? {
            ...value,
            results: value.results.map((r) =>
              r.voters ? { ...r, voters: rename(r.voters) } : r,
            ),
          }
        : value;
      continue;
    }
    if (value?.by !== from || !["v", "a", "r", "c"].includes(kind)) {
      if (kind !== "p") result[key] = value;
      continue;
    }
    const next = { ...value, by: user.uuid };
    if (next.name !== undefined) next.name = name;
    const id = kind === "c" ? JSON.parse(key.slice(2))[0] : null;
    result[
      kind === "v"
        ? voteKey(next.vote, next.by)
        : kind === "a"
          ? answerKey(next.poll, next.by)
          : kind === "r"
            ? reactionKey(next.by, next.target)
            : contributionKey(id)
    ] = next;
  }
  return result;
}

export function workshopSettings(board) {
  return {
    lock: "open",
    private: null,
    anonymous: false,
    stage: null,
    ...(board?.workshop?.settings || {}),
  };
}
// A vote whose time limit is shown in the board timer gives that timer an
// ID of its own, and then follows it: pausing, resuming, extending or
// resetting the timer moves the deadline with it. A paused or reset timer
// leaves the vote open with no deadline until it runs again or ends.
export const voteTimerId = (vote) => `vote-${vote.id}`;
// A step's timebox runs on a timer named for the agenda, so moving on to a
// step without one, or ending the agenda, stops it; a timer started by hand
// or for a vote is left alone.
export const agendaTimerId = (run) => `agenda-${run.id}`;
export const agendaTimer = (timer) => /^agenda-/.test(timer?.id || "");
// The board timer counting a running agenda step or a timed vote is the
// facilitator's: participants cannot pause, extend, reset or replace it,
// even on an open board. Once stopped, or run out, it is free again as on
// any board, so a timebox a facilitator left behind does not hold it.
// Returns why a participant cannot change it, or null.
export function facilitatorTimer(workshop, timer, now = Date.now()) {
  if (!["running", "paused"].includes(timerPhase(timer, now))) return null;
  const { run, vote } = workshop || {};
  if (vote?.state === "active" && timer.id === voteTimerId(vote))
    return "Only the owner or a facilitator can change the time left to vote.";
  if (run?.state === "running" && timer.id === agendaTimerId(run))
    return "Only the owner or a facilitator can change the timer of an agenda step.";
  return null;
}
export function voteFollowingTimer(vote, timer) {
  if (vote?.state !== "active" || !timer || timer.id !== voteTimerId(vote))
    return null;
  const endsAt = timer.state === "running" ? timer.endsAt : 0;
  return vote.endsAt === endsAt ? null : { ...vote, endsAt };
}
export const voteOpen = (vote, now = Date.now()) =>
  vote?.state === "active" && (!vote.endsAt || now < vote.endsAt);
export const pollOpen = (poll) => poll?.state === "open";
// Contributions are attributed while any workshop activity is running.
export function recording(board, now = Date.now()) {
  const w = board?.workshop || {},
    s = workshopSettings(board);
  return (
    w.session?.state === "active" ||
    w.run?.state === "running" ||
    voteOpen(w.vote, now) ||
    !!s.private ||
    s.anonymous ||
    s.lock !== "open"
  );
}
const entries = (board, kind) =>
  Object.entries(board?.workshop || {})
    .filter(([key]) => keyKind(key) === kind)
    .map(([, value]) => value);
export const ballots = (board, voteId) =>
  entries(board, "v").filter((b) => b.vote === voteId);
export const answers = (board, pollId) =>
  entries(board, "a").filter((b) => b.poll === pollId);
export const contributions = (board) =>
  Object.entries(board?.workshop || {})
    .filter(([key]) => keyKind(key) === "c")
    .map(([key, value]) => ({ id: JSON.parse(key.slice(2))[0], ...value }));
export const participants = (board) => entries(board, "p");
export const historyRecords = (board) =>
  entries(board, "h").sort((a, b) => b.endedAt - a.endedAt);
export const reactionRecords = (board) => entries(board, "r");
export const myBallot = (board, voteId, me) =>
  board?.workshop?.[voteKey(voteId, me)]?.ids || [];
export const myAnswer = (board, pollId, me) =>
  board?.workshop?.[answerKey(pollId, me)]?.ids || [];

// Ranked tallies. Anonymous sessions never report who chose what.
export function voteTally(board, vote) {
  if (!vote) return [];
  const rows = new Map(
    vote.targets.map((id, n) => [id, { id, count: 0, voters: [], n }]),
  );
  for (const ballot of ballots(board, vote.id))
    for (const id of ballot.ids) {
      const row = rows.get(id);
      if (!row) continue;
      row.count++;
      if (!vote.anonymous && ballot.name && !row.voters.includes(ballot.name))
        row.voters.push(ballot.name);
    }
  return [...rows.values()]
    .sort((a, b) => b.count - a.count || a.n - b.n)
    .map(({ n, voters, ...row }) =>
      vote.anonymous ? row : { ...row, voters: voters.sort() },
    );
}
export function pollTally(board, poll) {
  if (!poll) return [];
  const rows = poll.options.map((o) => ({
    id: o.id,
    text: o.text,
    ...(o.lang !== undefined ? { lang: o.lang } : {}),
    ...(o.textRuns?.length
      ? { textRuns: sliceTextRuns(o.textRuns, 0, o.text.length) }
      : {}),
    count: 0,
    voters: [],
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const answer of answers(board, poll.id))
    for (const id of answer.ids) {
      const row = byId.get(id);
      if (!row) continue;
      row.count++;
      if (!poll.anonymous && answer.name) row.voters.push(answer.name);
    }
  return rows.map(({ voters, ...row }) =>
    poll.anonymous ? row : { ...row, voters: voters.sort() },
  );
}
// A completed session's results, kept in the board's history.
export function resultRecord(board, kind, label, now = Date.now()) {
  const w = board.workshop || {},
    session = kind === "vote" ? w.vote : w.poll,
    titleLang = kind === "vote" ? session.titleLang : session.questionLang,
    titleRuns = kind === "vote" ? session.titleRuns : session.questionRuns,
    title = kind === "vote" ? session.title : session.question;
  // A vote can run over thousands of objects; only those that got a vote
  // are saved, with how many were in the vote, so a big board's history stays
  // small. A poll keeps all of its few options: one nobody chose is part of
  // its result.
  const rows =
    kind === "vote"
      ? voteTally(board, session)
          .filter((r) => r.count > 0)
          .map((r) => {
            // Callers may capture language with the label. Retallying uses
            // that same snapshot rather than the object's current text/tags.
            const value = label(r.id),
              content = typeof value === "string" ? { text: value } : value,
              text = content.text.slice(0, 300);
            return {
              id: r.id,
              label: text,
              count: r.count,
              ...(r.voters?.length ? { voters: r.voters.slice(0, 512) } : {}),
              ...(content.lang !== undefined ? { lang: content.lang } : {}),
              ...(content.textRuns?.length
                ? { textRuns: sliceTextRuns(content.textRuns, 0, text.length) }
                : {}),
            };
          })
      : pollTally(board, session)
          .map((r, n) => ({ ...r, n }))
          .sort((a, b) => b.count - a.count || a.n - b.n)
          .map((r) => ({
            id: r.id,
            label: r.text,
            ...(r.lang !== undefined ? { lang: r.lang } : {}),
            ...(r.textRuns?.length ? { textRuns: r.textRuns } : {}),
            count: r.count,
            ...(r.voters?.length ? { voters: r.voters.slice(0, 512) } : {}),
          }));
  return {
    kind,
    id: session.id,
    title,
    ...(titleLang !== undefined ? { titleLang } : {}),
    ...(titleRuns?.length
      ? { titleRuns: sliceTextRuns(titleRuns, 0, title.length) }
      : {}),
    ...(kind === "vote" ? { targets: session.targets.length } : {}),
    startedAt: session.startedAt,
    endedAt: session.endedAt || now,
    anonymous: session.anonymous,
    // Results the facilitator has not revealed stay hidden in the history.
    hidden: !!session.hidden && !session.revealed,
    participants: (kind === "vote"
      ? ballots(board, session.id)
      : answers(board, session.id)
    ).filter((b) => b.ids.length).length,
    results: rows.slice(0, WORKSHOP_LIMITS.results),
  };
}

// Reactions per target, with names only when the reaction was named.
export function reactionIndex(board) {
  const index = new Map();
  for (const r of reactionRecords(board)) {
    const key = targetText(r.target);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  return index;
}
export function reactionSummary(records = [], me) {
  return REACTIONS.map(([type, emoji, label]) => {
    const people = records.filter((r) => r.types.includes(type));
    return {
      type,
      emoji,
      label,
      count: people.length,
      mine: people.some((r) => r.by === me),
      names: people.filter((r) => r.name && r.by !== me).map((r) => r.name),
    };
  }).filter((r) => r.count);
}
export const targetKey = targetText;

// What this participant must not see. Private notes stay face down for
// everyone but their author until the facilitator reveals the round; staged
// frames stay covered for participants until the facilitator shows them.
// Objects a facilitator hid from participants, with what a hidden frame
// holds, including frames lying inside it and their contents.
export function hiddenObjects(board) {
  const hidden = new Set();
  const list = workshopSettings(board).hide;
  if (!list?.length) return hidden;
  const hide = new Set(list);
  for (const id of framesWithin(board.items, hide)) hide.add(id);
  const placed = lockedPlaces(board.items);
  for (const i of board.items)
    if (hide.has(i.id) || hide.has(i.parentId || placed.get(i.id)))
      hidden.add(i.id);
  return hidden;
}
export function concealment(board, me, manager = false) {
  const notes = new Set(),
    frames = new Set(),
    hidden = new Set();
  const w = board?.workshop;
  if (!w) return { notes, frames, hidden };
  const s = workshopSettings(board);
  if (s.private)
    for (const c of contributions(board))
      if (c.round === s.private && c.by !== me) notes.add(c.id);
  if (s.hide?.length && !manager)
    for (const id of hiddenObjects(board)) hidden.add(id);
  if (s.stage && !manager) {
    for (const id of s.stage.frames.slice(s.stage.shown)) frames.add(id);
    if (frames.size) {
      // Steps already shown stay shown, even inside a later, larger step.
      const nested = framesWithin(board.items, frames);
      for (const id of s.stage.frames.slice(0, s.stage.shown))
        nested.delete(id);
      const placed = lockedPlaces(board.items);
      for (const i of board.items) {
        const parent = i.parentId || placed.get(i.id);
        if (
          (nested.has(i.id) || frames.has(parent) || nested.has(parent)) &&
          !frames.has(i.id)
        )
          hidden.add(i.id);
      }
    }
  }
  // A line to a hidden object would still show where it lies.
  if (hidden.size)
    for (const i of board.items)
      if (i.type === "arrow" && (hidden.has(i.startId) || hidden.has(i.endId)))
        hidden.add(i.id);
  return { notes, frames, hidden };
}
// What the given frames hold, as they move and present with it: their
// objects, frames lying within them with theirs, and locked objects lying
// inside, which never join a frame. The frames themselves are left out.
export function framesContents(items, ids) {
  const frames = new Set(ids);
  for (const id of framesWithin(items, frames)) frames.add(id);
  const placed = lockedPlaces(items);
  return new Set(
    items
      .filter(
        (i) => i.type !== "frame" && frames.has(i.parentId || placed.get(i.id)),
      )
      .map((i) => i.id),
  );
}
// Frames lying inside any of the given frames. Frames are never children of
// other frames, so nesting is by position.
function framesWithin(items, ids) {
  const outer = items.filter((i) => i.type === "frame" && ids.has(i.id));
  const found = new Set();
  if (!outer.length) return found;
  for (const f of items)
    if (
      f.type === "frame" &&
      !ids.has(f.id) &&
      outer.some(
        (o) =>
          f.x >= o.x &&
          f.y >= o.y &&
          f.x + f.w <= o.x + o.w &&
          f.y + f.h <= o.y + o.h,
      )
    )
      found.add(f.id);
  return found;
}

// The step an agenda run is on: its frame's place in the steps now, so
// deleting or reordering earlier frames keeps everyone on the same frame.
export function runStep(run, steps) {
  if (!run || !steps.length) return -1;
  const at = run.frame ? steps.findIndex((s) => s.frame.id === run.frame) : -1;
  return at >= 0 ? at : Math.min(run.step, steps.length - 1);
}
// A frame titled with its timebox, such as "1 · Set the stage (10 min)" in
// the playbooks, runs for that long as an agenda step unless the agenda
// sets its duration; "min" reads the same in French.
export function titleMinutes(title) {
  const m = /\((\d{1,3})\s*min\)\s*$/i.exec(title || "");
  return m ? Math.min(600, +m[1]) : 0;
}
export function agendaSteps(board) {
  const config = new Map(
    (board?.workshop?.agenda?.steps || []).map((s) => [s.frame, s]),
  );
  return orderedFrames(board?.items || [])
    .filter((f) => !config.get(f.id)?.skip)
    .map((frame) => ({
      frame,
      title: frame.text || "",
      minutes: config.get(frame.id)?.minutes ?? titleMinutes(frame.text),
      text: config.get(frame.id)?.text || "",
      ...(config.get(frame.id)?.lang !== undefined
        ? { lang: config.get(frame.id).lang }
        : {}),
      ...(config.get(frame.id)?.textRuns?.length
        ? {
            textRuns: sliceTextRuns(
              config.get(frame.id).textRuns,
              0,
              config.get(frame.id).text.length,
            ),
          }
        : {}),
    }));
}

const itemMap = (items) => new Map(items.map((i) => [i.id, i]));
// Reactions one person may keep on objects or messages that are gone.
const MISSING_REACTIONS = 50;
function targetExists(board, target) {
  if (target[0] === "o") return board.items.some((i) => i.id === target[1]);
  return !!board.comments
    ?.find((t) => t.id === target[1])
    ?.messages.some((m) => m.id === target[2]);
}
const displayName = (user) => user.username || "Member";

// Enforced by the worker, and mirrored by the client before saving. Only the
// owner or a facilitator changes workshop configuration; everyone else may
// only add or remove their own ballots, answers, reactions, and contribution
// records. While a board is locked, participants cannot change others' work.
// A connector attached to objects is re-routed whenever they move, by every
// client, so a change that only follows its ends is not an edit of its own.
function followsEnds(x, y, items) {
  if (!isConnector(x) || !isConnector(y)) return false;
  const line = structuredClone(x);
  const ends = [x.startId, x.endId].map((id) => items.get(id)).filter(Boolean);
  if (!ends.length) return false;
  updateConnectors([line, ...ends]);
  const keys = new Set([...Object.keys(line), ...Object.keys(y)]);
  return [...keys].every((key) => same(line[key], y[key]));
}
// Text that grows with its content is measured again by every client with
// its own fonts, which can change its height (and a rotated text's place).
const growsWithText = (i) => i.type === "text" && i.autoHeight === true;
function reflowed(x, y) {
  if (!growsWithText(x) || !growsWithText(y) || x.h === y.h) return false;
  const text = structuredClone(x);
  setObjectHeight(text, y.h);
  const keys = new Set([...Object.keys(text), ...Object.keys(y)]);
  return [...keys].every((key) => same(text[key], y[key]));
}
// Participants keep their own attendance, which must name a session, never
// claim a facilitator's role, and be true to the clock: "last seen" is never
// in the future, and "first seen" is never before the session started or
// moved earlier, beyond a moment's slack for clock differences and two
// clients recording the same person at once. Only a facilitator removes
// attendance records.
const ATTENDANCE_SLACK = 60000;
function checkAttendance(old, next, session, now) {
  if (!next)
    throw Error(
      "Only the owner or a facilitator can remove attendance records.",
    );
  const earliest =
    session && next.session === session.id
      ? session.startedAt - ATTENDANCE_SLACK
      : 0;
  const moved =
    old?.session === next.session &&
    next.first < old.first &&
    !(
      old.first > now - ATTENDANCE_SLACK &&
      next.first >= old.first - ATTENDANCE_SLACK
    );
  if (
    next.session === undefined ||
    // Not their exact role, which may have changed since their client
    // wrote the record.
    !ROLES.includes(next.role) ||
    canManage(next.role) ||
    next.last > now + ATTENDANCE_SLACK ||
    next.first < earliest ||
    moved
  )
    throw Error("This attendance record is not allowed.");
}
// Workshop registers an update writes, even with unchanged values, which
// still win over the owner's concurrent change: facilitator registers, and
// other participants' ballots, answers, reactions, contributions and
// attendance. Clearing someone else's register is checked with the changes.
export function validateWorkshopWrites(keys, role, user, workshop = {}) {
  if (canManage(role)) return;
  for (const key of keys) {
    const kind = keyKind(key);
    if (MANAGED.has(kind) || kind === "h")
      throw Error(
        "Only the owner or a facilitator can run workshop activities.",
      );
    const record = workshop[key];
    if (kind && record && record.by !== user.uuid)
      throw Error("You can only change your own workshop entries.");
  }
}
// `written`, as the worker reports it, names the objects and roots a change
// wrote values back to unchanged, which would still win over a
// facilitator's concurrent edits.
export function validateWorkshopChanges(
  before,
  after,
  user,
  role,
  now = Date.now(),
  written = null,
) {
  const a = before.workshop || {},
    b = after.workshop || {},
    manage = canManage(role);
  const oldItems = itemMap(before.items),
    newItems = itemMap(after.items);
  let missing;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const old = a[key],
      next = b[key];
    if (same(old, next)) continue;
    const kind = keyKind(key),
      record = next || old;
    if (MANAGED.has(kind) || kind === "h") {
      if (!manage)
        throw Error(
          "Only the owner or a facilitator can run workshop activities.",
        );
      continue;
    }
    if (next?.name !== undefined && next.name !== displayName(user)) {
      if (record.by === user.uuid)
        throw Error("Workshop entries must use your account name.");
    }
    // While anonymous input is on, reactions and contributions are recorded
    // without names, including ones a device saved before it heard of the
    // switch. Named ones from before it stay as they are.
    if (
      next?.name !== undefined &&
      nameable(key) &&
      workshopSettings(before).anonymous
    )
      throw Error("Anonymous input cannot record names.");
    if (kind === "v" || kind === "a") {
      const session = kind === "v" ? b.vote : b.poll,
        sessionId = kind === "v" ? record.vote : record.poll,
        current = session?.id === sessionId;
      if (record.by !== user.uuid) {
        // Facilitators may clear ballots of earlier sessions; results stay in history.
        if (next || !manage || current)
          throw Error("You can only change your own votes.");
        continue;
      }
      // Ballots and answers sent just before a facilitator ended the
      // session are taken, as they are just before a timed vote's deadline,
      // rather than refusing everything else saved with them.
      const late =
        Number.isFinite(session?.endedAt) &&
        now <= session.endedAt + VOTE_GRACE;
      const open =
        current &&
        (kind === "v"
          ? (session.state === "active" &&
              (!session.endsAt || now <= session.endsAt + VOTE_GRACE)) ||
            (session.state === "ended" && late)
          : session.state === "open" || (session.state === "closed" && late));
      if (!next) {
        if (current && !open) throw Error("This session is closed.");
        continue;
      }
      if (!open) throw Error("This session is closed.");
      if (kind === "v") {
        const targets = new Set(session.targets);
        if (
          next.ids.length > session.votes ||
          next.ids.some((id) => !targets.has(id)) ||
          (!session.multiple && !unique(next.ids))
        )
          throw Error("This ballot is not allowed.");
      } else {
        const options = new Set(session.options.map((o) => o.id));
        if (
          next.ids.some((id) => !options.has(id)) ||
          (!session.multiple && next.ids.length > 1)
        )
          throw Error("This answer is not allowed.");
      }
      if (session.anonymous && next.name !== undefined)
        throw Error("Anonymous sessions cannot record names.");
      continue;
    }
    if (kind === "r") {
      if (record.by !== user.uuid) {
        // Whoever deletes content may clear reactions left on it.
        if (next || !canEditContent(role) || targetExists(after, old.target))
          throw Error("You can only change your own reactions.");
        continue;
      }
      // A reaction to an object or message someone deleted at the same
      // moment is harmless: its author's next save clears it. Refusing it
      // would refuse everything else saved with it, as would refusing one
      // to a message still on its way. Only a few are taken per person, so
      // reactions to made-up targets cannot use up the board's limit.
      const gone = (t) =>
        t[0] === "o" ? !newItems.has(t[1]) : !targetExists(after, t);
      if (next && gone(next.target)) {
        missing ??= Object.entries(b).filter(
          ([k, r]) =>
            keyKind(k) === "r" && r?.by === user.uuid && gone(r.target),
        ).length;
        if (missing > MISSING_REACTIONS)
          throw Error("This reaction target no longer exists.");
      }
      continue;
    }
    if (kind === "p") {
      if (record.by !== user.uuid && !manage)
        throw Error(
          "Only the owner or a facilitator can record other participants.",
        );
      if (!manage) checkAttendance(old, next, b.session, now);
      continue;
    }
    if (kind === "c") {
      const id = JSON.parse(key.slice(2))[0];
      if (!old) {
        if (
          next.by !== user.uuid ||
          (next.name !== undefined && next.name !== displayName(user))
        )
          throw Error("Contributions must belong to the signed-in account.");
        if (oldItems.has(id) || !newItems.has(id))
          throw Error("Only new objects can be recorded as your contribution.");
      } else if (next ? !manage : newItems.has(id) && !manage)
        throw Error("Contribution records cannot be changed.");
      continue;
    }
    throw Error("Invalid workshop state.");
  }
  if (manage) return;
  // Facilitator controls over content use the settings in force before this
  // change. Private notes stay protected from other participants' edits.
  const s = { lock: "open", private: null, ...(a.settings || {}) };
  // Objects a facilitator locked stay as they are until a facilitator
  // unlocks them: participants cannot unlock, change or remove them.
  const protect = new Set(s.protect || []);
  if (protect.size)
    for (const id of protect) {
      const x = oldItems.get(id),
        y = newItems.get(id);
      if (
        x?.locked &&
        (!y || !same(x, y) || written?.rewritten?.has(id)) &&
        !(y && (followsEnds(x, y, newItems) || reflowed(x, y)))
      )
        throw Error("Only a facilitator can unlock or change this object.");
    }
  // Staged frames not shown yet, objects a facilitator hid, and what they
  // hold stay the facilitator's until shown, on an open board too:
  // participants cannot change or remove them, nor put objects into such a
  // frame. Only those objects, and objects placed in a frame, are compared.
  if (s.stage || s.hide?.length) {
    const c = concealment(before, user.uuid, false),
      unseen = (id) => c.frames.has(id) || c.hidden.has(id);
    const changed = (id) => {
      const x = oldItems.get(id),
        y = newItems.get(id);
      if (same(x, y) && !written?.rewritten?.has(id)) return false;
      if (x && y) return !followsEnds(x, y, newItems) && !reflowed(x, y);
      // A line goes with an object removed from either end, as every
      // client removes it, so it may lead to something hidden.
      return !(
        x &&
        isConnector(x) &&
        [x.startId, x.endId].some(
          (end) =>
            end && oldItems.has(end) && !newItems.has(end) && !unseen(end),
        )
      );
    };
    if (c.frames.size || c.hidden.size) {
      for (const id of [...c.frames, ...c.hidden])
        if (changed(id))
          throw Error("The facilitator controls part of this selection.");
      for (const y of after.items)
        if (y.parentId && unseen(y.parentId) && changed(y.id))
          throw Error("The facilitator controls part of this selection.");
    }
  }
  if (
    !same(before.timer ?? null, after.timer ?? null) ||
    written?.rewrittenRoots?.has("timer")
  ) {
    const refused =
      facilitatorTimer(a, before.timer, now) ||
      facilitatorTimer(a, after.timer, now);
    if (refused) throw Error(refused);
  }
  if (s.lock === "open" && !s.private) return;
  if (
    s.lock !== "open" &&
    (before.title !== after.title ||
      !same(before.tags || [], after.tags || []) ||
      !same(before.timer ?? null, after.timer ?? null) ||
      !same(before.planning ?? null, after.planning ?? null) ||
      ["board", "tags", "timer"].some((root) =>
        written?.rewrittenRoots?.has(root),
      ))
  )
    throw Error("The facilitator locked this board.");
  for (const id of new Set([
    ...oldItems.keys(),
    ...newItems.keys(),
    ...(written?.rewritten || []),
  ])) {
    const x = oldItems.get(id),
      y = newItems.get(id);
    if (!x && !y) continue;
    // An object that looks the same counts only when a value was written
    // back as it was: tidying stored values, such as a link to a deleted
    // frame, or new layer ranks around a moved object, is not a change.
    if (
      (same(x, y) && !written?.rewritten?.has(id)) ||
      (x && y && (followsEnds(x, y, newItems) || reflowed(x, y)))
    )
      continue;
    const claim = a[contributionKey(id)],
      mine = claim?.by === user.uuid;
    if (s.lock === "frozen") throw Error("The facilitator froze this board.");
    if (s.lock === "contribute") {
      if (!x) {
        if (y.type !== "note" || b[contributionKey(id)]?.by !== user.uuid)
          throw Error(
            "While the board is locked, you can only add sticky notes.",
          );
      } else if (!mine || x.type !== "note" || (y && y.type !== "note"))
        // Their own sticky notes stay sticky notes, so a changed shape
        // cannot bring in what they could not add.
        throw Error(
          "While the board is locked, you can only change your own sticky notes.",
        );
    }
    if (s.private && x && claim?.round === s.private && !mine)
      throw Error(
        "Private notes can only be changed by their author until they are revealed.",
      );
  }
}

// Audit events for facilitation changes, recorded by the worker.
export function workshopEvents(before = {}, after = {}) {
  const events = [];
  const a = before || {},
    b = after || {};
  const push = (action, details) => events.push({ action, details });
  for (const kind of ["vote", "poll"]) {
    const x = a[kind],
      y = b[kind];
    const live = kind === "vote" ? "active" : "open";
    if (y && (!x || x.id !== y.id) && y.state === live) {
      const content =
        kind === "vote"
          ? { text: y.title, lang: y.titleLang, textRuns: y.titleRuns }
          : {
              text: y.question,
              lang: y.questionLang,
              textRuns: y.questionRuns,
            };
      let end = Math.min(content.text.length, 200);
      if (
        /[\uD800-\uDBFF]/.test(content.text[end - 1] || "") &&
        /[\uDC00-\uDFFF]/.test(content.text[end] || "")
      )
        end--;
      const runs = sliceTextRuns(content.textRuns, 0, end);
      push(`${kind}.started`, {
        id: y.id,
        title: content.text.slice(0, end),
        ...(content.lang !== undefined ? { titleLang: content.lang } : {}),
        ...(runs.length ? { titleRuns: runs } : {}),
        anonymous: y.anonymous,
      });
    }
    if (x && y && x.id === y.id) {
      if (x.state === live && y.state !== live)
        push(kind === "vote" ? "vote.ended" : "poll.closed", { id: y.id });
      if (!x.revealed && y.revealed) push(`${kind}.revealed`, { id: y.id });
    }
  }
  // Results of an earlier vote or poll revealed from History. The current
  // one's own reveal is recorded above, when it happens.
  for (const [key, record] of Object.entries(b)) {
    if (keyKind(key) !== "h" || record?.hidden || !a[key]?.hidden) continue;
    if (b[record.kind]?.id === record.id) continue;
    push(`${record.kind}.revealed`, { id: record.id });
  }
  const x = { lock: "open", private: null, anonymous: false, ...a.settings },
    y = { lock: "open", private: null, anonymous: false, ...b.settings };
  if (!!x.private !== !!y.private || (x.private && y.private !== x.private))
    push("workshop.private_mode", {
      enabled: !!y.private,
      ...(x.private && !y.private ? { revealed: true } : {}),
    });
  if (x.lock !== y.lock)
    push("workshop.locked", { lock: y.lock, locked: y.lock !== "open" });
  if (x.anonymous !== y.anonymous)
    push("workshop.anonymous", { enabled: y.anonymous });
  if (!same(x.stage ?? null, y.stage ?? null))
    push("workshop.staged", {
      frames: y.stage?.frames.length || 0,
      shown: y.stage?.shown ?? null,
    });
  if (!same(x.hide ?? null, y.hide ?? null))
    push("workshop.hidden", { objects: y.hide?.length || 0 });
  if (!same(x.protect ?? null, y.protect ?? null))
    push("workshop.protected", { objects: y.protect?.length || 0 });
  if (!same(a.run, b.run) && b.run)
    push("workshop.agenda", { state: b.run.state, step: b.run.step });
  if (a.session?.state !== b.session?.state && b.session)
    push(
      b.session.state === "active"
        ? "workshop.session.started"
        : "workshop.session.ended",
      { id: b.session.id },
    );
  return events;
}
