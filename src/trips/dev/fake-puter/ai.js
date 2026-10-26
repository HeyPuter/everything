// A scripted stand-in for `puter.ai` (`chat`, `img2txt`) with no network; replies depend only on the request.
// `script()` entries are tried newest first, then built-in replies for the requests Trips makes. `fail(mode)` fails
// calls with an `AI_FAILURES` mode (credit is 402, usage 429).
//
// Script entries are plain data so Playwright can pass them through `page.evaluate`: `{kind?, match?, reply, times?}`.
//   match: a case-insensitive substring of the request text, a RegExp, or a function of the request
//   reply: a string, {text?, json?, tools?: [{name, input}], error?: mode}, or a function of the request

export const AI_KINDS = Object.freeze(['import', 'summary', 'receipt', 'stops', 'assistant', 'ocr', 'chat']);
export const AI_FAILURES = Object.freeze(['credit', 'usage', 'auth', 'offline', 'failed']);

export function createAiState() { return { scripts: [], failure: null, calls: [] }; }

/** World-level controls over one shared state. */
export function aiControls(state) {
  return {
    script(entry) {
      if (!entry || typeof entry !== 'object' || entry.reply === undefined) throw new TypeError('A script needs a reply');
      if (entry.kind !== undefined && !AI_KINDS.includes(entry.kind)) throw new TypeError('Unknown AI request kind');
      const item = { kind: entry.kind, match: entry.match, reply: entry.reply, times: entry.times ?? Infinity };
      state.scripts.unshift(item);
      return () => { const index = state.scripts.indexOf(item); if (index >= 0) state.scripts.splice(index, 1); };
    },
    fail(mode = 'credit', { times = Infinity } = {}) {
      if (mode !== null && !AI_FAILURES.includes(mode)) throw new TypeError('Unknown AI failure');
      state.failure = mode === null ? null : { mode, times };
    },
    calls: () => state.calls.map((call) => ({ ...call })),
    reset() { state.scripts.length = 0; state.failure = null; state.calls.length = 0; },
  };
}

/**
 * The `puter.ai` object for one client. `call(method, run)` wraps each call (the fake world's auth, offline,
 * `failNext` and counters); `readFile(path)` returns a staged file's text for `{type: 'file', puter_path}` parts.
 */
export function createFakeAi({ state = createAiState(), call = (method, run) => run(), readFile = async () => null } = {}) {
  const run = async (method, request) => {
    try { return await call(method, () => respond(state, request)); }
    catch (cause) { throw cause?.code === 'offline' ? failure('offline') : cause; }
  };
  return {
    async chat(...args) { return run('ai.chat', await chatRequest(args, readFile)); },
    async img2txt(image, testMode = false) {
      return run('ai.img2txt', { kind: 'ocr', method: 'img2txt', messages: [], system: '', text: '', document: '', user: '', images: [String(image ?? '')], files: [], options: {}, tools: [], stream: false, testMode: testMode === true });
    },
  };
}

function failure(mode) {
  if (mode === 'offline') return Object.assign(new TypeError('Failed to fetch'), { code: 'offline', status: 0 });
  const [status, code, message] = { credit: [402, 'insufficient_funds', 'Insufficient funds'], usage: [429, 'rate_limit_exceeded', 'Too many requests'],
    auth: [401, 'token_auth_failed', 'Authentication failed'], failed: [500, 'internal_error', 'The model failed'] }[mode] ?? [500, 'internal_error', 'The model failed'];
  return Object.assign(new Error(message), { code, status, statusCode: status, error: { code, status, message } });
}

const partText = (part) => (typeof part === 'string' ? part : part?.type === 'text' || typeof part?.text === 'string' ? part.text ?? '' : '');
const contentText = (content) => (Array.isArray(content) ? content.map(partText).join('\n') : typeof content === 'string' ? content : '');
const TRIP_DATA = /^<trip_data>\n([\s\S]*?)\n<\/trip_data>\s*/;

