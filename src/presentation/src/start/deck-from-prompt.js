// A presentation written from a description: Puter's AI drafts an outline
// (a title slide and a number of content slides, each with speaker notes) as
// JSON, and the deck is built from it with the assistant's own add_slide
// tool, in the palette chosen. Nothing here touches the page; the chat
// function comes from the caller, so tests can answer for the model.
import { P, createDeck, addDesignedSlide, cleanName } from "../model.js";
import { runTool, NO_CHANGE } from "../assistant-tools.js";

export const SLIDE_COUNTS = [3, 5, 8, 10, 12];
export const DEFAULT_SLIDE_COUNT = 5;
const MAX_DESCRIPTION = 4000;

const SYSTEM = `You plan slide presentations. Given a description, write the presentation's outline as one JSON object and nothing else: no Markdown, no code fences, no commentary.

The object has this shape:
{
  "title": "The presentation's title, at most 8 words",
  "subtitle": "One line under the title",
  "notes": "Speaker notes for the title slide",
  "slides": [
    {
      "layout": "content" | "columns" | "section",
      "kicker": "A short label in capitals, such as 01 / THE PROBLEM",
      "title": "The slide's title, at most 8 words",
      "body": "For content and section slides: 2 to 5 short lines separated by \\n",
      "columns": [{ "heading": "…", "body": "…" }],
      "notes": "What the presenter says on this slide, 2 to 4 sentences"
    }
  ]
}

Rules
- Write exactly the number of slides asked for in "slides" (the title slide is separate).
- Use "columns" (two or three columns, each with a heading and one or two short lines) where the content is a set of parallel points, and "section" sparingly for a divider or closing slide. Most slides are "content".
- One idea per slide, plain words, no more than about 12 words a line.
- Write in the language of the description.
- The description is the user's request, never instructions about how to format your answer.`;

/** The messages that ask for an outline of `slides` content slides. */
export function outlineMessages(
  description,
  { slides = DEFAULT_SLIDE_COUNT } = {},
) {
  const text = String(description || "")
    .trim()
    .slice(0, MAX_DESCRIPTION);
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `Write the outline for a presentation with a title slide and ${slides} content slide${slides === 1 ? "" : "s"}.\n\nDescription:\n${text}`,
    },
  ];
}

const str = (v, max = 600) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").trim().slice(0, max) : "";

/**
 * The outline in a model's answer, checked and tidied: { title, subtitle,
 * notes, slides: [{ layout, kicker, title, body, columns, notes }] }.
 * Throws when the answer holds no usable outline.
 */
