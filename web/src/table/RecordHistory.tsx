import { useCallback, useEffect, useRef, useState } from 'react'
import { api, formatTime } from '../api'
import { IconHistory } from '../components/icons'
import { Tag } from './editors'
import { choiceOf, displayText, fmtDateTime, isEmptyValue } from './engine'
import { useSyncState, useTable, type TableModel } from './model'
import type { AttachmentValue, Field, HistoryChange, HistoryEntry, TableData } from './types'

/** Change log of one record, newest first; refreshed whenever the table finishes saving. */
export default function RecordHistory({ model, recordId }: { model: TableModel; recordId: string }) {
  const table = useTable(model)
  const sync = useSyncState(model)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const req = useRef(0)

  const load = useCallback(
    async (before?: HistoryEntry) => {
      const n = ++req.current
      setLoading(true)
      try {
        const r = await api.recordHistory(model.state.id, recordId, before?.id)
        if (n !== req.current) return
        setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries))
        setMore(r.more)
        setError('')
      } catch (e: any) {
        if (n === req.current) setError(e.message)
      } finally {
        if (n === req.current) setLoading(false)
      }
    },
    [model, recordId],
  )

  useEffect(() => {
    setEntries([])
    setMore(false)
  }, [recordId])
  useEffect(() => {
    if (sync === 'saved') load()
  }, [sync, load])

  return (
    <section className="bt-history">
      <div className="bt-history-title">
        <IconHistory width={15} height={15} /> 修改记录
      </div>
      {error && <div className="bt-history-empty">加载失败：{error}</div>}
      {!error && !loading && !entries.length && <div className="bt-history-empty">暂无修改记录</div>}
      <ol className="bt-history-list">
        {entries.map((e) => (
          <HistoryItem key={e.id} entry={e} table={table} />
        ))}
      </ol>
      {more && (
        <button className="btn sm bt-history-more" disabled={loading} onClick={() => load(entries.at(-1))}>
          {loading ? '加载中…' : '加载更多'}
        </button>
      )}
    </section>
  )
}

const ACTION: Record<HistoryEntry['action'], string> = {
  create: '创建了记录',
  update: '修改了记录',
  delete: '删除了记录',
  restore: '恢复了记录',
}

function HistoryItem({ entry, table }: { entry: HistoryEntry; table: TableData }) {
  const one = entry.action === 'update' && entry.changes.length === 1 ? entry.changes[0] : undefined
  return (
    <li className={'bt-history-item ' + entry.action}>
      <div className="bt-history-head">
        <span className="bt-history-action">{one ? <>修改了「{fieldOf(table, one).name}」</> : ACTION[entry.action]}</span>
        <time title={fmtDateTime(entry.updated_at)}>{formatTime(entry.updated_at)}</time>
      </div>
      {entry.changes.length > 0 && (
        <div className="bt-history-changes">
          {entry.changes.map((c) => {
            const f = fieldOf(table, c)
            const gone = !table.fields.some((x) => x.id === c.field)
            return (
              <div key={c.field} className="bt-history-change">
                {!one && (
                  <div className="bt-history-field">
                    {f.name}
                    {gone && <span className="muted">（已删除）</span>}
                  </div>
                )}
                <div className="bt-history-values">
                  {entry.action === 'update' && (
                    <>
                      <span className={'bt-history-old' + (isEmptyValue(c.old) && f.type !== 'checkbox' ? ' empty' : '')}>
                        <HistoryValue field={f} value={c.old} />
                      </span>
                      <span className="bt-history-arrow">→</span>
                    </>
                  )}
                  <span className="bt-history-new">
                    <HistoryValue field={f} value={c.new} />
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </li>
  )
}

/** The current field when it still exists with the same type, else the logged name / type. */
function fieldOf(table: TableData, c: HistoryChange): Field {
  const f = table.fields.find((x) => x.id === c.field)
  if (f && f.type === c.type) return f
  return { id: c.field, name: f?.name ?? c.name, type: c.type, options: {}, sort: 0 }
}

function HistoryValue({ field, value }: { field: Field; value: any }) {
  if (field.type === 'checkbox') return <>{value ? '已勾选' : '未勾选'}</>
  if (isEmptyValue(value)) return <span className="bt-history-empty-value">空</span>
  switch (field.type) {
    case 'select':
    case 'multiselect': {
      const ids: string[] = Array.isArray(value) ? value : [value]
      return (
        <span className="bt-tags">
          {ids.map((id) => {
            const c = choiceOf(field, id)
            return c ? <Tag key={id} choice={c} /> : <span key={id} className="bt-history-empty-value">已删除的选项</span>
          })}
        </span>
      )
    }
    case 'attachment':
      return <>{(value as AttachmentValue[]).map((a) => a.name).join('、')}</>
    case 'link': {
      const t = displayText(field, value)
      return t ? <>{t}</> : <span className="bt-history-empty-value">已删除的记录</span>
    }
    default:
      return <>{displayText(field, value)}</>
  }
}
