/**
 * Appearance: light / dark theme, accent colour, page background and reading style.
 *
 * The resolved theme is written to <html data-theme>, the accent to data-accent and the
 * background to data-background; tokens.css keys on them. 'system' (the default theme)
 * follows the OS setting live. Reading style (prose font / size / width) is applied as
 * CSS variables on <html>. Everything is stored per browser in localStorage.
 */
export type ThemeMode = 'system' | 'light' | 'dark'
export type Accent = 'cinnabar' | 'teal' | 'indigo' | 'celadon' | 'amber' | 'wisteria' | 'ink'
export type Background = 'paper' | 'white'
export type ProseFont = 'sans' | 'serif'
export type ProseWidth = 'narrow' | 'normal' | 'wide'

export interface Appearance {
  accent: Accent
  background: Background
  proseFont: ProseFont
  proseSize: number
  proseWidth: ProseWidth
}

export const ACCENTS: { id: Accent; name: string; swatch: string }[] = [
  { id: 'cinnabar', name: '朱砂', swatch: 'oklch(56% 0.15 30)' },
  { id: 'teal', name: '黛青', swatch: 'oklch(56% 0.08 205)' },
  { id: 'indigo', name: '靛蓝', swatch: 'oklch(56% 0.15 258)' },
  { id: 'celadon', name: '青瓷', swatch: 'oklch(60% 0.12 155)' },
  { id: 'amber', name: '琥珀', swatch: 'oklch(70% 0.13 75)' },
  { id: 'wisteria', name: '紫藤', swatch: 'oklch(58% 0.15 300)' },
  { id: 'ink', name: '松烟', swatch: 'oklch(30% 0.008 70)' },
]

export const PROSE_WIDTHS: Record<ProseWidth, { label: string; px: number }> = {
  narrow: { label: '窄', px: 660 },
  normal: { label: '标准', px: 760 },
  wide: { label: '宽', px: 920 },
}

const KEY = 'qj.theme'
const APPEARANCE_KEY = 'qj.appearance'
const DEFAULT_APPEARANCE: Appearance = {
  accent: 'cinnabar',
  background: 'paper',
  proseFont: 'sans',
  proseSize: 16,
  proseWidth: 'normal',
}
/* browser chrome colour (mobile address bar), matching the sidebar */
const THEME_COLOR = {
  light: { paper: '#f1efea', white: '#f6f6f7' },
  dark: { paper: '#141312', white: '#0f1011' },
}
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

export function getAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') as Partial<Appearance>
    const a = { ...DEFAULT_APPEARANCE, ...raw }
    if (!ACCENTS.some((x) => x.id === a.accent)) a.accent = DEFAULT_APPEARANCE.accent
    if (a.background !== 'white') a.background = 'paper'
    if (a.proseFont !== 'serif') a.proseFont = 'sans'
    if (!(a.proseWidth in PROSE_WIDTHS)) a.proseWidth = 'normal'
    a.proseSize = Math.min(20, Math.max(14, Math.round(Number(a.proseSize) || 16)))
    return a
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

const resolve = (mode: ThemeMode) => (mode === 'system' ? (mq?.matches ? 'dark' : 'light') : mode)

export const isDark = () => document.documentElement.dataset.theme === 'dark'

function apply() {
  const theme = resolve(getThemeMode())
  const a = getAppearance()
  const root = document.documentElement
  const themeChanged = root.dataset.theme !== theme
  root.dataset.theme = theme
  root.dataset.accent = a.accent
  root.dataset.background = a.background
  root.style.setProperty('--prose-font', a.proseFont === 'serif' ? 'var(--font-serif)' : 'var(--font-ui)')
  root.style.setProperty('--prose-size', `${a.proseSize}px`)
  root.style.setProperty('--prose-width', `${PROSE_WIDTHS[a.proseWidth].px}px`)
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = THEME_COLOR[theme][a.background]
  document.head.appendChild(meta)
  // drawings, diagrams and the table grid repaint for the new colours
  window.dispatchEvent(new Event('qj-theme'))
  if (themeChanged) window.dispatchEvent(new Event('qj-theme-mode'))
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

export function setAppearance(patch: Partial<Appearance>) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ ...getAppearance(), ...patch }))
  } catch {
    /* ignore */
  }
  apply()
}

/** Calls `fn` when light / dark flips (not on accent or background changes). */
export function onThemeModeChange(fn: () => void) {
  window.addEventListener('qj-theme-mode', fn)
  return () => window.removeEventListener('qj-theme-mode', fn)
}

/** Calls `fn` whenever the theme, accent or background changes; returns the unsubscribe function. */
export function onThemeChange(fn: () => void) {
  window.addEventListener('qj-theme', fn)
  return () => window.removeEventListener('qj-theme', fn)
}

export function initTheme() {
  apply()
  mq?.addEventListener('change', apply)
  // another tab changed the setting
  window.addEventListener('storage', (e) => (e.key === KEY || e.key === APPEARANCE_KEY) && apply())
}
