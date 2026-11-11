/**
 * Light / dark theme. The resolved theme is written to <html data-theme>, which the
 * stylesheets key on; 'system' (the default) follows the OS setting live.
 */
export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'qj.theme'
const THEME_COLOR = { light: '#f5f5f3', dark: '#19191b' }
const mq = window.matchMedia?.('(prefers-color-scheme: dark)')

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* storage unavailable: follow the system */
  }
  return 'system'
}

const resolve = (mode: ThemeMode) => (mode === 'system' ? (mq?.matches ? 'dark' : 'light') : mode)

export const isDark = () => document.documentElement.dataset.theme === 'dark'

function apply() {
  const theme = resolve(getThemeMode())
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  root.dataset.theme = theme
  // the browser chrome (mobile address bar) follows the page, not the OS
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = THEME_COLOR[theme]
  document.head.appendChild(meta)
  window.dispatchEvent(new Event('qj-theme'))
}

export function setThemeMode(mode: ThemeMode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, mode)
  } catch {
    /* ignore */
  }
  apply()
}

/** Calls `fn` whenever the resolved theme changes; returns the unsubscribe function. */
export function onThemeChange(fn: () => void) {
  window.addEventListener('qj-theme', fn)
  return () => window.removeEventListener('qj-theme', fn)
}

export function initTheme() {
  apply()
  mq?.addEventListener('change', apply)
  // another tab changed the setting
  window.addEventListener('storage', (e) => e.key === KEY && apply())
}
