import { describe, expect, it } from 'vitest'
import { DEFAULT_TYPOGRAPHY, normalizeTypography, proseFontStack } from './typography'

describe('reading preferences', () => {
  it('preserves old preferences and fills new fields when upgrading', () => {
    const old = { proseFont: 'serif', proseSize: 18, proseLine: 1.8, proseWidth: 'wide' }
    expect(normalizeTypography(old)).toEqual({ ...DEFAULT_TYPOGRAPHY, ...old })
  })

  it.each([null, undefined, 'invalid', [], 12])('falls back for malformed preferences: %j', (raw) => {
    expect(normalizeTypography(raw)).toEqual(DEFAULT_TYPOGRAPHY)
  })

  it('clamps sizes, keeps zero spacing and rejects invalid numbers and inherited keys', () => {
    expect(normalizeTypography({
      proseFont: 'toString', proseWidth: '__proto__', headingStyle: 'constructor',
      proseSize: 100, proseLine: -1, paragraphSpace: 0, proseTracking: Infinity,
    })).toEqual({ ...DEFAULT_TYPOGRAPHY, proseSize: 32, proseLine: 1.2 })
    expect(normalizeTypography({ proseLine: NaN, paragraphSpace: 500, proseTracking: -4 })).toMatchObject({
      proseLine: 1.65, paragraphSpace: 32, proseTracking: -0.02,
    })
    expect(normalizeTypography({ proseLine: 1.777, proseTracking: 0.013 })).toMatchObject({
      proseLine: 1.8, proseTracking: 0.015,
    })
  })

  it('retains new style selections through a JSON round trip', () => {
    const preferences = {
      ...DEFAULT_TYPOGRAPHY, proseFont: 'kai', proseWidth: 'full',
      textAlign: 'justify', headingStyle: 'numbered', quoteStyle: 'dashed', emphasisStyle: 'marker',
    }
    expect(normalizeTypography(JSON.parse(JSON.stringify(preferences)))).toEqual(preferences)
  })

  it('quotes custom fonts as one family, removes control characters and keeps a fallback', () => {
    const a = normalizeTypography({ proseFont: 'custom', customFont: 'A"; color: red; /*\n' })
    expect(a.customFont).not.toContain('\n')
    expect(proseFontStack(a)).toBe('"A\\"; color: red; /*", var(--font-ui)')
    expect(proseFontStack({ ...a, customFont: '   ' })).toBe('var(--font-ui)')
    // Spaces must survive intermediate keystrokes in a multiword family name.
    expect(normalizeTypography({ customFont: 'LXGW ' }).customFont).toBe('LXGW ')
  })
})
