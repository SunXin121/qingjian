/** Browser-local reading preferences. Font names refer to fonts installed on this device. */
export const PROSE_FONTS = {
  sans: { label: '无衬线', stack: 'var(--font-ui)' },
  serif: { label: '衬线 / 宋体', stack: 'var(--font-serif)' },
  kai: { label: '楷体', stack: '"LXGW WenKai", "Kaiti SC", "KaiTi", "STKaiti", var(--font-serif)' },
  fangsong: { label: '仿宋', stack: '"FangSong", "STFangsong", "FangSong SC", var(--font-serif)' },
  mono: { label: '等宽', stack: 'var(--font-mono)' },
  custom: { label: '自定义本机字体', stack: 'var(--font-ui)' },
} as const
export type ProseFont = keyof typeof PROSE_FONTS
export const PROSE_WIDTHS = {
  narrow: { label: '窄', px: 660 },
  normal: { label: '标准', px: 760 },
  wide: { label: '宽', px: 920 },
  full: { label: '全宽', px: 0 },
} as const
export type ProseWidth = keyof typeof PROSE_WIDTHS
export const HEADING_STYLES = { default: '简洁', bar: '侧边色条', numbered: '自动编号' } as const
export const QUOTE_STYLES = { default: '简洁', dashed: '虚线边框', accent: '强调色条', minimal: '上下细线' } as const
export const EMPHASIS_STYLES = { default: '加粗', marker: '荧光标记' } as const
export interface Typography {
  proseFont: ProseFont
  customFont: string
  proseSize: number
  proseLine: number
  proseWidth: ProseWidth
  proseTracking: number
  paragraphSpace: number
  textAlign: 'left' | 'justify'
  headingStyle: keyof typeof HEADING_STYLES
  quoteStyle: keyof typeof QUOTE_STYLES
  emphasisStyle: keyof typeof EMPHASIS_STYLES
}
export const DEFAULT_TYPOGRAPHY: Typography = {
  proseFont: 'sans', customFont: '', proseSize: 16, proseLine: 1.65, proseWidth: 'normal',
  proseTracking: -0.005, paragraphSpace: 0, textAlign: 'left',
  headingStyle: 'default', quoteStyle: 'default', emphasisStyle: 'default',
}
export const TYPOGRAPHY_RANGES = {
  proseSize: { min: 12, max: 32, step: 1 },
  proseLine: { min: 1.2, max: 2.5, step: 0.05 },
  proseTracking: { min: -0.02, max: 0.12, step: 0.005 },
  paragraphSpace: { min: 0, max: 32, step: 1 },
} as const

function choice<T extends string>(value: unknown, options: Record<T, unknown>, fallback: T): T {
  return typeof value === 'string' && Object.hasOwn(options, value) ? value as T : fallback
}

export function normalizeTypography(input: unknown): Typography {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const result: Typography = {
    ...DEFAULT_TYPOGRAPHY,
    proseFont: choice(raw.proseFont, PROSE_FONTS, 'sans'),
    customFont: typeof raw.customFont === 'string' ? raw.customFont.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100) : '',
    proseWidth: choice(raw.proseWidth, PROSE_WIDTHS, 'normal'),
    textAlign: raw.textAlign === 'justify' ? 'justify' : 'left',
    headingStyle: choice(raw.headingStyle, HEADING_STYLES, 'default'),
    quoteStyle: choice(raw.quoteStyle, QUOTE_STYLES, 'default'),
    emphasisStyle: choice(raw.emphasisStyle, EMPHASIS_STYLES, 'default'),
  }
  for (const key of Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
    const { min, max, step } = TYPOGRAPHY_RANGES[key]
    const value = raw[key]
    result[key] = typeof value === 'number' && Number.isFinite(value)
      ? Number((Math.round(Math.min(max, Math.max(min, value)) / step) * step).toFixed(3))
      : DEFAULT_TYPOGRAPHY[key]
  }
  return result
}

export function proseFontStack(a: Typography): string {
  // Quote one literal family name, so commas and CSS syntax cannot alter the fallback stack.
  return a.proseFont === 'custom' && a.customFont.trim()
    ? `${JSON.stringify(a.customFont.trim())}, var(--font-ui)`
    : PROSE_FONTS[a.proseFont].stack
}
