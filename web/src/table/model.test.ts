import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyOps } from './model'
import type { Field, Rec, TableData } from './types'

// Pure applyOps tests do not mount dialogs or make API calls.
vi.mock('../components/dialog', () => ({ toast: vi.fn() }))
const field = (id: string, type: Field['type'] = 'text', options: Field['options'] = {}): Field => ({ id, name: id, type, options, sort: 0 })
const rec = (id: string, data: Rec['data'], sort = 0, seq = 1): Rec => ({ id, data, sort, seq, created_at: 1, updated_at: 2 })
const table = (id: string, fields: Field[], records: Rec[]): TableData => ({ id, title: '', updated_at: 0, fields, records, views: [] })

function pairedTable() {
  const other = table('other', [field('back', 'link', { table: 't', pair: 'link' })], [rec('a', { back: ['r', 'unrelated'] }), rec('b', {})])
  return { ...table('t', [field('title'), field('link', 'link', { table: 'other', pair: 'back' })], [rec('r', { title: 'old', link: ['a'] })]), linked: { other } }
}

afterEach(() => vi.restoreAllMocks())

describe('pure table operations regressions', () => {
  it('clears null values, retains numeric zero and leaves old snapshots untouched', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const raw = table('t', [field('a'), field('b')], [rec('r', { a: 'old', b: 5 }), rec('same', {})])
    const out = applyOps(raw, [{ op: 'record.update', id: 'r', data: { a: null, b: 0 } }])
    expect(out.records[0].data).toEqual({ b: 0 })
    expect(out.records[0].updated_at).toBe(100)
    expect(raw.records[0].data).toEqual({ a: 'old', b: 5 })
    expect(out.records[1]).toBe(raw.records[1])
  })

  it('preserves modification time on moves and sorts ties by sequence', () => {
    const raw = table('t', [], [rec('a', {}, 0, 2), rec('b', {}, 1, 1)])
    const out = applyOps(raw, [{ op: 'record.update', id: 'a', sort: 1 }])
    expect(out.records.map((r) => r.id)).toEqual(['b', 'a'])
    expect(out.records[1].updated_at).toBe(2)
  })

  it('rebuilds record indexes after deletion and creation within a batch', () => {
    const raw = table('t', [], [rec('a', {}), rec('b', {})])
    const out = applyOps(raw, [
      { op: 'record.delete', id: 'a' },
      { op: 'record.update', id: 'b', data: { n: 2 } },
      { op: 'record.create', id: 'c', seq: 3, sort: 1, data: { missing: null, n: 3 } },
      { op: 'record.update', id: 'c', data: { n: 4 } },
      { op: 'record.update', id: 'deleted', data: { n: 99 } },
    ])
    expect(out.records.map((r) => [r.id, r.data])).toEqual([['b', { n: 2 }], ['c', { n: 4 }]])
    expect(raw.records).toHaveLength(2)
  })

  it('deletes field values without copying unaffected records', () => {
    const raw = table('t', [field('a'), field('b')], [rec('r', { a: 'x', b: 'y' }), rec('same', { b: 'z' })])
    const out = applyOps(raw, [{ op: 'field.delete', id: 'a' }])
    expect(out.fields.map((f) => f.id)).toEqual(['b'])
    expect(out.records[0].data).toEqual({ b: 'y' })
    expect(out.records[1]).toBe(raw.records[1])
    expect(raw.records[0].data.a).toBe('x')
  })

  it('keeps two-way links unchanged when updating an unrelated cell', () => {
    const raw = pairedTable()
    const out = applyOps(raw, [{ op: 'record.update', id: 'r', data: { title: 'new' } }])
    expect(out.linked).toBe(raw.linked)
    expect(out.linked?.other.records[0].data.back).toEqual(['r', 'unrelated'])
  })

  it('mirrors link additions, removals and deletion without mutating linked snapshots', () => {
    const raw = pairedTable()
    const out = applyOps(raw, [{ op: 'record.update', id: 'r', data: { link: ['b'] } }])
    expect(out.linked?.other.records.map((r) => r.data)).toEqual([{ back: ['unrelated'] }, { back: ['r'] }])
    expect(raw.linked.other.records[0].data.back).toEqual(['r', 'unrelated'])
    const removed = applyOps(out, [{ op: 'record.delete', id: 'r' }])
    expect(removed.linked?.other.records[1].data).toEqual({})
    expect(out.linked?.other.records[1].data.back).toEqual(['r'])
  })
})
