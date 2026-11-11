// Pure table logic shared by the grid, kanban, record card, embeds and share pages:
// display text, filtering, sorting, grouping, summaries, parsing pasted text and CSV.

import type { AttachmentValue, Choice, Field, FieldType, FilterCond, FilterOp, Rec, SortRule, SummaryKind, TableData, ValueKind, View } from './types'
import { baseField, isComputed, isNumeric, newId, ratingMax } from './types'
import { compileFilter, compileFormula, toCellValue, toDisplayExpr } from './formula'

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
  if (f.rt?.values) return f.rt.values.get(r.id)
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

// toLocaleString builds a new formatter on every call, which dominates search / export of
// big tables; formatters are cached per precision instead
const numberFormats = new Map<number | undefined, Intl.NumberFormat>()
function thousandsFormat(p: number | undefined) {
  let nf = numberFormats.get(p)
  if (!nf) {
    nf = new Intl.NumberFormat('en-US', p === undefined ? { maximumFractionDigits: 10 } : { minimumFractionDigits: p, maximumFractionDigits: p })
    numberFormats.set(p, nf)
  }
  return nf
}

export function formatNumber(f: Field, v: number): string {
  if (typeof v !== 'number' || !isFinite(v)) return ''
  const p = f.options.precision
  if (f.options.thousands) return thousandsFormat(p).format(v)
  return p === undefined ? String(v) : v.toFixed(p)
}

export function formatProgress(f: Field, v: number): string {
  if (typeof v !== 'number' || !isFinite(v)) return ''
  const p = f.options.precision ?? 0
  return (v * 100).toFixed(p) + '%'
}

/** Plain-text rendering of a value (used for copy, CSV, search, embeds). */
export function displayText(f: Field, v: any): string {
  if (isEmptyValue(v) && f.type !== 'autonumber') return ''
  f = baseField(f)
  switch (f.type) {
    case 'link': {
      const titles = f.rt?.titles
      return (Array.isArray(v) ? v : [])
        .map((id) => titles?.get(id))
        .filter((x) => x !== undefined)
        .join(', ')
    }
    case 'lookup': {
      const t = f.rt?.target
      const one = (x: any) =>
        typeof x === 'number' ? (t?.type === 'progress' ? formatProgress(t, x) : t?.type === 'number' ? formatNumber(t, x) : String(x)) : typeof x === 'boolean' ? (x ? '✓' : '') : String(x)
      return (Array.isArray(v) ? v : [v]).map(one).filter(Boolean).join(', ')
    }
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
    case 'rating':
      return typeof v === 'number' ? String(v) : ''
    case 'progress':
      return formatProgress(f, v)
    case 'attachment':
      return (Array.isArray(v) ? (v as AttachmentValue[]) : []).map((a) => a.name).join(', ')
    case 'created_time':
    case 'modified_time':
      return typeof v === 'number' ? fmtDateTime(v) : ''
    default:
      return typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'boolean' ? (x ? '✓' : '') : String(x))).join(', ') : String(v)
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
    case 'rating':
    case 'progress':
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
  f = baseField(f)
  const def = filterOps(f.type).find((o) => o.op === c.op)
  if (!def) return false
  if (def.unary || f.type === 'checkbox') return true
  if (Array.isArray(c.value)) return c.value.length > 0
  return c.value !== undefined && c.value !== null && String(c.value).trim() !== ''
}

