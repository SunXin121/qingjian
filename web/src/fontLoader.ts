import { fontSourceUrls, isOnlineFont, ONLINE_FONTS, onlineFontFamily, parseFontStylesheet, type FontSubset, type OnlineFont } from './fontCatalog'

export type FontStatus = 'idle' | 'loading' | 'loaded' | 'error'
const statuses = new Map<OnlineFont, FontStatus>()
const pending = new Map<OnlineFont, Promise<void>>()
const listeners = new Set<() => void>()
export const getFontStatus = (id: string): FontStatus => isOnlineFont(id) ? statuses.get(id) ?? 'idle' : 'idle'
export function subscribeFontStatus(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(id: OnlineFont, status: FontStatus) {
  statuses.set(id, status)
  listeners.forEach(listener => listener())
}

async function fontSubsets(id: OnlineFont): Promise<FontSubset[]> {
  const font = ONLINE_FONTS[id]
  if (!font.path.endsWith('.css')) return [{
    urls: fontSourceUrls(font.path), range: 'U+0-10FFFF', weight: 'weight' in font ? font.weight : '400',
  }]
  for (const url of fontSourceUrls(font.path)) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (!response.ok) continue
      return parseFontStylesheet(await response.text(), font.path)
    } catch { /* Try the equivalent pinned manifest on the other CDN. */ }
  }
  throw new Error('字体清单暂时无法下载')
}

/** Register all unicode ranges, but let the browser fetch only the glyphs a page uses. */
export function ensureOnlineFont(id: string, retry = false): Promise<void> {
  if (!isOnlineFont(id)) return Promise.resolve()
  const current = pending.get(id)
  if (current) return current
  if (getFontStatus(id) === 'loaded' || getFontStatus(id) === 'error' && !retry) return Promise.resolve()
  publish(id, 'loading')
  const task = (async () => {
    const faces: FontFace[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const subsets = await fontSubsets(id)
      const family = onlineFontFamily(id)
      for (const subset of subsets) {
        const face = new FontFace(family, subset.urls.map(url => `url(${JSON.stringify(url)})`).join(', '), {
          weight: subset.weight, unicodeRange: subset.range, display: 'swap',
        })
        document.fonts.add(face)
        faces.push(face)
      }
      const ready = document.fonts.load(`${subsets[0].weight.split(' ')[0]} 16px "${family}"`, '青简阅读笔记 Aa0123456789')
      const loaded = await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('字体加载超时')), 20000) }),
      ])
      if (!loaded.length) throw new Error('字体未包含预期字形')
      publish(id, 'loaded')
    } catch {
      faces.forEach(face => document.fonts.delete(face))
      publish(id, 'error')
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  })()
  pending.set(id, task)
  return task
}
