// A small formula language evaluated per record: formula fields and filter expressions.
//
//   {价格} > 100 AND CONTAINS({标题}, "bug")
//   {截止日期} < TODAY() + 7 && {状态} != "已完成"
//   HAS({标签}, "前端", "后端") OR ISEMPTY({负责人})
//
// Fields are referenced as {字段名} (or by a bare name without spaces). Stored
// expressions reference fields by id ({#id}) so renaming a field keeps them working;
// toStoredExpr / toDisplayExpr convert between the two forms.

import { cellValue, choiceOf, fmtDateTime, parseDate } from './engine'
import type { AttachmentValue, Field, Rec, TableData, ValueKind } from './types'

// ---------- values ----------

/** A point in time; `day` marks a date without a time, compared at day granularity. */
export class DateV {
  constructor(
    readonly t: number,
    readonly day: boolean,
  ) {}
  toString() {
    return fmtDateTime(this.t, !this.day)
  }
}

export type Value = number | string | boolean | null | DateV | Value[]

const DAY = 86_400_000

const dayStart = (t: number) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dateFromString(s: string): DateV | null {
  const p = parseDate(s, true)
  if (!p) return null
  const [d, tm] = p.split(' ')
  const [y, m, dd] = d.split('-').map(Number)
  const [hh, mm] = (tm ?? '00:00').split(':').map(Number)
  // a time of 00:00 parsed from a string without one is a plain date
  const hasTime = /\d[ T]+\d{1,2}[:：时]/.test(s)
  return new DateV(new Date(y, m - 1, dd, hh, mm).getTime(), !hasTime)
}

/** Reads the cell value of a field (computed fields included) for a record. */
export type CellReader = (f: Field, r: Rec) => any

/** A cell value in formula terms. */
export function toFormulaValue(f: Field, v: any): Value {
  switch (f.type) {
    case 'number':
    case 'autonumber':
    case 'rating':
    case 'progress':
      return typeof v === 'number' && isFinite(v) ? v : null
    case 'checkbox':
      return !!v
    case 'select':
      return choiceOf(f, v)?.name ?? null
    case 'multiselect':
      return (Array.isArray(v) ? v : []).map((id) => choiceOf(f, id)?.name).filter((x): x is string => !!x)
    case 'attachment':
      return (Array.isArray(v) ? (v as AttachmentValue[]) : []).map((a) => a.name)
    case 'date':
      return typeof v === 'string' && v ? dateFromString(v) : null
    case 'created_time':
    case 'modified_time':
      return typeof v === 'number' ? new DateV(v, false) : null
    case 'link': {
      const titles = f.rt?.titles
      return (Array.isArray(v) ? v : []).map((id) => titles?.get(id)).filter((x): x is string => x !== undefined)
    }
    case 'lookup':
      return Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : []
    case 'formula':
    case 'rollup': {
      const kind = f.rt?.kind
      const one = (x: any): Value => {
        if (x === undefined || x === null || x === '') return null
        if ((kind === 'date' || kind === 'datetime') && typeof x === 'string') return dateFromString(x) ?? x
        return x
      }
      return Array.isArray(v) ? v.map(one) : one(v)
    }
    default:
      return typeof v === 'string' && v !== '' ? v : null
  }
}

const defaultReader: CellReader = (f, r) => cellValue(r, f)

/** A formula result as a cell value, plus what kind of value it is. */
export function toCellValue(v: Value): { value: any; kind?: ValueKind } {
  if (v === null || v === '') return { value: undefined }
  if (v instanceof DateV) return { value: v.toString(), kind: v.day ? 'date' : 'datetime' }
  if (typeof v === 'number') return isFinite(v) ? { value: v, kind: 'number' } : { value: undefined }
  if (typeof v === 'boolean') return { value: v, kind: 'checkbox' }
  if (Array.isArray(v)) {
    const flat = v.flat(Infinity as 1) as Value[]
    const items = flat.map((x) => toCellValue(x).value).filter((x) => x !== undefined)
    return items.length ? { value: items, kind: 'list' } : { value: undefined }
  }
  return { value: v, kind: 'text' }
}

const isEmpty = (v: Value) => v === null || v === '' || (Array.isArray(v) && v.length === 0)

