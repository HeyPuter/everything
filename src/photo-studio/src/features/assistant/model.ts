// The conversation with the model: the system prompt, the four tools it may
// call (catalog search, details, propose a plan, answer a question) and the
// tool-calling loop. The chat function is passed in, so tests run the loop
// with scripted replies and never reach the network.
import type { ChatMessage, ChatPart, ChatReply, ChatTool } from '../../imaging/ai/puter-ai';
import { COMMON_COMMANDS, type Catalog } from './catalog';
import { OPS } from './ops';
import { describeParams } from './params';
import type { RawPlan } from './plan';

export type Turn = { role: 'user' | 'assistant'; text: string };
export type Reply = { kind: 'plan'; plan: RawPlan; text: string } | { kind: 'answer'; text: string; pointers: string[] } | { kind: 'text'; text: string };
export type ChatFn = (messages: ChatMessage[], opts: { model?: string; tools?: ChatTool[]; signal?: AbortSignal }) => Promise<ChatReply>;
export type ConverseInput = {
  request: string;
  history: Turn[];
  document: string;
  // A small preview of the visible image (data URI), when the user allows it.
  image?: string;
  catalog: Catalog;
  chat: ChatFn;
  model?: string;
  signal?: AbortSignal;
  details?: Parameters<Catalog['details']>[1];
  // Status while the model looks things up ("Searching for “blur”…").
  progress?: (text: string) => void;
};

export const MAX_ROUNDS = 8;
// Earlier turns sent with each request.
export const HISTORY_TURNS = 12;

export const TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search Photo Studio’s commands, tools, panels and Assistant operations by words. Returns one line per match: id | label | where | input kind | shortcut.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words describing what you need, e.g. "gaussian blur", "drop shadow", "remove background"' },
          kind: { type: 'string', enum: ['any', 'command', 'tool', 'panel', 'op'], description: 'Limit the results to one kind' },
          limit: { type: 'integer', description: 'At most this many results (default 12, at most 40)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_details',
      description: 'Details of commands, tools, panels or operations by ID: description, menu path, whether it needs a selection, and the settings (args) it takes with types and ranges.',
      parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Up to 12 IDs' } }, required: ['ids'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description: 'Propose the edit as ordered steps. The user reviews the plan and runs it (all at once or step by step); the whole run is one undo step. Call this once per request that changes the document.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short name for the edit, e.g. "Dramatic sky, 16:9 crop"' },
          summary: { type: 'string', description: 'One or two sentences on what the plan does and anything the user should know (dialogs that will open, AI credits).' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', description: 'A command ID or an operation ID (op.*)' },
                args: { type: 'object', description: 'Settings for the command or operation (see get_details)' },
                note: { type: 'string', description: 'Why this step, in a few words' },
              },
              required: ['action'],
            },
          },
        },
        required: ['title', 'steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'answer',
      description: 'Answer a question about using Photo Studio (how do I…, where is…). Point to the commands, tools (tool.<id>) and panels (panel.<id>) involved; the user gets a "Show me" button for each.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'A short, plain answer with the menu paths or steps' },
          pointers: { type: 'array', items: { type: 'string' }, description: 'IDs of commands, tools or panels to show' },
        },
        required: ['text'],
      },
    },
  },
];

/** The fixed instructions (identical every turn, so providers can cache them). */
export function systemPrompt(catalog: Catalog): string {
  const common = COMMON_COMMANDS.map((id) => catalog.get(id))
    .filter((e) => !!e && !e.hidden)
    .map((e) => catalog.line(e!));
  const ops = OPS.map((o) => `${o.id} — ${o.description}\n${describeParams(o.params)}`).join('\n\n');
  return `You are the Assistant in Photo Studio, a browser-based raster image editor with layers, masks, adjustment layers, selections, filters, type, layer effects and optional generative AI through Puter.

What you do:
- When the user describes a change to the document, call propose_plan once with the steps. Nothing changes until the user runs the plan; they can edit or remove steps first. The whole run is one undo step.
- When the user asks how to do something or where something is, call answer with a short explanation (menu paths, tools, keys) and pointers to the commands, tools and panels involved.
- When the request is unclear, impossible or needs information you lack, reply in plain text (a short question or explanation) without a plan.

Finding commands:
- Use only IDs from this prompt, from search_catalog results or from get_details. Never invent IDs.
- Call get_details before giving args to a command, to learn its settings and ranges. Operations (op.*) are listed below with their args.

Planning rules:
- Prefer operations and non-destructive edits: adjustment layers with settings (op.add_adjustment_layer), layer styles, masks. A selection active when an adjustment layer is added becomes its mask.
- "input: settings" commands take args directly. "input: dialog" commands open a dialog where the user picks settings during the run; use them only when nothing else fits. Tools cannot be used by a plan.
- "input: ai" commands (Generate Image, Edit with Prompt, AI Fill, AI Expand) create content with generative AI and spend the user's Puter credits. Use them only when the request needs new content that editing cannot make; put a precise prompt in args.prompt and say in the summary that it uses AI credits. Their dialog opens prefilled and the user presses Generate.
- A command that needs a selection must follow a step that makes one (op.select, select.subject, select.sky, select.all...). Remove the background of a subject with layer.remove-background (it masks the selected layer).
- Coordinates and sizes are document pixels, origin at the top left. Use the layer names from the document description.
- Keep plans short and in a sensible order. Write titles, summaries and notes in plain words for the user, without IDs.

Operations:
${ops}

Common commands (id | label | menu | input | shortcut):
${common.join('\n')}`;
}

