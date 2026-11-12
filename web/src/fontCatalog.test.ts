import { describe, expect, it } from 'vitest'
import { FONT_GROUPS, fontSourceUrls, ONLINE_FONTS, parseFontStylesheet } from './fontCatalog'
import { normalizeTypography, proseFontStack } from './typography'

const path = ONLINE_FONTS.wenkai.path
const face = (url: string, range = 'U+4E00-9FFF') => `@font-face { font-family: original; src: url('${url}') format('woff2'); font-weight: 400; unicode-range: ${range}; }`

describe('online font catalog', () => {
  it('exposes all 24 edgeever catalog fonts and 3 legacy fonts exactly once', () => {
    const ids = FONT_GROUPS.flatMap(group => [...group.ids])
    expect(ids).toHaveLength(27)
    expect(new Set(ids).size).toBe(27)
    expect([...ids].sort()).toEqual(Object.keys(ONLINE_FONTS).sort())
    for (const id of ids) {
      expect(normalizeTypography({ proseFont: id }).proseFont).toBe(id)
      expect(proseFontStack(normalizeTypography({ proseFont: id }))).toContain(`Qingjian ${id}`)
    }
  })

  it('uses pinned npm and repository mirrors', () => {
    expect(fontSourceUrls(path)[1]).toBe('https://unpkg.com/' + path)
    expect(fontSourceUrls(ONLINE_FONTS.inter.path)[1]).toBe('https://raw.githubusercontent.com/tianma-if/edgeever/0da78f6ce8a4643b2dfb7afe9f7a5101472c4ffb/apps/web/public/poster-fonts/inter.woff2')
  })

  it('preserves unicode ranges and resolves each subset against both package mirrors', () => {
    const result = parseFontStylesheet(face('./chinese.woff2') + face('./latin.woff2', 'U+0-FF'), path)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      weight: '400', range: 'U+4E00-9FFF',
      urls: fontSourceUrls(path).map(url => new URL('./chinese.woff2', url).href),
    })
    expect(result[1].range).toBe('U+0-FF')
  })

  it('ignores comments, injected CSS and resources outside the pinned directory', () => {
    const css = `/* ${face('comment.woff2')} */ body { background: url('https://example.org/track'); }`
      + face('https://example.org/track.woff2') + face('../outside.woff2') + face('./bad.woff2', 'invalid')
      + face('./ok.woff2')
    const result = parseFontStylesheet(css, path)
    expect(result).toHaveLength(1)
    expect(result[0].urls.every(url => url.endsWith('/ok.woff2'))).toBe(true)
    expect(() => parseFontStylesheet('<html>unavailable</html>', path)).toThrow()
  })
})
