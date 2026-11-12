// Shared with the browser extension; keep this module free of browser side effects.
export const CLIP_DRAFT_KEY = 'qj.clip.draft'
export const CLIP_EVENT = 'qj-clip-received'
export const MAX_CLIP_BYTES = 1024 * 1024
export const CLIP_MODES = ['article', 'selection', 'page', 'link'] as const
export type ClipMode = (typeof CLIP_MODES)[number]

export interface ClipDraft {
  version: 1
  title: string
  url: string
  markdown: string
  capturedAt: string
  mode: ClipMode
}

export function parseClipDraft(input: unknown, restoringEdits = false): ClipDraft {
  if (!input || typeof input !== 'object') throw new Error('剪藏草稿格式错误')
  const value = input as Record<string, unknown>
  if (value.version !== 1 || typeof value.title !== 'string' || typeof value.url !== 'string' ||
      typeof value.markdown !== 'string' || typeof value.capturedAt !== 'string' ||
      !CLIP_MODES.includes(value.mode as ClipMode)) throw new Error('剪藏草稿格式错误')
  const url = new URL(value.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('来源网址必须是 HTTP 或 HTTPS 地址')
  if (!Number.isFinite(Date.parse(value.capturedAt))) throw new Error('剪藏时间无效')
  const draft: ClipDraft = {
    version: 1,
    title: value.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || '网页剪藏',
    url: url.href,
    markdown: value.markdown.trim(),
    capturedAt: new Date(value.capturedAt).toISOString(),
    mode: value.mode as ClipMode,
  }
  if (!restoringEdits && draft.mode !== 'link' && !draft.markdown) throw new Error('没有提取到内容，请尝试整页或仅链接模式')
  if (!restoringEdits && new TextEncoder().encode(JSON.stringify(draft)).length > MAX_CLIP_BYTES) throw new Error('剪藏内容超过 1MB，请删减正文、缩小选区或使用仅链接模式')
  return draft
}

export function clipMarkdown(draft: ClipDraft, markdown = draft.markdown): string {
  const destination = draft.url.replace(/[<>\s()\\]/g, (char) => char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char))
  return `${markdown.trim()}\n\n---\n\n来源：[原始网页](<${destination}>)\n\n剪藏时间：${draft.capturedAt}\n`.trimStart()
}

export function clipServer(input: string): { url: string; permission: string } {
  const url = new URL(input.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== '/' && url.pathname !== '')) throw new Error('请填写青简站点首页地址，例如 https://note.example.com')
  if (url.search || url.hash) throw new Error('站点地址不能包含查询参数或锚点')
  return { url: url.origin, permission: `${url.protocol}//${url.hostname}/*` }
}
