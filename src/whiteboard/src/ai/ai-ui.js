import { item, bounds, COLORS, MAX_OBJECTS } from "../model.js";
import { addTranslations, t, language, plural } from "../i18n.js";
import { planClusters, applyClusters } from "../clusters.js";
import {
  createAuthoredField,
  fieldContent,
} from "../facilitation/authored-field.js";
import { authoredTextHTML } from "../accessibility/object-content.js";
import { imageLayout } from "../image-crop.js";

// AI assistance: summaries, grouping sticky notes into themes, turning a photo
// of handwritten notes into digital sticky notes, and generating ideas.
// People in an organization send every request through its worker, which
// enforces the administrator's AI settings. Everyone else uses Puter AI
// directly under their own account and can turn AI off on this device.
export const AI_KEY = "whiteboard-ai-enabled";
const COLOR_NAMES = {
  yellow: COLORS[0],
  green: COLORS[1],
  blue: COLORS[2],
  purple: COLORS[3],
  pink: COLORS[4],
  orange: COLORS[4],
  white: COLORS[5],
};
export function personalAIEnabled(storage) {
  try {
    // Reading localStorage itself throws where the browser blocks storage.
    storage = storage === undefined ? globalThis.localStorage : storage;
    return storage?.getItem(AI_KEY) !== "false";
  } catch {
    return true;
  }
}
// Notes from a model reply, which may list objects or plain strings. Empty
// entries are dropped.
export function replyNotes(parsed) {
  return (Array.isArray(parsed?.notes) ? parsed.notes : [])
    .map((n) => (typeof n === "string" ? { text: n } : n))
    .filter((n) => n && String(n.text ?? "").trim())
    .map((n) => ({ ...n, text: String(n.text).trim() }));
}
// Parse the first JSON object in a model reply, tolerating code fences and
// remarks after it, even ones with braces. A reply that is not JSON gives a
// message people can read, not the parser's.
export function parseJSON(text) {
  const source = String(text || "");
  const start = source.indexOf("{"),
    end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw Error("The AI reply could not be read.");
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {}
  // The object up to the brace that closes the first one, outside strings.
  let depth = 0,
    quoted = false;
  for (let n = start; n <= end; n++) {
    const c = source[n];
    if (quoted) {
      if (c === "\\") n++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && !--depth)
      try {
        return JSON.parse(source.slice(start, n + 1));
      } catch {
        break;
      }
  }
  throw Error("The AI reply could not be read.");
}
export function replyText(response) {
  const content = response?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c.text || "").join("");
  return String(response?.text ?? response ?? "");
}
function promptText(text, limit) {
  let end = Math.min(limit, text.length);
  const previous = text.charCodeAt(end - 1),
    next = text.charCodeAt(end);
  if (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  )
    end--;
  return text.slice(0, end);
}

function hasSummaryText(i) {
  let parts = 0;
  // Two nonempty parts contribute a separator even if both are whitespace.
  for (const value of [i.text, i.fileName, i.url])
    if (value && (++parts > 1 || String(value).trim())) return true;
  for (const row of i.cells || [])
    for (const value of row)
      if (value && (++parts > 1 || String(value).trim())) return true;
  return false;
}