function truthy(v: Value): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (v instanceof DateV) return true
  if (typeof v === 'number') return v !== 0 && !isNaN(v)
  return !!v
}

function toNum(v: Value): number {
  if (v === null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof DateV) return v.t
  if (Array.isArray(v)) return v.length === 1 ? toNum(v[0]) : NaN
  const n = Number(v.replace(/[,，\s]/g, ''))
  return v.trim() === '' ? 0 : n
}

function toStr(v: Value): string {
  if (v === null) return ''
  if (Array.isArray(v)) return v.map(toStr).join(', ')
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function toDate(v: Value): DateV | null {
  if (v instanceof DateV) return v
  if (typeof v === 'number' && isFinite(v)) return new DateV(v, false)
  if (typeof v === 'string') return dateFromString(v)
  if (Array.isArray(v) && v.length === 1) return toDate(v[0])
  return null
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const norm = (s: string) => s.trim().toLowerCase()

/** -1 / 0 / 1, or undefined when the two values cannot be ordered. */
function compare(a: Value, b: Value): number | undefined {
  if (a instanceof DateV || b instanceof DateV) {
    const x = toDate(a)
    const y = toDate(b)
    if (!x || !y) return undefined
    const day = x.day || y.day
    const d = day ? dayStart(x.t) - dayStart(y.t) : x.t - y.t
    return Math.sign(d)
  }
  if (typeof a === 'number' || typeof b === 'number' || typeof a === 'boolean' || typeof b === 'boolean') {
    const x = toNum(a)
    const y = toNum(b)
    if (isNaN(x) || isNaN(y)) return undefined
    return Math.sign(x - y)
  }
  return Math.sign(collator.compare(toStr(a), toStr(b)))
}

function equals(a: Value, b: Value): boolean {
  if (isEmpty(a) || isEmpty(b)) {
    // FALSE also counts as empty so {复选框} = FALSE matches unchecked records
    return (isEmpty(a) || a === false) && (isEmpty(b) || b === false)
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = new Set(a.map((v) => norm(toStr(v))))
    const y = new Set(b.map((v) => norm(toStr(v))))
    return x.size === y.size && [...x].every((v) => y.has(v))
  }
  // a multi-value field equals a single value when it contains it
  if (Array.isArray(a)) return a.some((v) => equals(v, b))
  if (Array.isArray(b)) return b.some((v) => equals(a, v))
  if (typeof a === 'string' && typeof b === 'string') return norm(a) === norm(b)
  return compare(a, b) === 0
}

function add(a: Value, b: Value, sign: 1 | -1): Value {
  if (a instanceof DateV && b instanceof DateV) {
    if (sign === 1) return null
    const day = a.day && b.day
    return day ? Math.round((dayStart(a.t) - dayStart(b.t)) / DAY) : (a.t - b.t) / DAY
  }
  if (a instanceof DateV) return shiftDays(a, sign * toNum(b))
  if (b instanceof DateV) return sign === 1 ? shiftDays(b, toNum(a)) : null
  const x = toNum(a)
  const y = toNum(b)
  if (sign === 1 && (isNaN(x) || isNaN(y))) return toStr(a) + toStr(b)
  return num(x + sign * y)
}

function shiftDays(d: DateV, n: number): DateV | null {
  if (!isFinite(n)) return null
  const x = new Date(d.t)
  const whole = Math.trunc(n)
  x.setDate(x.getDate() + whole)
  return new DateV(x.getTime() + (n - whole) * DAY, d.day && n === whole)
}

const num = (n: number): number | null => (isFinite(n) ? n : null)

// ---------- tokens ----------

type Tok =
  | { k: 'num'; v: number; pos: number; end: number }
  | { k: 'str'; v: string; pos: number; end: number }
  | { k: 'field'; v: string; pos: number; end: number }
  | { k: 'ident'; v: string; pos: number; end: number }
  | { k: 'op'; v: string; pos: number; end: number }
  | { k: 'eof'; pos: number; end: number }

export class FormulaError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message)
  }
}

