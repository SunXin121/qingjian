import { describe, expect, it } from 'vitest'
import { fixImageRatios, isImageRatio } from './imageRatio'

describe('image ratio alt', () => {
  it('accepts ratios Milkdown writes', () => {
    expect(isImageRatio('1.00')).toBe(true)
    expect(isImageRatio('0.62')).toBe(true)
  })

  it('rejects timestamps, bare integers and huge values', () => {
    expect(isImageRatio('1555484318133')).toBe(false)
    expect(isImageRatio('3')).toBe(false)
    expect(isImageRatio('250.00')).toBe(false)
    expect(isImageRatio('0.00')).toBe(false)
  })

  it('clears numeric alts that are not ratios and keeps the rest', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'image', alt: '1555484318133' }] },
        { type: 'image-block', alt: '1.50' },
        { type: 'paragraph', children: [{ type: 'image', alt: '流程图' }] },
      ],
    }
    fixImageRatios(tree)
    expect(tree.children[0].children![0].alt).toBe('')
    expect(tree.children[1].alt).toBe('1.50')
    expect(tree.children[2].children![0].alt).toBe('流程图')
  })
})
