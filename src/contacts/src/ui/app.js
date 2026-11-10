// App conductor: builds the shell once, then re-renders the list/detail from
// store state and wires every interaction (selection, search, sort, filters,
// theme, import/export, context menus, keyboard shortcuts).
import { store } from '../store.js'
import { toast, progressToast } from '../toast.js'
import { icons } from '../icons.js'
import { track } from '../analytics.js'
import { isPuterApp } from '../env.js'
import { renderList, listCount, listLoading } from './list.js'
import { renderDetail, detailLoading } from './detail.js'
import { openEditor } from './editor.js'
import { openSmartAdd } from './smartadd.js'
import { startDropImport } from './dropimport.js'
import { confirmDialog } from './confirm.js'
import { promptDialog } from './prompt.js'
import {
  addBirthdayToCalendar,
  calendarSupported,
  disposeCalendar,
  initCalendar,
  upcomingFor,
} from './calendar.js'
import { showContextMenu } from '../contextmenu.js'
import { displayName } from '../model.js'
import { filterContacts, sortContacts, allTags, SORT_KEYS } from '../search.js'
import { escapeHtml, escapeAttr } from '../format.js'
import { contactToVCard, contactsToVCard, vCardToContacts } from '../vcard.js'
import { setPref, getPref } from '../env.js'
import { hasUserMenu, userMenu, syncUserMenuTheme } from './usermenu.js'

const SORT_LABELS = {
  first: 'First name',
  last: 'Last name',
  recent: 'Recently updated',
  created: 'Recently added',
}

let els = {}
let userEmail = ''
// Render bookkeeping so a re-render preserves scroll/focus instead of resetting
// the list to the top and dropping keyboard focus on every state change.
let lastListSig = null
let lastDetailId = null
// Anchor for Shift+click range selection: the last row touched by a plain
// (non-range) click or arrow move. Shift+click selects everything between it
// and the clicked row; the anchor itself only moves on the next plain action.
// `rangeBase` is the checked set as it stood at that moment, so repeated
// Shift+clicks re-extend (grow *and* shrink) the live range from the anchor
// while preserving checks made outside it.
let anchorId = null
let rangeBase = new Set()

// --- helpers ----------------------------------------------------------------

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

// 'system' | 'light' | 'dark' — 'system' means no explicit stored preference.
function currentThemeMode() {
  const stored = getPref('theme')
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

// Keep the browser UI (mobile address bar) in step with the *active* theme,
// including a manual override that differs from the system preference — the
// static <meta media> tags only track the system setting.
function setThemeColor(theme) {
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0f1115' : '#ffffff')
}

function applyTheme(mode) {
  const theme = mode === 'light' || mode === 'dark' ? mode : systemTheme()
  setPref('theme', mode === 'light' || mode === 'dark' ? mode : '') // '' → follow system
  document.documentElement.setAttribute('data-theme', theme)
  setThemeColor(theme)
  syncUserMenuTheme()
}

// Roughly the point where parsing a .vcf stops being instant (a card runs a
// few hundred bytes, so this is several hundred contacts' worth of text).
const PARSE_FEELS_SLOW = 200_000

/** Thousands separators, so "Importing 1,204 of 8,391…" stays readable. */
function count(n) {
  return n.toLocaleString()
}

// Yield until the browser has painted, so an element added just now is on
// screen before we start blocking work.
function nextFrame() {
  if (typeof requestAnimationFrame !== 'function') return new Promise((r) => setTimeout(r, 0))
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
}

function downloadFile(filename, text, type = 'text/vcard;charset=utf-8') {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// `field` ('email' | 'phone' | 'url' | 'address' | 'other') tags which detail a
// user copied, so analytics can see stored data actually being put to use.
async function copyText(value, field = 'other') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value)
    } else {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast('Copied to clipboard', 'success', 1600)
    track('Contact Info Used', { field })
  } catch (_e) {
    toast('Could not copy', 'error')
  }
}

// --- contact-scoped actions -------------------------------------------------

function exportAll() {
  if (!store.all.length) return toast('No contacts to export', 'info')
  downloadFile('contacts.vcf', contactsToVCard(sortContacts(store.all, 'last')))
  toast(`Exported ${store.all.length} contact${store.all.length === 1 ? '' : 's'}`, 'success')
}

function exportOne(contact) {
  const safe = (displayName(contact) || 'contact').replace(/[^\w.-]+/g, '_')
  downloadFile(`${safe}.vcf`, contactToVCard(contact))
  toast('vCard exported', 'success')
}

function triggerImport() {
  els.fileInput.value = ''
  els.fileInput.click()
}

function handleImportFiles(fileList) {
  return importFiles([...fileList], 'picker')
}

/**
 * Resolve once the address book is in memory. An error still resolves — the
 * store marks itself loaded either way, and its read has a timeout, so this
 * can't hang.
 */
function whenLoaded() {
  if (store.loaded) return Promise.resolve()
  return new Promise((resolve) => {
    const off = store.subscribe(() => {
      if (!store.loaded) return
      off()
      resolve()
    })
  })
}

/**
 * Import from anything that reads like a file — a File from the picker or an
 * OS drop, or a Puter cloud item wrapped by the drop importer. A source only
 * has to answer `name` and `text()`.
 *
 * `via` tags where the contacts came in, so the drop gesture's use is
 * measurable rather than guessed at.
 */
