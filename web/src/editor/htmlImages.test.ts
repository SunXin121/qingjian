import { describe, expect, it } from 'vitest'
import { convertHtmlImages, parseHtmlImages } from './htmlImages'

const TYPORA = '<img src="https://5a352de.webp.li/2025/08/78dc.png" alt="image-20250818161711250" style="zoom:50%;" />'

describe('html images', () => {
  it('parses Typora-style img tags', () => {
    expect(parseHtmlImages(TYPORA)).toEqual([
      { src: 'https://5a352de.webp.li/2025/08/78dc.png', alt: 'image-20250818161711250', title: '' },
    ])
  })

  it('accepts wrappers, single quotes, entities and several images', () => {
    const html = `<p align="center"><img src='a.png?x=1&amp;y=2'><br><img src=b.png></p>`
    expect(parseHtmlImages(html)?.map((i) => i.src)).toEqual(['a.png?x=1&y=2', 'b.png'])
  })

  it('leaves other html alone', () => {
    expect(parseHtmlImages('<img src="a.png"> caption text')).toBeNull()
    expect(parseHtmlImages('<table><tr><td><img src="a.png"></td></tr></table>')).toBeNull()
    expect(parseHtmlImages('<img src="javascript:alert(1)">')).toBeNull()
    expect(parseHtmlImages('<b>bold</b>')).toBeNull()
  })

  it('makes block images out of standalone html and inline ones inside text', () => {
    const tree: any = {
      type: 'root',
      children: [
        { type: 'html', value: TYPORA },
        { type: 'paragraph', children: [{ type: 'html', value: TYPORA }] },
        { type: 'paragraph', children: [{ type: 'text', value: 'see ' }, { type: 'html', value: '<img src="x.png" alt="x">' }] },
      ],
    }
    convertHtmlImages(tree)
    expect(tree.children[0]).toEqual({ type: 'image-block', url: 'https://5a352de.webp.li/2025/08/78dc.png', alt: '', title: '' })
    expect(tree.children[1].type).toBe('image-block')
    expect(tree.children[2].children[1]).toMatchObject({ type: 'image', url: 'x.png', alt: 'x' })
  })
})
