import { describe, expect, it } from 'vitest'
import { splitMarkdown } from './progressive'

const para = (n: number) => `第 ${n} 段正文内容，写得足够长一些以便切分。\n`

describe('splitMarkdown', () => {
  it('joins back to the input and cuts only before headings or column-0 text after a blank line', () => {
    const md = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? `## 标题 ${i}\n` : para(i))).join('\n')
    const parts = splitMarkdown(md, 100, 100)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.join('')).toBe(md)
    for (const p of parts.slice(1)) expect(p).toMatch(/^(## |第)/)
  })

  it('returns short documents whole', () => {
    expect(splitMarkdown('# a\n\nb\n', 1000, 1000)).toEqual(['# a\n\nb\n'])
  })

  it('never cuts inside fenced code, math, comments or raw html', () => {
    const filler = 'x'.repeat(50)
    const blocks = [
      '```js\n' + filler + '\n\n# not a heading\n\ntext inside code\n```\n',
      '~~~~\n' + filler + '\n\n```\n\nstill code\n~~~~\n',
      '$$\n' + filler + '\n\nE = mc^2\n$$\n',
      '<!--\n' + filler + '\n\nhidden\n-->\n',
      '<pre>\n' + filler + '\n\nkept\n</pre>\n',
    ]
    for (const b of blocks) {
      const md = filler + '\n\n' + b + '\nafter\n'
      const parts = splitMarkdown(md, 10, 10)
      expect(parts.join('')).toBe(md)
      expect(parts.some((p) => p.includes(b))).toBe(true)
    }
  })

  it('does not cut list items, quotes or indented continuation lines', () => {
    const md = 'intro\n\n- a\n\n- b\n\n  continued\n\n> quote\n\n> more\n\n1. one\n\n2. two\n\nend\n'
    const parts = splitMarkdown(md, 1, 1)
    expect(parts.join('')).toBe(md)
    expect(parts).toEqual(['intro\n\n- a\n\n- b\n\n  continued\n\n> quote\n\n> more\n\n1. one\n\n2. two\n\n', 'end\n'])
  })

  it('keeps documents with reference definitions or footnotes whole', () => {
    const body = Array.from({ length: 20 }, (_, i) => para(i)).join('\n')
    expect(splitMarkdown(body + '\n[ref]: https://example.com\n', 10, 10)).toHaveLength(1)
    expect(splitMarkdown(body + '\n[^1]: note\n', 10, 10)).toHaveLength(1)
  })
})
