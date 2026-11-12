import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const manifest = '@font-face { src: url("subset.woff2"); font-weight: 400; unicode-range: U+0-10FFFF; }'

describe('on-demand font loading', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('FontFace', class {
      constructor(public family: string, public source: string, public descriptors: FontFaceDescriptors) {}
    })
    vi.stubGlobal('document', { fonts: { add: vi.fn(), delete: vi.fn(), load: vi.fn().mockResolvedValue([{}]) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => manifest }))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not fetch anything until an online font is selected, and deduplicates loads', async () => {
    const loader = await import('./fontLoader')
    await loader.ensureOnlineFont('sans')
    expect(fetch).not.toHaveBeenCalled()
    const first = loader.ensureOnlineFont('wenkai')
    expect(loader.getFontStatus('wenkai')).toBe('loading')
    expect(loader.ensureOnlineFont('wenkai')).toBe(first)
    await first
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(document.fonts.add).toHaveBeenCalledTimes(1)
    expect(loader.getFontStatus('wenkai')).toBe('loaded')
    await loader.ensureOnlineFont('wenkai')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('tries the manifest mirror and notifies subscribers', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('CDN unavailable'))
    const loader = await import('./fontLoader')
    const listener = vi.fn()
    const unsubscribe = loader.subscribeFontStatus(listener)
    await loader.ensureOnlineFont('wenkai')
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('https://unpkg.com/')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(loader.getFontStatus('wenkai')).toBe('loaded')
    unsubscribe()
    await loader.ensureOnlineFont('inter')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('cleans up failed faces, uses fallback and allows an explicit retry', async () => {
    vi.mocked(document.fonts.load).mockRejectedValueOnce(new Error('download failed'))
    const loader = await import('./fontLoader')
    await loader.ensureOnlineFont('inter')
    expect(loader.getFontStatus('inter')).toBe('error')
    expect(document.fonts.delete).toHaveBeenCalledTimes(1)
    await loader.ensureOnlineFont('inter')
    expect(document.fonts.load).toHaveBeenCalledTimes(1)
    await loader.ensureOnlineFont('inter', true)
    expect(loader.getFontStatus('inter')).toBe('loaded')
    expect(document.fonts.load).toHaveBeenCalledTimes(2)
  })
})