function userContent(input: ConverseInput, withImage: boolean): string | ChatPart[] {
  const text = `Current document:\n${input.document}\n\nRequest: ${input.request}`;
  if (!withImage || !input.image) return text;
  return [
    { type: 'text', text: `${text}\n\nA small preview of the visible image is attached.` },
    { type: 'image_url', image_url: { url: input.image } },
  ];
}

/** Run the conversation for one request until the model proposes a plan,
 * answers, or replies in text. */
export async function converse(input: ConverseInput): Promise<Reply> {
  const base: ChatMessage[] = [{ role: 'system', content: systemPrompt(input.catalog) }];
  for (const t of input.history.slice(-HISTORY_TURNS)) base.push({ role: t.role, content: t.text });
  let withImage = !!input.image;
  const messages: ChatMessage[] = [...base, { role: 'user', content: userContent(input, withImage) }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let reply: ChatReply;
    try {
      reply = await input.chat(messages, { model: input.model, tools: TOOLS, signal: input.signal });
    } catch (error) {
      // A model or route that does not take images: try once more without.
      const code = (error as { code?: string })?.code;
      if (withImage && round === 0 && code === 'bad-request') {
        withImage = false;
        messages[base.length] = { role: 'user', content: userContent(input, false) };
        round--;
        continue;
      }
      throw error;
    }
    const final = reply.calls.find((c) => c.name === 'propose_plan' || c.name === 'answer');
    if (final) {
      const a = (final.args && typeof final.args === 'object' ? final.args : {}) as Record<string, unknown>;
      if (final.name === 'answer') {
        const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : reply.text;
        return { kind: 'answer', text: text || 'I have no answer for that.', pointers: Array.isArray(a.pointers) ? a.pointers.filter((p): p is string => typeof p === 'string').slice(0, 8) : [] };
      }
      if (!Array.isArray(a.steps)) return { kind: 'text', text: reply.text || 'The proposed plan could not be read. Try asking again.' };
      return { kind: 'plan', plan: a as RawPlan, text: reply.text };
    }
    if (!reply.calls.length) return { kind: 'text', text: reply.text || 'I could not work out what to do. Try describing the change differently.' };
    messages.push({ role: 'assistant', ...(reply.text ? { content: reply.text } : {}), tool_calls: reply.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) });
    for (const c of reply.calls) messages.push({ role: 'tool', tool_call_id: c.id, content: await runTool(input, c.name, c.args) });
  }
  return { kind: 'text', text: 'I could not settle on a plan for this. Try a more specific request.' };
}

async function runTool(input: ConverseInput, name: string, raw: unknown): Promise<string> {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (name === 'search_catalog') {
    const query = String(a.query ?? '').slice(0, 200);
    input.progress?.(`Looking up “${query}”…`);
    const kind = typeof a.kind === 'string' && ['any', 'command', 'tool', 'panel', 'op'].includes(a.kind) ? (a.kind as 'any') : 'any';
    const found = input.catalog.search(query, { kind, limit: typeof a.limit === 'number' ? a.limit : 12 });
    return found.length ? found.map((e) => input.catalog.line(e)).join('\n') : `No matches for “${query}”. Try other words.`;
  }
  if (name === 'get_details') {
    const ids = Array.isArray(a.ids) ? a.ids.map(String) : typeof a.ids === 'string' ? [a.ids] : [];
    input.progress?.('Reading command details…');
    return ids.length ? input.catalog.details(ids, input.details) : 'Give the IDs to describe.';
  }
  return `Unknown tool “${name}”. Use search_catalog, get_details, propose_plan or answer.`;
}
