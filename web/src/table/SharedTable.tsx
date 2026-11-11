import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { shareApi } from '../api'
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
        document.title = `${t.title.trim() || '未命名表格'} - 青简`
      })
      .catch((e) => setError(e.message))
  }, [token, tableId])

  const title = model?.state.title.trim() || (model ? '未命名表格' : '')
  return (
    <>
      {header(<span className="crumb ellipsis">{title}</span>)}
      {error ? (
        <div className="empty-state">{error}</div>
      ) : !model ? (
        <div className="ink-loading">加载中…</div>
      ) : (
        <TableView model={model} readOnly viewId={params.get('view') ?? undefined} onViewChange={(id) => setParams({ view: id }, { replace: true })} />
      )}
    </>
  )
}