// The text of objects, in reading order, with their kind and frame.
function summaryContent(items, ids, reportShortening = false) {
  const frames = new Map(
    items.filter((i) => i.type === "frame").map((i) => [i.id, i.text]),
  );
  const lines = [];
  let length = 0,
    shortened = false;
  for (const i of items) {
    if ((ids && !ids.has(i.id)) || i.type === "frame") continue;
    if (length === 50_000) {
      if (hasSummaryText(i)) {
        shortened = true;
        break;
      }
      continue;
    }
    const text = [i.text, i.fileName, i.url, ...(i.cells?.flat() || [])]
      .filter(Boolean)
      .join(" | ")
      .trim();
    if (!text) continue;
    const excerpt = promptText(text, 2000);
    shortened ||= excerpt.length < text.length;
    const frame = frames.get(i.parentId),
      line = `${lines.length ? "\n" : ""}- (${i.type}${frame ? `, ${frame}` : ""}) ${excerpt}`,
      room = 50_000 - length;
    if (line.length >= room) {
      lines.push(promptText(line, room));
      shortened ||= line.length > room;
      if (shortened || !reportShortening) break;
    } else lines.push(line);
    length += line.length;
  }
  return { text: lines.join(""), shortened };
}
// What people said about the content and what they decided, for a summary:
// the board's comments, without names, and completed votes and polls with
// their leading results. Threads on content hidden from this person are
// left out, as in Comments; a selection takes only its own threads, and
// results only come with the whole board.
function discussionContent(b, ids, concealed, outcomes) {
  let shortened = false;
  const capped = (lines, limit) => {
    const text = lines.join("\n");
    if (text.length <= limit) return text;
    shortened = true;
    return promptText(text, limit);
  };
  const threads = (b.comments || []).filter(
    (thread) =>
      !concealed.has(thread.anchorId) &&
      (!ids || (thread.anchorId && ids.has(thread.anchorId))),
  );
  const comments = capped(
    threads.flatMap((thread) =>
      thread.messages
        .filter((m) => !m.deleted && m.text?.trim())
        .map(
          (m, n) =>
            `${n ? "  - reply: " : "- "}${promptText(m.text.trim(), 1000)}${n === 0 && thread.resolved ? " (resolved)" : ""}`,
        ),
    ),
    20_000,
  );
  const results = ids
    ? ""
    : capped(
        outcomes().map(
          (r) =>
            `- ${r.kind === "vote" ? "Dot vote" : "Poll"} "${r.title}" (${r.participants} participants): ${r.results.map((x) => `${x.label || "hidden object"} ${x.count}`).join("; ")}`,
        ),
        5_000,
      );
  return { comments, results, shortened };
}
export function boardText(items, ids = null) {
  return summaryContent(items, ids).text;
}
// Only the colour names above, never names every object has, such as
// constructor, which would put a function on the board.
function colorFor(name) {
  const key = String(name || "").toLowerCase();
  return Object.hasOwn(COLOR_NAMES, key) ? COLOR_NAMES[key] : COLORS[0];
}
export function noteGrid(notes, origin, columns = 4) {
  return notes.map((n, index) => {
    const value = String(n.text || ""),
      content = fieldContent(
        { value, lang: n.lang, textRuns: n.textRuns },
        0,
        Math.min(value.length, 2000),
      );
    return item(
      "note",
      origin.x + (index % columns) * 230,
      origin.y + Math.floor(index / columns) * 210,
      {
        ...content,
        color: colorFor(n.color),
        w: 210,
        h: 190,
      },
    );
  });
}
// Shrink an image data URL before sending it to AI.
export async function downscaleDataURL(src, max = 1600, crop) {
  const blob = await (await fetch(src)).blob();
  return downscale(blob, max, crop);
}
async function downscale(file, max = 2000, crop) {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Error("This image could not be read."));
      img.src = url;
    });
    const { source } = imageLayout(
      { crop, x: 0, y: 0, w: 1, h: 1 },
      image.naturalWidth,
      image.naturalHeight,
    );
    const scale = Math.min(1, max / Math.max(source.w, source.h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.w * scale));
    canvas.height = Math.max(1, Math.round(source.h * scale));
    const ctx = canvas.getContext("2d");
    // JPEG has no transparency: transparent pixels would turn black and
    // hide dark writing or drawings on a transparent background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Describe the content people can see on the board. Fill before clipping
    // so masked-out pixels remain white in the JPEG rather than black.
    if (crop?.mask === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        canvas.width / 2,
        canvas.height / 2,
        canvas.width / 2,
        canvas.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.clip();
    }
    ctx.drawImage(
      image,
      source.x,
      source.y,
      source.w,
      source.h,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}
const languageName = (value = language) =>
  value === "fr" ? "Canadian French" : "English";

