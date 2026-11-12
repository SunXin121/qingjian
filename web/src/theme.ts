import { ensureOnlineFont } from './fontLoader'
import { DEFAULT_TYPOGRAPHY, normalizeTypography, proseFontStack, PROSE_WIDTHS, type Typography } from './typography'
export { PROSE_WIDTHS } from './typography'
export type { ProseFont, ProseWidth } from './typography'

/**
 * Appearance: light / dark theme, accent colour, page background and reading style.
 *
 * The resolved theme is written to <html data-theme>, the accent to data-accent and the
 * background to data-background; tokens.css keys on them. 'system' (the default theme)
 * follows the OS setting live. Reading style (prose font / size / width) is applied as
 * CSS variables on <html>. Everything is stored per browser in localStorage.
 */
export type ThemeMode = 'system' | 'light' | 'dark'
export type Accent = 'cinnabar' | 'teal' | 'indigo' | 'celadon' | 'amber' | 'wisteria' | 'ink' | 'custom'
export type Background = 'paper' | 'white'

export interface Appearance extends Typography {
  accent: Accent
  /** the colour picked for the 'custom' accent, as #rrggbb */
  customAccent: string
  background: Background
}

export const ACCENTS: { id: Exclude<Accent, 'custom'>; name: string; swatch: string }[] = [
  { id: 'cinnabar', name: '朱砂', swatch: 'oklch(56% 0.15 30)' },
  { id: 'teal', name: '黛青', swatch: 'oklch(56% 0.08 205)' },
  { id: 'indigo', name: '靛蓝', swatch: 'oklch(56% 0.15 258)' },
  { id: 'celadon', name: '青瓷', swatch: 'oklch(60% 0.12 155)' },
  { id: 'amber', name: '琥珀', swatch: 'oklch(70% 0.13 75)' },
  { id: 'wisteria', name: '紫藤', swatch: 'oklch(58% 0.15 300)' },
  { id: 'ink', name: '松烟', swatch: 'oklch(30% 0.008 70)' },
]


const KEY = 'qj.theme'
const APPEARANCE_KEY = 'qj.appearance'
const DEFAULT_APPEARANCE: Appearance = {
  accent: 'cinnabar',
  customAccent: '#2f7d6d',
  background: 'paper',
  ...DEFAULT_TYPOGRAPHY,
}
const HEX = /^#[0-9a-f]{6}$/i
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
    const a = { ...DEFAULT_APPEARANCE, ...raw, ...normalizeTypography(raw) }
    if (a.accent !== 'custom' && !ACCENTS.some((x) => x.id === a.accent)) a.accent = DEFAULT_APPEARANCE.accent
    if (!HEX.test(String(a.customAccent))) a.customAccent = DEFAULT_APPEARANCE.customAccent
    if (a.background !== 'white') a.background = 'paper'
    return a
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

/** Text colour that reads on a filled `hex` (buttons, selected chips). */
function contrastOn(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.36 ? 'oklch(18% 0.006 70)' : 'oklch(99% 0 0)'
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
  root.style.setProperty('--prose-font', proseFontStack(a))
  void ensureOnlineFont(a.proseFont)
  root.style.setProperty('--prose-size', `${a.proseSize}px`)
  root.style.setProperty('--prose-line', String(a.proseLine))
  root.style.setProperty('--prose-tracking', `${a.proseTracking}em`)
  root.style.setProperty('--prose-paragraph-space', `${a.paragraphSpace}px`)
  root.style.setProperty('--prose-align', a.textAlign)
  root.dataset.proseHeading = a.headingStyle
  root.dataset.proseQuote = a.quoteStyle
  root.dataset.proseEmphasis = a.emphasisStyle
  // a custom accent is set inline; tokens.css derives hover and tints from it
  if (a.accent === 'custom') {
    root.style.setProperty('--accent-custom', a.customAccent)
    root.style.setProperty('--accent-contrast', contrastOn(a.customAccent))
  } else {
    root.style.removeProperty('--accent-custom')
    root.style.removeProperty('--accent-contrast')
  }
  root.style.setProperty('--prose-width', a.proseWidth === 'full' ? '100%' : `${PROSE_WIDTHS[a.proseWidth].px}px`)
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