async function chatRequest(args, readFile) {
  const [first, ...rest] = args;
  const messages = Array.isArray(first) ? first.filter((message) => message && typeof message === 'object') : [{ role: 'user', content: String(first ?? '') }];
  const options = {};
  const images = [];
  let testMode = false;
  for (const arg of rest) {
    if (typeof arg === 'boolean') testMode = arg;
    else if (typeof arg === 'string') images.push(arg);
    else if (Array.isArray(arg)) images.push(...arg.filter((item) => typeof item === 'string'));
    else if (arg && typeof arg === 'object') Object.assign(options, arg);
  }
  const files = [];
  for (const message of messages) {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part?.type === 'file' && typeof part.puter_path === 'string') files.push(part.puter_path);
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') images.push(part.image_url.url);
    }
  }
  const fileText = (await Promise.all(files.map((path) => Promise.resolve().then(() => readFile(path)).catch(() => null)))).filter(Boolean).join('\n');
  const system = messages.filter((message) => message.role === 'system').map((message) => contentText(message.content)).join('\n');
  const lastUser = messages.findLast((message) => message.role === 'user');
  const userRaw = contentText(lastUser?.content);
  const snapshot = TRIP_DATA.exec(userRaw);
  const user = snapshot ? userRaw.slice(snapshot[0].length) : userRaw;
  const text = [...messages.filter((message) => message.role !== 'system').map((message) => contentText(message.content)), fileText].join('\n');
  // The import sends documents inside <document> tags and files by path; the rest of its prompt is trip context.
  const documents = [...text.matchAll(/<document>\n([\s\S]*?)\n<\/document>/g)].map((match) => match[1]);
  const document = documents.length || fileText ? [...documents, fileText].join('\n') : text;
  const tools = (Array.isArray(options.tools) ? options.tools : []).map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === 'string');
  const request = { method: 'chat', messages, system, text, document, user, snapshot: snapshot ? parseJson(snapshot[1]) : null, files, images, options, tools, stream: options.stream === true, testMode };
  request.kind = kindOf(request);
  return request;
}

function kindOf({ system, options, tools, text }) {
  const schema = options.outputFormat?.schema?.properties ?? {};
  if (tools.length || /trip assistant in Trips/.test(system)) return 'assistant';
  if (options.outputFormat?.name === 'bookings' || /extract travel bookings/.test(system)) return 'import';
  if (/short notes for travellers/.test(system) || 'matches' in schema) return 'summary';
  if (/name the stops of a past trip/.test(system) || 'stops' in schema) return 'stops';
  if ('merchant' in schema || /^Read the receipt/.test(text)) return 'receipt';
  return 'chat';
}

function matches(script, request) {
  if (script.kind && script.kind !== request.kind) return false;
  const { match } = script;
  if (match === undefined || match === null) return true;
  if (typeof match === 'function') return Boolean(match(request));
  const haystack = `${request.user}\n${request.text}`;
  if (match instanceof RegExp) return match.test(haystack);
  return haystack.toLowerCase().includes(String(match).toLowerCase());
}

async function respond(state, request) {
  state.calls.push({ kind: request.kind, method: request.method, model: request.options.model ?? null, user: request.user.slice(0, 500), tools: request.tools.length, stream: request.stream, files: request.files.length, images: request.images.length });
  if (state.failure) {
    const { mode } = state.failure;
    if (--state.failure.times <= 0) state.failure = null;
    throw failure(mode);
  }
  const script = state.scripts.find((item) => item.times > 0 && matches(item, request));
  if (script) script.times -= 1;
  let reply = script ? script.reply : builtIn(request);
  if (typeof reply === 'function') reply = await reply(request);
  if (typeof reply === 'string') reply = { text: reply };
  if (reply?.error) throw failure(reply.error);
  return shape(request, reply ?? {});
}

