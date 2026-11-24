const DEFAULT_DESC = '青简 Qingjian — 个人自托管的在线知识库，原生 Markdown、多维表格与结构化绘图。'

function upsertMeta(attr: 'name' | 'property', key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertLink(rel: string, href: string | null, type?: string) {
  const selector = type ? `link[rel="${rel}"][type="${type}"]` : `link[rel="${rel}"]:not([type])`
  const existing = document.head.querySelector<HTMLLinkElement>(selector)
  if (!href) {
    existing?.remove()
    return
  }
  const el = existing ?? document.createElement('link')
  el.rel = rel
  if (type) el.type = type
  el.href = href
  if (!existing) document.head.appendChild(el)
}

export interface PageMetaOptions {
  title: string
  description?: string
  robots?: 'index, follow' | 'noindex, nofollow'
  canonical?: string | null
  markdownAlternate?: string | null
}

/** Synchronises document title, description, robots directive and canonical/alternate links on SPA navigation. */
export function setPageMeta({ title, description, robots = 'noindex, nofollow', canonical = null, markdownAlternate = null }: PageMetaOptions) {
  const fullTitle = title.includes('青简') ? title : `${title} - 青简`
  document.title = fullTitle
  const desc = description?.trim() || DEFAULT_DESC
  upsertMeta('name', 'description', desc)
  upsertMeta('name', 'robots', robots)
  upsertLink('canonical', canonical)
  upsertLink('alternate', markdownAlternate, 'text/markdown')
}

export function plainExcerpt(md: string, maxLen = 140): string {
  const cleaned = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+])[ \t]+/gm, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() + '…' : cleaned
}
