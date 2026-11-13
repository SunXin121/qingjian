import { describe, expect, it } from 'vitest'
import { choiceCollector, groupPaths, groupRows, makeMatcher, parseCSV, parseText, sortRecords, summarize, toCSV, viewRecords, visibleFields } from './engine'
import type { Field, Rec, TableData, View } from './types'

const field = (id: string, type: Field['type'] = 'text'): Field => ({ id, name: id, type, sort: 0, options: {} })
const rec = (id: string, data: Rec['data']): Rec => ({ id, data, seq: 1, sort: 0, created_at: 0, updated_at: 0 })
const table = (fields: Field[], records: Rec[]): TableData => ({ id: 't', title: '', updated_at: 0, fields, records, views: [] })
const view = (config: View['config']): View => ({ id: 'v', name: '', type: 'grid', sort: 0, config })

describe('table engine regressions', () => {
  it('keeps the primary field visible and first despite hidden and ordering settings', () => {
    const t = table([field('title'), field('a'), field('b'), field('c')], [])
    expect(visibleFields(t, view({ order: ['c', 'title', 'b'], hidden: ['title', 'b'] })).map((f) => f.id)).toEqual(['title', 'c', 'a'])
  })

  it('sorts stably, keeps empty cells last in both directions and leaves input untouched', () => {
    const rows = [rec('empty', {}), rec('zero', { n: 0 }), rec('a', { n: 2 }), rec('b', { n: 2 })]
    const t = table([field('n', 'number')], rows)
    expect(sortRecords(t, rows, [{ field: 'n' }]).map((r) => r.id)).toEqual(['zero', 'a', 'b', 'empty'])
    expect(sortRecords(t, rows, [{ field: 'n', desc: true }]).map((r) => r.id)).toEqual(['a', 'b', 'zero', 'empty'])
    expect(rows.map((r) => r.id)).toEqual(['empty', 'zero', 'a', 'b'])
  })

  it('ignores invalid filters, uses percentage units and retains sticky edited records', () => {
    const t = table([field('p', 'progress')], [rec('low', { p: 0.25 }), rec('high', { p: 0.8 })])
    const v = view({ filter: { conj: 'and', conds: [
      { id: '1', field: 'p', op: 'gte', value: 50 },
      { id: '2', field: 'deleted', op: 'is', value: 'x' },
      { id: '3', field: '', op: 'expr', value: 'BROKEN(' },
    ] } })
    expect(t.records.filter(makeMatcher(t, v)).map((r) => r.id)).toEqual(['high'])
    expect(viewRecords(t, v, new Set(['low'])).map((r) => r.id)).toEqual(['low', 'high'])
    expect(makeMatcher(t, view({ filter: { conj: 'or', conds: [] } }))(t.records[0])).toBe(true)
  })

  it('collapses nested groups while keeping correct counts and stable group paths', () => {
    const t = table([field('team'), field('state')], [rec('a', { team: 'A', state: 'open' }), rec('b', { team: 'A', state: 'done' }), rec('c', { team: 'B', state: 'open' })])
    const rules = [{ field: 'team' }, { field: 'state' }]
    const paths = groupPaths(t, t.records[0], rules)
    expect(paths).toEqual(['/team:A', '/team:A/state:open'])
    const rows = groupRows(t, t.records, rules, new Set([paths[0]]))
    expect(rows[0]).toMatchObject({ kind: 'group', count: 2, collapsed: true, path: '/team:A' })
    expect(rows.filter((r) => r.kind === 'record').map((r) => r.rec.id)).toEqual(['c'])
  })

  it('counts numeric zero as filled and excludes missing values from averages', () => {
    const f = field('n', 'number')
    const rows = [rec('a', { n: 0 }), rec('b', { n: 4 }), rec('c', {})]
    expect(summarize(f, 'filled', rows)).toMatch(/ 2$/)
    expect(summarize(f, 'avg', rows)).toMatch(/ 2\.00$/)
    expect(summarize(f, 'sum', rows)).toMatch(/ 4$/)
  })

  it('round trips CSV quotes, commas, multiline cells and boundary whitespace, and reads TSV', () => {
    const rows = [['标题', '描述'], ['a,b', 'say "hi"\nnext'], [' spaced ', '']]
    expect(parseCSV(toCSV(rows))).toEqual(rows)
    expect(parseCSV('\uFEFFa\tb\r\n1\t2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('reuses choices case-insensitively and deduplicates pasted multiselect values', () => {
    const f: Field = { ...field('tags', 'multiselect'), options: { choices: [{ id: 'known', name: 'Known', color: 0 }] } }
    const collector = choiceCollector([f])
    const ids = parseText(f, 'known, New;new', collector.resolve)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('known')
    expect(collector.added.get('tags')).toHaveLength(1)
    expect(parseText(field('p', 'progress'), '50%', collector.resolve)).toBe(0.5)
    expect(parseText(field('n', 'number'), '$1,234.50', collector.resolve)).toBe(1234.5)
  })
})
