// Computed fields: formula, link titles, lookup and rollup.
//
// The server stores raw values only. derive() returns a copy of the table whose records
// carry the computed values in `data` (so display, filtering, sorting, grouping and
// summaries treat them like stored values) and whose fields carry runtime info (`rt`):
// the linked table and record titles of link fields, the inferred value kind of formulas
// and a pseudo "base" field used to format, sort and filter the computed values.
//
// Columns are computed lazily per (table, field), so formulas may use other formulas,
// lookups may target formulas or lookups of the linked table, and cycles are detected.

import { cellValue, choiceOf, displayText, fmtDateTime } from './engine'
import { compileFormula, toCellValue } from './formula'
import type { AttachmentValue, Field, FieldRuntime, Rec, RollupAgg, TableData, ValueKind } from './types'
import { isDerived } from './types'

export const ROLLUP_AGGS: { agg: RollupAgg; label: string; kind: ValueKind }[] = [
  { agg: 'sum', label: '求和', kind: 'number' },
  { agg: 'avg', label: '平均值', kind: 'number' },
  { agg: 'max', label: '最大值', kind: 'number' },
  { agg: 'min', label: '最小值', kind: 'number' },
  { agg: 'count', label: '计数（非空值）', kind: 'number' },
  { agg: 'unique', label: '去重计数', kind: 'number' },
  { agg: 'concat', label: '文本拼接', kind: 'text' },
  { agg: 'concat_unique', label: '去重拼接', kind: 'text' },
  { agg: 'earliest', label: '最早日期', kind: 'date' },
  { agg: 'latest', label: '最晚日期', kind: 'date' },
]

const NEEDS_DERIVE = (f: Field) => isDerived(f.type) || f.type === 'link'

type Column = Map<string, any>

interface TableCtx {
  t: TableData
  fields: Field[]
  byId: Map<string, Field>
  recs: Map<string, Rec>
  titles?: Map<string, string>
}

class Evaluator {
  private tables = new Map<string, TableCtx>()
  private cols = new Map<string, Column>()
  private busy = new Map<string, Field>()

  constructor(root: TableData) {
    const all = [root, ...Object.values(root.linked ?? {}).filter((x) => x.id !== root.id)]
    for (const t of all) {
      const fields = t.fields.map((f) => (NEEDS_DERIVE(f) ? { ...f, rt: {} as FieldRuntime } : f))
      this.tables.set(t.id, { t, fields, byId: new Map(fields.map((f) => [f.id, f])), recs: new Map(t.records.map((r) => [r.id, r])) })
    }
    // link fields first: everything else reads titles through them
    for (const ctx of this.tables.values())
      for (const f of ctx.fields) {
        if (f.type !== 'link') continue
        const target = f.options.table ? this.tables.get(f.options.table) : undefined
        if (!target) {
          f.rt!.error = f.options.table ? '关联的表格不存在或已被删除' : '未选择关联的表格'
          continue
        }
        f.rt!.table = target.t
        f.rt!.titles = this.titles(target)
      }
    for (const ctx of this.tables.values())
      for (const f of ctx.fields) {
        if (f.type === 'lookup' || f.type === 'rollup') this.setupLookup(ctx, f)
      }
  }

  ctx(id: string) {
    return this.tables.get(id)
  }

  private titles(ctx: TableCtx): Map<string, string> {
    if (ctx.titles) return ctx.titles
    const primary = ctx.fields[0]
    const m = new Map<string, string>()
    for (const r of ctx.t.records) m.set(r.id, (primary && !isDerived(primary.type) && primary.type !== 'link' ? displayText(primary, cellValue(r, primary)) : '') || '未命名记录')
    return (ctx.titles = m)
  }

  private setupLookup(ctx: TableCtx, f: Field) {
    const link = f.options.link ? ctx.byId.get(f.options.link) : undefined
    if (!link || link.type !== 'link') {
      f.rt!.error = '未选择关联字段'
      return
    }
    const target = link.rt?.table ? this.tables.get(link.rt.table.id)?.byId.get(f.options.target ?? '') : undefined
    if (!target) {
      f.rt!.error = link.rt?.error ?? '未选择要引用的字段'
      return
    }
    f.rt!.target = target
  }

  /** Cell value of any field of a table for a record (computed values included). */
  value(tableId: string, f: Field, r: Rec): any {
    if (!isDerived(f.type)) return cellValue(r, f)
    return this.column(tableId, f).get(r.id)
  }

