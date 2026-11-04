# API Client

**Live app:** [apic.puter.com](https://apic.puter.com/)

Build, send and test HTTP requests in your browser. API Client is an
open-source alternative to Postman and Insomnia, built on
[Puter](https://puter.com). It uses no framework and has no backend of its
own: it is vanilla JavaScript, built with Vite, with Puter.js for accounts,
cloud storage and networking.

> **Alpha.** Features may change and data could be lost. Please do not rely on
> it for important work yet.

## Features

- **Requests.** Any method, including custom ones. The URL bar highlights
  `{{variables}}`, suggests them as you type `{{`, and shows each value on
  hover. Query parameters stay in sync with the URL, and `/:id` path
  variables get their own table. Headers come with name suggestions, bulk
  editing and a list of the headers the app adds on its own.
- **Bodies.** form-data (text and files), x-www-form-urlencoded, raw (JSON,
  text, JavaScript, HTML, XML) in a code editor with highlighting, folding
  and a Beautify button, binary files, and GraphQL (query plus variables).
- **Authorization.** Bearer token, Basic, API key (header or query),
  OAuth 2.0 (paste a token, or get one with the client credentials or
  password grant) and AWS Signature Version 4. Folders and requests inherit
  auth from their parents.
- **Responses.** Status, time and size, with a timing and size breakdown.
  The body can be shown pretty, raw or previewed (HTML without scripts,
  images, audio, video, PDF). Large responses are formatted in a worker and
  shown in a virtualized editor, and JSON keeps the exact digits of large
  numbers. Filter JSON with a path such as `$.data[*].id`. Also: headers,
  cookies, test results, find, wrap, copy, save to file, and save as an
  example.
- **WebSocket requests.** Connect, send text or JSON messages (with saved
  message drafts and `{{variables}}`), and follow a searchable log of what
  was sent and received, with subprotocols and automatic reconnect.
- **Collections.** Nested folders, drag and drop, rename (F2), duplicate,
  delete, collection and folder settings (description, auth, scripts,
  variables) and a filterable tree with full keyboard support.
- **Environments and variables.** Environments, globals, collection
  variables and variables set by scripts, plus secret values, bulk editing,
  an environment switcher with a quick look at what is in scope, and dynamic
  values like `{{$uuid}}`, `{{$timestamp}}` and `{{$randomEmail}}`.
- **Scripts and tests.** Pre-request and post-response JavaScript at the
  collection, folder and request level, with snippets and autocompletion.
  Scripts run in an isolated sandbox, a worker inside an opaque-origin
  iframe with no network access, and are stopped after a timeout.
- **Collection runner.** Run a collection or a folder with iterations, a
  delay, and a CSV or JSON data file. You can pick and reorder requests,
  stop on the first error, keep or discard variable changes, filter the
  results, rerun the failures and export the results.
- **Sharing.** Share a collection with other Puter users by username or
  email, so they can view it or edit it with you. Shared collections appear
  under "Shared with you", and changes reach everyone when the app is
  opened or regains focus.
- **History.** Every request you send, grouped by day and searchable, and
  can be reopened or saved to a collection.
- **Import and export.** Postman Collection v2.0/v2.1 and environments,
  OpenAPI 3 and Swagger 2 (JSON or YAML), HAR, Insomnia v4 exports and cURL
  commands. Pasting a cURL command into the URL bar fills in the request.
  Export uses this app's format or the v2.1 collection format.
- **Code snippets.** 17 languages and libraries, including cURL, HTTPie,
  wget, JavaScript fetch, Node.js, axios, Python requests and http.client,
  Go, PHP, Java, Kotlin, C#, Ruby, Rust, Swift and PowerShell.
- **Cookies.** A cookie jar for requests sent through the Puter relay, with
  a manager to view, add, edit and delete cookies.
- **Console.** Requests with their full headers, script logs, warnings and
  errors, with filters.
- **Workspace.** Tabs (preview tabs, drag to reorder, unsaved indicators,
  close others), a command palette (Ctrl/Cmd+K) and a resizable layout with
  the response below or beside the request.
- **Themes.** System (default), light and dark.
- **Everywhere.** Desktop, tablet and phone layouts. On phones the sidebar
  becomes a drawer and you switch between the request and the response.
- **Accessibility.** Landmarks and a skip link, tabs, trees, menus and
  dialogs that work with the keyboard, labels on every field, live
  announcements for responses and runs, visible focus, and reduced motion.

## Sending requests

Requests can be sent two ways. Pick one in the status bar or in Settings,
or override it per request.

| | Browser | Puter relay |
| --- | --- | --- |
| Needs an account | No | Yes |
| CORS | The server must allow requests from web pages | Not affected |
| Headers | The browser refuses some (Cookie, Host, Origin...) | Sent exactly as written |
| Response headers and cookies | Only the ones the server exposes | All of them |
| Local servers (localhost, LAN) | Yes | No |

The relay is a small HTTP/1.1 client (`src/core/http1.js`) running over
Puter's socket relay. TLS runs in your browser, so Puter's servers only see
encrypted bytes. **Automatic** mode (the default) tries the browser first. It
switches to the relay only when the browser is blocked and retrying cannot
send the request twice. For example, a plain POST that may already have
reached the server is not retried automatically.

## Where your data lives

- **Signed out:** everything is stored in this browser (IndexedDB).
- **Signed in:** the workspace is also saved to your Puter cloud, as one JSON
  file per collection and environment in the app's folder, so it syncs
  across devices. Changes upload a moment after you make them. Remote changes
  are picked up when the app starts or regains focus. When the same item was
  changed on two devices, the newer edit wins.
- When you sign in, work you did while signed out moves into your account.
- A shared collection stays in its owner's cloud. People with edit access
  write to that same file; people with view access cannot change it.
- Files attached to requests, cookies, the last response of each request
  and open tabs stay on the device.

## Script API

```js
// Pre-request
env.set('timestamp', String(Date.now()));
request.headers.set('X-Signature', await utils.hmacSha256(env.get('secret'), variables.resolve(request.body.raw)));

// Post-response
test('Status is 200', () => expect(response.status).toBe(200));
test('Has an id', () => expect(response.json()).toHaveProperty('id'));
env.set('token', response.json().token);
const other = await send({ method: 'GET', url: 'https://example.com/health' });
runner.next('Get profile'); // jump to a request when running a collection
```

Available globals: `request`, `response`, `env`, `collectionVars`,
`globals`, `vars`, `variables`, `test`, `expect`, `send`, `runner`, `info`,
`utils` and `console`. `expect` has Jest-style matchers.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Send | Ctrl/Cmd+Enter |
| Save, Save as | Ctrl/Cmd+S, Ctrl/Cmd+Shift+S |
| Search and commands | Ctrl/Cmd+K |
| New request | Ctrl/Cmd+Alt+N |
| Close tab | Ctrl/Cmd+Alt+W |
| Next and previous tab | Ctrl/Cmd+Alt+] and [ |
| Toggle sidebar | Ctrl/Cmd+\ |
| Toggle console | Ctrl+` |
| Import | Ctrl/Cmd+O |
| All shortcuts | Ctrl/Cmd+/ or ? |

## Development

```sh
npm install
npm run dev        # http://api-client.puter.localhost:5297/
npm test           # unit and DOM tests (Vitest + jsdom)
npm run test:e2e   # browser tests (Playwright)
npm run build
```

### Layout

- `src/core/`: no DOM. Data model, URL and variable handling, request
  preparation, transports (`send.js`, `http1.js`), cookies, importers
  (`io/`), code generation, cURL parsing, the script sandbox (`scripts/`),
  the collection runner and pretty printers.
- `src/data/`: IndexedDB storage, the workspace model and cloud sync.
- `src/ui/`: the app shell and views (sidebar, tabs, request and response,
  collections, environments, runner, console, dialogs, command palette).
  CodeMirror 6 is loaded on demand.
- `src/workers/`: the response formatter worker.

Third-party code: CodeMirror 6 and Lezer (MIT), Lucide icons (ISC) and
`yaml` (ISC). `npm run build` checks every dependency's license first.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
