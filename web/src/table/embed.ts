// A view of a table embedded in a document: ```table {"table":"<id>","view":"<id>"}```.
// Rendered as static HTML inside the editor preview (and on share pages), so it stays
// light: no canvas grid, a capped number of rows, and a link to the full table.

import { api, type TableSummary } from '../api'
import { cellValue, displayText, primaryField, viewRecords, visibleFields } from './engine'
import type { AttachmentValue, Field, Rec, TableData } from './types'

export interface EmbedRef {
  table?: string
  view?: string
}

type Fetcher = (id: string) => Promise<TableData>
type LinkFn = (t: TableData, viewId: string) => string | null

let fetcher: Fetcher = (id) => api.table(id)
let linkFor: LinkFn = (t, v) => (t.repo_id ? `/r/${t.repo_id}/t/${t.id}?view=${v}` : null)

/** Share pages read tables through the share token and link inside the share. */
export function setEmbedSource(f: Fetcher, link: LinkFn) {
  fetcher = f
  linkFor = link
  cache.clear()
}
export function resetEmbedSource() {
  setEmbedSource((id) => api.table(id), (t, v) => (t.repo_id ? `/r/${t.repo_id}/t/${t.id}?view=${v}` : null))
}

const cache = new Map<string, { at: number; p: Promise<TableData> }>()
function load(id: string) {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < 8000) return hit.p
  const p = fetcher(id)
  cache.set(id, { at: Date.now(), p })
  p.catch(() => cache.delete(id))
  return p
}

export function parseEmbed(content: string): EmbedRef {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const TABLE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>'

function safeURL(u: string) {
  const s = u.trim()
  if (/^(https?:|mailto:|\/)/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '#'
  return 'https://' + s
}

function cellHTML(f: Field, r: Rec): string {
  const v = cellValue(r, f)
  switch (f.type) {
    case 'select':
    case 'multiselect': {
      const ids: string[] = f.type === 'select' ? (v ? [v] : []) : Array.isArray(v) ? v : []
      return ids
        .map((id) => f.options.choices?.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => `<span class="bt-tag c${c!.color % 10}"><span>${esc(c!.name)}</span></span>`)
        .join('')
    }
    case 'checkbox':
      return v ? '<span class="bt-embed-check">✓</span>' : ''
    case 'attachment':
      return ((v as AttachmentValue[] | undefined) ?? []).map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noreferrer" class="bt-chip">${esc(a.name)}</a>`).join(' ')
    case 'url':
      return v ? `<a href="${esc(safeURL(v))}" target="_blank" rel="noreferrer">${esc(v)}</a>` : ''
    case 'longtext':
      return esc(displayText(f, v)).replace(/\n/g, '<br>')
    default:
      return esc(displayText(f, v))
  }
}

const MAX_ROWS = 50

export function embedHTML(t: TableData, viewId?: string): string {
  const view = t.views.find((v) => v.id === viewId) ?? t.views[0]
  if (!view) return hint('表格没有视图')
  const fields = visibleFields(t, view)
  const records = viewRecords(t, view)
  const link = linkFor(t, view.id)
  const head = `<div class="bt-embed-head">${TABLE_ICON}<span class="bt-embed-title">${esc(t.title.trim() || '未命名表格')}</span><span class="bt-embed-view">${esc(view.name)}</span><span class="spacer"></span>${
    link ? `<a class="bt-embed-open" href="${esc(link)}" data-qj-nav>打开表格</a>` : ''
  }</div>`
  let body: string
  if (view.type === 'kanban') {
    const groupField = t.fields.find((f) => f.id === view.config.kanbanField && f.type === 'select') ?? t.fields.find((f) => f.type === 'select')
    const primary = primaryField(t)
    if (!groupField) body = hint('看板缺少单选分组字段')
    else {
      const cols = [...(groupField.options.choices ?? []).map((c) => ({ key: c.id, head: `<span class="bt-tag c${c.color % 10}"><span>${esc(c.name)}</span></span>` })), { key: '', head: '<span class="muted">未分组</span>' }]
      const byKey = new Map<string, Rec[]>(cols.map((c) => [c.key, []]))
      for (const r of records) (byKey.get(r.data[groupField.id]) ?? byKey.get(''))!.push(r)
      const others = fields.filter((f) => f.id !== primary.id && f.id !== groupField.id)
      body = `<div class="bt-embed-kanban">${cols
        .filter((c) => c.key !== '' || byKey.get('')!.length)
        .map((c) => {
          const list = byKey.get(c.key)!
          return `<div class="bt-embed-col"><div class="bt-embed-col-head">${c.head}<span class="muted">${list.length}</span></div>${list
            .slice(0, 20)
            .map(
              (r) =>
                `<div class="bt-embed-card"><div class="bt-embed-card-title">${esc(displayText(primary, cellValue(r, primary)) || '未命名记录')}</div>${others
                  .map((f) => {
                    const h = cellHTML(f, r)
                    return h ? `<div class="bt-embed-card-line"><span class="muted">${esc(f.name)}</span> ${h}</div>` : ''
                  })
                  .join('')}</div>`,
            )
            .join('')}${list.length > 20 ? `<div class="muted bt-embed-more">还有 ${list.length - 20} 条</div>` : ''}</div>`
        })
        .join('')}</div>`
    }
  } else {
    const rows = records.slice(0, MAX_ROWS)
    body = `<div class="bt-embed-scroll"><table><thead><tr>${fields.map((f) => `<th>${esc(f.name)}</th>`).join('')}</tr></thead><tbody>${rows
      .map((r) => `<tr>${fields.map((f) => `<td class="t-${f.type}">${cellHTML(f, r)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table></div>`
  }
  const foot = `<div class="bt-embed-foot">共 ${records.length} 条记录${view.type === 'grid' && records.length > MAX_ROWS ? `，显示前 ${MAX_ROWS} 条` : ''}</div>`
  return `<div class="bt-embed" contenteditable="false">${head}${body}${foot}</div>`
}

const hint = (text: string) => `<div class="ink-preview-hint">${esc(text)}</div>`

/** renderPreview hook for ```table blocks. */
export function renderTableEmbed(content: string, apply: (v: string) => void): string | undefined {
  const ref = parseEmbed(content)
  if (!ref.table) return hint('未选择表格')
  load(ref.table)
    .then((t) => apply(embedHTML(t, ref.view)))
    .catch((e) => apply(hint(e?.status === 404 ? '表格不存在或已被删除' : '表格加载失败：' + (e?.message ?? e))))
  return undefined
}

export function invalidateEmbed(id: string) {
  cache.delete(id)
}

export type { TableSummary }