  column(tableId: string, f: Field): Column {
    const key = tableId + ':' + f.id
    let col = this.cols.get(key)
    if (col) return col
    if (this.busy.has(key)) {
      // a cycle: every field being computed right now is marked (and reads empty values)
      for (const g of this.busy.values()) g.rt!.error = '字段之间存在循环引用'
      return new Map()
    }
    this.busy.set(key, f)
    const ctx = this.tables.get(tableId)!
    try {
      col = f.type === 'formula' ? this.formula(ctx, f) : this.lookup(ctx, f)
    } finally {
      this.busy.delete(key)
    }
    this.cols.set(key, col)
    return col
  }

  private formula(ctx: TableCtx, f: Field): Column {
    const col: Column = new Map()
    const rt = f.rt!
    const src = f.options.expr?.trim() ?? ''
    if (!src) {
      rt.error = '未填写公式'
      return col
    }
    const c = compileFormula({ fields: ctx.fields }, src, (g, r) => this.value(ctx.t.id, g, r))
    if (!c.ok) {
      rt.error = c.error
      return col
    }
    const kinds = new Set<ValueKind>()
    for (const r of ctx.t.records) {
      const { value, kind } = toCellValue(c.run(r))
      if (value === undefined) continue
      col.set(r.id, value)
      if (kind) kinds.add(kind)
    }
    rt.kind = kinds.size === 0 ? 'text' : kinds.size === 1 ? [...kinds][0] : kinds.size === 2 && kinds.has('date') && kinds.has('datetime') ? 'datetime' : 'text'
    if (rt.kind === 'text' && kinds.size > 1) for (const [id, v] of col) if (typeof v !== 'string' && !Array.isArray(v)) col.set(id, plain(v))
    return col
  }

  /** Values of the target field over a record's linked records, flattened. */
  private items(ctx: TableCtx, f: Field, r: Rec): any[] {
    const link = ctx.byId.get(f.options.link!)!
    const target = f.rt!.target!
    const tctx = this.tables.get(link.rt!.table!.id)!
    const ids = r.data[link.id]
    const out: any[] = []
    if (!Array.isArray(ids)) return out
    for (const id of ids) {
      const rec = tctx.recs.get(id)
      if (!rec) continue
      pushItems(out, target, this.value(tctx.t.id, target, rec))
    }
    return out
  }

  private lookup(ctx: TableCtx, f: Field): Column {
    const col: Column = new Map()
    const rt = f.rt!
    if (!rt.target) return col
    // make sure a computed target knows its kind before its values are read
    const tctx = this.tables.get(ctx.byId.get(f.options.link!)!.rt!.table!.id)!
    if (isDerived(rt.target.type)) this.column(tctx.t.id, rt.target)
    if (f.type === 'lookup') {
      rt.kind = 'list'
      for (const r of ctx.t.records) {
        const items = this.items(ctx, f, r)
        if (items.length) col.set(r.id, items)
      }
      return col
    }
    const agg = f.options.agg ?? 'sum'
    const def = ROLLUP_AGGS.find((a) => a.agg === agg) ?? ROLLUP_AGGS[0]
    let kind: ValueKind = def.kind
    for (const r of ctx.t.records) {
      const v = rollup(agg, this.items(ctx, f, r))
      if (v === undefined) continue
      if (typeof v === 'string' && def.kind === 'date' && v.length > 10) kind = 'datetime'
      col.set(r.id, v)
    }
    rt.kind = kind
    return col
  }
}

const plain = (v: any) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))

/** Appends the lookup items of one cell value: numbers stay numbers, the rest become text. */
function pushItems(out: any[], f: Field, v: any) {
  if (v === undefined || v === null || v === '') return
  switch (f.type) {
    case 'number':
    case 'autonumber':
    case 'rating':
    case 'progress':
      if (typeof v === 'number') out.push(v)
      return
    case 'checkbox':
      out.push(!!v)
      return
    case 'select': {
      const c = choiceOf(f, v)
      if (c) out.push(c.name)
      return
    }
    case 'multiselect':
      for (const id of Array.isArray(v) ? v : []) {
        const c = choiceOf(f, id)
        if (c) out.push(c.name)
      }
      return
    case 'attachment':
      for (const a of (Array.isArray(v) ? v : []) as AttachmentValue[]) out.push(a.name)
      return
    case 'created_time':
    case 'modified_time':
      if (typeof v === 'number') out.push(fmtDateTime(v))
      return
    case 'link':
      for (const id of Array.isArray(v) ? v : []) {
        const t = f.rt?.titles?.get(id)
        if (t !== undefined) out.push(t)
      }
      return
    case 'lookup':
    case 'formula':
      if (Array.isArray(v)) for (const x of v) x !== null && x !== undefined && x !== '' && out.push(x)
      else out.push(v)
      return
    default:
      out.push(v)
  }
}