const reIdentStart = /[\p{L}_]/u
const reIdent = /[\p{L}\p{N}_]/u
const OPS = ['&&', '||', '==', '!=', '<>', '<=', '>=', '=', '<', '>', '+', '-', '*', '/', '%', '&', '!', '(', ')', ',']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const pos = i
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!
      i += m[0].length
      out.push({ k: 'num', v: Number(m[0]), pos, end: i })
      continue
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const close = ch === '“' ? '”' : ch === '‘' ? '’' : ch
      let s = ''
      i++
      while (i < src.length && src[i] !== close) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const n = src[++i]
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n
        } else s += src[i]
        i++
      }
      if (i >= src.length) throw new FormulaError('字符串缺少结束引号', pos)
      i++
      out.push({ k: 'str', v: s, pos, end: i })
      continue
    }
    if (ch === '{') {
      const j = src.indexOf('}', i + 1)
      if (j < 0) throw new FormulaError('字段引用缺少 }', pos)
      out.push({ k: 'field', v: src.slice(i + 1, j).trim(), pos, end: j + 1 })
      i = j + 1
      continue
    }
    if (reIdentStart.test(ch)) {
      let j = i + 1
      while (j < src.length && reIdent.test(src[j])) j++
      out.push({ k: 'ident', v: src.slice(i, j), pos, end: j })
      i = j
      continue
    }
    // full-width punctuation typed with a Chinese IME
    const c = ch === '（' ? '(' : ch === '）' ? ')' : ch === '，' ? ',' : null
    if (c) {
      out.push({ k: 'op', v: c, pos, end: i + 1 })
      i++
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new FormulaError(`无法识别的字符「${ch}」`, pos)
    i += op.length
    out.push({ k: 'op', v: op, pos, end: i })
  }
  out.push({ k: 'eof', pos: src.length, end: src.length })
  return out
}

// ---------- functions ----------

type Fn = (args: Value[]) => Value

interface FnDef {
  name: string
  min: number
  max: number
  group: string
  sig: string
  desc: string
  fn: Fn
}

const str = (v: Value) => toStr(v)
const list = (v: Value): Value[] => (Array.isArray(v) ? v : isEmpty(v) ? [] : [v])

let regexCache = new Map<string, RegExp | null>()
function regex(p: string, flags: string): RegExp | null {
  const key = flags + '/' + p
  let re = regexCache.get(key)
  if (re === undefined) {
    try {
      re = new RegExp(p, flags)
    } catch {
      re = null
    }
    if (regexCache.size > 200) regexCache = new Map()
    regexCache.set(key, re)
  }
  return re
}

function dateParts(v: Value): Date | null {
  const d = toDate(v)
  return d ? new Date(d.t) : null
}

const nums = (args: Value[]) => args.flatMap(list).map(toNum).filter((n) => !isNaN(n))

