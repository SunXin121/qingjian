import { describe, expect, it } from 'vitest'
import { derive } from './compute'
import { compileFilter, compileFormula, formulaRefs, toDisplayExpr, toStoredExpr } from './formula'
import type { Field, Rec, TableData } from './types'

const field = (id: string, name: string, type: Field['type'], options: Field['options'] = {}): Field => ({ id, name, type, options, sort: 0 })
const rec = (id: string, data: Record<string, any>): Rec => ({ id, seq: 1, data, sort: 0, created_at: 0, updated_at: 0 })

const fields: Field[] = [
  field('ftitle0001', '标题', 'text'),
  field('fprice0001', '价格', 'number'),
  field('fcount0001', '数量', 'number'),
  field('fdone00001', '完成', 'checkbox'),
  field('ftags00001', '标签', 'multiselect', {
    choices: [
      { id: 'cfront0001', name: '前端', color: 0 },
      { id: 'cback00001', name: '后端', color: 1 },
    ],
  }),
]
const table = (extra: Field[] = [], records: Rec[] = []): TableData => ({ id: 'tbl0000001', title: 't', updated_at: 0, fields: [...fields, ...extra], views: [], records })

const row = rec('rec0000001', { ftitle0001: 'Fix login bug', fprice0001: 120, fcount0001: 3, fdone00001: true, ftags00001: ['cfront0001'] })
const empty = rec('rec0000002', {})

function run(src: string, r: Rec = row) {
  const c = compileFormula(table(), src)
  if (!c.ok) throw new Error(c.error)
  return c.run(r)
}

describe('formula evaluation', () => {
  it('does arithmetic with precedence and parentheses', () => {
    expect(run('{价格} * {数量} + 1')).toBe(361)
    expect(run('({价格} + 30) / {数量}')).toBe(50)
    expect(run('1 + 2 * 3')).toBe(7)
  })

  it('calls functions', () => {
    expect(run('IF({价格} > 100, "贵", "便宜")')).toBe('贵')
    expect(run('UPPER(LEFT({标题}, 3))')).toBe('FIX')
    expect(run('LEN({标题})')).toBe(13)
    expect(run('ROUND(10 / 3, 2)')).toBe(3.33)
    expect(run('SUM({价格}, {数量}, 7)')).toBe(130)
    expect(run('CONCAT({标题}, "!")')).toBe('Fix login bug!')
  })

  it('concatenates with &', () => {
    expect(run('{标题} & " x" & {数量}')).toBe('Fix login bug x3')
  })

  it('treats missing values as empty', () => {
    expect(run('ISEMPTY({标题})', empty)).toBe(true)
    expect(run('ISNOTEMPTY({标题})')).toBe(true)
    expect(run('IF(ISEMPTY({价格}), 0, {价格})', empty)).toBe(0)
  })

  it('reports syntax errors with a position instead of throwing', () => {
    const c = compileFormula(table(), '{价格} +')
    expect(c.ok).toBe(false)
    const unknown = compileFormula(table(), 'NOSUCHFN(1)')
    expect(unknown.ok).toBe(false)
    const field = compileFormula(table(), '{不存在的字段} + 1')
    expect(field.ok).toBe(false)
  })
})

describe('filter expressions', () => {
  const test = (src: string, r: Rec = row) => {
    const c = compileFilter(table(), src)
    if (!c.ok) throw new Error(c.error)
    return c.test(r)
  }

  it('combines conditions with AND / OR / NOT', () => {
    expect(test('{价格} > 100 AND CONTAINS({标题}, "bug")')).toBe(true)
    expect(test('{价格} > 500 OR {完成}')).toBe(true)
    expect(test('NOT({完成})')).toBe(false)
    expect(test('{价格} > 100 && {数量} >= 5')).toBe(false)
  })

  it('matches multiselect choices by name', () => {
    expect(test('HAS({标签}, "前端")')).toBe(true)
    expect(test('HAS({标签}, "后端")')).toBe(false)
    expect(test('HASALL({标签}, "前端", "后端")')).toBe(false)
  })

  it('is false for empty records rather than failing', () => {
    expect(test('{价格} > 100', empty)).toBe(false)
    expect(test('ISEMPTY({标签})', empty)).toBe(true)
  })
})

describe('stored expressions', () => {
  it('round-trips between field names and ids', () => {
    const t = table()
    const stored = toStoredExpr(t, '{价格} * {数量}')
    expect(stored).toBe('{#fprice0001} * {#fcount0001}')
    expect(formulaRefs(stored)).toEqual(['fprice0001', 'fcount0001'])
    expect(toDisplayExpr(t, stored)).toBe('{价格} * {数量}')
  })

  it('keeps working after a field is renamed', () => {
    const stored = toStoredExpr(table(), '{价格} + 1')
    const renamed = table()
    renamed.fields = renamed.fields.map((f) => (f.id === 'fprice0001' ? { ...f, name: '单价' } : f))
    expect(toDisplayExpr(renamed, stored)).toBe('{单价} + 1')
    const c = compileFormula(renamed, stored)
    expect(c.ok && c.run(row)).toBe(121)
  })
})

describe('derive', () => {
  it('fills formula fields, including formulas that read other formulas', () => {
    const total = field('ftotal0001', '合计', 'formula', { expr: '{#fprice0001} * {#fcount0001}' })
    const label = field('flabel0001', '说明', 'formula', { expr: 'IF({#ftotal0001} > 300, "大单", "小单")' })
    const t = derive(table([total, label], [row, empty]))
    expect(t.records[0].data.ftotal0001).toBe(360)
    expect(t.records[0].data.flabel0001).toBe('大单')
    expect(t.records[1].data.flabel0001).toBe('小单')
  })

  it('returns the same table when nothing is computed', () => {
    const t = table([], [row])
    expect(derive(t)).toBe(t)
  })

  it('survives formulas that reference each other in a cycle', () => {
    const a = field('fcyclea001', 'A', 'formula', { expr: '{#fcycleb001} + 1' })
    const b = field('fcycleb001', 'B', 'formula', { expr: '{#fcyclea001} + 1' })
    expect(() => derive(table([a, b], [row]))).not.toThrow()
  })
})
