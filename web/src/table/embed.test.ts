import { afterEach, expect, it, vi } from 'vitest'
import { invalidateEmbed, renderTableEmbed, resetEmbedSource, setEmbedSource } from './embed'
import type { TableData } from './types'

const table = (view: string): TableData => ({
  id: 'table', title: 'Table', updated_at: 0,
  fields: [{ id: 'title', name: 'Title', type: 'text', options: {}, sort: 0 }],
  records: [{ id: 'row', seq: 1, data: { title: view }, sort: 0, created_at: 0, updated_at: 0 }],
  views: [{ id: view, name: view, type: 'grid', config: {}, sort: 0 }],
})

const render = (view: string) => new Promise<string>((resolve) => {
  renderTableEmbed(JSON.stringify({ table: 'table', view }), resolve)
})

afterEach(resetEmbedSource)

it('loads each embedded view separately and reuses only that view cache', async () => {
  const fetch = vi.fn(async (_id: string, view?: string) => table(view ?? 'default'))
  setEmbedSource(fetch, () => null)
  const [a, b] = await Promise.all([render('first'), render('second')])
  expect(fetch.mock.calls).toEqual([['table', 'first'], ['table', 'second']])
  expect(a).toContain('first')
  expect(a).not.toContain('second')
  expect(b).toContain('second')
  await render('first')
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('invalidates all views of a table', async () => {
  const fetch = vi.fn(async (_id: string, view?: string) => table(view ?? 'default'))
  setEmbedSource(fetch, () => null)
  await Promise.all([render('first'), render('second')])
  invalidateEmbed('table')
  await Promise.all([render('first'), render('second')])
  expect(fetch).toHaveBeenCalledTimes(4)
})
