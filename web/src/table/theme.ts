// The canvas grid cannot read CSS variables, so the theme is resolved from the app's
// design tokens at runtime (and again when the colour scheme flips).

import { useEffect, useState } from 'react'
import type { Theme } from '@glideapps/glide-data-grid'
import { TAG_COLORS } from './types'

export interface Palette {
  tagBg: string[]
  tagFg: string[]
  groupBg: string
  footBg: string
  muted: string
  text: string
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
  groupBg: '#f5f5f3',
  footBg: '#fafaf9',
  muted: '#8c8d91',
  text: '#1c1c1e',
  chipBg: '#ededeb',
  chipFg: '#55565a',
  link: '#2f6bd9',
  searchHit: '#fdf3c4',
  searchCurrent: '#fbd27a',
  star: '#f5b301',
  starOff: '#e3e3e0',
  linkBg: '#e8eefc',
  linkFg: '#2a56b0',
  success: '#2f9e5b',
}

function read(): { theme: Partial<Theme>; palette: Palette } {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(name).trim()
  const font = v('--font')
  const p: Palette = {
    tagBg: Array.from({ length: TAG_COLORS }, (_, i) => v(`--tag-${i}-bg`)),
    tagFg: Array.from({ length: TAG_COLORS }, (_, i) => v(`--tag-${i}-fg`)),
    groupBg: v('--c-surface'),
    footBg: v('--c-side'),
    muted: v('--c-text-3'),
    text: v('--c-text'),
    chipBg: v('--c-surface-low'),
    chipFg: v('--c-text-2'),
    link: v('--c-info'),
    searchHit: v('--bt-search-hit'),
    searchCurrent: v('--bt-search-current'),
    star: v('--bt-star') || '#f5b301',
    linkBg: v('--tag-0-bg'),
    linkFg: v('--tag-0-fg'),
    starOff: v('--bt-star-off') || '#e3e3e0',
    success: v('--c-success') || '#2f9e5b',
  }
  const theme: Partial<Theme> = {
    accentColor: v('--c-info'),
    accentFg: '#ffffff',
    accentLight: v('--bt-accent-light'),
    textDark: v('--c-text'),
    textMedium: v('--c-text-2'),
    textLight: v('--c-text-3'),
    textBubble: v('--c-text-2'),
    bgIconHeader: v('--c-text-3'),
    fgIconHeader: v('--c-panel'),
    textHeader: v('--c-text-2'),
    textHeaderSelected: '#ffffff',
    bgCell: v('--c-panel'),
    bgCellMedium: v('--c-surface'),
    bgHeader: v('--c-side'),
    bgHeaderHasFocus: v('--c-active'),
    bgHeaderHovered: v('--c-active'),
    bgBubble: v('--c-surface-low'),
    bgBubbleSelected: v('--c-panel'),
    bgSearchResult: v('--c-mark'),
    borderColor: v('--c-border'),
    horizontalBorderColor: v('--c-border'),
    headerBottomBorderColor: v('--c-border-strong'),
    drilldownBorder: v('--c-border'),
    linkColor: v('--c-info'),
    fontFamily: font,
    baseFontStyle: '13px',
    headerFontStyle: '500 13px',
    markerFontStyle: '12px',
    editorFontSize: '13px',
    cellHorizontalPadding: 10,
    cellVerticalPadding: 4,
    headerIconSize: 16,
    roundingRadius: 4,
    resizeIndicatorColor: v('--c-info'),
  }
  return { theme, palette: p }
}

/** Grid theme that follows the page's light / dark tokens. */
export function useGridTheme(): Partial<Theme> {
  const [theme, setTheme] = useState(() => {
    const r = read()
    palette = r.palette
    return r.theme
  })
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const update = () => {
      // tokens switch in CSS on the same tick; read them after styles recalc
      requestAnimationFrame(() => {
        const r = read()
        palette = r.palette
        setTheme(r.theme)
      })
    }
    mq?.addEventListener('change', update)
    return () => mq?.removeEventListener('change', update)
  }, [])
  return theme
}