const FNS: FnDef[] = [
  // logic
  { name: 'IF', min: 2, max: 3, group: '逻辑', sig: 'IF(条件, 真值, 假值)', desc: '条件成立时取真值，否则取假值', fn: ([c, a, b]) => (truthy(c) ? a : (b ?? null)) },
  {
    name: 'SWITCH',
    min: 3,
    max: 99,
    group: '逻辑',
    sig: 'SWITCH(值, 匹配1, 结果1, …, 默认值)',
    desc: '值等于某个匹配项时取对应结果，都不匹配时取默认值',
    fn: ([v, ...rest]) => {
      for (let i = 0; i + 1 < rest.length; i += 2) if (equals(v, rest[i])) return rest[i + 1]
      return rest.length % 2 ? rest[rest.length - 1] : null
    },
  },
  { name: 'AND', min: 1, max: 99, group: '逻辑', sig: 'AND(条件1, 条件2, …)', desc: '全部成立', fn: (a) => a.every(truthy) },
  { name: 'OR', min: 1, max: 99, group: '逻辑', sig: 'OR(条件1, 条件2, …)', desc: '任一成立', fn: (a) => a.some(truthy) },
  { name: 'NOT', min: 1, max: 1, group: '逻辑', sig: 'NOT(条件)', desc: '取反', fn: ([a]) => !truthy(a) },
  { name: 'ISEMPTY', min: 1, max: 1, group: '逻辑', sig: 'ISEMPTY(值)', desc: '值为空（复选框未勾选也算空）', fn: ([a]) => isEmpty(a) || a === false },
  { name: 'ISNOTEMPTY', min: 1, max: 1, group: '逻辑', sig: 'ISNOTEMPTY(值)', desc: '值不为空', fn: ([a]) => !(isEmpty(a) || a === false) },
  // text
  {
    name: 'CONTAINS',
    min: 2,
    max: 99,
    group: '文本',
    sig: 'CONTAINS(文本, 关键词1, …)',
    desc: '文本包含任一关键词（不区分大小写）',
    fn: ([t, ...ks]) => {
      const s = norm(str(t))
      return ks.some((k) => s.includes(norm(str(k))))
    },
  },
  { name: 'STARTSWITH', min: 2, max: 2, group: '文本', sig: 'STARTSWITH(文本, 前缀)', desc: '以前缀开头', fn: ([t, k]) => norm(str(t)).startsWith(norm(str(k))) },
  { name: 'ENDSWITH', min: 2, max: 2, group: '文本', sig: 'ENDSWITH(文本, 后缀)', desc: '以后缀结尾', fn: ([t, k]) => norm(str(t)).endsWith(norm(str(k))) },
  {
    name: 'REGEX',
    min: 2,
    max: 3,
    group: '文本',
    sig: 'REGEX(文本, "正则", "i")',
    desc: '文本匹配正则表达式，第三个参数为标志',
    fn: ([t, p, f]) => regex(str(p), f === undefined ? '' : str(f).replace(/[^gimsuy]/g, ''))?.test(str(t)) ?? false,
  },
  { name: 'LEN', min: 1, max: 1, group: '文本', sig: 'LEN(值)', desc: '文本长度；多选 / 附件为个数', fn: ([a]) => (Array.isArray(a) ? a.length : [...str(a)].length) },
  { name: 'LOWER', min: 1, max: 1, group: '文本', sig: 'LOWER(文本)', desc: '转小写', fn: ([a]) => str(a).toLowerCase() },
  { name: 'UPPER', min: 1, max: 1, group: '文本', sig: 'UPPER(文本)', desc: '转大写', fn: ([a]) => str(a).toUpperCase() },
  { name: 'TRIM', min: 1, max: 1, group: '文本', sig: 'TRIM(文本)', desc: '去掉首尾空白', fn: ([a]) => str(a).trim() },
  { name: 'LEFT', min: 2, max: 2, group: '文本', sig: 'LEFT(文本, n)', desc: '取前 n 个字符', fn: ([a, n]) => [...str(a)].slice(0, Math.max(0, toNum(n))).join('') },
  { name: 'RIGHT', min: 2, max: 2, group: '文本', sig: 'RIGHT(文本, n)', desc: '取后 n 个字符', fn: ([a, n]) => (toNum(n) > 0 ? [...str(a)].slice(-toNum(n)).join('') : '') },
  { name: 'CONCAT', min: 1, max: 99, group: '文本', sig: 'CONCAT(值1, 值2, …)', desc: '拼接为文本，也可用 & 运算符', fn: (a) => a.map(str).join('') },
  { name: 'TEXT', min: 1, max: 1, group: '文本', sig: 'TEXT(值)', desc: '转为文本', fn: ([a]) => str(a) },
  { name: 'MID', min: 3, max: 3, group: '文本', sig: 'MID(文本, 起始, 长度)', desc: '从第几个字符（从 1 开始）起取若干字符', fn: ([a, i, n]) => [...str(a)].slice(Math.max(0, toNum(i) - 1), Math.max(0, toNum(i) - 1) + Math.max(0, toNum(n))).join('') },
  { name: 'FIND', min: 2, max: 2, group: '文本', sig: 'FIND(关键词, 文本)', desc: '关键词在文本中的位置（从 1 开始），找不到为 0', fn: ([k, t]) => [...str(t)].join('').indexOf(str(k)) + 1 },
  {
    name: 'SUBSTITUTE',
    min: 3,
    max: 3,
    group: '文本',
    sig: 'SUBSTITUTE(文本, 旧文本, 新文本)',
    desc: '把文本中的旧文本全部替换为新文本',
    fn: ([t, a, b]) => (str(a) ? str(t).split(str(a)).join(str(b)) : str(t)),
  },
  { name: 'REPT', min: 2, max: 2, group: '文本', sig: 'REPT(文本, 次数)', desc: '重复文本，例如 REPT("★", {评分})', fn: ([t, n]) => str(t).repeat(Math.max(0, Math.min(1000, Math.floor(toNum(n) || 0)))) },
  // number
  { name: 'VALUE', min: 1, max: 1, group: '数字', sig: 'VALUE(文本)', desc: '文本转数字', fn: ([a]) => num(toNum(a)) },
  { name: 'ABS', min: 1, max: 1, group: '数字', sig: 'ABS(数字)', desc: '绝对值', fn: ([a]) => num(Math.abs(toNum(a))) },
  {
    name: 'ROUND',
    min: 1,
    max: 2,
    group: '数字',
    sig: 'ROUND(数字, 位数)',
    desc: '四舍五入',
    fn: ([a, d]) => {
      const p = 10 ** (d === undefined ? 0 : toNum(d))
      return num(Math.round(toNum(a) * p) / p)
    },
  },
  { name: 'FLOOR', min: 1, max: 1, group: '数字', sig: 'FLOOR(数字)', desc: '向下取整', fn: ([a]) => num(Math.floor(toNum(a))) },
  { name: 'CEIL', min: 1, max: 1, group: '数字', sig: 'CEIL(数字)', desc: '向上取整', fn: ([a]) => num(Math.ceil(toNum(a))) },
  { name: 'POWER', min: 2, max: 2, group: '数字', sig: 'POWER(底数, 指数)', desc: '乘方', fn: ([a, b]) => num(toNum(a) ** toNum(b)) },
  { name: 'SQRT', min: 1, max: 1, group: '数字', sig: 'SQRT(数字)', desc: '平方根', fn: ([a]) => num(Math.sqrt(toNum(a))) },
  { name: 'MOD', min: 2, max: 2, group: '数字', sig: 'MOD(a, b)', desc: 'a 除以 b 的余数', fn: ([a, b]) => num(toNum(a) % toNum(b)) },
  { name: 'MIN', min: 1, max: 99, group: '数字', sig: 'MIN(数字1, …)', desc: '最小值', fn: (a) => (nums(a).length ? Math.min(...nums(a)) : null) },
  { name: 'MAX', min: 1, max: 99, group: '数字', sig: 'MAX(数字1, …)', desc: '最大值', fn: (a) => (nums(a).length ? Math.max(...nums(a)) : null) },
  { name: 'SUM', min: 1, max: 99, group: '数字', sig: 'SUM(数字1, …)', desc: '求和', fn: (a) => nums(a).reduce((s, x) => s + x, 0) },
  {
    name: 'AVERAGE',
    min: 1,
    max: 99,
    group: '数字',
    sig: 'AVERAGE(数字1, …)',
    desc: '平均值',
    fn: (a) => {
      const n = nums(a)
      return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null
    },
  },
  // date
  { name: 'TODAY', min: 0, max: 0, group: '日期', sig: 'TODAY()', desc: '今天（按天比较）', fn: () => new DateV(dayStart(Date.now()), true) },
  { name: 'NOW', min: 0, max: 0, group: '日期', sig: 'NOW()', desc: '当前时间', fn: () => new DateV(Date.now(), false) },
  {
    name: 'DATE',
    min: 1,
    max: 3,
    group: '日期',
    sig: 'DATE(年, 月, 日) 或 DATE("2026-01-31")',
    desc: '构造日期',
    fn: (a) => (a.length === 1 ? toDate(a[0]) : new DateV(new Date(toNum(a[0]), toNum(a[1]) - 1, toNum(a[2] ?? 1)).getTime(), true)),
  },
  { name: 'YEAR', min: 1, max: 1, group: '日期', sig: 'YEAR(日期)', desc: '年份', fn: ([a]) => dateParts(a)?.getFullYear() ?? null },
  { name: 'MONTH', min: 1, max: 1, group: '日期', sig: 'MONTH(日期)', desc: '月份 1–12', fn: ([a]) => (dateParts(a) ? dateParts(a)!.getMonth() + 1 : null) },
  { name: 'DAY', min: 1, max: 1, group: '日期', sig: 'DAY(日期)', desc: '日 1–31', fn: ([a]) => dateParts(a)?.getDate() ?? null },
  { name: 'HOUR', min: 1, max: 1, group: '日期', sig: 'HOUR(日期)', desc: '小时 0–23', fn: ([a]) => dateParts(a)?.getHours() ?? null },
  { name: 'WEEKDAY', min: 1, max: 1, group: '日期', sig: 'WEEKDAY(日期)', desc: '星期几，周一为 1，周日为 7', fn: ([a]) => (dateParts(a) ? dateParts(a)!.getDay() || 7 : null) },
  {
    name: 'DAYS',
    min: 2,
    max: 2,
    group: '日期',
    sig: 'DAYS(结束, 开始)',
    desc: '相差的天数，也可直接写 日期 - 日期',
    fn: ([a, b]) => {
      const x = toDate(a)
      const y = toDate(b)
      return x && y ? Math.round((dayStart(x.t) - dayStart(y.t)) / DAY) : null
    },
  },
  {
    name: 'DATEADD',
    min: 2,
    max: 3,
    group: '日期',
    sig: 'DATEADD(日期, 数量, "day")',
    desc: '加减时间，单位 day / week / month / year / hour；日期 ± 数字 按天计算',
    fn: ([a, n, u]) => {
      const d = toDate(a)
      const k = toNum(n)
      if (!d || !isFinite(k)) return null
      const unit = u === undefined ? 'day' : norm(str(u)).replace(/s$/, '')
      const x = new Date(d.t)
      if (unit === 'year') x.setFullYear(x.getFullYear() + k)
      else if (unit === 'month') x.setMonth(x.getMonth() + k)
      else if (unit === 'week') x.setDate(x.getDate() + 7 * k)
      else if (unit === 'hour') return new DateV(d.t + k * 3_600_000, false)
      else if (unit === 'day') x.setDate(x.getDate() + k)
      else return null
      return new DateV(x.getTime(), d.day)
    },
  },
  // multi-value
  {
    name: 'HAS',
    min: 2,
    max: 99,
    group: '多选',
    sig: 'HAS({多选}, 选项1, …)',
    desc: '包含任一选项',
    fn: ([a, ...vs]) => vs.some((v) => list(a).some((x) => equals(x, v))),
  },
  {
    name: 'HASALL',
    min: 2,
    max: 99,
    group: '多选',
    sig: 'HASALL({多选}, 选项1, …)',
    desc: '包含全部选项',
    fn: ([a, ...vs]) => vs.every((v) => list(a).some((x) => equals(x, v))),
  },
  { name: 'COUNT', min: 1, max: 1, group: '多选', sig: 'COUNT(值)', desc: '多选 / 附件的个数，空为 0', fn: ([a]) => list(a).length },
]