async function importFiles(files, via) {
  if (!files.length) return
  const progress = progressToast('Reading contacts…')
  try {
    // A drop can arrive before the first load finishes — the app is opened
    // *with* a .vcf, or someone drops one onto the loading list. Importing then
    // would de-dup against an empty book and re-add everyone already in it.
    await whenLoaded()
    const texts = []
    // A cloud item reads over the network, so this is inside the progress
    // toast's lifetime, not before it.
    for (const file of files) texts.push(await file.text())
    // Parsing is synchronous, and a large file blocks the main thread long
    // enough to look like a freeze — so get the indicator on screen and let it
    // paint before starting. Small files parse in a blink and keep the toast's
    // anti-flicker delay.
    if (texts.reduce((n, t) => n + t.length, 0) > PARSE_FEELS_SLOW) {
      progress.show()
      await nextFrame()
    }
    let parsed = []
    for (const text of texts) parsed = parsed.concat(vCardToContacts(text))
    if (!parsed.length) return toast('No contacts found in that file', 'error')
    const { written, skipped } = await store.importMany(parsed, {
      onProgress: (done, total) =>
        progress.update(`Importing ${count(done)} of ${count(total)}…`, total ? done / total : 1),
    })
    progress.done()
    if (!written) {
      toast(
        skipped ? 'Already in your address book — nothing new to import' : 'Could not import that file',
        skipped ? 'info' : 'error',
      )
      return
    }
    track('Contacts Imported', { count: written, via })
    let msg = `Imported ${written} contact${written === 1 ? '' : 's'}`
    if (skipped) msg += `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}`
    toast(msg, 'success')
  } catch (_e) {
    toast('Could not import that file', 'error')
  } finally {
    progress.done()
  }
}

// Re-create just-deleted contacts exactly as they were. saveMany restores by
// id (ids/timestamps preserved, no de-dup — a restored contact may legitimately
// share an email or phone with a survivor), and re-writing one that still
// exists after a partial bulk fail is a harmless identical write.
async function undoDelete(contacts) {
  const progress = progressToast('Restoring contacts…')
  try {
    const { saved, failed } = await store.saveMany(contacts, {
      onProgress: (done, total) =>
        progress.update(`Restoring ${count(done)} of ${count(total)}…`, total ? done / total : 1),
    })
    progress.done()
    if (saved && contacts.length === 1) store.setUI({ selectedId: contacts[0].id })
    if (failed) toast(`Restored ${saved} of ${contacts.length} — try again for the rest`, 'error')
    else toast(contacts.length === 1 ? 'Contact restored' : `Restored ${contacts.length} contacts`, 'success')
  } catch (_e) {
    toast('Could not restore', 'error')
  } finally {
    progress.done()
  }
}

