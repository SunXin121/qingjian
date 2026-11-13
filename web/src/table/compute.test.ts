import { describe, expect, it } from 'vitest'
import { derive } from './compute'
import { displayText } from './engine'
import type { Field, Rec, TableData } from './types'

const field = (id: string, type: Field['type'], options: Field['options'] = {}): Field => ({ id, name: id, type, options, sort: 0 })
const rec = (id: string, data: Rec['data']): Rec => ({ id, seq: 1, sort: 0, created_at: 0, updated_at: 0, data })
const table = (id: string, fields: Field[], records: Rec[]): TableData => ({ id, title: '', updated_at: 0, fields, records, views: [] })

describe('computed table regressions', () => {
  it('evaluates formula dependencies regardless of field order without mutating raw values', () => {
    const raw = table('t', [field('fnext00001', 'formula', { expr: '{#fbase00001} + 1' }), field('fbase00001', 'formula', { expr: '{#fnum000001} * 2' }), field('fnum000001', 'number')], [rec('r', { fnum000001: 3, fnext00001: 999 })])
    const out = derive(raw)
    expect(out.records[0].data).toEqual({ fnum000001: 3, fbase00001: 6, fnext00001: 7 })
    expect(raw.records[0].data).toEqual({ fnum000001: 3, fnext00001: 999 })
    expect(raw.fields[0].rt).toBeUndefined()
    expect(out.fields[0].rt?.kind).toBe('number')
    expect(derive(raw)).toBe(out)
    expect(derive({ ...raw }).records[0]).toBe(out.records[0])
  })

  it('reports cycles and invalid formulas rather than retaining stored computed values', () => {
    const raw = table('t', [field('fcycle0001', 'formula', { expr: '{#fcycle0002}' }), field('fcycle0002', 'formula', { expr: '{#fcycle0001}' }), field('fbroken001', 'formula', { expr: 'BROKEN(' })], [rec('r', { fbroken001: 'stale' })])
    const out = derive(raw)
    expect(out.fields[0].rt?.error).toContain('循环引用')
    expect(out.fields[1].rt?.error).toContain('循环引用')
    expect(out.fields[2].rt?.error).toBeTruthy()
    expect(out.records[0].data.fbroken001).toBeUndefined()
  })

  it('looks up computed linked values, skips deleted records, and inherits rollup formatting', () => {
    const linked = table('other', [field('ftitle0001', 'text'), field('famount001', 'number', { precision: 2, thousands: true }), field('fdouble001', 'formula', { expr: '{#famount001} * 2' })], [rec('a', { ftitle0001: 'A', famount001: 1000 }), rec('b', { ftitle0001: 'B', famount001: 20 })])
    const raw = table('t', [field('flink00001', 'link', { table: 'other' }), field('flookup001', 'lookup', { link: 'flink00001', target: 'fdouble001' }), field('frollup001', 'rollup', { link: 'flink00001', target: 'famount001', agg: 'sum' })], [rec('r', { flink00001: ['a', 'deleted', 'b'] }), rec('empty', {})])
    raw.linked = { other: linked }
    const out = derive(raw)
    expect(out.records[0].data.flookup001).toEqual([2000, 40])
    expect(out.records[0].data.frollup001).toBe(1020)
    expect(displayText(out.fields[0], out.records[0].data.flink00001)).toBe('A, B')
    expect(displayText(out.fields[2], out.records[0].data.frollup001)).toBe('1,020.00')
    expect(out.records[1].data.frollup001).toBeUndefined()
    expect(linked.fields[2].rt).toBeUndefined()
  })

  it('recomputes when linked records change and preserves the previous derived snapshot', () => {
    const other = table('other', [field('fnum000001', 'number')], [rec('a', { fnum000001: 2 })])
    const raw = table('t', [field('flink00001', 'link', { table: 'other' }), field('flookup001', 'lookup', { link: 'flink00001', target: 'fnum000001' })], [rec('r', { flink00001: ['a'] })])
    raw.linked = { other }
    const before = derive(raw)
    const after = derive({ ...raw, linked: { other: { ...other, records: [rec('a', { fnum000001: 9 })] } } })
    expect(before.records[0].data.flookup001).toEqual([2])
    expect(after.records[0].data.flookup001).toEqual([9])
    expect(after.records[0]).not.toBe(before.records[0])
  })

  it('reports missing link targets and returns uncomputed tables by identity', () => {
    const plain = table('t', [field('title', 'text')], [])
    expect(derive(plain)).toBe(plain)
    const out = derive({ ...plain, fields: [field('link', 'link', { table: 'deleted' }), field('lookup', 'lookup', { link: 'link', target: 'unknown' })] })
    expect(out.fields[0].rt?.error).toContain('不存在')
    expect(out.fields[1].rt?.error).toContain('不存在')
  })
})
