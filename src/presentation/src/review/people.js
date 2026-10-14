// Who is writing a comment, and the people a comment can mention.
//
// Signed in, the reviewer is their Puter user; otherwise they are asked for a
// name once (offered "Guest"), which the browser remembers.

const NAME_KEY = "presentation:reviewer-name";

export function storedGuestName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}
export function rememberGuestName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {}
}

export function initialsOf(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  return words
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join("");
}

/** The reviewer: the signed-in account, else the remembered guest name. */
export function currentReviewer(account) {
  if (account?.username)
    return {
      name: account.username,
      userId: account.username,
      initials: initialsOf(account.username),
      providerId: "None",
      signedIn: true,
    };
  const name = storedGuestName();
  return name
    ? {
        name,
        userId: name,
        initials: initialsOf(name),
        providerId: "None",
        signedIn: false,
      }
    : null;
}

/** The same person: by user id where both have one, else by name. */
export const samePerson = (a, b) =>
  !!a &&
  !!b &&
  ((a.userId && b.userId && a.userId === b.userId) || a.name === b.name);

/**
 * The people a comment can mention: the deck's authors and the reviewer,
 * each once, sorted by name.
 */
export function mentionCandidates(people, me) {
  const out = [];
  for (const p of [...(me ? [me] : []), ...people]) {
    if (!p?.name) continue;
    if (out.some((q) => q.name === p.name)) continue;
    out.push({ name: p.name, initials: p.initials || initialsOf(p.name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The mention being typed at `caret`: "@" at the start of a word and what
 * follows it, or null. Names may hold spaces, so the query runs to the
 * caret.
 */
export function mentionQuery(text, caret) {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s([{"'“‘]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\n/.test(query)) return null;
  // Two words at most before the list gives up.
  if (query.split(/\s+/).length > 3) return null;
  return { start: at, query };
}

/** Candidates whose name or any word of it starts with the query. */
export function filterMentions(candidates, query) {
  const q = query.trim().toLowerCase();
  if (!q) return candidates.slice(0, 8);
  return candidates
    .filter((c) => {
      const n = c.name.toLowerCase();
      return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
    })
    .slice(0, 8);
}

/**
 * The text split into plain pieces and mentions of known people:
 * [{ text, mention?: name }].
 */
export function splitMentions(text, names) {
  const known = [...new Set(names.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (!known.length) return [{ text }];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@(${known.map(escape).join("|")})`, "g");
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ text: m[0], mention: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The names a text mentions, of those known. */
export const mentionedNames = (text, names) =>
  splitMentions(text, names)
    .filter((p) => p.mention)
    .map((p) => p.mention);

/** A colour for a person's initials, the same every time. */
export function personHue(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

/** "just now", "5 min ago", "3 h ago", or the date. */
export function relativeTime(iso, now = Date.now()) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