async function deleteContact(contact) {
  const ok = await confirmDialog({
    title: `Delete ${displayName(contact)}?`,
    message: 'This permanently removes the contact from your cloud.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  try {
    await store.remove(contact.id)
    toast('Contact deleted', 'success', 6000, { label: 'Undo', onClick: () => undoDelete([contact]) })
  } catch (_e) {
    toast('Could not delete the contact', 'error')
  }
}

async function toggleFavorite(id) {
  try {
    await store.toggleFavorite(id)
  } catch (_e) {
    toast('Could not update favorite', 'error')
  }
}

function openContactMenu(contact, event, triggerBtn = null) {
  const items = [
    { label: 'Edit', action: () => openEditor(contact) },
    {
      label: contact.favorite ? 'Remove from favorites' : 'Add to favorites',
      action: () => toggleFavorite(contact.id),
    },
    // Offered only where there is a Calendar app to add it to, and only for
    // someone whose birthday we actually know.
    ...(contact.birthday && calendarSupported()
      ? [{ label: 'Add birthday to Calendar', action: () => addBirthdayToCalendar(contact) }]
      : []),
    { label: 'Export vCard', action: () => exportOne(contact) },
    {
      label: 'Copy email',
      disabled: !(contact.emails && contact.emails.length),
      action: () => contact.emails[0] && copyText(contact.emails[0].value, 'email'),
    },
    {
      label: 'Copy phone',
      disabled: !(contact.phones && contact.phones.length),
      action: () => contact.phones[0] && copyText(contact.phones[0].value, 'phone'),
    },
    '-',
    { label: 'Delete', danger: true, action: () => deleteContact(contact) },
  ]
  // Highlight the contact's sidebar row — and, when the menu was opened from the
  // detail page's "More" button, that button too — so it's clear which contact
  // the menu acts on. Removing the class from a re-rendered/detached element is
  // a harmless no-op. Mark only after showContextMenu: opening over an
  // undismissed menu runs that menu's onClose first, which would otherwise
  // strip the classes this menu just applied.
  const row = els.list.querySelector(`.contact-item[data-id="${CSS.escape(contact.id)}"]`)
  const marked = [row, triggerBtn].filter(Boolean)
  showContextMenu(event, items, {
    onClose: () => marked.forEach((el) => el.classList.remove('is-menu-open')),
  })
  marked.forEach((el) => el.classList.add('is-menu-open'))
}

function openListOptions(btn) {
  showAnchoredMenu(btn, [
    {
      label: 'Sort by',
      items: SORT_KEYS.map((key) => ({
        label: SORT_LABELS[key] + (store.ui.sort === key ? '   ✓' : ''),
        action: () => store.setUI({ sort: key }),
      })),
    },
    '-',
    { label: 'Select contacts', action: () => store.enterSelectMode() },
    { label: 'Import from .vcf', action: triggerImport },
    { label: 'Export all contacts', action: exportAll },
  ])
}

function openAccountMenu(btn) {
  const mode = currentThemeMode()
  const themeItem = (label, value) => ({
    label: label + (mode === value ? '   ✓' : ''),
    action: () => applyTheme(value),
  })
  const items = []
  // With puter.js's <puter-user-menu> beside it (usermenu.js) this is the
  // Settings menu: the element names the account and signs out.
  const account = !hasUserMenu()
  if (account && userEmail) {
    // A bare username (no "@") reads like a truncated email — show it as a handle.
    const identity = userEmail.includes('@') ? userEmail : `@${userEmail}`
    items.push({ label: identity, disabled: true }, '-')
  }
  items.push({
    label: 'Theme',
    items: [themeItem('System', 'system'), themeItem('Light', 'light'), themeItem('Dark', 'dark')],
  })
  if (account && !isPuterApp()) {
    items.push('-', { label: 'Sign out', danger: true, action: signOut })
  }
  showAnchoredMenu(btn, items)
}

async function signOut() {
  // Let go of the calendar first: it holds a service window open in this
  // user's session, and nothing of theirs should outlive the sign-out.
  disposeCalendar()
  try {
    await window.puter.auth.signOut()
  } finally {
    location.reload()
  }
}

// A sign-in or sign-out <puter-user-menu> did by itself (usermenu.js): the
// session is already another one, so the page starts over for it.
function sessionChanged() {
  disposeCalendar()
  location.reload()
}

// Build a synthetic event so a button click can position a context menu at the
// button's lower-left corner.
function menuEventFor(btn) {
  const r = btn.getBoundingClientRect()
  return { preventDefault() {}, clientX: r.left, clientY: r.bottom + 4 }
}

// Open a menu anchored under a trigger button, keeping the button visibly
// highlighted (its menu open) until the menu is dismissed. Highlight after
// showContextMenu — see openContactMenu on re-opening over an undismissed menu.
function showAnchoredMenu(btn, items) {
  showContextMenu(menuEventFor(btn), items, {
    onClose: () => btn && btn.classList.remove('is-menu-open'),
  })
  if (btn) btn.classList.add('is-menu-open')
}

// --- tag actions --------------------------------------------------------------

// Restore the affected contacts to their pre-rename/-delete state. `filter`
// re-points the sidebar tag filter too — but only when it still sits where the
// tag operation left it (the user may have moved on since).
async function undoRetag(snapshot, filter) {
  try {
    const { failed } = await store.saveMany(snapshot)
    if (store.ui.tag === filter.from) store.setUI({ tag: filter.to })
    if (failed) toast('Could not restore some contacts', 'error')
    else toast('Tags restored', 'success')
  } catch (_e) {
    toast('Could not restore', 'error')
  }
}

async function renameTagFlow(name) {
  const next = await promptDialog({
    title: 'Rename tag',
    message: `Renames “${name}” on every contact that has it.`,
    value: name,
    confirmLabel: 'Rename',
    validate: (v) => {
      if (!v) return 'Enter a tag name.'
      if (v.includes(',')) return 'Tag names can’t contain commas.'
      return ''
    },
  })
  if (next == null || next === name) return
  const before = store.ui.tag
  try {
    const { changed, failed, total, snapshot } = await store.renameTag(name, next)
    if (!changed && !failed) return // the tag vanished (or already matched) meanwhile
    // Capture where the operation left the filter *now* — undoRetag uses it to
    // restore the filter only if the user hasn't re-filtered by click time.
    const after = store.ui.tag
    const undo = { label: 'Undo', onClick: () => undoRetag(snapshot, { from: after, to: before }) }
    if (failed) {
      toast(`Renamed on ${changed} of ${total} contacts — try again for the rest`, 'error', 8000, changed ? undo : undefined)
    } else {
      toast(`Renamed “${name}” to “${next}”`, 'success', 6000, undo)
    }
    track('Tag Renamed', { count: changed })
  } catch (_e) {
    toast('Could not rename the tag', 'error')
  }
}

async function deleteTagFlow(name) {
  const n = filterContacts(store.all, { tag: name }).length
  const ok = await confirmDialog({
    title: `Delete tag “${name}”?`,
    message: `This removes the tag from ${n} contact${n === 1 ? '' : 's'}. The contacts themselves are kept.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  const before = store.ui.tag
  try {
    const { changed, failed, total, snapshot } = await store.removeTag(name)
    if (!changed && !failed) return
    const after = store.ui.tag // see renameTagFlow on why this is captured here
    const undo = { label: 'Undo', onClick: () => undoRetag(snapshot, { from: after, to: before }) }
    if (failed) {
      toast(`Removed from ${changed} of ${total} contacts — try again for the rest`, 'error', 8000, changed ? undo : undefined)
    } else {
      toast(`Tag “${name}” deleted`, 'success', 6000, undo)
    }
    track('Tag Deleted', { count: changed })
  } catch (_e) {
    toast('Could not delete the tag', 'error')
  }
}

// When a touch long-press just opened the tag menu, the browser may still
// deliver a contextmenu (Android) and a finger-lift click — both must be
// swallowed so the menu isn't reopened or a filter toggled underneath it.
let lastTagLongPress = 0

// Right-click (or long-press) menu for a sidebar tag chip. Highlight the chip
// while its menu is open, same as contact rows (see openContactMenu).
function openTagMenu(name, event, chip = null) {
  showContextMenu(
    event,
    [
      { label: 'Rename tag', action: () => renameTagFlow(name) },
      '-',
      { label: 'Delete tag', danger: true, action: () => deleteTagFlow(name) },
    ],
    { onClose: () => chip && chip.classList.remove('is-menu-open') },
  )
  if (chip) chip.classList.add('is-menu-open')
}

// --- selection / navigation -------------------------------------------------

function selectContact(id) {
  setAnchor(id)
  store.setUI({ selectedId: id, cursorId: id })
  els.shell.dataset.mobile = 'detail'
  // On the single-column mobile layout the list (and the row that had focus) is
  // now hidden, so move focus into the detail pane instead of dropping it.
  if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) {
    const back = els.detail.querySelector('.detail__back')
    if (back) back.focus()
  }
}

// Arrow keys from the search box (combobox pattern): move the active option but
// keep focus — and typing — in the field. Only meaningful for single-select.
function moveSelection(delta) {
  if (store.ui.selectMode) return
  const visible = sortContacts(filterContacts(store.all, store.ui), store.ui.sort)
  if (!visible.length) return
  const idx = visible.findIndex((c) => c.id === store.ui.selectedId)
  let next = idx + delta
  if (idx === -1) next = delta > 0 ? 0 : visible.length - 1
  next = Math.max(0, Math.min(visible.length - 1, next))
  setAnchor(visible[next].id)
  store.setUI({ selectedId: visible[next].id, cursorId: visible[next].id })
  const el = els.list.querySelector(`.contact-item[data-id="${CSS.escape(visible[next].id)}"]`)
  if (el) el.scrollIntoView({ block: 'nearest' })
}

// --- in-list keyboard navigation (roving focus over a listbox) --------------

function listItems() {
  return [...els.list.querySelectorAll('.contact-item')]
}

// Make `el` the focused row: sync the store cursor (and, in single-select mode,
// the selection so the detail follows) then put DOM focus on the freshly
// rendered node. setUI re-renders synchronously, so we re-query by id.
function focusListItem(el) {
  if (!el) return
  const id = el.dataset.id
  setAnchor(id)
  if (store.ui.selectMode) {
    if (store.ui.cursorId !== id) store.setUI({ cursorId: id })
  } else if (store.ui.selectedId !== id) {
    store.setUI({ selectedId: id, cursorId: id })
  }
  const fresh = els.list.querySelector(`.contact-item[data-id="${CSS.escape(id)}"]`) || el
  fresh.focus({ preventScroll: true })
  fresh.scrollIntoView({ block: 'nearest' })
}

// dir: +1 / -1 to step, 'home' / 'end' to jump. When the list isn't focused
// yet, the first press lands on the current tab stop rather than skipping it.
function navigateList(dir) {
  const items = listItems()
  if (!items.length) return
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.contact-item')
    : null
  if (!focused) {
    let seed
    if (dir === 'home') seed = 0
    else if (dir === 'end') seed = items.length - 1
    else {
      seed = items.findIndex((el) => el.tabIndex === 0)
      if (seed === -1) seed = 0
    }
    focusListItem(items[seed])
    return
  }
  const idx = Math.max(0, items.indexOf(focused))
  let next
  if (dir === 'home') next = 0
  else if (dir === 'end') next = items.length - 1
  else next = Math.max(0, Math.min(items.length - 1, idx + dir))
  focusListItem(items[next])
}

// --- multi-select / bulk actions --------------------------------------------

function selectAllVisible() {
  const visible = filterContacts(store.all, store.ui).map((c) => c.id)
  const allChecked = visible.length > 0 && visible.every((id) => store.ui.checked.has(id))
  store.setChecked(allChecked ? [] : visible)
}

// Remember a row as the range anchor, snapshotting the checks that should
// survive a subsequent Shift+click extension from it.
function setAnchor(id) {
  anchorId = id
  rangeBase = new Set(store.ui.checked)
}

// Shift+click range: check every visible row between the anchor and `id`
// (inclusive), on top of the baseline checks. From single-select mode this
// begins a multi-selection; the anchor stays put so a follow-up Shift+click
// re-extends from the same origin (growing or shrinking the range).
function selectRange(id) {
  const order = sortContacts(filterContacts(store.all, store.ui), store.ui.sort).map((c) => c.id)
  const a = order.indexOf(anchorId)
  const t = order.indexOf(id)
  if (t === -1) return
  if (a === -1) {
    // Anchor scrolled out of the current filter: treat it as a plain action.
    if (store.ui.selectMode) {
      setAnchor(id)
      store.toggleCheck(id)
    } else {
      selectContact(id)
    }
    return
  }
  const [lo, hi] = a <= t ? [a, t] : [t, a]
  const checked = new Set(rangeBase)
  for (const rowId of order.slice(lo, hi + 1)) checked.add(rowId)
  store.setUI({ selectMode: true, checked, cursorId: id })
}

async function bulkDelete() {
  const ids = [...store.ui.checked]
  if (!ids.length) return
  const ok = await confirmDialog({
    title: `Delete ${ids.length} contact${ids.length === 1 ? '' : 's'}?`,
    message: 'This permanently removes them from your cloud.',
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return
  // Snapshot the contacts up front so the toast can offer an undo.
  const snapshot = ids.map((id) => store.get(id)).filter(Boolean)
  const progress = progressToast('Deleting contacts…')
  try {
    const n = await store.removeMany(ids, {
      onProgress: (done, total) =>
        progress.update(`Deleting ${count(done)} of ${count(total)}…`, total ? done / total : 1),
    })
    progress.done()
    // removeMany absorbs per-contact failures and reports what actually went
    // through — surface a shortfall instead of dressing it up as success.
    // Stay in select mode: the failed contacts are still checked, so "Delete
    // selected" retries exactly the remainder.
    if (n < ids.length) {
      const deleted = snapshot.filter((c) => !store.get(c.id))
      const undo = { label: 'Undo', onClick: () => undoDelete(deleted) }
      toast(`Deleted ${n} of ${ids.length} — try again for the rest`, 'error', 8000, n ? undo : undefined)
      return
    }
    store.exitSelectMode()
    toast(`Deleted ${n} contact${n === 1 ? '' : 's'}`, 'success', 6000, {
      label: 'Undo',
      onClick: () => undoDelete(snapshot),
    })
  } catch (_e) {
    toast('Could not delete the contacts', 'error')
  } finally {
    progress.done()
  }
}

function bulkExport() {
  const list = [...store.ui.checked].map((id) => store.get(id)).filter(Boolean)
  if (!list.length) return
  downloadFile('contacts.vcf', contactsToVCard(list))
  toast(`Exported ${list.length} contact${list.length === 1 ? '' : 's'}`, 'success')
}

// --- rendering --------------------------------------------------------------

function renderSelectBar() {
  const n = store.ui.checked.size
  const visible = filterContacts(store.all, store.ui)
  const allChecked = visible.length > 0 && visible.every((c) => store.ui.checked.has(c.id))
  const someChecked = n > 0 && !allChecked
  // Tri-state checkbox: empty (none) → dash (some) → tick (all), with a single
  // toggle that selects everything visible or clears it.
  const state = allChecked ? 'true' : someChecked ? 'mixed' : 'false'
  const selAll = allChecked ? 'Deselect all' : 'Select all'
  const mark = allChecked ? icons.check : someChecked ? icons.minus : ''
  els.selectBar.innerHTML = `
    <button class="select-all" data-action="select-all" role="checkbox" aria-checked="${state}" title="${selAll}" aria-label="${selAll}">
      <span class="checkbox ${allChecked || someChecked ? 'is-on' : ''}" aria-hidden="true">${mark}</span>
    </button>
    <span class="select-bar__count">${n ? `${n} selected` : 'Select all'}</span>
    <div class="select-bar__actions">
      <button class="icon-btn" data-action="bulk-export" title="Export selected" aria-label="Export selected" ${n ? '' : 'disabled'}>${icons.download}</button>
      <button class="icon-btn icon-btn--danger" data-action="bulk-delete" title="Delete selected" aria-label="Delete selected" ${n ? '' : 'disabled'}>${icons.trash}</button>
    </div>
    <button class="btn btn--ghost btn--sm" data-action="cancel-select">Cancel</button>`
}

function renderTags() {
  const tags = allTags(store.all)
  if (!tags.length || store.ui.selectMode) {
    els.tags.innerHTML = ''
    els.tags.hidden = true
    return
  }
  els.tags.hidden = false
  els.tags.innerHTML = tags
    .map((t) => {
      const active = store.ui.tag.toLowerCase() === t.name.toLowerCase()
      return `<button class="chip ${active ? 'is-active' : ''}" data-action="filter-tag" data-tag="${escapeAttr(t.name)}" aria-pressed="${active}">${escapeHtml(t.name)}<span class="chip__count">${t.count}</span></button>`
    })
    .join('')
}

// Identify the focused action control (within a re-stamped region: list,
// detail, select bar, or tag strip) so focus can be returned to its
// equivalent after the surrounding HTML is replaced.
function activeActionKey() {
  const a = document.activeElement
  if (!a || !a.dataset || !a.dataset.action) return null
  const container = els.list.contains(a)
    ? 'list'
    : els.detail.contains(a)
      ? 'detail'
      : els.selectBar.contains(a)
        ? 'selectbar'
        : els.tags.contains(a)
          ? 'tags'
          : null
  if (!container) return null
  return {
    container,
    action: a.dataset.action,
    id: a.dataset.id || '',
    copy: a.dataset.copy || '',
    tag: a.dataset.tag || '',
  }
}

function restoreActionFocus(key) {
  if (!key) return
  const roots = { list: els.list, detail: els.detail, selectbar: els.selectBar, tags: els.tags }
  const root = roots[key.container]
  // Match by attribute values rather than building a selector, so arbitrary
  // copy values (emails, addresses) can't break the query.
  for (const el of root.querySelectorAll(`[data-action="${key.action}"]`)) {
    if (
      (el.dataset.id || '') === key.id &&
      (el.dataset.copy || '') === key.copy &&
      (el.dataset.tag || '') === key.tag
    ) {
      el.focus({ preventScroll: true })
      return
    }
  }
}

function render() {
  // Capture scroll/focus before we replace innerHTML below.
  const focusKey = activeActionKey()
  const prevListScroll = els.list.scrollTop
  const prevDetailScroll = els.detail.scrollTop
  const prevDetailId = lastDetailId
  // Only changes that re-filter/re-order the list should snap it back to the
  // top; selecting, favoriting, editing, etc. keep the reader where they were.
  const u = store.ui
  const listSig = `${u.query}|${u.tag}|${u.favoritesOnly}|${u.sort}|${u.selectMode}`
  const sigChanged = listSig !== lastListSig
  lastListSig = listSig

  let detailId = null
  if (store.error) {
    els.list.innerHTML = `
      <div class="list-empty">
        <p class="list-empty__title">Couldn't load your contacts</p>
        <p class="list-empty__hint">${escapeHtml(store.error.message || 'Something went wrong.')}</p>
        <button class="btn btn--soft btn--sm" data-action="reload">Try again</button>
      </div>`
    els.detail.innerHTML = renderDetail(null)
    els.count.textContent = ''
  } else if (!store.loaded) {
    // First load in flight: show a spinner, not the "empty address book" card —
    // and a neutral spinner in the detail, not the "choose someone" CTA.
    els.list.innerHTML = listLoading()
    els.detail.innerHTML = detailLoading()
    els.count.textContent = ''
  } else {
    els.list.innerHTML = renderList(store)
    // Keep the detail pane consistent with the list: if the current search or
    // filter excludes the selected contact, show the empty state instead.
    const selectedVisible =
      store.selected && filterContacts(store.all, store.ui).some((c) => c.id === store.selected.id)
    const shown = selectedVisible ? store.selected : null
    // What's next with this person, if the Calendar app has anything to say.
    // Answered from what we already know; a read it starts comes back through
    // the render hook set in mountApp, never by holding up this one.
    els.detail.innerHTML = renderDetail(shown, { upcoming: upcomingFor(shown) })
    els.count.textContent = listCount(store)
    if (selectedVisible) detailId = store.selected.id
  }

  // Restore scroll: list stays put unless its filter/order changed; the detail
  // stays put only while showing the same contact.
  if (!sigChanged) els.list.scrollTop = prevListScroll
  if (detailId && detailId === prevDetailId) els.detail.scrollTop = prevDetailScroll
  lastDetailId = detailId

  // Expose the active option to assistive tech (combobox → listbox pattern), so
  // arrow-key navigation from the search box is actually announced.
  const hasOptions = !!els.list.querySelector('[role="option"]')
  els.search.setAttribute('aria-expanded', hasOptions ? 'true' : 'false')
  if (detailId && !store.ui.selectMode) els.search.setAttribute('aria-activedescendant', `opt-${detailId}`)
  else els.search.removeAttribute('aria-activedescendant')

  const selecting = store.ui.selectMode
  els.segmented.hidden = selecting
  els.selectBar.hidden = !selecting
  if (selecting) {
    renderSelectBar()
    els.shell.dataset.mobile = 'list'
  }

  // "All" is only the active filter when nothing else narrows the list — a tag
  // filter highlights its own chip instead, so All/Favorites both go quiet.
  // Mirror the visual state into aria-pressed so it's not styling-only.
  const allActive = !store.ui.favoritesOnly && !store.ui.tag
  els.filterAll.classList.toggle('is-active', allActive)
  els.filterAll.setAttribute('aria-pressed', String(allActive))
  els.filterFav.classList.toggle('is-active', store.ui.favoritesOnly)
  els.filterFav.setAttribute('aria-pressed', String(store.ui.favoritesOnly))
  els.clearBtn.hidden = !store.ui.query
  if (!store.selected && !selecting) els.shell.dataset.mobile = 'list'
  renderTags()

  // After every re-stamped region (list, detail, select bar, tag strip) is in
  // place, put focus back on the equivalent of whatever control had it.
  restoreActionFocus(focusKey)
}

// --- event wiring -----------------------------------------------------------

function onClick(e) {
  const target = e.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  const id = target.dataset.id
  const contact = id ? store.get(id) : store.selected

  switch (action) {
    case 'select':
      if (e.shiftKey && id && anchorId && anchorId !== id) selectRange(id)
      else selectContact(id)
      break
    case 'toggle-check':
      if (!id) break
      if (e.shiftKey && anchorId && anchorId !== id) selectRange(id)
      else {
        setAnchor(id)
        store.toggleCheck(id)
      }
      break
    case 'cancel-select':
      store.exitSelectMode()
      break
    case 'select-all':
      selectAllVisible()
      break
    case 'bulk-delete':
      bulkDelete()
      break
    case 'bulk-export':
      bulkExport()
      break
    case 'new':
      openEditor()
      break
    case 'smart-add':
      openSmartAdd()
      break
    case 'import':
      triggerImport()
      break
    case 'export-all':
      exportAll()
      break
    case 'account':
      openAccountMenu(target)
      break
    case 'list-options':
      openListOptions(target)
      break
    case 'filter-all':
      store.setUI({ favoritesOnly: false, tag: '' })
      break
    case 'filter-fav':
      store.setUI({ favoritesOnly: true, tag: '' })
      break
    case 'filter-tag': {
      const tag = target.dataset.tag
      store.setUI({ tag: store.ui.tag.toLowerCase() === tag.toLowerCase() ? '' : tag, favoritesOnly: false })
      break
    }
    case 'clear-search':
      els.search.value = ''
      store.setUI({ query: '' })
      els.search.focus()
      break
    case 'back': {
      els.shell.dataset.mobile = 'list'
      // The detail pane — and the Back button that had focus — is now hidden;
      // hand focus to the selected row so keyboard flow continues in the list
      // (mirrors selectContact moving focus into the detail on the way in).
      const row =
        els.list.querySelector(`.contact-item[data-id="${CSS.escape(store.ui.selectedId || '')}"]`) ||
        els.list.querySelector('.contact-item[tabindex="0"]')
      if (row) {
        row.focus({ preventScroll: true })
        row.scrollIntoView({ block: 'nearest' })
      }
      break
    }
    case 'edit':
      if (contact) openEditor(contact)
      break
    case 'favorite':
      if (contact) toggleFavorite(contact.id)
      break
    case 'menu':
      if (contact) openContactMenu(contact, menuEventFor(target), target)
      break
    case 'copy':
      copyText(target.dataset.copy || '', target.dataset.field || 'other')
      break
    case 'reload':
      store.load().catch(() => {})
      break
    default:
      break
  }
}

function onContextMenu(e) {
  // Sidebar tag chips get their own menu; tag chips inside the detail card
  // still fall through to the contact menu below.
  const chip = e.target.closest('[data-tags] .chip[data-tag]')
  if (chip) {
    // Long-press already opened this menu (Android fires contextmenu too):
    // keep the native menu suppressed but don't open ours a second time.
    if (Date.now() - lastTagLongPress < 800) {
      e.preventDefault()
      return
    }
    openTagMenu(chip.dataset.tag, e, chip)
    return
  }
  const item = e.target.closest('.contact-item[data-id], .detail__card')
  if (!item) return
  const id = item.dataset.id || store.ui.selectedId
  const contact = store.get(id)
  if (contact) openContactMenu(contact, e)
}

function onKeydown(e) {
  // A key pressed inside puter.js's account menu (usermenu.js) is that menu's:
  // it arrives here from the element itself, and its arrows must not walk the list.
  if (e.target.closest && e.target.closest('puter-user-menu')) return
  const tag = (e.target.tagName || '').toLowerCase()
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable
  if (document.body.classList.contains('has-overlay')) return

  // Single-key shortcuts must not hijack browser/OS chords (Cmd+N opens a new
  // window, Alt+↑/↓ scrolls, etc.) — only fire on a bare key press.
  const bareKey = !(e.metaKey || e.ctrlKey || e.altKey)
  const inList = !!(e.target.closest && e.target.closest('.contact-item'))

  // Cmd/Ctrl+A selects everything visible while in select mode — but not when a
  // text field has focus, where it must keep selecting text.
  if ((e.key === 'a' || e.key === 'A') && (e.metaKey || e.ctrlKey) && !e.altKey && store.ui.selectMode && !typing) {
    e.preventDefault()
    selectAllVisible()
    return
  }

  if (e.key === '/' && !typing && bareKey) {
    e.preventDefault()
    els.search.focus()
    els.search.select()
  } else if ((e.key === 'n' || e.key === 'N') && !typing && bareKey) {
    e.preventDefault()
    openEditor()
  } else if (bareKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
    // From the search box, single-select navigation stays a combobox (focus and
    // text cursor remain in the field). Home/End there is left to the browser.
    if (e.target === els.search && !store.ui.selectMode && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      moveSelection(e.key === 'ArrowDown' ? 1 : -1)
    } else if (inList || !typing) {
      // Roving focus inside the listbox — works in single- and multi-select.
      e.preventDefault()
      const dir = e.key === 'Home' ? 'home' : e.key === 'End' ? 'end' : e.key === 'ArrowDown' ? 1 : -1
      navigateList(dir)
    }
  } else if (e.key === 'Escape' && e.target === els.search) {
    if (els.search.value) {
      els.search.value = ''
      store.setUI({ query: '' })
    } else {
      els.search.blur()
    }
  } else if (e.key === 'Escape' && store.ui.selectMode) {
    // Select mode is a mode — Escape cancels it, same as the Cancel button.
    store.exitSelectMode()
  }
}

function shellHtml() {
  // The account button; with puter.js's <puter-user-menu> (usermenu.js) it is
  // the Settings button just before the element, at the end of the bar.
  const withUserMenu = hasUserMenu()
  const accountBtn = withUserMenu
    ? `<button class="icon-btn" data-action="account" title="Settings" aria-label="Settings">${icons.settings}</button>`
    : `<button class="icon-btn" data-action="account" title="Account menu" aria-label="Account menu">${icons.user}</button>`
  return `
    <div class="app-shell" data-mobile="list">
      <header class="topbar">
        <div class="topbar__brand">
          <span class="topbar__logo"><img src="/icon.svg" width="24" height="24" alt="" /></span>
          <span class="topbar__name">Contacts</span>
        </div>
        <div class="topbar__actions">
          ${withUserMenu ? '' : accountBtn}
          <button class="btn btn--soft btn--sm" data-action="smart-add" title="Smart add" aria-label="Smart add">${icons.sparkles}<span class="hide-sm">Smart add</span></button>
          <button class="btn btn--primary btn--sm" data-action="new" title="New contact" aria-label="New contact">${icons.plus}<span class="hide-xs">New</span></button>
          ${withUserMenu ? accountBtn : ''}
        </div>
      </header>
      <div class="layout">
        <aside class="sidebar">
          <div class="sidebar__head">
            <div class="searchbar">
              <span class="searchbar__icon">${icons.search}</span>
              <input class="searchbar__input" data-search type="search" placeholder="Search name, company, email…" aria-label="Search contacts" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="contacts-listbox" aria-autocomplete="list" />
              <button class="searchbar__clear" data-action="clear-search" aria-label="Clear search" hidden>${icons.close}</button>
            </div>
            <button class="icon-btn icon-btn--bordered" data-action="list-options" title="List options" aria-label="List options">${icons.more}</button>
          </div>
          <div class="segmented">
            <button class="segmented__btn is-active" data-action="filter-all" aria-pressed="true">All</button>
            <button class="segmented__btn" data-action="filter-fav" aria-pressed="false">${icons.star}<span>Favorites</span></button>
          </div>
          <div class="select-bar" data-selectbar hidden></div>
          <div class="sidebar__tags" data-tags hidden></div>
          <div class="contact-list" data-list></div>
          <!-- role=status: the "12 of 80" count is the only feedback that a
               search/filter actually narrowed the list — announce it politely. -->
          <div class="sidebar__foot"><span data-count role="status"></span></div>
        </aside>
        <main class="detail" data-detail></main>
      </div>
      <!-- Shown only while a file is dragged over the window. Decorative: it
           describes a pointer gesture, and what the drop *did* is announced by
           the toast that follows. -->
      <div class="dropzone" data-dropzone hidden aria-hidden="true">
        <div class="dropzone__card">
          <span class="dropzone__icon">${icons.contacts}</span>
          <p class="dropzone__title">Drop to import</p>
          <p class="dropzone__hint">vCard (.vcf) contact files</p>
        </div>
      </div>
    </div>`
}

/** Mount the app shell into `root` and start rendering from store state. */
export function mountApp(root, { email = '' } = {}) {
  userEmail = email
  root.innerHTML = shellHtml()
  root.removeAttribute('aria-busy')
  const accountMenu = userMenu({ onSignOut: signOut, onSessionChanged: sessionChanged })
  if (accountMenu) root.querySelector('.topbar__actions').append(accountMenu)

  els = {
    shell: root.querySelector('.app-shell'),
    list: root.querySelector('[data-list]'),
    detail: root.querySelector('[data-detail]'),
    count: root.querySelector('[data-count]'),
    tags: root.querySelector('[data-tags]'),
    segmented: root.querySelector('.segmented'),
    selectBar: root.querySelector('[data-selectbar]'),
    search: root.querySelector('[data-search]'),
    clearBtn: root.querySelector('[data-action="clear-search"]'),
    filterAll: root.querySelector('[data-action="filter-all"]'),
    filterFav: root.querySelector('[data-action="filter-fav"]'),
    fileInput: Object.assign(document.createElement('input'), {
      type: 'file',
      accept: '.vcf,text/vcard,text/x-vcard',
      multiple: true,
    }),
  }
  els.fileInput.style.display = 'none'
  document.body.appendChild(els.fileInput)
  els.fileInput.addEventListener('change', () => handleImportFiles(els.fileInput.files))

  // Dropping a .vcf on the app imports it, from the OS or from the Puter
  // desktop. Wired at the document so the whole window is the target — a drop
  // that lands on the detail pane or a scrollbar should work like any other.
  startDropImport({
    zone: root.querySelector('[data-dropzone]'),
    onFiles: (files) => importFiles(files, 'drop'),
    onRejected: () => toast('Drop a .vcf file to import contacts', 'error'),
  })

  // Follow the system theme live while in "system" mode.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentThemeMode() === 'system') {
        const theme = systemTheme()
        document.documentElement.setAttribute('data-theme', theme)
        setThemeColor(theme)
      }
    })
  }

  root.addEventListener('click', onClick)
  root.addEventListener('contextmenu', onContextMenu)
  els.search.addEventListener('input', () => store.setUI({ query: els.search.value }))
  document.addEventListener('keydown', onKeydown)

  // iOS Safari never fires contextmenu on a long-press, which would leave tag
  // rename/delete unreachable there — so give chips an explicit touch
  // long-press that opens the same menu (anchored under the chip, clear of the
  // fingertip). Movement, lift, or a scroll takeover cancels the press.
  const LONG_PRESS_MS = 500
  let tagPressTimer = 0
  let tagPressStart = null
  const cancelTagPress = () => {
    clearTimeout(tagPressTimer)
    tagPressStart = null
  }
  els.tags.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return
    const chip = e.target.closest('.chip[data-tag]')
    if (!chip) return
    cancelTagPress()
    tagPressStart = { x: e.clientX, y: e.clientY }
    tagPressTimer = setTimeout(() => {
      tagPressStart = null
      lastTagLongPress = Date.now()
      // The finger-lift click would land on the fresh menu or re-toggle the
      // chip's filter — swallow it wherever it goes (auto-disarm in case the
      // browser never delivers one).
      const swallow = (ce) => {
        ce.stopPropagation()
        ce.preventDefault()
      }
      document.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => document.removeEventListener('click', swallow, true), 700)
      openTagMenu(chip.dataset.tag, menuEventFor(chip), chip)
    }, LONG_PRESS_MS)
  })
  els.tags.addEventListener('pointermove', (e) => {
    if (tagPressStart && Math.hypot(e.clientX - tagPressStart.x, e.clientY - tagPressStart.y) > 8) {
      cancelTagPress()
    }
  })
  for (const type of ['pointerup', 'pointercancel']) els.tags.addEventListener(type, cancelTagPress)

  // Let a vertical mouse wheel scroll the horizontal tag strip (it has no
  // scrollbar), so desktop mouse users can reach overflowing tags.
  els.tags.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return // horizontal gesture: leave to native
      if (els.tags.scrollWidth <= els.tags.clientWidth) return // nothing to scroll
      e.preventDefault()
      els.tags.scrollLeft += e.deltaY
    },
    { passive: false },
  )

  // The Calendar app answers when it answers; a landed reply re-renders the
  // detail pane the same way a store change does.
  initCalendar({ onUpdate: render })

  // Let go of the Calendar when this window goes away. Reading someone's
  // calendar means holding a service window open in their session, and inside
  // the Puter desktop — the only place that window exists — closing Contacts is
  // how a user ends this app, not the Sign out item below, which the desktop
  // owns the session for and so isn't offered. Without this the service window
  // outlives the app that opened it, invisible, until its own idle timeout.
  // `pagehide` rather than `unload`: it is the one browsers still fire
  // reliably, and it also covers a page put into the back/forward cache, which
  // has no more business holding another app's window open than a closed one.
  window.addEventListener('pagehide', disposeCalendar)
  // Coming back from that cache does not re-run mountApp, so hand the hook back
  // or a landed answer would have nothing to redraw with. A fresh client is
  // built on demand; disposeCalendar() left the module ready for one.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) initCalendar({ onUpdate: render })
  })

  store.subscribe(render)
  render()
}
