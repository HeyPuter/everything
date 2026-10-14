// Small one-shot requests to Puter's AI for the review panes: the answer is
// asked for as JSON and read leniently.
import * as cloud from "../cloud.js";
import { AI_MODEL } from "../assistant.js";

export const aiAvailable = () => cloud.canAI();

/** The first JSON value in a reply, fenced or not. */
export function parseJsonReply(text) {
  const raw = String(text || "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const open = raw.search(/[[{]/);
  if (open < 0) throw new Error("The AI's answer could not be read.");
  const close = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  try {
    return JSON.parse(raw.slice(open, close + 1));
  } catch {
    throw new Error("The AI's answer could not be read.");
  }
}

export async function askJson(system, user, { maxTokens = 1500 } = {}) {
  let text = "";
  for await (const part of cloud.aiChatStream(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { model: AI_MODEL, maxTokens },
  ))
    if (part.type === "text") text += part.text;
  return parseJsonReply(text);
}
