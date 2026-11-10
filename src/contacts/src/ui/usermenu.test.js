// @vitest-environment happy-dom
//
// puter.js's <puter-user-menu> at the end of the top bar: where the SDK defines
// it, it stands in for the account button, a Settings button keeps the rest of
// the account menu, and its Sign out is the app's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { store } from '../store.js'
import { mountApp } from './app.js'
import { disposeCalendar } from './calendar.js'
import { hasUserMenu, userMenu, USER_MENU_TAG } from './usermenu.js'

// A stand-in with the real element's shape: an open shadow root holding the
// Sign out item.
class FakeUserMenu extends window.HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<div class="menu"><button class="menu-item feedback"></button><button class="menu-item sign-out"></button></div>'
    this.ownSignOut = vi.fn()
    this.escapes = 0
    this.shadowRoot.querySelector('.sign-out').addEventListener('click', this.ownSignOut)
    this.shadowRoot.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.escapes++
    })
  }
}

let sdk
let root
let reload

function mount() {
  store.contacts.clear()
  store.loaded = false
  store.error = null
  root = document.createElement('div')
  document.body.appendChild(root)
  mountApp(root, { email: 'tester@example.com' })
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

const actionLabels = () =>
  [...root.querySelectorAll('.topbar__actions > *')].map((n) => n.getAttribute('aria-label') || n.localName)
const menuLabels = () => [...document.querySelectorAll('.ctx-menu__item')].map((n) => n.textContent.trim())
const closeMenu = () =>
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

beforeEach(() => {
  localStorage.clear()
  sdk = {
    env: 'web',
    appID: 'contacts-test',
    auth: { isSignedIn: () => true, signIn: vi.fn(), signOut: vi.fn(async () => {}) },
    kv: { list: async () => [], set: async () => true, del: async () => true, get: async () => null },
    ui: {},
  }
  window.puter = sdk
  reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
})

afterEach(() => {
  closeMenu()
  disposeCalendar()
  root?.remove()
  root = null
  vi.unstubAllGlobals()
  delete window.puter
})

describe('without <puter-user-menu> in the SDK', () => {
  it('keeps the account button first in the bar, with the account in its menu', () => {
    expect(hasUserMenu()).toBe(false)
    expect(userMenu()).toBe(null)
    mount()
    expect(actionLabels()).toEqual(['Account menu', 'Smart add', 'New contact'])
    click(root.querySelector('[data-action="account"]'))
    expect(menuLabels()).toContain('tester@example.com')
    expect(menuLabels()).toContain('Sign out')
    expect(menuLabels().some((label) => label.startsWith('Theme'))).toBe(true)
  })
})

describe('with <puter-user-menu> in the SDK', () => {
  beforeEach(() => {
    if (!window.customElements.get(USER_MENU_TAG)) window.customElements.define(USER_MENU_TAG, FakeUserMenu)
  })

  it('ends the bar, after a Settings button that keeps the theme without the account', () => {
    expect(hasUserMenu()).toBe(true)
    mount()
    expect(actionLabels()).toEqual(['Smart add', 'New contact', 'Settings', USER_MENU_TAG])
    click(root.querySelector('[data-action="account"]'))
    // The theme and its three choices, and nothing of the account.
    expect(menuLabels()).toHaveLength(4)
    expect(menuLabels()[0].startsWith('Theme')).toBe(true)
    expect(menuLabels()).not.toContain('tester@example.com')
    expect(menuLabels()).not.toContain('Sign out')
  })

  it('stays out of a Puter app window, where the element renders nothing', () => {
    sdk.env = 'app'
    expect(hasUserMenu()).toBe(false)
    mount()
    expect(actionLabels()).toEqual(['Account menu', 'Smart add', 'New contact'])
  })

  it("hands Sign out to the app, and closes the element's menu", async () => {
    mount()
    const menu = root.querySelector(USER_MENU_TAG)
    click(menu.shadowRoot.querySelector('.sign-out'))
    await flush()
    expect(menu.ownSignOut).not.toHaveBeenCalled()
    expect(menu.escapes).toBe(1)
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
    // Its other items are its own.
    click(menu.shadowRoot.querySelector('.feedback'))
    await flush()
    expect(sdk.auth.signOut).toHaveBeenCalledTimes(1)
  })

  it('starts the page over after a sign-in or a sign-out the element did by itself', () => {
    mount()
    const menu = root.querySelector(USER_MENU_TAG)
    menu.dispatchEvent(new window.CustomEvent('signout'))
    expect(reload).toHaveBeenCalledTimes(1)
    menu.dispatchEvent(new window.CustomEvent('signin', { detail: { user: { username: 'ada' } } }))
    expect(reload).toHaveBeenCalledTimes(2)
    expect(sdk.auth.signOut).not.toHaveBeenCalled()
    expect(sdk.auth.signIn).not.toHaveBeenCalled()
  })

  it('follows an explicit theme, and the OS otherwise', () => {
    mount()
    const menu = root.querySelector(USER_MENU_TAG)
    expect(menu.hasAttribute('theme')).toBe(false)
    const pick = (label) => {
      click(root.querySelector('[data-action="account"]'))
      click([...document.querySelectorAll('.ctx-menu__item')].find((n) => n.textContent.trim().startsWith(label)))
    }
    pick('Dark')
    expect(menu.getAttribute('theme')).toBe('dark')
    pick('System')
    expect(menu.hasAttribute('theme')).toBe(false)
  })

  it('leaves the keys pressed inside it to the element', () => {
    mount()
    const press = (target) => {
      const e = new window.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })
      target.dispatchEvent(e)
      return e.defaultPrevented
    }
    // `/` puts the keyboard in the search box from anywhere else on the page.
    expect(press(root.querySelector('[data-action="account"]'))).toBe(true)
    // A key pressed in the element's shadow tree reaches the page with the
    // element itself as its target.
    expect(press(root.querySelector(USER_MENU_TAG))).toBe(false)
  })
})