function matchCond(c: FilterCond, f: Field, r: Rec): boolean {
  const v = cellValue(r, f)
  f = baseField(f)
  if (c.op === 'empty') return isEmptyValue(v)
  if (c.op === 'not_empty') return !isEmptyValue(v)
  switch (f.type) {
    case 'checkbox':
      return !!v === !!c.value
    case 'number':
    case 'autonumber':
    case 'rating':
    case 'progress': {
      // progress conditions are entered in percent
      const x = Number(c.value) / (f.type === 'progress' ? 100 : 1)
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

const isExpr = (c: FilterCond) => c.op === 'expr'

export function activeConds(t: TableData, v: View): FilterCond[] {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  return (v.config.filter?.conds ?? []).filter((c) => {
    // an expression that does not compile is ignored (the filter panel shows the error)
    if (isExpr(c)) return typeof c.value === 'string' && c.value.trim() !== '' && compileFilter(t, c.value).ok
    const f = byId.get(c.field)
    return f && condActive(c, f)
  })
}

export function makeMatcher(t: TableData, v: View): (r: Rec) => boolean {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const tests = activeConds(t, v).map((c): ((r: Rec) => boolean) => {
    if (isExpr(c)) {
      const e = compileFilter(t, c.value)
      return e.ok ? e.test : () => true
    }
    const f = byId.get(c.field)!
    return (r) => matchCond(c, f, r)
  })
  if (!tests.length) return () => true
  if (tests.length === 1) return tests[0]
  const any = v.config.filter?.conj === 'or'
  return (r) => (any ? tests.some((test) => test(r)) : tests.every((test) => test(r)))
}

// ---------- expressions as fields ----------

// pseudo fields per table object (a new derived table on every change) and expression
const exprFields = new WeakMap<TableData, Map<string, Field | null>>()

/**
 * A formula expression (stored form) as a read-only pseudo field: its values are computed
 * for every record and read through cellValue, so sorting, grouping, kanban columns and
 * titles treat it like a formula field. Undefined when the expression is empty or broken.
 */
export function exprField(t: TableData, src: string | undefined): Field | undefined {
  src = src?.trim()
  if (!src) return undefined
  let m = exprFields.get(t)
  if (!m) exprFields.set(t, (m = new Map()))
  let f = m.get(src)
  if (f === undefined) {
    f = null
    const c = compileFormula(t, src)
    if (c.ok) {
      const values = new Map<string, any>()
      const kinds = new Set<ValueKind>()
      for (const r of t.records) {
        const { value, kind } = toCellValue(c.run(r))
        if (value === undefined) continue
        values.set(r.id, value)
        if (kind) kinds.add(kind)
      }
      const kind: ValueKind = kinds.size === 1 ? [...kinds][0] : kinds.size === 2 && kinds.has('date') && kinds.has('datetime') ? 'datetime' : 'text'
      if (kind === 'text') for (const [id, v] of values) if (typeof v !== 'string') values.set(id, Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))
      const name = toDisplayExpr(t, src)
      f = { id: 'expr:' + src, name, type: 'formula', options: { expr: src }, sort: 0, rt: { values } }
      const base: Field =
        kind === 'number'
          ? { ...f, type: 'number', options: {} }
          : kind === 'date' || kind === 'datetime'
            ? { ...f, type: 'date', options: { time: kind === 'datetime' } }
            : kind === 'checkbox'
              ? { ...f, type: 'checkbox', options: {} }
              : { ...f, type: 'text', options: {} }
      f.rt!.base = base
      f.rt!.kind = kind
    }
    if (m.size > 50) m.clear()
    m.set(src, f)
  }
  return f ?? undefined
}

/** The field a sort / group rule orders by: a table field or an expression's pseudo field. */
export function ruleField(t: TableData, rule: SortRule, byId?: Map<string, Field>): Field | undefined {
  if (rule.expr !== undefined) return exprField(t, rule.expr)
  return byId ? byId.get(rule.field) : t.fields.find((f) => f.id === rule.field)
}

/** Title shown for a record in calendar / gantt views (fields joined, or an expression). */
export function titleReader(t: TableData, v: View): (r: Rec) => string {
  const cfg = v.config
  if (cfg.titleExpr !== undefined) {
    const f = exprField(t, cfg.titleExpr)
    if (f) {
      const b = baseField(f)
      return (r) => displayText(b, cellValue(r, f))
    }
  }
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  let fields = (cfg.titleFields ?? []).map((id) => byId.get(id)).filter((f): f is Field => !!f)
  if (!fields.length && t.fields[0]) fields = [t.fields[0]]
  return (r) =>
    fields
      .map((f) => displayText(f, cellValue(r, f)).replace(/\s*\n\s*/g, ' '))
      .filter(Boolean)
      .join(' · ')
}

// ---------- sorting ----------

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** Comparable key for sorting / grouping; undefined sorts last. */
function sortKey(f: Field, v: any): number | string | undefined {
  f = baseField(f)
  if (isEmptyValue(v) && f.type !== 'checkbox') return undefined
  switch (f.type) {
    case 'number':
    case 'autonumber':
    case 'rating':
    case 'progress':
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
  const rs = rules.map((r) => ({ f: ruleField(t, r, byId)!, desc: !!r.desc })).filter((r) => r.f)
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
  const rules = [...(v.type === 'grid' || v.type === 'gantt' ? (v.config.groups ?? []) : []), ...(v.config.sorts ?? [])]
  return sortRecords(t, list, rules)
}

// ---------- grouping ----------

export function groupKey(f: Field, v: any): string {
  f = baseField(f)
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
  f = baseField(f)
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
  const fields = rules.map((r) => ruleField(t, r, byId)).filter(Boolean) as Field[]
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

/** Group header paths a record sits under (to expand its collapsed groups). */
export function groupPaths(t: TableData, rec: Rec, rules: SortRule[]): string[] {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const out: string[] = []
  let prefix = ''
  for (const r of rules) {
    const f = ruleField(t, r, byId)
    if (!f) continue
    prefix += '/' + f.id + ':' + groupKey(f, cellValue(rec, f))
    out.push(prefix)
  }
  return out
}

// ---------- kanban ----------

/** Fields a kanban board can be grouped by; attachments and auto numbers make no useful columns. */
export const kanbanFieldOk = (f: Field) => f.type !== 'attachment' && f.type !== 'autonumber'

/** The field a kanban view groups by: the configured one, else the first select-like field. */
export function kanbanField(t: TableData, v: View): Field | undefined {
  if (v.config.kanbanExpr !== undefined) return exprField(t, v.config.kanbanExpr)
  const set = t.fields.find((f) => f.id === v.config.kanbanField && kanbanFieldOk(f))
  return set ?? t.fields.find((f) => f.type === 'select') ?? t.fields.find((f) => f.type === 'multiselect') ?? t.fields.find((f) => f.type === 'checkbox')
}

export const KANBAN_EMPTY = '__empty'
/** columns shown at most when grouping by free-form values (text, numbers, dates) */
export const MAX_KANBAN_COLUMNS = 200

export interface KanbanColumn {
  key: string
  label: string
  choice?: Choice
  /** value stored when a card is dropped into / created in this column (free-form fields) */
  value?: any
}

export interface KanbanLayout {
  columns: KanbanColumn[]
  byColumn: Map<string, Rec[]>
  /** records whose column is beyond MAX_KANBAN_COLUMNS */
  hiddenRecords: number
}

/**
 * Splits records into kanban columns. Select / multi-select columns are the options (a
 * multi-select record shows in each of its options), checkbox gives two columns, other
 * fields one column per distinct value in ascending order.
 */
export function kanbanLayout(f: Field, records: Rec[], hideEmpty?: boolean): KanbanLayout {
  const empty: KanbanColumn = { key: KANBAN_EMPTY, label: '未分组' }
  let columns: KanbanColumn[]
  const byColumn = new Map<string, Rec[]>()
  const push = (key: string, r: Rec) => {
    let l = byColumn.get(key)
    if (!l) byColumn.set(key, (l = []))
    l.push(r)
  }
  let hiddenRecords = 0
  if (f.type === 'select' || f.type === 'multiselect') {
    const choices = f.options.choices ?? []
    const ids = new Set(choices.map((c) => c.id))
    columns = choices.map((c) => ({ key: c.id, label: c.name, choice: c }))
    for (const r of records) {
      const v = r.data[f.id]
      const keys = (f.type === 'select' ? [v] : Array.isArray(v) ? v : []).filter((id) => ids.has(id))
      if (keys.length) for (const k of new Set(keys)) push(k, r)
      else push(KANBAN_EMPTY, r)
    }
    if (!hideEmpty) columns.push(empty)
  } else if (f.type === 'checkbox') {
    columns = [
      { key: '0', label: '未勾选' },
      { key: '1', label: '已勾选' },
    ]
    for (const r of records) push(r.data[f.id] ? '1' : '0', r)
  } else {
    const samples = new Map<string, any>()
    for (const r of records) {
      const v = cellValue(r, f)
      const key = groupKey(f, v)
      if (key === '') push(KANBAN_EMPTY, r)
      else {
        if (!samples.has(key)) samples.set(key, v)
        push(key, r)
      }
    }
    const keys = [...samples.keys()].map((key) => ({ key, k: sortKey(f, samples.get(key)) }))
    keys.sort((a, b) => compareKeys(a.k, b.k))
    columns = keys.map(({ key }) => ({ key, label: groupLabel(f, key), value: f.type === 'date' ? key : samples.get(key) }))
    if (columns.length > MAX_KANBAN_COLUMNS) {
      for (const c of columns.slice(MAX_KANBAN_COLUMNS)) hiddenRecords += byColumn.get(c.key)!.length
      columns = columns.slice(0, MAX_KANBAN_COLUMNS)
    }
    if (!hideEmpty) columns.push(empty)
  }
  for (const c of columns) if (!byColumn.has(c.key)) byColumn.set(c.key, [])
  return { columns, byColumn, hiddenRecords }
}

/**
 * Data that moves a record from one kanban column to another (undefined: no change).
 * `from` matters for multi-select, where the card swaps one option for another.
 */
export function kanbanMoveData(f: Field, rec: Rec, from: string, to: KanbanColumn): Record<string, any> | undefined {
  if (from === to.key || isComputed(f.type)) return undefined
  const cur = rec.data[f.id]
  let next: any
  if (to.key === KANBAN_EMPTY) next = null
  else
    switch (f.type) {
      case 'select':
        next = to.key
        break
      case 'multiselect': {
        const list: string[] = Array.isArray(cur) ? cur : []
        if (list.includes(to.key)) next = list.filter((id) => id !== from)
        else if (list.includes(from)) next = list.map((id) => (id === from ? to.key : id))
        else next = [...list, to.key]
        if (!next.length) next = null
        break
      }
      case 'checkbox':
        next = to.key === '1' ? true : null
        break
      case 'date':
        // keep the time of day when the field has one
        next = to.key + (f.options.time && typeof cur === 'string' ? cur.slice(10) : '')
        break
      default:
        next = to.value
    }
  return { [f.id]: next }
}

/** Initial data of a record created in a kanban column. */
export function kanbanNewData(f: Field, col: KanbanColumn): Record<string, any> {
  if (col.key === KANBAN_EMPTY || isComputed(f.type)) return {}
  switch (f.type) {
    case 'select':
      return { [f.id]: col.key }
    case 'multiselect':
      return { [f.id]: [col.key] }
    case 'checkbox':
      return col.key === '1' ? { [f.id]: true } : {}
    case 'date':
      return { [f.id]: col.key }
    default:
      return { [f.id]: col.value }
  }
}

// ---------- search ----------

/** Normalised search text; empty means no search. */
export const searchNeedle = (q: string) => q.trim().toLowerCase()

// Lower-cased display text per (field, record). Both objects are replaced whenever they
// change (the model never mutates them), so identity is a safe cache key.
const searchTexts = new WeakMap<Field, WeakMap<Rec, string>>()

/** Lower-cased display text of a cell, cached for repeated searches. */
export function searchText(f: Field, r: Rec): string {
  let m = searchTexts.get(f)
  if (!m) searchTexts.set(f, (m = new WeakMap()))
  let t = m.get(r)
  if (t === undefined) {
    t = displayText(f, cellValue(r, f)).toLowerCase()
    m.set(r, t)
  }
  return t
}

/** Whether a cell's displayed text contains the (normalised) needle. */
export function cellMatches(f: Field, r: Rec, needle: string): boolean {
  if (!needle) return false
  if (f.type === 'checkbox') return false
  return searchText(f, r).includes(needle)
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
  if (isNumeric(type))
    base.push({ kind: 'sum', label: '求和' }, { kind: 'avg', label: '平均值' }, { kind: 'min', label: '最小值' }, { kind: 'max', label: '最大值' })
  if (type === 'checkbox') return [base[0], base[1], { kind: 'checked', label: '已勾选' }, { kind: 'empty', label: '未勾选' }]
  return base
}

export function summarize(f: Field, kind: SummaryKind, list: Rec[]): string {
  if (kind === 'none') return ''
  f = baseField(f)
  const label = summaryKinds(f.type).find((k) => k.kind === kind)?.label ?? ''
  if (kind === 'count') return `${label} ${list.length}`
  const filled: any[] = []
  for (const r of list) {
    const v = cellValue(r, f)
    if (!isEmptyValue(v)) filled.push(v)
  }
  let out: string
  switch (kind) {
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
      let sum = 0
      let min = Infinity
      let max = -Infinity
      // no Math.min(...nums): spreading 100k+ values overflows the call stack
      for (const x of nums) {
        sum += x
        if (x < min) min = x
        if (x > max) max = x
      }
      const n = kind === 'sum' ? sum : kind === 'avg' ? sum / nums.length : kind === 'min' ? min : max
      out =
        f.type === 'progress'
          ? formatProgress({ ...f, options: { ...f.options, precision: kind === 'avg' ? Math.max(f.options.precision ?? 1, 1) : f.options.precision } }, n)
          : f.type === 'number' ? formatNumber({ ...f, options: { ...f.options, precision: kind === 'avg' ? Math.max(f.options.precision ?? 2, 2) : f.options.precision } }, n) : String(Math.round(n * 100) / 100)
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
    case 'phone':
    case 'email':
      return s.replace(/\n+/g, ' ').trim() || undefined
    case 'rating': {
      const t = s.trim()
      // "★★★" counts stars
      const n = /^[★⭐☆]+$/.test(t) ? [...t].filter((c) => c !== '☆').length : parseFloat(t)
      if (!isFinite(n)) return undefined
      const r = Math.max(0, Math.min(ratingMax(f), Math.round(n)))
      return r || undefined
    }
    case 'progress': {
      // typed as a percentage: "50" and "50%" both mean half done
      const t = s.replace(/[,\s，%]/g, '')
      if (!t) return undefined
      const n = parseFloat(t)
      return isFinite(n) ? n / 100 : undefined
    }
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
    case 'link': {
      // record titles, matched against the linked table
      const titles = f.rt?.titles
      if (!titles) return undefined
      const byTitle = new Map<string, string>()
      for (const [id, t] of titles) {
        const k = t.trim().toLowerCase()
        if (!byTitle.has(k)) byTitle.set(k, id)
      }
      const names = s.split(/[,，、;；\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean)
      const ids = [...new Set(names.map((n) => byTitle.get(n)).filter((x): x is string => !!x))]
      if (f.options.multiple === false) ids.splice(1)
      return ids.length ? ids : undefined
    }
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
  // links can only keep pointing at records of the same table
  if (to.type === 'link') return from.type === 'link' && from.options.table === to.options.table ? v : undefined
  if (isNumeric(baseField(from).type) && isNumeric(to.type) && typeof v === 'number') {
    if (to.type === 'rating') return Math.max(0, Math.min(ratingMax(to), Math.round(v))) || undefined
    return v
  }
  if (baseField(from).type === 'checkbox' && to.type !== 'checkbox') return to.type === 'number' ? 1 : parseText(to, '✓', resolve)
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
