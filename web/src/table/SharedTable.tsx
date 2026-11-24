import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { shareApi } from '../api'
import { Crumb } from '../components/page'
import { Crumbs } from '../components/PageHeader'
import { EmptyState, Loading } from '../components/ui'
import { setPageMeta } from '../seo'
import { TableModel } from './model'
import TableView from './TableView'
import './table.css'

/** Read-only table for share links; view settings (filters etc.) change only locally. */
export default function SharedTable({ token, tableId, header }: { token: string; tableId: string; header: (extra: ReactNode) => ReactNode }) {
  const [model, setModel] = useState<TableModel | null>(null)
  const [error, setError] = useState('')
  const [params, setParams] = useSearchParams()

  useEffect(() => {
    setModel(null)
    setError('')
    shareApi
      .table(token, tableId)
      .then((t) => {
        setModel(new TableModel(t, { readOnly: true }))
        const name = t.title.trim() || '未命名表格'
        setPageMeta({
          title: `${name} - 青简`,
          description: `${name} — 由青简知识库分享的多维表格。`,
          canonical: `${location.origin}${location.pathname}`,
          markdownAlternate: `${location.pathname}.md`,
        })
      })
      .catch((e) => setError(e.message))
  }, [token, tableId])

  const title = model?.state.title.trim() || (model ? '未命名表格' : '')
  return (
    <>
      {header(
        <Crumbs>
          <Crumb>{title}</Crumb>
        </Crumbs>,
      )}
      <main id="main-content" className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <EmptyState title="打不开这个多维表格">{error}</EmptyState>
        ) : !model ? (
          <Loading />
        ) : (
          <TableView model={model} readOnly viewId={params.get('view') ?? undefined} onViewChange={(id) => setParams({ view: id }, { replace: true })} />
        )}
      </main>
    </>
  )
}