function rollup(agg: RollupAgg, items: any[]): any {
  switch (agg) {
    case 'count':
      return items.length
    case 'unique':
      return new Set(items.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : x))).size
    case 'concat':
    case 'concat_unique': {
      const list = items.map((x) => (typeof x === 'boolean' ? (x ? '✓' : '') : String(x))).filter(Boolean)
      const out = agg === 'concat' ? list : [...new Set(list)]
      return out.length ? out.join(', ') : undefined
    }
    case 'earliest':
    case 'latest': {
      const ds = items.filter((x): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)).sort()
      return ds.length ? (agg === 'earliest' ? ds[0] : ds[ds.length - 1]) : undefined
    }
  }
  const nums = items.map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? Number(x.replace(/[,\s]/g, '')) : NaN)).filter((x) => isFinite(x))
  if (!nums.length) return agg === 'sum' && items.length === 0 ? undefined : agg === 'sum' ? 0 : undefined
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const x of nums) {
    sum += x
    if (x < min) min = x
    if (x > max) max = x
  }
  return agg === 'sum' ? sum : agg === 'avg' ? sum / nums.length : agg === 'min' ? min : max
}

/** Pseudo field describing how a computed field's values are shown, sorted and filtered. */
function baseOf(f: Field): Field {
  const rt = f.rt!
  const kind = rt.kind ?? 'text'
  if (f.type === 'lookup') return f
  if (f.type === 'rollup') {
    const t = rt.target
    const agg = f.options.agg ?? 'sum'
    // averages / extremes of progress stay progress; of numbers inherit the number format
    if (t && t.type === 'progress' && (agg === 'avg' || agg === 'min' || agg === 'max'))
      return { ...f, type: 'progress', options: { precision: f.options.precision ?? t.options.precision } }
    if (kind === 'number') {
      const inherit = t && (agg === 'sum' || agg === 'min' || agg === 'max' || agg === 'avg') && t.type === 'number'
      const precision = f.options.precision ?? (inherit ? t.options.precision : undefined) ?? (agg === 'avg' ? 2 : undefined)
      return { ...f, type: 'number', options: { precision, thousands: f.options.thousands ?? (inherit ? t.options.thousands : undefined) } }
    }
  }
  switch (kind) {
    case 'number':
      return { ...f, type: 'number', options: { precision: f.options.precision, thousands: f.options.thousands } }
    case 'date':
    case 'datetime':
      return { ...f, type: 'date', options: { time: kind === 'datetime' } }
    case 'checkbox':
      return { ...f, type: 'checkbox', options: {} }
    default:
      return { ...f, type: 'text', options: {} }
  }
}

// derived records are reused while their raw record and computed values stay the same
const derivedRecs = new WeakMap<Rec, Rec>()
const derivedTables = new WeakMap<TableData, TableData>()

function sameValue(a: any, b: any) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return false
}

/** The table with computed values filled in (the same object when it has none). */
export function derive(t: TableData): TableData {
  if (!t.fields.some(NEEDS_DERIVE)) return t
  const hit = derivedTables.get(t)
  if (hit) return hit
  const ev = new Evaluator(t)
  const ctx = ev.ctx(t.id)!
  const computed = ctx.fields.filter((f) => isDerived(f.type))
  const cols = computed.map((f) => ev.column(t.id, f))
  for (const f of ctx.fields) if (f.rt && isDerived(f.type)) f.rt.base = baseOf(f)
  const records = t.records.map((r) => {
    const prev = derivedRecs.get(r)
    if (prev && computed.every((f, i) => sameValue(prev.data[f.id], cols[i].get(r.id)))) return prev
    const data = { ...r.data }
    computed.forEach((f, i) => {
      const v = cols[i].get(r.id)
      if (v === undefined) delete data[f.id]
      else data[f.id] = v
    })
    const out = { ...r, data }
    derivedRecs.set(r, out)
    return out
  })
  const out = { ...t, fields: ctx.fields, records }
  derivedTables.set(t, out)
  return out
}

