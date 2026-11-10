import { useEffect, useState } from 'react'
import { api, type TableSummary } from '../api'
import { Modal, mount } from '../components/dialog'
import { IconTable } from '../components/icons'
import { viewIcon } from './TableView'

/** Lets the user pick a table view to embed into a document. */
export function pickTableView(): Promise<{ table: string; view: string } | null> {
  return new Promise((resolve) => {
    mount((close) => (
      <TablePicker
        onDone={(v) => {
          close()
          resolve(v)
        }}
      />
    ))
  })
}

function TablePicker({ onDone }: { onDone: (v: { table: string; view: string } | null) => void }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    api
      .tables()
      .then(setTables)
      .catch((e) => setError(e.message))
  }, [])
  const query = q.trim().toLowerCase()
  const list = (tables ?? []).filter((t) => !query || t.title.toLowerCase().includes(query) || t.repo_name.toLowerCase().includes(query))
  return (
    <Modal title="嵌入多维表格" onClose={() => onDone(null)} wide>
      <div className="modal-body form">
        <input className="bt-input" autoFocus placeholder="搜索表格" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="bt-picker-tables">
          {error && <div className="empty-state small">{error}</div>}
          {tables && !list.length && <div className="empty-state small">{tables.length ? '没有匹配的表格' : '还没有多维表格。先在目录中「新建多维表格」，再回来嵌入。'}</div>}
          {list.map((t) => (
            <div key={t.id} className="bt-picker-table">
              <div className="bt-picker-table-head">
                <IconTable width={16} height={16} />
                <span className="ellipsis">{t.title || '未命名表格'}</span>
                <span className="muted ellipsis">{t.repo_name}</span>
              </div>
              <div className="bt-picker-views">
                {t.views.map((v) => (
                  <button key={v.id} className="btn sm" onClick={() => onDone({ table: t.id, view: v.id })}>
                    {viewIcon(v.type as 'grid' | 'kanban')} {v.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={() => onDone(null)}>
          取消
        </button>
      </div>
    </Modal>
  )
}
