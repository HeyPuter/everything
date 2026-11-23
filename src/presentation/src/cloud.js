import { cleanName, MIME, validateImportSize } from "./model.js";
export const FOLDER = "Presentations";
const sdk = () => {
  if (!globalThis.puter)
    throw new Error(
      "Puter is unavailable. Check your connection and try again.",
    );
  return globalThis.puter;
};
export const isApp = () => globalThis.puter?.env === "app";
export const canSignOut = () => !isApp();
export async function user() {
  try {
    if (await sdk().auth.isSignedIn()) return await sdk().auth.getUser();
  } catch {}
  return null;
}
export async function profilePicture() {
  try {
    return (await sdk().auth.getProfilePicture?.()) || null;
  } catch {
    return null;
  }
}
// The SDK rejects with plain `{ error, msg }` objects rather than Errors. A
// sign-in window the person closed is a decision, not a failure, and a
// blocked pop-up needs advice they can act on.
export async function signIn() {
  try {
    await sdk().auth.signIn();
  } catch (error) {
    if (error?.error === "auth_window_closed")
      throw Object.assign(new Error("Sign-in was cancelled."), {
        code: "cancelled",
      });
    if (error?.error === "popup_blocked")
      throw new Error(
        "The browser blocked the Puter sign-in window. Allow pop-ups for this site and try again.",
        { cause: error },
      );
    if (error instanceof Error) throw error;
    throw new Error(
      error?.msg || error?.message || "Puter sign-in failed. Please try again.",
      { cause: error },
    );
  }
  return sdk().auth.getUser();
}
export async function signOut() {
  if (!canSignOut()) return;
  await sdk().auth.signOut();
}
// On the open web the SDK opens Puter's sign-in before any cloud call made
// without a session, then reports the user here.
export function onAuth(handler) {
  if (globalThis.puter) globalThis.puter.onAuth = handler;
}
export async function listFiles() {
  try {
    return (await sdk().fs.readdir(FOLDER))
      .filter((f) => !f.is_dir && /\.pptx$/i.test(f.name))
      .map((f) => ({ ...f, path: f.path || `${FOLDER}/${f.name}` }));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}
// The SDK reports a missing file through a code, or only through its words.
export function isNotFound(error) {
  const code = error?.code || error?.error?.code || "";
  const message = String(
    error?.message || error?.error?.message || error?.msg || "",
  ).toLowerCase();
  return (
    code === "subject_does_not_exist" ||
    code === "ENOENT" ||
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("no such")
  );
}
export const displayName = (path) =>
  String(path || "")
    .split("/")
    .pop();
export const isPptxName = (name) => /\.pptx$/i.test(String(name || ""));
// The desktop keeps a deleted file in ~/Trash (or /<user>/Trash) under its id.
export const inTrash = (path) =>
  typeof path === "string" && /^(?:\/[^/]+|~)\/Trash(?:\/|$)/.test(path);
// A launch item, a drop from the desktop, or a listing entry naming a folder.
export const isDirItem = (item) =>
  !!(item?.is_dir || item?.isDirectory || item?.isDir || item?.fsentry_is_dir);
// The folder a file sits in, by its last path segment ("Desktop").
export function folderName(path) {
  const parts = String(path || "").split("/");
  return parts.length > 2 ? parts.at(-2) : "";
}
// Is this file directly in the app's own Presentations folder, whichever
// spelling of the folder the path uses?
export function inAppFolder(path) {
  const parts = String(path || "").split("/");
  return parts.length >= 2 && parts.at(-2) === FOLDER;
}
// A file's modification time in milliseconds (Puter reports seconds), or
// null when it is not reported.
export function modifiedMs(item) {
  const m = item?.modified ?? item?.created;
  if (m == null || m === "") return null;
  const n = typeof m === "number" ? m : Number(m) || new Date(m).getTime();
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}
// A file's size in bytes, or null when it is not reported (a PPTX file is
// never empty).
export function sizeOf(item) {
  const size = Number(item?.size);
  return Number.isFinite(size) && size > 0 ? size : null;
}
// Looking a file up is what tells a save whether the file changed, moved, or
// went away since it was opened. An SDK without it saves as before.
export const canStat = () => typeof globalThis.puter?.fs?.stat === "function";
// The file at `path` (null when there is none).
export async function stat(path) {
  try {
    return await sdk().fs.stat(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
// The file with this id, wherever it is now: a file keeps its id when it is
// moved or renamed, here or on the desktop. Null when it is gone.
export async function statByUid(uid) {
  if (!uid || !canStat()) return null;
  try {
    return await sdk().fs.stat({ uid });
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
export async function readFile(path, { importing = false } = {}) {
  const blob = await sdk().fs.read(path);
  if (importing) validateImportSize(blob.size);
  return new Uint8Array(await blob.arrayBuffer());
}
export async function saveFile(bytes, name, path = null) {
  return sdk().fs.write(
    path ||
      `${FOLDER}/${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
    new Blob([bytes], { type: MIME }),
    { overwrite: !!path, dedupeName: !path, createMissingParents: true },
  );
}
// A rename never replaces another file: the drive would refuse it, in words
// meant for developers, or worse, take it.
export async function renameFile(path, name) {
  const fileName = `${cleanName(name)}.pptx`;
  const target = path.slice(0, path.lastIndexOf("/") + 1) + fileName;
  if (
    canStat() &&
    target.toLowerCase() !== path.toLowerCase() &&
    (await stat(target))
  )
    throw Object.assign(
      new Error(
        `A file named “${fileName}” is already in that folder. Choose another name.`,
      ),
      { code: "exists" },
    );
  return sdk().fs.rename(path, fileName);
}
export async function deleteFile(path) {
  return sdk().fs.delete(path);
}
export const canPickFiles = () =>
  typeof globalThis.puter?.ui?.showOpenFilePicker === "function";
export const canSaveFiles = () =>
  typeof globalThis.puter?.ui?.showSaveFilePicker === "function";
// Puter's pickers never settle when they are cancelled; the SDK hangs a
// promise on them that does, with undefined, and older SDKs leave the
// original to wait.
const settleOnCancel = (pending) => pending?.undefinedOnCancel ?? pending;
// Puter's Open dialog: the chosen file, or null when it was cancelled.
export async function pickFile({ accept = [".pptx"] } = {}) {
  const item = await settleOnCancel(
    sdk().ui.showOpenFilePicker({ multiple: false, accept }),
  );
  return (Array.isArray(item) ? item[0] : item) || null;
}
// Puter's Save dialog, which writes `blob` where the person chooses: the file
// it wrote, or null when it was cancelled.
export async function saveFileAs(blob, suggestedName) {
  const item = await settleOnCancel(
    sdk().ui.showSaveFilePicker(blob, suggestedName),
  );
  return item || null;
}
// Inside the Puter desktop a presentation's first file, and a copy, go where
// the person chooses in Puter's Save dialog. Elsewhere they go to the app's
// Presentations folder, a relative path the SDK keeps under the app's data.
export const asksWhereToSave = () => isApp() && canSaveFiles();
// Puter's Save dialog never answers when the desktop fails to write the file.
// A save made while one is open waits for that one, under the same `key`,
// rather than opening another; once the app has the focus back (the desktop
// holds it while its dialog is up) the dialog is gone, answered or not, and
// the next save opens a new one. `open` resolves with what the save did.
const openDialogs = new Map();
export function oneDialog(key, open) {
  const pending = openDialogs.get(key);
  if (pending) return pending;
  const release = () => {
    globalThis.removeEventListener?.("focus", release);
    if (openDialogs.get(key) === done) openDialogs.delete(key);
  };
  const done = Promise.resolve().then(open).finally(release);
  openDialogs.set(key, done);
  globalThis.addEventListener?.("focus", release);
  return done;
}
// What the app was launched with ("Open with", a double-click on the
// desktop) arrives through this, as soon as it is registered. Every item is
// handed on, so a folder or another kind of file can be explained.
export function onLaunch(handler) {
  try {
    globalThis.puter?.ui?.onLaunchedWithItems?.((items) => {
      const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
      if (list.length) handler(list);
    });
  } catch {}
}
// The Puter desktop window's title follows the open presentation.
export function setWindowTitle(title) {
  if (!isApp()) return;
  try {
    globalThis.puter?.ui?.setWindowTitle?.(title)?.catch?.(() => {});
  } catch {}
}
// Take over the Puter window's close button: the window stays open until
// exitApp(). False where the window could then never close.
export function onWindowClose(handler) {
  const ui = globalThis.puter?.ui;
  if (
    !isApp() ||
    typeof ui?.onWindowClose !== "function" ||
    typeof globalThis.puter?.exit !== "function"
  )
    return false;
  try {
    ui.onWindowClose(handler);
    return true;
  } catch {
    return false;
  }
}
export function exitApp() {
  try {
    globalThis.puter?.exit?.();
  } catch {}
}
export async function download(bytes, name) {
  return downloadBlob(
    new Blob([bytes], { type: MIME }),
    `${cleanName(name, { stripExtension: false, maxLength: Infinity })}.pptx`,
  );
}
// A file the app exports is downloaded to this device, inside the Puter
// desktop too (its app frames allow downloads): exporting is the reverse of
// importing from this device, and Save is what puts a file in Puter.
export async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
// Serialize writes so a slow request cannot overwrite a newer revision.
export class SaveQueue {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(work) {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
}
// Puter's AI answers the assistant. It is there wherever the SDK loaded; the
// SDK asks for a sign-in itself on the first request made without one.
export const canAI = () => !!globalThis.puter?.ai?.chat;
// One reply from Puter's AI to a conversation, as it arrives: yields
// { type: "text", text } and { type: "tool", id, name, input } for each
// function the model calls. `messages` take the OpenAI shape Puter accepts
// (system, user, assistant with tool_calls, tool). A reply the SDK hands back
// whole rather than streamed is yielded in the same pieces. A failure throws
// an Error carrying the service's own message and code where it gives them.
//
// `cache` marks a conversation sent again and again as it grows (the
// assistant's): it goes with prompt-cache breakpoints (withCacheBreakpoints).
export async function* aiChatStream(
  messages,
  { model, tools, maxTokens, cache = false } = {},
) {
  const ai = globalThis.puter?.ai;
  if (!ai?.chat) throw new Error("AI is not available here.");
  const options = {
    stream: true,
    ...(model ? { model } : {}),
    // Unpinned, Puter starts a request on whichever route is healthiest,
    // which after anyone's recent failure is a reseller holding none of the
    // conversation in its cache. Pinned, Puter still falls back when it fails.
    ...(model?.startsWith("claude-") ? { provider: "claude" } : {}),
    // Unless asked, Puter lets the model call one tool per reply, so reading
    // three slides took three requests, each sending the whole conversation.
    ...(tools?.length ? { tools, parallelToolCalls: true } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };
  let res;
  try {
    res = await ai.chat(
      cache ? withCacheBreakpoints(messages) : messages,
      options,
    );
  } catch (e) {
    throw aiError(e);
  }
  if (res && typeof res[Symbol.asyncIterator] === "function") {
    try {
      for await (const part of res) {
        if (!part) continue;
        if (part.type === "error" || (part.success === false && part.error))
          throw aiError(part.error || part);
        if (part.type === "tool_use")
          yield {
            type: "tool",
            id: part.id,
            name: part.name,
            input: part.input ?? {},
          };
        else if (
          typeof part.text === "string" &&
          part.text &&
          part.type !== "reasoning"
        )
          yield { type: "text", text: part.text };
      }
    } catch (e) {
      throw aiError(e);
    }
    return;
  }
  if (res?.success === false) throw aiError(res.error || res);
  const message = res?.message || {};
  const content = typeof res === "string" ? res : message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => (typeof c === "string" ? c : c?.text || ""))
            .join("")
        : "";
  if (text) yield { type: "text", text };
  for (const call of message.tool_calls || []) {
    let input = call.function?.arguments ?? {};
    if (typeof input === "string") {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        input = { __unreadable: input };
      }
    }
    yield { type: "tool", id: call.id, name: call.function?.name, input };
  }
}
// Content as blocks with a cache breakpoint on the last one (an empty text
// block cannot take one).
function marked(content, cache) {
  const blocks =
    typeof content === "string"
      ? content
        ? [{ type: "text", text: content }]
        : []
      : [...(content ?? [])];
  const last = blocks.at(-1);
  if (!last || (last.type === "text" && !last.text)) return null;
  blocks[blocks.length - 1] = { ...last, cache_control: cache };
  return blocks;
}
/**
 * The conversation with prompt-cache breakpoints. Puter passes them to
 * Claude, which caches nothing unless asked and takes at most four:
 * - the instructions (the tools, which come before them, are cached with
 *   them, for an hour: they are the same for everyone);
 * - the end of the last finished turn, and on a turn's first request the end
 *   of the one before. Earlier turns are sent shortened (requestMessages),
 *   so they read the same in every later request: a new turn reads them from
 *   the cache the turn before wrote, rather than paying to send them again;
 * - the message that started the current turn;
 * - the newest message, which the next round reads up to.
 * A tool result goes in Claude's own shape, which keeps its breakpoint (an
 * OpenAI tool message loses it on the way). The messages given are not
 * changed.
 */
export function withCacheBreakpoints(messages) {
  const LONG = { type: "ephemeral", ttl: "1h" };
  const SHORT = { type: "ephemeral" };
  const out = [...messages];
  const markAt = (i, cache) => {
    const m = messages[i];
    if (!m) return;
    if (m.role === "tool") {
      if (!m.content) return;
      out[i] = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id,
            content: m.content,
            cache_control: cache,
          },
        ],
      };
      return;
    }
    // On a reply's text a breakpoint would sit before its tool calls.
    if (m.role === "assistant" && m.tool_calls?.length) return;
    const content = marked(m.content, cache);
    if (content) out[i] = { ...m, content };
  };
  if (messages[0]?.role === "system") markAt(0, LONG);
  // Where each turn starts: a user message after the instructions or after
  // a finished reply.
  const starts = [];
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    if (
      messages[i].role === "user" &&
      (prev.role === "system" ||
        (prev.role === "assistant" && !prev.tool_calls?.length))
    )
      starts.push(i);
  }
  const turn = starts.at(-1) ?? -1;
  const last = messages.length - 1;
  if (turn === last && starts.length > 2) markAt(starts.at(-2) - 1, SHORT);
  if (starts.length > 1) markAt(turn - 1, SHORT);
  if (turn > 0 && turn < last) markAt(turn, SHORT);
  if (last > 0) markAt(last, SHORT);
  return out;
}
// The SDK often rejects with a plain { error: { message } } object.
function aiError(e) {
  if (e instanceof Error) return e;
  const inner = e?.error && typeof e.error === "object" ? e.error : e;
  const message =
    inner?.message ||
    (typeof e?.error === "string" ? e.error : "") ||
    (typeof e === "string" ? e : "") ||
    "The AI did not answer.";
  return Object.assign(new Error(message), { code: inner?.code || e?.code });
}
