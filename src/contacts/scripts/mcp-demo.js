#!/usr/bin/env node
/**
 * Drive a real MCP session against the real server, with no Puter account and no
 * desktop:
 *
 *   node scripts/mcp-demo.js
 *
 * Only two things are stand-ins — an in-memory Map for `puter.kv`, and a fake
 * AppConnection for the one the Puter desktop hands over. Everything between
 * them is the code that ships: server.js routing the dialect, mcp.js answering
 * it, tools.js rendering the result, methods.js and store.js doing the work
 * (including the real freshness re-read, which is why the first call reads the
 * "cloud").
 *
 * Read it as a transcript: → is the client, ← is Contacts.
 */

/* The store reaches for window.puter.kv, exactly as it does in a browser. */
const kv = new Map()
globalThis.window = globalThis
globalThis.window.puter = {
  kv: {
    list: async () => [...kv.entries()].map(([key, value]) => ({ key, value })),
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    set: async (k, v) => (kv.set(k, v), true),
    del: async (k) => (kv.delete(k), true),
  },
}

const { store } = await import('../src/store.js')
const { createContact } = await import('../src/model.js')
const { createMethods } = await import('../src/api/methods.js')
const { startApiServer } = await import('../src/api/server.js')

/* ---- pretty printing ----------------------------------------------------- */

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`

const indent = (text) => String(text).split('\n').map((l) => `      ${l}`).join('\n')

function heading(text) {
  console.log(`\n${bold(`── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}`)}`)
}

/** Long JSON is here to prove a shape, not to be read. */
function brief(value, max = 200) {
  const s = JSON.stringify(value)
  return s.length > max ? `${s.slice(0, max)}… ${dim(`(+${s.length - max} chars)`)}` : s
}

function printOut(msg) {
  const kind = msg.id === undefined ? ` ${dim('(notification)')}` : dim(` #${msg.id}`)
  console.log(`  ${cyan('→')} ${msg.method}${kind}`)
  const body = msg.params ?? {}
  if (Object.keys(body).length) console.log(indent(dim(brief(body))))
}

function printIn(msg) {
  // A notification from us (no id): the address book changed.
  if (msg.id === undefined) {
    console.log(`  ${yellow('←')} ${msg.method || msg.type} ${dim('(notification)')}`)
    return
  }
  if (msg.error) {
    console.log(`  ${yellow('←')} ${yellow(`error ${msg.error.code}`)}  ${msg.error.message}`)
    return
  }
  const r = msg.result
  if (r && Array.isArray(r.content)) {
    const tag = r.isError ? yellow('tool error') : green('ok')
    console.log(`  ${green('←')} ${tag}`)
    console.log(indent(r.content[0].text))
    if (r.structuredContent) {
      console.log(indent(dim(`+ structuredContent (${JSON.stringify(r.structuredContent).length} bytes of exact JSON)`)))
    }
    return
  }
  console.log(`  ${green('←')} ${green('ok')}`)
  console.log(indent(dim(brief(r))))
}

/* ---- the fake AppConnection ---------------------------------------------- */

let deliver = null
const inbox = []
const connection = {
  postMessage: (msg) => {
    inbox.push(msg)
    printIn(msg)
  },
  on: (event, fn) => {
    if (event === 'message') deliver = fn
  },
  off: () => {
    deliver = null
  },
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

let nextId = 1
async function send(method, params) {
  const msg = { jsonrpc: '2.0', id: nextId++, method, params }
  printOut(msg)
  deliver(msg)
  await settle()
  return inbox.find((m) => m.id === msg.id)
}

async function notify(method, params) {
  const msg = { jsonrpc: '2.0', method, params }
  printOut(msg)
  deliver(msg)
  await settle()
  console.log(indent(dim('(no reply — JSON-RPC forbids replying to a notification)')))
}

/* ---- the session --------------------------------------------------------- */

for (const c of [
  { firstName: 'Ada', lastName: 'Lovelace', company: 'Analytical Engines', jobTitle: 'Founder',
    emails: [{ label: 'Work', value: 'ada@analytical.co' }], tags: ['pioneers'], favorite: true },
  { firstName: 'Alan', lastName: 'Turing', company: 'Bletchley Park',
    emails: [{ label: 'Work', value: 'alan@bletchley.uk' }] },
  { firstName: 'Katherine', lastName: 'Johnson', company: 'NASA',
    phones: [{ label: 'Mobile', value: '555-0100' }], tags: ['nasa'] },
]) {
  const contact = createContact(c)
  kv.set(`contact:${contact.id}`, contact)
}

console.log(bold('\nContacts over MCP — a full session, no Puter required.'))
console.log(dim(`${kv.size} contacts seeded in the fake cloud.\n`))

// Exactly what main.js does when another app launches us.
const server = startApiServer({
  connection,
  callerApp: 'ai',
  methods: createMethods({ store }),
  subscribe: (fn) => store.subscribe(fn),
})
console.log(dim(`Server up for "ai". Tools offered: ${server.tools.join(', ')}`))
console.log(dim("(That first ← is the app-to-app protocol's greeting — an MCP client ignores it.)"))

heading('Handshake')
await send('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'demo', version: '1' } })
await notify('notifications/initialized')

heading('What can it do?')
const listed = await send('tools/list', {})
console.log(indent(listed.result.tools.map((t) => `${t.name}${dim(` — ${t.title}`)}`).join('\n')))

heading('Find someone')
await send('tools/call', { name: 'search_contacts', arguments: { query: 'engines' } })

heading('Who can I email?')
await send('tools/call', { name: 'suggest_recipients', arguments: { query: 'a' } })

heading('Add someone')
const created = await send('tools/call', {
  name: 'create_contact',
  arguments: {
    firstName: 'Radia',
    lastName: 'Perlman',
    company: 'Spanning Tree',
    emails: [{ label: 'Work', value: 'radia@spanning.net' }],
    tags: ['pioneers'],
  },
})
const radiaId = created.result.structuredContent.contact.id
console.log(dim('\n  …the address book changed, so a notification follows (debounced 250ms):'))
await settle(400)

heading('Read a contact as a vCard')
await send('resources/templates/list', {})
const vcard = await send('resources/read', { uri: `contact://${radiaId}` })
console.log(indent(vcard.result.contents[0].text.trim()))

heading('When the model gets it wrong')
console.log(dim('  A bad request comes back as a result the model can read and retry:'))
await send('tools/call', { name: 'get_contact', arguments: { id: 'no-such-id' } })
await send('tools/call', { name: 'create_contact', arguments: { emails: [{ value: 'not-an-email' }] } })
console.log(dim('\n  A bad call is a protocol error instead — the client got it wrong, not the model:'))
await send('tools/call', { name: 'drop_everything', arguments: {} })

heading('An app with a narrower grant')
console.log(dim('  ALLOWED_CALLERS governs both protocols. Suppose "assistant" had READ_METHODS:'))
const readOnly = startApiServer({
  connection: { postMessage: () => {}, on: () => {}, off: () => {} },
  callerApp: 'assistant',
  methods: createMethods({ store }),
  allowed: { assistant: ['ping', 'list', 'search', 'suggest', 'get'] },
})
console.log(indent(`tools offered: ${readOnly.tools.join(', ')}`))
console.log(indent(dim('no create_contact, no update_contact, no delete_contact — and tools/call on one')))
console.log(indent(dim('answers exactly as it would for a tool that does not exist.')))

server.stop()
readOnly.stop()
console.log(green('\n✓ Session complete.\n'))
