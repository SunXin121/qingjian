// The canvas grid cannot read CSS variables, so the theme is resolved from the app's
// design tokens at runtime (and again whenever theme mode, accent or background changes).

import { useEffect, useState } from 'react'
import type { Theme } from '@glideapps/glide-data-grid'
import { onThemeChange } from '../theme'
import { TAG_COLORS } from './types'

export interface Palette {
  tagBg: string[]
  tagFg: string[]
  groupBg: string
  footBg: string
  rowHover: string
  rowSelected: string
  headerSortBg: string
  headerFilterBg: string
  accent: string
  accentFg: string
  border: string
  panel: string
  muted: string
  text: string
  textMedium: string
  chipBg: string
  chipFg: string
  link: string
  searchHit: string
  searchCurrent: string
  star: string
  starOff: string
  linkBg: string
  linkFg: string
  success: string
}

export let palette: Palette = {
  tagBg: [],
  tagFg: [],
  groupBg: '#f5f6f8',
  footBg: '#f8f9fb',
  rowHover: '#f5f7fa',
  rowSelected: '#edf2ff',
  headerSortBg: '#eef3ff',
  headerFilterBg: '#eaf8f0',
  accent: '#b8432e',
  accentFg: '#ffffff',
  border: '#e5e6eb',
  panel: '#ffffff',
  muted: '#8f959e',
  text: '#1f2329',
  textMedium: '#646a73',
  chipBg: '#eff0f1',
  chipFg: '#4e5969',
  link: '#b8432e',
  searchHit: '#fff3bf',
  searchCurrent: '#ffd666',
  star: '#ffaa00',
  starOff: '#dee0e3',
  linkBg: '#e8f0ff',
  linkFg: '#245bdb',
  success: '#2ea121',
}

let probe: CanvasRenderingContext2D | null = null
/** Any CSS colour (oklch, color-mix…) as rgba(): the grid parses colours itself. */
function toRgba(color: string): string {
  if (!color) return color
  probe ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })
  if (!probe) return color
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = '#000'
  probe.fillStyle = color
  probe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`
}

function read(): { theme: Partial<Theme>; palette: Palette } {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => toRgba(cs.getPropertyValue(name).trim())
  const font = cs.getPropertyValue('--font-ui').trim()
  const accent = v('--accent')
  const accentFg = v('--accent-contrast') || '#ffffff'
  const accentLight = v('--accent-soft')
  const p: Palette = {
    tagBg: Array.from({ length: TAG_COLORS }, (_, i) => v(`--tag-${i}-bg`)),
    tagFg: Array.from({ length: TAG_COLORS }, (_, i) => v(`--tag-${i}-fg`)),
    groupBg: v('--bt-group-bg') || v('--c-surface'),
    footBg: v('--bt-header-bg') || v('--c-side'),
    rowHover: v('--bt-row-hover') || v('--c-surface'),
    rowSelected: v('--bt-row-selected') || accentLight,
    headerSortBg: v('--bt-sort-bg') || accentLight,
    headerFilterBg: v('--bt-filter-bg') || accentLight,
    accent,
    accentFg,
    border: v('--c-border'),
    panel: v('--c-panel'),
    muted: v('--c-text-3'),
    text: v('--c-text'),
    textMedium: v('--c-text-2'),
    chipBg: v('--c-surface-low'),
    chipFg: v('--c-text-2'),
    link: accent,
    searchHit: v('--bt-search-hit'),
    searchCurrent: v('--bt-search-current'),
    star: v('--bt-star') || '#ffaa00',
    linkBg: v('--tag-0-bg'),
    linkFg: v('--tag-0-fg'),
    starOff: v('--bt-star-off') || '#dee0e3',
    success: v('--c-success') || '#2ea121',
  }
  const theme: Partial<Theme> = {
    accentColor: accent,
    accentFg,
    accentLight,
    textDark: v('--c-text'),
    textMedium: v('--c-text-2'),
    textLight: v('--c-text-3'),
    textBubble: v('--c-text-2'),
    bgIconHeader: v('--c-text-3'),
    fgIconHeader: v('--c-panel'),
    textHeader: v('--c-text-2'),
    textHeaderSelected: accentFg,
    bgCell: v('--c-panel'),
    bgCellMedium: v('--c-surface'),
    bgHeader: v('--bt-header-bg') || v('--c-side'),
    bgHeaderHasFocus: v('--bt-header-focus') || v('--c-active'),
    bgHeaderHovered: v('--bt-header-hover') || v('--c-active'),
    bgBubble: v('--c-surface-low'),
    bgBubbleSelected: v('--c-panel'),
    bgSearchResult: v('--c-mark'),
    borderColor: v('--bt-grid-line') || v('--c-border'),
    horizontalBorderColor: v('--bt-grid-line') || v('--c-border'),
    headerBottomBorderColor: v('--c-border'),
    drilldownBorder: v('--c-border'),
    linkColor: accent,
    fontFamily: font,
    baseFontStyle: '13px',
    headerFontStyle: '500 13px',
    markerFontStyle: '12px',
    editorFontSize: '13px',
    cellHorizontalPadding: 10,
    cellVerticalPadding: 5,
    headerIconSize: 15,
    roundingRadius: 5,
    resizeIndicatorColor: accent,
  }
  return { theme, palette: p }
}

/** Grid theme that follows the page's light / dark, accent and background tokens. */
export function useGridTheme(): Partial<Theme> {
  const [theme, setTheme] = useState(() => {
    const r = read()
    palette = r.palette
    return r.theme
  })
  useEffect(() => {
    // Re-read on mount in case appearance changed while GridView was unmounted
    const sync = () => {
      const r = read()
      palette = r.palette
      setTheme(r.theme)
    }
    sync()
    const update = () => {
      // tokens switch in CSS on the same tick; read them after styles recalc
      requestAnimationFrame(sync)
    }
    return onThemeChange(update)
  }, [])
  return theme
}