function shape(request, reply) {
  const text = typeof reply.text === 'string' ? reply.text : reply.json !== undefined ? JSON.stringify(reply.json) : '';
  if (request.method === 'img2txt') return text;
  const prior = request.messages.reduce((count, message) => count + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0), 0);
  const calls = (reply.tools ?? []).map((tool, index) => ({ id: `call_fake_${prior + index + 1}`, name: tool.name, input: tool.input ?? {} }));
  if (request.stream) {
    return (async function* stream() {
      for (const chunk of text.match(/\S+\s*|\s+/g) ?? []) yield { type: 'text', text: chunk };
      for (const tool of calls) yield { type: 'tool_use', id: tool.id, name: tool.name, input: tool.input };
    })();
  }
  const message = { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((tool) => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } })) } : {}) };
  return { message, text, toString: () => text };
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
const ISO = /\b(\d{4}-\d{2}-\d{2})\b/g;
function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const todayIn = (text) => /Today is (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? new Date().toISOString().slice(0, 10);

function builtIn(request) {
  switch (request.kind) {
    case 'import': return { json: { bookings: bookingsFrom(request) } };
    case 'summary': return { json: summaryFrom(request) };
    case 'receipt': return { json: receiptFrom(request) };
    case 'stops': return { json: stopsFrom(request) };
    case 'assistant': return assistantTurn(request);
    case 'ocr': return { text: 'CAFE CENTRAL\nCoffee 6.00\nPastries 12.50\nTOTAL 18.50' };
    default: return { text: 'This is a scripted reply from the fake Puter AI.' };
  }
}

/** Bookings named in the document: a flight and/or a lodging, with dates, times and codes taken from the text. */
function bookingsFrom({ text, document }) {
  const tripStart = /Trip dates: (\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
  const dates = [...document.matchAll(ISO)].map((match) => match[1]);
  const base = dates[0] ?? tripStart ?? todayIn(text);
  const code = /(?:confirmation|booking reference|booking ref|reservation|pnr)\W{0,20}([A-Z0-9]{5,8})\b/i.exec(document)?.[1];
  const bookings = [];
  const flight = /\b([A-Z]{2})\s?(\d{2,4})\b/.exec(document);
  if (/\bflight\b|\bboarding pass\b/i.test(document) || flight) {
    const route = /\b([A-Z]{3})\s*(?:→|->|–|-|to)\s*([A-Z]{3})\b/.exec(document);
    const times = [...document.matchAll(/\b([01]\d|2[0-3]):([0-5]\d)\b/g)].map((match) => match[0]);
    const [from, to] = route ? [route[1], route[2]] : ['LIS', 'OPO'];
    bookings.push({
      type: 'flight', title: `${from} → ${to}`, status: 'confirmed', ...(code ? { code } : {}),
      legs: [{ from: { code: from }, to: { code: to }, dep: { date: base, time: times[0] ?? '09:30' }, arr: { date: base, time: times[1] ?? '10:25' },
        ...(flight ? { carrier: flight[1], number: `${flight[1]}${flight[2]}` } : {}) }],
    });
  }
  if (/\bhotel\b|check-?in|\blodging\b|\bapartment\b|\bhostel\b/i.test(document)) {
    const name = /\b(Hotel(?: [A-Z][\w'’-]*){1,3}|(?:[A-Z][\w'’-]* ){1,3}Hotel)\b/.exec(document)?.[1] ?? 'Hotel Fixture';
    const start = bookings.length ? dates[1] ?? base : base;
    const end = dates.find((date) => date > start) ?? addDays(start, 2);
    bookings.push({ type: 'lodging', title: name, status: 'confirmed', ...(code && !bookings.length ? { code } : {}),
      start: { date: start }, end: { date: end }, location: { name }, checkIn: '15:00', checkOut: '11:00' });
  }
  if (!bookings.length && /\brestaurant\b|table for|\bdinner\b/i.test(document)) {
    bookings.push({ type: 'restaurant', title: 'Dinner', status: 'confirmed', start: { date: base, time: '20:00' } });
  }
  return bookings;
}

function summaryFrom({ text }) {
  const name = /Name: (.+)/.exec(text)?.[1]?.trim() ?? 'This place';
  const category = /Category: (.+)/.exec(text)?.[1]?.trim();
  const country = /Country code: ([A-Z]{2})/.exec(text)?.[1] ?? '';
  return {
    summary: `${name} is ${category ? `listed as ${category.toLowerCase()}` : 'a saved place'} in this trip. This short note is a scripted test summary.`,
    country, matches: true,
  };
}

function receiptFrom({ text }) {
  const currency = /use "([A-Z]{3})" when it is unclear/.exec(text)?.[1] ?? 'EUR';
  return { merchant: 'Café Central', date: todayIn(text), total: 18.5, currency, category: 'food', tax: null, tip: null,
    items: [{ label: 'Coffee', amount: 6 }, { label: 'Pastries', amount: 12.5 }], confidence: 0.92 };
}

function stopsFrom({ system, user }) {
  const categories = /Pick a category from: ([^.]*)\./.exec(system)?.[1]?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  const category = categories.includes('attraction') ? 'attraction' : categories[0];
  const stops = Array.isArray(parseJson(user)) ? parseJson(user) : [];
  return { stops: stops.map((stop, index) => ({ index: Number.isInteger(stop?.index) ? stop.index : index,
    name: typeof stop?.near === 'string' && stop.near.trim() ? stop.near.split(',')[0].trim().slice(0, 40) : `Stop ${index + 1}`, ...(category ? { category } : {}) })) };
}

/** One assistant round: a tool call chosen from the user's words, or a reply to the tool results just sent. */
function assistantTurn(request) {
  const { messages, tools, snapshot } = request;
  const last = messages.at(-1);
  if (last?.role === 'tool') {
    const results = [];
    for (let index = messages.length - 1; index >= 0 && messages[index].role === 'tool'; index--) results.unshift(parseJson(contentText(messages[index].content)) ?? {});
    const asked = messages.findLast((message) => message.role === 'assistant' && Array.isArray(message.tool_calls));
    const names = asked?.tool_calls?.map((item) => item.function?.name) ?? [];
    const result = results[0] ?? {};
    if (names[0] === 'get_trip_summary') {
      const days = result.days ?? 0; const places = result.places?.total ?? 0;
      return { text: `${result.title ?? 'Your trip'} has ${days} ${days === 1 ? 'day' : 'days'} and ${places} saved ${places === 1 ? 'place' : 'places'}.` };
    }
    if (result.status === 'applied') return { text: 'Done. The change is in the trip.' };
    if (['declined', 'not_applied'].includes(result.status)) return { text: 'All right, I left the trip as it is. What would you like instead?' };
    if (['shown', 'handed_to_user'].includes(result.status)) return { text: 'You can review the new dates before changing them.' };
    return { text: result.message ? `That did not work: ${String(result.message).slice(0, 200)}` : 'Here is what I found.' };
  }
  const said = request.user.toLowerCase();
  const day = snapshot?.days?.[0];
  const dayRef = day?.id ?? day?.date;
  const start = snapshot?.trip?.start;
  const propose = (name, input, text) => (tools.includes(name) ? { text, tools: [{ name, input }] } : { text: 'You can view this trip but not change it, so I can only describe it.' });
  if (/\bpack/.test(said)) {
    return propose('propose_add_packing_items', { items: [{ name: 'Passport', list: 'Documents' }, { name: 'Phone charger', list: 'Electronics' }, { name: 'Sunscreen', list: 'Toiletries' }] }, 'Here are a few things to pack.');
  }
  if (/to-?do|\btask|remind/.test(said)) {
    return propose('propose_add_todos', { items: [{ name: 'Check in online' }, { name: 'Buy travel insurance', priority: 1 }] }, 'I suggest these to-dos.');
  }
  if (/\b(dates?|postpone|later|earlier)\b/.test(said) && start) {
    return propose('propose_redate', { start: addDays(start, 7) }, 'Moving the trip one week later keeps its length.');
  }
  if (/\b(add|plan|visit|itinerary|schedule)\b/.test(said) && dayRef) {
    return propose('propose_add_visits', { day: dayRef, items: [{ title: 'Walk through the old town', start: '10:00', end: '12:00' }, { title: 'Lunch at a local market', start: '12:30' }] }, 'Here is a plan for the first day.');
  }
  if (/summary|overview|how many|what/.test(said) && tools.includes('get_trip_summary')) return { text: '', tools: [{ name: 'get_trip_summary', input: {} }] };
  return { text: 'I am the scripted test assistant. Ask me to plan a day, add packing items or to-dos, move the trip dates, or summarize the trip.' };
}
