# Surveys

**Live app:** [survey.puter.com](https://survey.puter.com/)

An open-source alternative to SurveyMonkey, Google Forms and Typeform, built on
[Puter](https://puter.com). Build a survey, share it with a link, and analyze
the results as they come in. Surveys and responses live in your own Puter
account. People answering a survey need no account at all.

No framework and no backend of its own: plain JavaScript, Vite, and Puter.js.

> Surveys is in alpha. Things will change, and data created now might not
> carry over to later versions.

## Features

**Build**

- 14 question types: multiple choice, checkboxes, dropdown, star rating
  (stars, hearts, thumbs or circles, 2 to 10 points), recommendation score
  (0 to 10), rating grid (one or several answers per row, with scored
  columns), slider, ranking, short answer, long answer, multiple short
  answers, contact details, date and time, and text blocks.
- Edit in place on a canvas that shows the survey in its theme. Each
  question opens into an editor with Edit, Options and Logic tabs.
- Answer choices: Enter adds the next one, Backspace on an empty one
  removes it, pasting several lines makes one choice per line, and choices
  reorder by dragging or with Alt+Up/Down. There are 15 ready-made answer
  scales (agreement, satisfaction, frequency and more) and an "edit as text"
  mode.
- "Other (please specify)" and "None of the above" options, randomized
  choice and row order, list/row/column layouts, minimum and maximum
  selections.
- Validation: required answers with custom messages, email, number, whole
  number, and text length.
- Logic: skip logic per answer (jump to a later page, end the survey, or
  disqualify), page logic, display conditions ("show only if Q2 is Yes"),
  and shuffled question order per page. Logic that points at something you
  delete is cleaned up automatically.
- Pages: add, duplicate, reorder, merge, or split a page after any question.
- Starter questions (name, email, age range, satisfaction, would recommend
  and more), and pasting a whole list of questions in one go.
- Themes: 12 presets, custom colors with live contrast checks against WCAG
  ratios, 5 font styles, corner styles, classic or boxed answer choices,
  and a logo.
- Options: all questions on a page or one at a time, progress bar, question
  numbers, required marks, back button, button labels, thank-you screen with
  an optional redirect, a disqualification screen and a closed-survey
  message.
- Undo and redo for every change, autosave, and keyboard shortcuts
  throughout (press `?`).
- Preview at desktop, tablet and phone widths, starting at any page.

**Start faster**

- 27 original templates in 7 categories: customer feedback, employees,
  events, education, market research, health and community, and everyday
  polls and forms.
- Describe what you want to learn and let AI draft the survey (Puter AI).
- Import: paste questions from a document, or open a survey file exported
  from Surveys.

**Collect**

- Share links. Each survey can have several links, so you can tell
  audiences apart in the results.
- Per link: open or closed, close automatically at a date and time, a
  response limit, one response per browser, password protection, and a
  custom thank-you screen.
- QR codes (SVG and PNG), embed code for websites (the frame resizes to fit
  the survey), and sharing by email.
- Edits stay private until you publish them, so respondents never see a
  half-finished change.

**Analyze**

- Question summaries: charts with tables for every question type, average
  ratings, the recommendation score (promoters minus detractors), grid
  averages, ranking scores, and frequent words in text answers.
- Responses over time, completion counts and typical time taken.
- Filters by link, outcome, date range, device and answer.
- Individual responses, one at a time (J and K to move), with delete.
- Export to CSV (Excel friendly) or JSON, and print the summary.

**Everywhere**

- Home screen with search, status filter, sorting, folders (drag surveys
  onto them), bulk move and delete, copies and survey file export.
- Light, dark, or system theme (the default).
- Works on desktop, tablet and phone.
- Accessible: native form controls, labelled groups, keyboard operation
  everywhere, visible focus, screen reader announcements, and respect for
  reduced motion.

## How it works

### Respondents and the collector worker

A survey is answered by people without a Puter account, who cannot reach the
creator's storage. So the first time you share a survey, the app deploys a
small [serverless worker](https://docs.puter.com/Workers/) into your own
account (`sv-<username>.puter.work`, source in
[`src/worker/collector.js`](src/worker/collector.js)). It serves published
surveys and stores responses in your account's key-value store.

- **Respondents** open `survey.puter.com/r/#<username>/<link id>`. The page
  ([`r/index.html`](r/index.html)) loads no SDK: it fetches the survey from
  the worker and posts answers back as CORS "simple" requests, so there is no
  preflight round trip. It is about 16 KB of gzipped JavaScript.
- **The worker re-checks every response** with the same code the respondent
  page uses ([`src/shared/runtime.js`](src/shared/runtime.js) is prepended to
  the worker at deploy time): unknown answers are dropped, required questions
  on the path the respondent actually took must be answered, and answers to
  skipped pages or hidden questions are discarded.
- **The app manages the worker** over admin routes authenticated with a
  random secret that lives only in your KV; the deployed source contains just
  its SHA-256. The worker is upgraded in place when its version changes, so
  links already shared keep working.
- Response limits are race-safe: a slot is reserved with an atomic increment
  before the response is written.

### Storage

Puter's key-value store is DynamoDB-backed: reads are billed per 4 KB, writes
per 1 KB of the whole entry, and there are no secondary indexes. The layout
follows from that:

| Data | Where | Why |
| --- | --- | --- |
| Survey list | KV `sv:index`, one map | One read draws the home screen; edits touch one item by path |
| Survey document | File `surveys/<id>.json` | Always loaded and saved whole, and autosaved often |
| Folders, settings | KV `sv:folders`, `sv:settings` | Small maps |
| Share links | KV `sv:collectors:<survey>` | Read only on that survey's screens |
| Published survey | Worker KV `svw:s:<survey>` | What respondents load |
| Responses | Worker KV `svw:r:<survey>:<time><random>`, one key each | A submission is one small write that never rewrites anything shared |
| Counts | Worker KV `svw:n:<survey>`, `svw:nc:<link>` | Atomic counters for lists and limits |

Each device caches responses in IndexedDB and syncs newest first, stopping
once it reaches responses it already has (with a few minutes of overlap for
clock differences between edge servers). Reopening results reads only what
is new.

### Performance

- The builder redraws only what changed: edits produce new objects only for
  the parts they touch, and the canvas reuses every page and card whose
  object is unchanged. Typing never redraws the editor.
- Every screen and dialog is its own chunk, loaded on first use. The
  worker's source text loads only when deploying.
- Charts are small inline SVGs. Above 3,000 responses, aggregation runs in a
  Web Worker so the page stays responsive.

## Development

```sh
npm install
npm run dev      # http://survey.puter.localhost:5263/
npm test
npm run build
```

Add `?local` to the URL (`http://localhost:5263/?local`) for **local demo
mode**: no Puter account, everything is kept in this browser, and the
collector worker runs inside the page. Share links work in other tabs of the
same browser, so you can try the whole build, share, answer and analyze loop
offline.

### Layout

```
index.html, r/index.html   the builder app and the respondent page
src/main.js, src/app.js    boot, routing and the app shell
src/views/                 home, survey frame, builder/, collect, analyze/, dialogs
src/respond/               respondent page and the survey renderer (shared with preview)
src/shared/runtime.js      answer checks and logic, shared with the worker
src/worker/collector.js    the collector worker
src/data/                  Puter and local backends, repository, sessions, worker client, response cache
src/model/                 survey model, edits, templates, text import, AI prompts
src/analysis/              aggregation, filters, export
tests/                     Vitest suites
```

## Third-party code

- [Lucide](https://lucide.dev) icons (ISC)
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT)

The app icon and brand mark are original.

## License

This repository, including all its contents, sub-projects, modules, and components, is licensed under [MIT](../../LICENSE) unless explicitly stated otherwise. Third-party libraries included in this repository may be subject to their own licenses.