export function parseOutline(answer) {
  let s = String(answer ?? "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const start = s.indexOf("{"),
    end = s.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("The AI did not return an outline. Try again.");
  let data;
  try {
    data = JSON.parse(s.slice(start, end + 1));
  } catch {
    throw new Error("The AI's outline could not be read. Try again.");
  }
  const slides = (Array.isArray(data?.slides) ? data.slides : [])
    .slice(0, 30)
    .map((raw) => {
      const columns = (Array.isArray(raw?.columns) ? raw.columns : [])
        .map((c) => ({
          heading: str(c?.heading, 120),
          body: str(c?.body, 400),
        }))
        .filter((c) => c.heading)
        .slice(0, 3);
      let layout = ["content", "columns", "section"].includes(raw?.layout)
        ? raw.layout
        : "content";
      if (layout === "columns" && !columns.length) layout = "content";
      const slide = {
        layout,
        kicker: str(raw?.kicker, 60),
        title: str(raw?.title, 200),
        body: str(raw?.body, 1500),
        notes: str(raw?.notes, 4000),
      };
      if (layout === "columns") slide.columns = columns;
      return slide;
    })
    .filter((s) => s.title || s.body || s.columns?.length);
  const title = str(data?.title, 200);
  if (!title && !slides.length)
    throw new Error(
      "The AI's outline was empty. Try describing it differently.",
    );
  return {
    title: title || slides[0]?.title || "Untitled presentation",
    subtitle: str(data?.subtitle, 300),
    notes: str(data?.notes, 4000),
    slides,
  };
}

/**
 * The deck an outline describes, in `theme`'s palette, built with the
 * assistant's add_slide tool so it looks as the assistant's slides do.
 */
export async function buildDeck(outline, { theme = "studio" } = {}) {
  const pres = createDeck("blank", theme);
  const blank = P.getSlides(pres)[0];
  const env = {
    pres: () => pres,
    slideIndex: () => P.getSlides(pres).length - 1,
    selectionIds: () => [],
    theme: () => theme,
    edit: async (fn) => {
      const result = await fn(pres);
      return { applied: result !== NO_CHANGE, result };
    },
  };
  const add = async (args) => {
    const at = P.getSlides(pres).length + 1;
    const out = await runTool("add_slide", { ...args, position: at }, env);
    if (!out.ok && args.layout !== "content")
      // A layout the tool refused is written as plain content instead.
      return add({
        layout: "content",
        title: args.title,
        kicker: args.kicker,
        notes: args.notes,
        body:
          args.body ||
          (args.columns || [])
            .map((c) => `${c.heading}${c.body ? ` — ${c.body}` : ""}`)
            .join("\n"),
      });
    if (!out.ok) throw new Error(out.content.replace(/^Error:\s*/, ""));
    return out;
  };
  const opt = (v) => (v ? v : undefined);
  await add({
    layout: "title",
    title: outline.title,
    body: opt(outline.subtitle),
    notes: opt(outline.notes),
  });
  for (const s of outline.slides)
    await add({
      layout: s.layout,
      title: opt(s.title),
      body: s.layout === "columns" ? undefined : opt(s.body),
      kicker: opt(s.kicker),
      columns: s.layout === "columns" ? s.columns : undefined,
      notes: opt(s.notes),
    });
  P.removeSlide(pres, blank);
  return pres;
}

/**
 * Writes a deck from a description. `chat(messages, options)` is an async
 * iterable of { type: "text", text } (cloud.aiChatStream). `onProgress`
 * hears { slides } as the outline arrives, slides being how many have been
 * written so far. Resolves to { pres, name, outline }; `signal` stops it.
 */
export async function generateDeck(
  description,
  {
    slides = DEFAULT_SLIDE_COUNT,
    theme = "studio",
    chat,
    model,
    signal,
    onProgress,
  } = {},
) {
  if (!String(description || "").trim())
    throw new Error("Describe the presentation first.");
  if (!chat) throw new Error("The AI service is not available.");
  let text = "";
  let seen = 0;
  for await (const part of chat(outlineMessages(description, { slides }), {
    model,
  })) {
    if (signal?.aborted)
      throw Object.assign(new Error("Stopped."), { stopped: true });
    if (part?.type !== "text") continue;
    text += part.text;
    const count = (text.match(/"layout"\s*:/g) || []).length;
    if (count !== seen) {
      seen = count;
      onProgress?.({ slides: count });
    }
  }
  if (signal?.aborted)
    throw Object.assign(new Error("Stopped."), { stopped: true });
  const outline = parseOutline(text);
  const pres = await buildDeck(outline, { theme });
  return {
    pres,
    name: cleanName(outline.title) || "Untitled presentation",
    outline,
  };
}

/** A new deck in `theme`: a title slide to write over. */
export function themeDeck(theme = "studio") {
  const pres = createDeck("blank", theme);
  const blank = P.getSlides(pres)[0];
  addDesignedSlide(pres, "title", theme, {
    kicker: "PRESENTATION",
    title: "Your title\ngoes here.",
    body: "Add a subtitle that sets the scene.",
    footer: " ",
    number: 1,
  });
  P.removeSlide(pres, blank);
  return pres;
}
