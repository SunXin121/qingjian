import { describe, expect, it } from 'vitest'
import { parseHeadings } from './components/Outline'
import { plainExcerpt } from './seo'

describe('plainExcerpt', () => {
  it('strips markdown formatting, code fences, images and HTML tags cleanly', () => {
    const md = [
      '# 架构说明',
      '',
      '这是一段包含 **加粗**、[内部链接](/r/abc/d/123) 与 ![架构图](/files/12345678901234567890/a.png) 的正文。',
      '',
      '```go',
      'func secretCode() {}',
      '```',
      '',
      '<br />',
      '> 引用总结',
    ].join('\n')

    const out = plainExcerpt(md, 80)
    expect(out).toContain('架构说明')
    expect(out).toContain('包含 加粗、内部链接 与 架构图 的正文')
    expect(out).not.toContain('secretCode')
    expect(out).not.toContain('<br')
  })

  it('truncates long text with an ellipsis', () => {
    const text = '青简知识库'.repeat(40)
    const out = plainExcerpt(text, 20)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(21)
  })
})

describe('parseHeadings', () => {
  it('extracts ATX headings while ignoring fenced code blocks', () => {
    const md = ['# 第一章', '```bash', '# comment inside code', '```', '## 1.1 **小节**', '### 1.1.1 细节 ###'].join('\n')
    expect(parseHeadings(md)).toEqual([
      { level: 1, text: '第一章', index: 0 },
      { level: 2, text: '1.1 小节', index: 1 },
      { level: 3, text: '1.1.1 细节', index: 2 },
    ])
  })
})
