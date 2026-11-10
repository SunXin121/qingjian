// Pure table logic shared by the grid, kanban, record card, embeds and share pages:
// display text, filtering, sorting, grouping, summaries, parsing pasted text and CSV.

import type { AttachmentValue, Choice, Field, FieldType, FilterCond, FilterOp, Rec, SortRule, SummaryKind, TableData, View } from './types'
import { isComputed, newId } from './types'

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtDateTime(ms: number, withTime = true) {
  const d = new Date(ms)
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${s} ${pad(d.getHours())}:${pad(d.getMinutes())}` : s
}

export const todayStr = (offset = 0) => fmtDateTime(Date.now() + offset * 86_400_000, false)

/** The field listed first is the primary field: always visible, first column, never deleted. */
export const primaryField = (t: TableData) => t.fields[0]

export function choiceOf(f: Field, id: unknown): Choice | undefined {
  return f.options.choices?.find((c) => c.id === id)
}

/** Raw value of a field for a record; computed fields derive from record metadata. */
export function cellValue(r: Rec, f: Field): any {
  switch (f.type) {
    case 'autonumber':
      return r.seq
    case 'created_time':
      return r.created_at
    case 'modified_time':
      return r.updated_at
  }
  return r.data[f.id]
}

export function isEmptyValue(v: any): boolean {
  return v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)
}

export function formatNumber(f: Field, v: number): string {
  if (typeof v !== 'number' || !isFinite(v)) return ''
  const p = f.options.precision
  if (f.options.thousands) {
    return v.toLocaleString('en-US', p === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: p, maximumFractionDigits: p })
  }
  return p === undefined ? String(v) : v.toFixed(p)
}

/** Plain-text rendering of a value (used for copy, CSV, search, embeds). */
export function displayText(f: Field, v: any): string {
  if (isEmptyValue(v) && f.type !== 'autonumber') return ''
  switch (f.type) {
    case 'number':
    case 'autonumber':
      return f.type === 'autonumber' ? String(v ?? '') : formatNumber(f, v)
    case 'select':
      return choiceOf(f, v)?.name ?? ''
    case 'multiselect':
      return (Array.isArray(v) ? v : [])
        .map((id) => choiceOf(f, id)?.name)
        .filter(Boolean)
        .join(', ')
    case 'checkbox':
      return v ? '✓' : ''
    case 'attachment':
      return (Array.isArray(v) ? (v as AttachmentValue[]) : []).map((a) => a.name).join(', ')
    case 'created_time':
    case 'modified_time':
      return typeof v === 'number' ? fmtDateTime(v) : ''
    default:
      return typeof v === 'string' ? v : String(v)
  }
}

// ---------- fields in a view ----------

/** All fields in the order the view shows them (hidden ones included). */
export function orderedFields(t: TableData, v: View | undefined): Field[] {
  const [primary, ...rest] = t.fields
  if (!primary) return []
  const order = v?.config.order ?? []
  const pos = new Map(order.map((id, i) => [id, i]))
  const sorted = rest
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (pos.get(a.f.id) ?? 1e6 + a.i) - (pos.get(b.f.id) ?? 1e6 + b.i))
    .map((x) => x.f)
  return [primary, ...sorted]
}

export function visibleFields(t: TableData, v: View | undefined): Field[] {
  const hidden = new Set(v?.config.hidden ?? [])
  return orderedFields(t, v).filter((f, i) => i === 0 || !hidden.has(f.id))
}

// ---------- filtering ----------

export interface OpDef {
  op: FilterOp
  label: string
  /** the condition takes no value */
  unary?: boolean
}

export function filterOps(type: FieldType): OpDef[] {
  const empty: OpDef[] = [
    { op: 'empty', label: '为空', unary: true },
    { op: 'not_empty', label: '不为空', unary: true },
  ]
  switch (type) {
    case 'number':
    case 'autonumber':
      return [
        { op: 'is', label: '=' },
        { op: 'is_not', label: '≠' },
        { op: 'gt', label: '>' },
        { op: 'gte', label: '≥' },
        { op: 'lt', label: '<' },
        { op: 'lte', label: '≤' },
        ...empty,
      ]
    case 'select':
      return [{ op: 'is', label: '是' }, { op: 'is_not', label: '不是' }, ...empty]
    case 'multiselect':
      return [{ op: 'contains', label: '包含任一' }, { op: 'not_contains', label: '不包含' }, ...empty]
    case 'date':
    case 'created_time':
    case 'modified_time':
      return [{ op: 'is', label: '是' }, { op: 'lt', label: '早于' }, { op: 'gt', label: '晚于' }, ...empty]
    case 'checkbox':
      return [{ op: 'is', label: '是' }]
    case 'attachment':
      return [{ op: 'contains', label: '文件名包含' }, ...empty]
    default:
      return [
        { op: 'contains', label: '包含' },
        { op: 'not_contains', label: '不包含' },
        { op: 'is', label: '等于' },
        { op: 'is_not', label: '不等于' },
        ...empty,
      ]
  }
}

export function defaultCondValue(type: FieldType) {
  if (type === 'checkbox') return true
  if (type === 'select' || type === 'multiselect') return []
  if (type === 'date' || type === 'created_time' || type === 'modified_time') return 'today'
  return ''
}

export const DATE_PRESETS: { value: string; label: string }[] = [
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'tomorrow', label: '明天' },
]

function resolveDate(v: string): string {
  if (v === 'today') return todayStr()
  if (v === 'yesterday') return todayStr(-1)
  if (v === 'tomorrow') return todayStr(1)
  return v
}

/** Date part (YYYY-MM-DD) of a date-ish value. */
function datePart(v: any): string {
  if (typeof v === 'number') return fmtDateTime(v, false)
  if (typeof v === 'string') return v.slice(0, 10)
  return ''
}

function condActive(c: FilterCond, f: Field): boolean {
  const def = filterOps(f.type).find((o) => o.op === c.op)
  if (!def) return false
  if (def.unary || f.type === 'checkbox') return true
  if (Array.isArray(c.value)) return c.value.length > 0
  return c.value !== undefined && c.value !== null && String(c.value).trim() !== ''
}

function matchCond(c: FilterCond, f: Field, r: Rec): boolean {
  const v = cellValue(r, f)
  if (c.op === 'empty') return isEmptyValue(v)
  if (c.op === 'not_empty') return !isEmptyValue(v)
  switch (f.type) {
    case 'checkbox':
      return !!v === !!c.value
    case 'number':
    case 'autonumber': {
      const x = Number(c.value)
      if (typeof v !== 'number') return c.op === 'is_not'
      switch (c.op) {
        case 'is':
          return v === x
        case 'is_not':
          return v !== x
        case 'gt':
          return v > x
        case 'gte':
          return v >= x
        case 'lt':
          return v < x
        case 'lte':
          return v <= x
      }
      return true
    }
    case 'select': {
      const ids: string[] = Array.isArray(c.value) ? c.value : [c.value]
      const hit = ids.includes(v)
      return c.op === 'is_not' ? !hit : hit
    }
    case 'multiselect': {
      const ids: string[] = Array.isArray(c.value) ? c.value : [c.value]
      const have: string[] = Array.isArray(v) ? v : []
      const hit = ids.some((id) => have.includes(id))
      return c.op === 'not_contains' ? !hit : hit
    }
    case 'date':
    case 'created_time':
    case 'modified_time': {
      const d = datePart(v)
      const target = resolveDate(String(c.value))
      if (!d) return false
      if (c.op === 'is') return d === target
      if (c.op === 'lt') return d < target
      if (c.op === 'gt') return d > target
      return true
    }
    default: {
      const text = displayText(f, v).toLowerCase()
      const q = String(c.value).toLowerCase().trim()
      switch (c.op) {
        case 'contains':
          return text.includes(q)
        case 'not_contains':
          return !text.includes(q)
        case 'is':
          return text === q
        case 'is_not':
          return text !== q
      }
      return true
    }
  }
}

export function activeConds(t: TableData, v: View): FilterCond[] {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  return (v.config.filter?.conds ?? []).filter((c) => {
    const f = byId.get(c.field)
    return f && condActive(c, f)
  })
}

export function makeMatcher(t: TableData, v: View): (r: Rec) => boolean {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const conds = activeConds(t, v)
  if (!conds.length) return () => true
  const any = v.config.filter?.conj === 'or'
  return (r) => (any ? conds.some((c) => matchCond(c, byId.get(c.field)!, r)) : conds.every((c) => matchCond(c, byId.get(c.field)!, r)))
}

// ---------- sorting ----------

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** Comparable key for sorting / grouping; undefined sorts last. */
function sortKey(f: Field, v: any): number | string | undefined {
  if (isEmptyValue(v) && f.type !== 'checkbox') return undefined
  switch (f.type) {
    case 'number':
    case 'autonumber':
    case 'created_time':
    case 'modified_time':
      return typeof v === 'number' ? v : undefined
    case 'checkbox':
      return v ? 1 : 0
    case 'select': {
      const i = f.options.choices?.findIndex((c) => c.id === v) ?? -1
      return i < 0 ? undefined : i
    }
    case 'multiselect': {
      const choices = f.options.choices ?? []
      const idx = (v as string[]).map((id) => choices.findIndex((c) => c.id === id)).filter((i) => i >= 0)
      return idx.length ? idx.sort((a, b) => a - b).map((i) => String(i).padStart(4, '0')).join(',') : undefined
    }
    case 'attachment':
      return (v as unknown[]).length
    default:
      return displayText(f, v)
  }
}

function compareKeys(a: number | string | undefined, b: number | string | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return collator.compare(String(a), String(b))
}

export function sortRecords(t: TableData, list: Rec[], rules: SortRule[]): Rec[] {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const rs = rules.map((r) => ({ f: byId.get(r.field)!, desc: !!r.desc })).filter((r) => r.f)
  if (!rs.length) return list
  const keyed = list.map((r, i) => ({ r, i, k: rs.map(({ f }) => sortKey(f, cellValue(r, f))) }))
  keyed.sort((a, b) => {
    for (let j = 0; j < rs.length; j++) {
      const ka = a.k[j]
      const kb = b.k[j]
      // empty values stay at the end in both directions
      if (ka === undefined || kb === undefined) {
        if (ka !== kb) return ka === undefined ? 1 : -1
        continue
      }
      const c = compareKeys(ka, kb)
      if (c) return rs[j].desc ? -c : c
    }
    return a.i - b.i
  })
  return keyed.map((x) => x.r)
}

/**
 * Records a view shows, filtered and sorted (groups sort first). `sticky` records stay
 * visible even if they no longer match the filter, so a freshly added or edited row
 * does not vanish under the cursor.
 */
export function viewRecords(t: TableData, v: View, sticky?: Set<string>): Rec[] {
  const match = makeMatcher(t, v)
  const list = t.records.filter((r) => match(r) || sticky?.has(r.id))
  const rules = [...(v.type === 'grid' ? (v.config.groups ?? []) : []), ...(v.config.sorts ?? [])]
  return sortRecords(t, list, rules)
}

// ---------- grouping ----------

export function groupKey(f: Field, v: any): string {
  if (f.type === 'checkbox') return v ? '1' : '0'
  if (isEmptyValue(v)) return ''
  switch (f.type) {
    case 'select':
      return choiceOf(f, v) ? String(v) : ''
    case 'multiselect':
      return (v as string[]).filter((id) => choiceOf(f, id)).join(',')
    case 'date':
    case 'created_time':
    case 'modified_time':
      return datePart(v)
    default:
      return displayText(f, v)
  }
}

export function groupLabel(f: Field, key: string): string {
  if (f.type === 'checkbox') return key === '1' ? '已勾选' : '未勾选'
  if (key === '') return `${f.name}为空`
  if (f.type === 'select') return choiceOf(f, key)?.name ?? key
  if (f.type === 'multiselect')
    return key
      .split(',')
      .map((id) => choiceOf(f, id)?.name ?? '')
      .join(', ')
  return key
}

export type GridRow =
  | { kind: 'group'; key: string; path: string; depth: number; field: Field; count: number; collapsed: boolean; sample: Rec }
  | { kind: 'record'; rec: Rec; depth: number }

/** Flattens grouped records into header + record rows (records must be sorted by the groups). */
export function groupRows(t: TableData, records: Rec[], rules: SortRule[], collapsed: Set<string>): GridRow[] {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const fields = rules.map((r) => byId.get(r.field)).filter(Boolean) as Field[]
  if (!fields.length) return records.map((rec) => ({ kind: 'record', rec, depth: 0 }))
  const out: GridRow[] = []
  const walk = (list: Rec[], depth: number, prefix: string) => {
    if (depth >= fields.length) {
      for (const rec of list) out.push({ kind: 'record', rec, depth })
      return
    }
    const f = fields[depth]
    let i = 0
    while (i < list.length) {
      const key = groupKey(f, cellValue(list[i], f))
      let j = i + 1
      while (j < list.length && groupKey(f, cellValue(list[j], f)) === key) j++
      const path = prefix + '/' + f.id + ':' + key
      const isCollapsed = collapsed.has(path)
      out.push({ kind: 'group', key, path, depth, field: f, count: j - i, collapsed: isCollapsed, sample: list[i] })
      if (!isCollapsed) walk(list.slice(i, j), depth + 1, path)
      i = j
    }
  }
  walk(records, 0, '')
  return out
}

// ---------- summaries ----------

export function summaryKinds(type: FieldType): { kind: SummaryKind; label: string }[] {
  const base: { kind: SummaryKind; label: string }[] = [
    { kind: 'none', label: '不展示' },
    { kind: 'count', label: '记录总数' },
    { kind: 'filled', label: '已填写' },
    { kind: 'empty', label: '未填写' },
    { kind: 'unique', label: '唯一值' },
    { kind: 'percent_filled', label: '已填写占比' },
  ]
  if (type === 'number' || type === 'autonumber')
    base.push({ kind: 'sum', label: '求和' }, { kind: 'avg', label: '平均值' }, { kind: 'min', label: '最小值' }, { kind: 'max', label: '最大值' })
  if (type === 'checkbox') return [base[0], base[1], { kind: 'checked', label: '已勾选' }, { kind: 'empty', label: '未勾选' }]
  return base
}

export function summarize(f: Field, kind: SummaryKind, list: Rec[]): string {
  if (kind === 'none') return ''
  const label = summaryKinds(f.type).find((k) => k.kind === kind)?.label ?? ''
  const values = list.map((r) => cellValue(r, f))
  const filled = values.filter((v) => !isEmptyValue(v))
  let out: string
  switch (kind) {
    case 'count':
      out = String(list.length)
      break
    case 'filled':
    case 'checked':
      out = String(filled.length)
      break
    case 'empty':
      out = String(list.length - filled.length)
      break
    case 'unique':
      out = String(new Set(filled.map((v) => groupKey(f, v))).size)
      break
    case 'percent_filled':
      out = list.length ? `${Math.round((filled.length / list.length) * 1000) / 10}%` : '0%'
      break
    default: {
      const nums = filled.filter((v): v is number => typeof v === 'number')
      if (!nums.length) return label + ' -'
      const sum = nums.reduce((a, b) => a + b, 0)
      const n = kind === 'sum' ? sum : kind === 'avg' ? sum / nums.length : kind === 'min' ? Math.min(...nums) : Math.max(...nums)
      out = f.type === 'number' ? formatNumber({ ...f, options: { ...f.options, precision: kind === 'avg' ? Math.max(f.options.precision ?? 2, 2) : f.options.precision } }, n) : String(Math.round(n * 100) / 100)
    }
  }
  return `${label} ${out}`
}

// ---------- parsing text into values (paste, CSV import, type conversion) ----------

/** Resolves a choice name to an id, creating the choice when needed. */
export type ChoiceResolver = (field: Field, name: string) => string

const reDate = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:[:：分](\d{1,2})秒?)?)?/

export function parseDate(text: string, withTime: boolean): string | undefined {
  const s = text.trim()
  if (!s) return undefined
  const m = reDate.exec(s)
  let d: Date | undefined
  if (m) d = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0)
  else if (/^\d{12,13}$/.test(s)) d = new Date(+s)
  else {
    const t = Date.parse(s)
    if (!isNaN(t)) d = new Date(t)
  }
  if (!d || isNaN(d.getTime())) return undefined
  const day = fmtDateTime(d.getTime(), false)
  return withTime ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day
}

const reTrue = /^(true|1|yes|y|是|✓|✔|√|x|on|checked|已勾选|已完成)$/i

/** Converts text to a stored value for the field; undefined means "no value". */
export function parseText(f: Field, text: string, resolve: ChoiceResolver): any {
  const s = text.replace(/\r/g, '')
  switch (f.type) {
    case 'text':
      return s.replace(/\n+/g, ' ').trim() || undefined
    case 'longtext':
      return s.trim() ? s : undefined
    case 'url':
      return s.trim() || undefined
    case 'number': {
      const t = s.replace(/[,\s，¥$€£]/g, '')
      if (!t) return undefined
      const pct = t.endsWith('%')
      const n = parseFloat(pct ? t.slice(0, -1) : t)
      return isFinite(n) ? (pct ? n / 100 : n) : undefined
    }
    case 'select': {
      const name = s.trim()
      return name ? resolve(f, name) : undefined
    }
    case 'multiselect': {
      const names = s
        .split(/[,，、;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean)
      const ids = [...new Set(names.map((n) => resolve(f, n)))]
      return ids.length ? ids : undefined
    }
    case 'date':
      return parseDate(s, !!f.options.time)
    case 'checkbox':
      return reTrue.test(s.trim()) || undefined
    default:
      return undefined
  }
}

/** Converts a value when a field changes type. */
export function convertValue(from: Field, to: Field, v: any, resolve: ChoiceResolver): any {
  if (isEmptyValue(v)) return undefined
  if (from.type === to.type) return v
  if (from.type === 'select' && to.type === 'multiselect') return choiceOf(to, v) ? [v] : undefined
  if (from.type === 'multiselect' && to.type === 'select') return (v as string[]).find((id) => choiceOf(to, id))
  if (to.type === 'attachment' || isComputed(to.type)) return undefined
  if (from.type === 'checkbox' && to.type !== 'checkbox') return to.type === 'number' ? 1 : parseText(to, '✓', resolve)
  return parseText(to, displayText(from, v), resolve)
}

/** Creates choices on demand while parsing; collect `added` to persist them. */
export function choiceCollector(fields: Field[]) {
  const added = new Map<string, Choice[]>()
  const resolve: ChoiceResolver = (f, name) => {
    const existing = (f.options.choices ?? []).concat(added.get(f.id) ?? [])
    const hit = existing.find((c) => c.name === name) ?? existing.find((c) => c.name.toLowerCase() === name.toLowerCase())
    if (hit) return hit.id
    const c: Choice = { id: newId(), name, color: existing.length % 10 }
    added.set(f.id, [...(added.get(f.id) ?? []), c])
    return c.id
  }
  return { resolve, added, fields }
}

// ---------- CSV ----------

export function parseCSV(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // tab-separated if the first line has tabs and no commas outside quotes
  const firstLine = text.slice(0, text.indexOf('\n') >>> 0)
  const sep = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export function toCSV(rows: string[][]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
}
