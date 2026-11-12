import { describe, expect, it } from 'vitest'
import { clipMarkdown, clipServer, MAX_CLIP_BYTES, parseClipDraft } from './clipper'

const sample = { version: 1, title: '测试文章', url: 'https://example.com/post', markdown: '## 正文\n\n内容', capturedAt: '2026-06-01T12:00:00Z', mode: 'article' }

describe('剪藏草稿边界', () => {
  it('规范标题和时间，并附上可点击来源', () => {
    const draft = parseClipDraft({ ...sample, title: '  一篇\n文章  ' })
    expect(draft.title).toBe('一篇 文章')
    expect(clipMarkdown(draft)).toContain('来源：[原始网页](<https://example.com/post>)')
    expect(clipMarkdown(draft)).toContain('剪藏时间：2026-06-01T12:00:00.000Z')
  })
  it.each(['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/file', 'https://name:password@example.com'])('拒绝不支持或携带凭据的来源 %s', (url) => {
    expect(() => parseClipDraft({ ...sample, url })).toThrow()
  })
  it('拒绝错误版本、模式、日期、空正文和超限 UTF-8 内容', () => {
    for (const patch of [{ version: 2 }, { mode: 'unknown' }, { capturedAt: 'invalid' }, { markdown: ' ' }, { markdown: '文'.repeat(MAX_CLIP_BYTES / 2) }]) {
      expect(() => parseClipDraft({ ...sample, ...patch })).toThrow()
    }
  })
  it('允许编辑中清空的草稿在刷新后恢复，保存时仍拒绝空正文', () => {
    expect(parseClipDraft({ ...sample, markdown: '' }, true).markdown).toBe('')
    expect(() => parseClipDraft({ ...sample, markdown: '' })).toThrow()
  })
  it('允许恢复超限编辑内容，保存时提示删减', () => {
    const edited = { ...sample, markdown: '文'.repeat(MAX_CLIP_BYTES / 2) }
    expect(parseClipDraft(edited, true).markdown).toBe(edited.markdown)
    expect(() => parseClipDraft(edited)).toThrow(/超过 1MB/)
  })
  it('仅链接无需正文，并转义来源中的 Markdown 分隔符', () => {
    const draft = parseClipDraft({ ...sample, mode: 'link', markdown: '', url: 'https://example.com/a(b)?v=<x>' })
    expect(clipMarkdown(draft)).toContain('https://example.com/a%28b%29?v=%3Cx%3E')
  })
})

describe('青简站点权限', () => {
  it('保留开发服务器端口，权限按域申请', () => {
    expect(clipServer(' http://localhost:8080/ ')).toEqual({ url: 'http://localhost:8080', permission: 'http://localhost/*' })
    expect(clipServer('https://note.example.com/').url).toBe('https://note.example.com')
  })
  it.each(['https://note.example.com/path', 'https://user:pass@note.example.com', 'https://note.example.com/?token=secret', 'https://note.example.com/#clip', 'file:///tmp', 'not a url'])('拒绝错误站点地址 %s', (server) => {
    expect(() => clipServer(server)).toThrow()
  })
})