export function createAI({
  org,
  session,
  board,
  // What this person may see of the board, which is what AI prompts may
  // include: private round notes and hidden objects stay out of them.
  view = board,
  selection,
  modal,
  toast,
  icon,
  mutate,
  center,
  select,
  canEdit,
  fileInput,
  refresh = () => {},
  puter = () => window.puter,
  signIn = () => puter().auth.signIn(),
  // Objects whose comment threads this person cannot see, and the results
  // of completed votes and polls as they see them in History.
  concealed = () => new Set(),
  outcomes = () => [],
}) {
  const reviews = new WeakMap(),
    summaryScopes = new WeakMap(),
    dialogBoards = new WeakMap(),
    observed = new WeakSet(),
    closed = new WeakSet();
  function watchDialog(d) {
    if (observed.has(d)) return;
    observed.add(d);
    dialogBoards.set(d, board());
    d.addEventListener(
      "close",
      () => {
        closed.add(d);
        reviews.get(d)?.destroy();
        reviews.delete(d);
        summaryScopes.delete(d);
        dialogBoards.delete(d);
      },
      { once: true },
    );
  }
  // Navigation leaves this review open. Its requests and saves still belong
  // to the board where it opened, even when another board is now editable.
  function onBoard(d) {
    watchDialog(d);
    if (closed.has(d)) return false;
    if (board() === dialogBoards.get(d)) return true;
    progress(
      d,
      "You’re viewing a different board. Return to the original board to use this draft, or close this dialog and open AI again.",
    );
    return false;
  }
  function replaceWork(d, html) {
    if (!onBoard(d)) return null;
    const work = d.querySelector("#ai-work");
    if (!work) return null;
    reviews.get(d)?.destroy();
    reviews.delete(d);
    work.innerHTML = html;
    return work;
  }
  // Whether AI is available here, and why not when it is not.
  function availability(feature) {
    if (org.info?.role) {
      if (!org.allows("ai"))
        return "Your organization has turned off AI features.";
      if (feature && !org.allows("ai." + feature))
        return "Your organization has turned off this AI feature.";
    }
    // A shared board follows its organization's choices for everyone on
    // it, guests and people from other organizations included.
    const shared = session()?.features?.ai;
    if (shared?.enabled === false)
      return "This board’s organization has turned off AI features.";
    if (feature && shared?.[feature] === false)
      return "This board’s organization has turned off this AI feature.";
    if (org.info?.role) return null;
    return personalAIEnabled()
      ? null
      : "AI features are turned off on this device.";
  }
  // Puter's SDK can reject with a plain object or a string rather than an
  // Error; whatever came back, the dialog shows a reason.
  const reason = (error) =>
    error?.message ||
    error?.error?.message ||
    (typeof error === "string" && error) ||
    "The AI request failed.";
  async function ask(task, prompt, image) {
    try {
      return await request(task, prompt, image);
    } catch (error) {
      throw error?.message ? error : Error(reason(error));
    }
  }
  async function request(task, prompt, image) {
    const feature = {
      summarize: "summaries",
      generate: "summaries",
      describe: "summaries",
      cluster: "clustering",
      handwriting: "handwriting",
    }[task];
    const blocked = availability(feature);
    if (blocked) throw Error(t(blocked));
    // Members use the organization's AI; guests, whose use it does not pay
    // for, use their own Puter account, within the organization's policy.
    if (org.info?.role && org.info.role !== "guest")
      return (
        await org.request("org.ai", {
          task,
          prompt,
          image,
          room: session()?.room,
        })
      ).text;
    const p = puter();
    if (!p?.ai?.chat) throw Error(t("Puter AI is not available."));
    if (!p.auth.isSignedIn()) {
      await signIn();
      // Signing in can reveal an organization, whose policy then applies.
      if (org.info?.role) return request(task, prompt, image);
    }
    if (image) {
      const blob = await (await fetch(image)).blob();
      const file = new File([blob], "notes.jpg", { type: blob.type });
      return replyText(
        await p.ai.chat(prompt, file, false, { normalize: true }),
      );
    }
    return replyText(await p.ai.chat(prompt, false, { normalize: true }));
  }
  function progress(d, message) {
    const out = d.querySelector("#ai-status");
    if (out) out.textContent = t(message);
  }
  // One request runs at a time in a dialog, so a double click or a second
  // action never sends it twice or replaces the first result.
  async function exclusive(d, run) {
    if (d.dataset.aiBusy || !onBoard(d)) return;
    d.dataset.aiBusy = "true";
    d.querySelector("#ai-work")?.setAttribute("aria-busy", "true");
    // The other actions wait, visibly, rather than swallowing clicks.
    const held = [...d.querySelectorAll("[data-ai]")].filter(
      (button) => !button.disabled,
    );
    for (const button of held) button.disabled = true;
    try {
      return await run();
    } finally {
      delete d.dataset.aiBusy;
      d.querySelector("#ai-work")?.removeAttribute("aria-busy");
      for (const button of held)
        if (button.isConnected) button.disabled = false;
    }
  }
  // A save the board refuses, as when a facilitator froze it meanwhile,
  // puts the saved content back and says why; nothing then succeeded.
  function kept(ids) {
    const present = new Set(board().items.map((i) => i.id));
    return [...ids].every((id) => present.has(id));
  }
  function insertNotes(notes) {
    if (!notes.length) return;
    const b = board();
    if (b.items.length + notes.length > MAX_OBJECTS)
      throw Error(t("This would exceed the board limit of 5,000 objects."));
    const c = center();
    const created = noteGrid(notes, { x: c.x - 450, y: c.y - 200 });
    mutate(() => b.items.push(...created));
    const ids = new Set(created.map((i) => i.id));
    if (!kept(ids)) return 0;
    select(ids);
    return created.length;
  }
  const api = {
    availability,
    ask,
    open() {
      const blocked = availability();
      const selected = new Set(selection()),
        selectedCount = selected.size;
      return modal(
        "AI assistant",
        `<p class="dialog-copy">${t(org.info?.role && org.info.role !== "guest" ? "Requests go through your organization, which controls these features and records their use in the audit log." : "Requests use Puter AI with your Puter account. Board content you choose is sent to the AI model.")}</p>${blocked ? `<p class="dialog-copy" role="alert">${t(blocked)}</p>` : ""}<div class="ai-actions"><button class="secondary" data-ai="summarize" ${blocked ? "disabled" : ""}>${icon("text-quote")}<span><strong>${t("Summarize")}</strong><small>${t(selectedCount ? "The selected objects" : "The whole board")}</small></span></button><button class="secondary" data-ai="themes" ${blocked || selectedCount < 2 ? "disabled" : ""}>${icon("group")}<span><strong>${t("Group into themes")}</strong><small>${t("Select two or more sticky notes")}</small></span></button><button class="secondary" data-ai="handwriting" ${blocked ? "disabled" : ""}>${icon("scan-text")}<span><strong>${t("Photo to sticky notes")}</strong><small>${t("Turn handwritten notes into digital ones")}</small></span></button><button class="secondary" data-ai="generate" ${blocked ? "disabled" : ""}>${icon("sparkles")}<span><strong>${t("Generate ideas")}</strong><small>${t("Sticky notes from a prompt")}</small></span></button></div>${org.info?.role ? "" : `<label class="check-field"><input type="checkbox" id="ai-enabled" ${personalAIEnabled() ? "checked" : ""}><span>${t("Allow AI features on this device")}</span></label>`}<div id="ai-work"></div><p id="ai-status" role="status" aria-live="polite"></p>`,
        (d) => {
          watchDialog(d);
          // Keep the scope promised by the action, even if remote changes
          // remove the selection while this dialog remains open.
          summaryScopes.set(d, selectedCount ? selected : null);
          d.classList.add("ai-dialog");
          d.querySelector("#ai-enabled")?.addEventListener("change", (e) => {
            try {
              localStorage.setItem(AI_KEY, String(e.target.checked));
            } catch {}
            d.close();
            // The dialog opens again with the new setting; focus stays on it.
            api.open()?.querySelector("#ai-enabled")?.focus();
          });
          d.querySelectorAll("[data-ai]").forEach((el) => {
            el.onclick = () => d.dataset.aiBusy || api[el.dataset.ai](d);
          });
        },
      );
    },
    async summarize(d) {
      if (!onBoard(d)) return;
      const b = board();
      const ids = summaryScopes.has(d)
        ? summaryScopes.get(d)
        : selection().size
          ? new Set(selection())
          : null;
      const { text: content, shortened: cut } = summaryContent(
        view().items,
        ids,
        true,
      );
      const said = discussionContent(view(), ids, concealed(), outcomes),
        shortened = cut || said.shortened;
      if (!content && !said.comments && !said.results)
        return toast("There is no text to summarize.");
      return exclusive(d, async () => {
        const authoringLanguage = language;
        progress(d, "Summarizing…");
        try {
          const text = await ask(
            "summarize",
            `You are helping a team review a collaborative whiteboard titled "${b.title}". Write in ${languageName(authoringLanguage)}. Summarize the content below in plain text with these parts: a two or three sentence overview, then "Themes:" with short bullet points, then "Decisions:" and "Action items:" when the content contains any. Use simple hyphen bullets and no markdown formatting.${said.comments || said.results ? " Comments and the results of votes and polls, when given, show what people said and decided; use them for the decisions and priorities." : ""}\n\nContent:\n${content}${said.comments ? `\n\nComments:\n${said.comments}` : ""}${said.results ? `\n\nVotes and polls:\n${said.results}` : ""}`,
          );
          const work = replaceWork(
            d,
            `${shortened ? `<p id="ai-summary-scope" class="dialog-copy">${t("Some source text was shortened or left out to fit the summary limit. Check the original content before using this summary.")}</p>` : ""}<div class="field"><span id="ai-summary-label">${t("Summary", "ai")}</span><div id="ai-summary"></div></div><div class="dialog-footer"><button class="secondary" id="ai-copy">${t("Copy")}</button><button class="primary" id="ai-add">${t("Add to board")}</button></div>`,
          );
          if (!work) return;
          const summary = createAuthoredField(
            work.querySelector("#ai-summary"),
            { text: text.trim(), lang: authoringLanguage },
            { maxLength: 20000 },
          );
          summary.style.minHeight = "min(10em, 30dvh)";
          if (shortened)
            summary.setAttribute("aria-describedby", "ai-summary-scope");
          reviews.set(d, summary);
          progress(
            d,
            "Summary ready. Review it before adding it to the board.",
          );
          work.querySelector("#ai-copy").onclick = async () => {
            try {
              const content = fieldContent(summary),
                clipboard = navigator.clipboard;
              if (clipboard?.write && typeof ClipboardItem === "function")
                await clipboard.write([
                  new ClipboardItem({
                    "text/plain": new Blob([content.text], {
                      type: "text/plain",
                    }),
                    "text/html": new Blob(
                      [authoredTextHTML(content).replaceAll("\n", "<br>")],
                      { type: "text/html" },
                    ),
                  }),
                ]);
              else await clipboard.writeText(content.text);
              progress(d, "Copied.");
            } catch {
              summary.focus();
              summary.select();
            }
          };
          work.querySelector("#ai-add").onclick = () => {
            if (!onBoard(d) || !canEdit(new Set())) return;
            if (b.items.length >= MAX_OBJECTS)
              return progress(
                d,
                "This would exceed the board limit of 5,000 objects.",
              );
            const start =
                summary.value.length - summary.value.trimStart().length,
              end = Math.max(
                start,
                Math.min(summary.value.trimEnd().length, start + 20000),
              ),
              content = fieldContent(summary, start, end);
            const area = ids
              ? bounds(b.items.filter((i) => ids.has(i.id)))
              : bounds(b.items);
            const note = item("text", area.x + area.w + 60, area.y, {
              ...content,
              w: 420,
              h: 300,
              autoHeight: true,
            });
            mutate(() => b.items.push(note));
            if (!kept([note.id])) return;
            select(new Set([note.id]));
            d.close();
            toast("Summary added.");
          };
          refresh();
        } catch (error) {
          progress(d, error.message);
        }
      });
    },
    async themes(d) {
      if (!onBoard(d)) return;
      const b = board();
      const notes = b.items.filter(
        (i) => selection().has(i.id) && i.type === "note" && i.text?.trim(),
      );
      if (notes.length < 2)
        return toast("Select two or more sticky notes with text.");
      if (notes.length > 300)
        return toast("Select up to 300 sticky notes at a time.");
      if (!canEdit(new Set(notes.map((n) => n.id)))) return;
      return exclusive(d, async () => {
        const authoringLanguage = language;
        progress(d, "Finding themes…");
        // Organization requests keep up to 60,000 characters, so the notes
        // share 50,000 and every note number reaches the model.
        const room = Math.min(500, Math.floor(50_000 / notes.length));
        try {
          const reply = await ask(
            "cluster",
            `Group these sticky notes from a workshop into 2 to 8 themes. Write theme names in ${languageName(authoringLanguage)}, at most five words each. Every note number must appear in exactly one theme. Reply with JSON only, in this shape: {"themes":[{"name":"Theme name","notes":[1,2]}]}\n\nNotes:\n${notes.map((n, index) => `${index + 1}. ${promptText(n.text.replace(/\s+/g, " "), room)}`).join("\n")}`,
          );
          const parsed = parseJSON(reply);
          if (!Array.isArray(parsed?.themes))
            throw Error("The AI reply could not be read.");
          const seen = new Set();
          const themes = parsed.themes
            .filter((theme) => theme && typeof theme === "object")
            .slice(0, 12)
            .map((theme) => {
              const value = String(theme.name || t("Theme")),
                { text: name, ...declarations } = fieldContent(
                  { value, lang: theme.name ? authoringLanguage : language },
                  0,
                  Math.min(120, value.length),
                );
              return {
                name,
                ...declarations,
                ids: (Array.isArray(theme.notes) ? theme.notes : [])
                  .map((n) => notes[Number(n) - 1]?.id)
                  .filter((id) => id && !seen.has(id) && seen.add(id)),
              };
            })
            .filter((theme) => theme.ids.length);
          const rest = notes.filter((n) => !seen.has(n.id)).map((n) => n.id);
          if (rest.length)
            themes.push({ name: t("Other"), lang: language, ids: rest });
          const work = replaceWork(
            d,
            `<h3>${t("Suggested themes")}</h3><ol class="ai-themes">${themes.map((theme, n) => `<li><div class="field"><span id="ai-theme-${n}-label">${t("Theme name")}</span><div id="ai-theme-${n}"></div></div><small>${plural(theme.ids.length, "{count} note", "{count} notes")}</small></li>`).join("")}</ol><div class="dialog-footer"><button class="primary" id="ai-apply">${t("Arrange into frames")}</button></div>`,
          );
          if (!work) return;
          const inputs = themes.map((theme, n) => {
            const input = createAuthoredField(
              work.querySelector(`#ai-theme-${n}`),
              { text: theme.name, lang: theme.lang },
              { maxLength: 120, multiline: false },
            );
            input.dataset.theme = String(n);
            return input;
          });
          reviews.set(d, {
            destroy: () => inputs.forEach((input) => input.destroy()),
          });
          progress(
            d,
            "Review the themes, rename them if needed, then arrange.",
          );
          work.querySelector("#ai-apply").onclick = () => {
            // Locks can change while the themes are reviewed.
            if (!onBoard(d) || !canEdit(new Set(notes.map((n) => n.id))))
              return;
            try {
              const reviewed = inputs.map((input, n) => {
                const start =
                    input.value.length - input.value.trimStart().length,
                  end = Math.max(
                    start,
                    Math.min(input.value.trimEnd().length, start + 120),
                  ),
                  { text: name, ...declarations } = fieldContent(
                    input,
                    start,
                    end,
                  );
                return {
                  ...(name
                    ? { name, ...declarations }
                    : { name: t("Theme"), lang: language }),
                  ids: themes[n].ids,
                };
              });
              const plan = planClusters(
                b,
                new Set(notes.map((n) => n.id)),
                "themes",
                "",
                {
                  themes: reviewed,
                  other: t("Other"),
                  language,
                },
              );
              let frames;
              mutate(() => (frames = applyClusters(b, plan)));
              if (!frames || !kept(frames)) return;
              select(frames);
              d.close();
              toast("Notes arranged into themes. Undo restores them.");
            } catch (error) {
              progress(d, error.message);
            }
          };
          refresh();
        } catch (error) {
          progress(d, error.message);
        }
      });
    },
    handwriting(d) {
      if (!onBoard(d) || d.dataset.aiBusy) return;
      if (!canEdit(new Set())) return;
      fileInput("image/png,image/jpeg,image/webp", async (file) => {
        await exclusive(d, async () => {
          progress(d, "Reading the photo…");
          try {
            const image = await downscale(file);
            if (closed.has(d) || !d.isConnected || !onBoard(d)) return;
            const reply = await ask(
              "handwriting",
              `This photo shows handwritten sticky notes, for example from a workshop wall. Transcribe every note exactly as written, keeping the author's wording and language. Do not add, merge, or summarize notes. Estimate each note's paper color as one of yellow, green, blue, purple, pink, orange, white. Reply with JSON only: {"notes":[{"text":"...","color":"yellow"}]}`,
              image,
            );
            const notes = replyNotes(parseJSON(reply)).slice(0, 400);
            if (!notes.length)
              throw Error(t("No sticky notes were found in this photo."));
            api.review(
              d,
              notes,
              "Check the transcription. Edit or remove notes before adding them.",
            );
          } catch (error) {
            progress(d, error.message);
          }
        });
      });
    },
    async generate(d) {
      // Ideas are only worth asking for when they can be added.
      if (!onBoard(d) || !canEdit(new Set())) return;
      const work = replaceWork(
        d,
        `<form id="ai-generate"><label class="field">${t("What should the ideas be about?")}<textarea id="ai-prompt" rows="3" required maxlength="2000"></textarea></label><label class="field">${t("How many sticky notes")}<input id="ai-count" type="number" min="1" max="40" value="12"></label><div class="dialog-footer"><button class="primary">${t("Generate")}</button></div></form>`,
      );
      if (!work) return;
      const form = work.querySelector("#ai-generate"),
        prompt = work.querySelector("#ai-prompt"),
        amount = work.querySelector("#ai-count");
      let revision = 0;
      form.addEventListener("input", () => revision++);
      prompt.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        await exclusive(d, async () => {
          const authoringLanguage = language,
            requestedPrompt = prompt.value,
            requestedAmount = amount.value,
            requestedRevision = revision;
          progress(d, "Generating ideas…");
          try {
            const count = Math.max(
              1,
              Math.min(40, Number(requestedAmount) || 12),
            );
            const reply = await ask(
              "generate",
              `Generate ${count} distinct, concise sticky note ideas (at most 20 words each) in ${languageName(authoringLanguage)} for this request from a team: ${requestedPrompt}\nReply with JSON only: {"notes":[{"text":"..."}]}`,
            );
            if (closed.has(d) || !form.isConnected || !onBoard(d)) return;
            if (
              revision !== requestedRevision ||
              prompt.value !== requestedPrompt ||
              amount.value !== requestedAmount
            ) {
              progress(
                d,
                "Your request changed while AI was working. It has been kept. Generate again to use it.",
              );
              return;
            }
            const notes = replyNotes(parseJSON(reply)).slice(0, count);
            if (!notes.length)
              throw Error(t("No ideas came back. Try rewording the request."));
            api.review(
              d,
              notes,
              "Review the ideas before adding them.",
              authoringLanguage,
            );
          } catch (error) {
            progress(d, error.message);
          }
        });
      };
      refresh();
    },
    review(d, notes, message, authoringLanguage) {
      const work = replaceWork(
        d,
        `<div class="field"><span id="ai-notes-label">${t("One sticky note per line")}</span><div id="ai-notes"></div></div><div class="dialog-footer"><button class="primary" id="ai-insert">${t("Add sticky notes")}</button></div>`,
      );
      if (!work) return;
      // Each note is one line of the review.
      const shown = notes.map((n) =>
        String(n.text)
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      );
      const input = createAuthoredField(
        work.querySelector("#ai-notes"),
        {
          text: shown.join("\n"),
          ...(authoringLanguage ? { lang: authoringLanguage } : {}),
        },
        // Review may contain hundreds of notes. The 2,000-character cap
        // applies independently to each inserted note, rather than this draft.
        { maxLength: Infinity },
      );
      reviews.set(d, input);
      input.style.minHeight = "min(12em, 30dvh)";
      progress(d, message);
      // The form that asked for ideas is gone; the review takes focus.
      input.focus();
      work.querySelector("#ai-insert").onclick = () => {
        if (!onBoard(d) || !canEdit(new Set())) return;
        try {
          const lines = [];
          let start = 0,
            next = 0;
          for (const row of input.value.split("\n")) {
            const text = row.trim();
            if (text) {
              // A line keeps its note's colour: the next note with its text,
              // or for an edited line the note after the last one matched,
              // so removing a line leaves the others' colours as they were.
              let index = shown.indexOf(text, next);
              if (index < 0) index = shown.indexOf(text);
              if (index < 0) index = next;
              next = index + 1;
              const offset = start + row.length - row.trimStart().length,
                content = fieldContent(
                  input,
                  offset,
                  Math.min(start + row.trimEnd().length, offset + 2000),
                );
              lines.push({ ...content, color: notes[index]?.color });
            }
            start += row.length + 1;
          }
          if (!lines.length)
            return progress(d, "Enter at least one line to add.");
          const count = insertNotes(lines);
          if (!count) return;
          d.close();
          toast(
            plural(
              count,
              "{count} sticky note added.",
              "{count} sticky notes added.",
            ),
          );
        } catch (error) {
          progress(d, error.message);
        }
      };
      refresh();
    },
  };
  return api;
}