const FN_MAP = new Map(FNS.map((f) => [f.name, f]))

/** Function reference for the help popover. */
export const FORMULA_FUNCTIONS: readonly Pick<FnDef, 'name' | 'group' | 'sig' | 'desc'>[] = FNS

const KEYWORDS: Record<string, Value> = { TRUE: true, FALSE: false, NULL: null }

// ---------- parser / compiler ----------

type Eval = (r: Rec) => Value

type FieldSource = Pick<TableData, 'fields'>

function fieldResolver(t: FieldSource) {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  const byName = new Map<string, Field>()
  for (const f of t.fields) if (!byName.has(f.name.trim())) byName.set(f.name.trim(), f)
  return (ref: string): Field | undefined => (ref.startsWith('#') && byId.get(ref.slice(1))) || byName.get(ref)
}

function compileExpr(t: FieldSource, src: string, read: CellReader = defaultReader): Eval {
  const toks = tokenize(src)
  const field = fieldResolver(t)
  const valueOf = (f: Field): Eval => (r) => toFormulaValue(f, read(f, r))
  let i = 0
  const peek = () => toks[i]
  const isOp = (...v: string[]) => {
    const k = toks[i]
    return k.k === 'op' && v.includes(k.v)
  }
  const isWord = (w: string) => {
    const k = toks[i]
    return k.k === 'ident' && k.v.toUpperCase() === w
  }
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`缺少「${v}」`, peek().pos)
    i++
  }

  const or = (): Eval => {
    let l = and()
    while (isOp('||') || isWord('OR')) {
      i++
      const a = l
      const b = and()
      l = (r) => truthy(a(r)) || truthy(b(r))
    }
    return l
  }
  const and = (): Eval => {
    let l = not()
    while (isOp('&&') || isWord('AND')) {
      i++
      const a = l
      const b = not()
      l = (r) => truthy(a(r)) && truthy(b(r))
    }
    return l
  }
  const not = (): Eval => {
    // NOT( … ) is the function; a bare NOT is the operator
    if (isOp('!') || (isWord('NOT') && !(toks[i + 1]?.k === 'op' && (toks[i + 1] as { v: string }).v === '('))) {
      i++
      const a = not()
      return (r) => !truthy(a(r))
    }
    return cmp()
  }
  const cmp = (): Eval => {
    let l = concat()
    while (isOp('=', '==', '!=', '<>', '<', '<=', '>', '>=')) {
      const op = (toks[i++] as { v: string }).v
      const a = l
      const b = concat()
      if (op === '=' || op === '==') l = (r) => equals(a(r), b(r))
      else if (op === '!=' || op === '<>') l = (r) => !equals(a(r), b(r))
      else {
        const test = op === '<' ? (c: number) => c < 0 : op === '<=' ? (c: number) => c <= 0 : op === '>' ? (c: number) => c > 0 : (c: number) => c >= 0
        l = (r) => {
          const x = a(r)
          const y = b(r)
          if (isEmpty(x) || isEmpty(y)) return false
          const c = compare(x, y)
          return c !== undefined && test(c)
        }
      }
    }
    return l
  }
  const concat = (): Eval => {
    let l = additive()
    while (isOp('&')) {
      i++
      const a = l
      const b = additive()
      l = (r) => toStr(a(r)) + toStr(b(r))
    }
    return l
  }
  const additive = (): Eval => {
    let l = mul()
    while (isOp('+', '-')) {
      const sign = (toks[i++] as { v: string }).v === '+' ? 1 : -1
      const a = l
      const b = mul()
      l = (r) => add(a(r), b(r), sign)
    }
    return l
  }
  const mul = (): Eval => {
    let l = unary()
    while (isOp('*', '/', '%')) {
      const op = (toks[i++] as { v: string }).v
      const a = l
      const b = unary()
      l = op === '*' ? (r) => num(toNum(a(r)) * toNum(b(r))) : op === '/' ? (r) => num(toNum(a(r)) / toNum(b(r))) : (r) => num(toNum(a(r)) % toNum(b(r)))
    }
    return l
  }
  const unary = (): Eval => {
    if (isOp('-')) {
      i++
      const a = unary()
      return (r) => num(-toNum(a(r)))
    }
    if (isOp('+')) {
      i++
      return unary()
    }
    return primary()
  }
  const primary = (): Eval => {
    const tk = peek()
    switch (tk.k) {
      case 'num': {
        i++
        const v = tk.v
        return () => v
      }
      case 'str': {
        i++
        const v = tk.v
        return () => v
      }
      case 'field': {
        i++
        const f = field(tk.v)
        if (!f) throw new FormulaError(`找不到字段「${tk.v.startsWith('#') ? '已删除的字段' : tk.v}」`, tk.pos)
        return valueOf(f)
      }
      case 'ident': {
        i++
        const next = peek()
        if (next.k === 'op' && next.v === '(') {
          const def = FN_MAP.get(tk.v.toUpperCase())
          if (!def) throw new FormulaError(`未知函数 ${tk.v}`, tk.pos)
          i++
          const args: Eval[] = []
          if (!isOp(')')) {
            args.push(or())
            while (isOp(',')) {
              i++
              args.push(or())
            }
          }
          expect(')')
          if (args.length < def.min || args.length > def.max) {
            const n = def.min === def.max ? `${def.min} 个` : def.max >= 99 ? `至少 ${def.min} 个` : `${def.min}–${def.max} 个`
            throw new FormulaError(`${def.name} 需要 ${n}参数`, tk.pos)
          }
          const fn = def.fn
          if (def.name === 'IF') {
            // only evaluate the branch taken
            const [c, a, b] = args
            return (r) => (truthy(c(r)) ? a(r) : b ? b(r) : null)
          }
          return (r) => fn(args.map((a) => a(r)))
        }
        const kw = tk.v.toUpperCase()
        if (kw in KEYWORDS) {
          const v = KEYWORDS[kw]
          return () => v
        }
        const f = field(tk.v)
        if (!f) throw new FormulaError(`找不到字段「${tk.v}」，字段名请用 {} 括起来`, tk.pos)
        return valueOf(f)
      }
      case 'op':
        if (tk.v === '(') {
          i++
          const e = or()
          expect(')')
          return e
        }
        throw new FormulaError(`这里不应出现「${tk.v}」`, tk.pos)
      case 'eof':
        throw new FormulaError(i === 0 ? '表达式为空' : '表达式不完整', tk.pos)
    }
  }

  const e = or()
  const rest = peek()
  if (rest.k !== 'eof') throw new FormulaError('表达式在这里多出了内容，是否缺少 AND / OR？', rest.pos)
  return e
}