addTranslations({
  "You’re viewing a different board. Return to the original board to use this draft, or close this dialog and open AI again.":
    "Vous consultez un autre tableau. Revenez au tableau d’origine pour utiliser ce brouillon, ou fermez cette fenêtre et rouvrez l’assistant IA.",
  "Your request changed while AI was working. It has been kept. Generate again to use it.":
    "Votre demande a changé pendant le travail de l’IA. Elle a été conservée. Relancez la génération pour l’utiliser.",
  "AI assistant": "Assistant IA",
  "Requests go through your organization, which controls these features and records their use in the audit log.":
    "Les demandes passent par votre organisation, qui contrôle ces fonctions et en consigne l’utilisation dans le journal d’audit.",
  "Requests use Puter AI with your Puter account. Board content you choose is sent to the AI model.":
    "Les demandes utilisent l’IA de Puter avec votre compte Puter. Le contenu du tableau que vous choisissez est envoyé au modèle d’IA.",
  "Your organization has turned off AI features.":
    "Votre organisation a désactivé les fonctions d’IA.",
  "Your organization has turned off this AI feature.":
    "Votre organisation a désactivé cette fonction d’IA.",
  "This board’s organization has turned off AI features.":
    "L’organisation de ce tableau a désactivé les fonctions d’IA.",
  "This board’s organization has turned off this AI feature.":
    "L’organisation de ce tableau a désactivé cette fonction d’IA.",
  "AI features are turned off on this device.":
    "Les fonctions d’IA sont désactivées sur cet appareil.",
  "Puter AI is not available.": "L’IA de Puter n’est pas disponible.",
  Summarize: "Résumer",
  "The selected objects": "Les objets sélectionnés",
  "The whole board": "Le tableau entier",
  "Group into themes": "Regrouper par thème",
  "Select two or more sticky notes":
    "Sélectionnez au moins deux notes adhésives",
  "Photo to sticky notes": "Photo en notes adhésives",
  "Turn handwritten notes into digital ones": "Numériser des notes manuscrites",
  "Generate ideas": "Générer des idées",
  "Sticky notes from a prompt": "Notes adhésives à partir d’une consigne",
  "Allow AI features on this device":
    "Autoriser les fonctions d’IA sur cet appareil",
  "There is no text to summarize.": "Il n’y a aucun texte à résumer.",
  "Summarizing…": "Résumé en cours…",
  "ai|Summary": "Résumé",
  Copy: "Copier",
  "Add to board": "Ajouter au tableau",
  "Summary ready. Review it before adding it to the board.":
    "Résumé prêt. Relisez-le avant de l’ajouter au tableau.",
  "Some source text was shortened or left out to fit the summary limit. Check the original content before using this summary.":
    "Une partie du texte source a été raccourcie ou omise pour respecter la limite du résumé. Vérifiez le contenu original avant d’utiliser ce résumé.",
  "Copied.": "Copié.",
  "Summary added.": "Résumé ajouté.",
  "Select two or more sticky notes with text.":
    "Sélectionnez au moins deux notes adhésives contenant du texte.",
  "Select up to 300 sticky notes at a time.":
    "Sélectionnez jusqu’à 300 notes adhésives à la fois.",
  "Finding themes…": "Recherche de thèmes…",
  Theme: "Thème",
  Other: "Autre",
  "Suggested themes": "Thèmes proposés",
  "Theme name": "Nom du thème",
  notes: "notes",
  "Arrange into frames": "Disposer dans des cadres",
  "Review the themes, rename them if needed, then arrange.":
    "Examinez les thèmes, renommez-les au besoin, puis disposez-les.",
  "Notes arranged into themes. Undo restores them.":
    "Notes regroupées par thème. Annulez pour les rétablir.",
  "Reading the photo…": "Lecture de la photo…",
  "No ideas came back. Try rewording the request.":
    "Aucune idée n’a été proposée. Essayez de reformuler la demande.",
  "No sticky notes were found in this photo.":
    "Aucune note adhésive n’a été trouvée sur cette photo.",
  "Check the transcription. Edit or remove notes before adding them.":
    "Vérifiez la transcription. Modifiez ou retirez des notes avant de les ajouter.",
  "What should the ideas be about?": "Sur quoi les idées doivent-elles porter?",
  "How many sticky notes": "Nombre de notes adhésives",
  Generate: "Générer",
  "Generating ideas…": "Génération d’idées…",
  "Review the ideas before adding them.":
    "Examinez les idées avant de les ajouter.",
  "One sticky note per line": "Une note adhésive par ligne",
  "Add sticky notes": "Ajouter des notes adhésives",
  "{count} sticky note added.": "{count} note adhésive ajoutée.",
  "{count} sticky notes added.": "{count} notes adhésives ajoutées.",
  "Enter at least one line to add.": "Saisissez au moins une ligne à ajouter.",
  "The AI reply could not be read.": "La réponse de l’IA n’a pas pu être lue.",
  "This image could not be read.": "Cette image n’a pas pu être lue.",
  "This would exceed the board limit of 5,000 objects.":
    "Cela dépasserait la limite de 5 000 objets par tableau.",
});