export type CompiledFormula = { ok: true; run: (r: Rec) => Value } | { ok: false; error: string; pos: number }

/** Compiles a formula field's expression; `read` supplies the values of computed fields. */
export function compileFormula(t: FieldSource, src: string, read?: CellReader): CompiledFormula {
  try {
    const e = compileExpr(t, src, read)
    return {
      ok: true,
      run: (r) => {
        try {
          return e(r)
        } catch {
          return null
        }
      },
    }
  } catch (err) {
    return err instanceof FormulaError ? { ok: false, error: err.message, pos: err.pos } : { ok: false, error: String(err), pos: 0 }
  }
}

/** Field ids a stored expression references. */
export function formulaRefs(src: string): string[] {
  return [...src.matchAll(/\{#([0-9a-z]+)\}/g)].map((m) => m[1])
}

export type CompiledFilter = { ok: true; test: (r: Rec) => boolean } | { ok: false; error: string; pos: number }

// compiled expressions per field list (replaced on every field change)
const cache = new WeakMap<TableData['fields'], Map<string, CompiledFilter>>()

/** Compiles a (stored or display form) filter expression against a table's fields. */
export function compileFilter(t: TableData, src: string): CompiledFilter {
  let m = cache.get(t.fields)
  if (!m) cache.set(t.fields, (m = new Map()))
  let c = m.get(src)
  if (!c) {
    try {
      const e = compileExpr(t, src)
      c = {
        ok: true,
        test: (r) => {
          try {
            return truthy(e(r))
          } catch {
            return false
          }
        },
      }
    } catch (err) {
      c = err instanceof FormulaError ? { ok: false, error: err.message, pos: err.pos } : { ok: false, error: String(err), pos: 0 }
    }
    if (m.size > 100) m.clear()
    m.set(src, c)
  }
  return c
}

// ---------- stored <-> display form ----------

/**
 * Rewrites field references. Lenient: it also runs on half-typed expressions, leaving
 * anything it does not understand untouched.
 */
function rewriteRefs(src: string, map: (ref: string, braced: boolean) => string | undefined): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const close = ch === '“' ? '”' : ch === '‘' ? '’' : ch
      let j = i + 1
      while (j < src.length && src[j] !== close) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (ch === '{') {
      const j = src.indexOf('}', i + 1)
      if (j < 0) {
        out += src.slice(i)
        break
      }
      const ref = src.slice(i + 1, j).trim()
      out += map(ref, true) ?? src.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (reIdentStart.test(ch) && !(i > 0 && reIdent.test(src[i - 1]))) {
      let j = i + 1
      while (j < src.length && reIdent.test(src[j])) j++
      const word = src.slice(i, j)
      const call = /^\s*[(（]/.test(src.slice(j))
      out += (!call && !(word.toUpperCase() in KEYWORDS) && !['AND', 'OR', 'NOT'].includes(word.toUpperCase()) && map(word, false)) || word
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Expression as typed (field names) → stored form (field ids). */
export function toStoredExpr(t: FieldSource, src: string): string {
  const field = fieldResolver(t)
  return rewriteRefs(src, (ref) => {
    const f = field(ref)
    return f ? `{#${f.id}}` : undefined
  })
}

/** Stored form → expression with field names for editing. */
export function toDisplayExpr(t: FieldSource, src: string): string {
  const byId = new Map(t.fields.map((f) => [f.id, f]))
  return rewriteRefs(src, (ref, braced) => {
    if (!braced || !ref.startsWith('#')) return undefined
    const f = byId.get(ref.slice(1))
    return f ? `{${f.name}}` : undefined
  })
}
