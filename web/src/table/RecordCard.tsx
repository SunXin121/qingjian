import { useEffect } from 'react'
import { confirmDialog } from '../components/dialog'
import { IconClose, IconDown, IconTrash, IconUp } from '../components/icons'
import { FieldInput } from './editors'
import RecordHistory from './RecordHistory'
import { cellValue, displayText, fmtDateTime, orderedFields } from './engine'
import { useTable, type TableModel } from './model'
import { fieldTypeLabel } from './types'

interface Props {
  model: TableModel
  viewId: string
  recordId: string
  list: string[]
  readOnly: boolean
  onNavigate: (id: string) => void
  onClose: () => void
}

/** Side sheet (full screen on phones) with every field of one record. */
export default function RecordCard({ model, viewId, recordId, list, readOnly, onNavigate, onClose }: Props) {
  const table = useTable(model)
  const rec = table.records.find((r) => r.id === recordId)
  const view = table.views.find((v) => v.id === viewId)
  const fields = orderedFields(table, view)
  const hidden = new Set(view?.config.hidden ?? [])
  const i = list.indexOf(recordId)
  const prev = i > 0 ? list[i - 1] : undefined
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : undefined

  // the sheet owns the keyboard while open: take focus away from the grid
  useEffect(() => {
    const a = document.activeElement as HTMLElement | null
    if (a && !a.closest('.bt-sheet')) a.blur()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = t.closest?.('input, textarea, select, [contenteditable]')
      if (e.key === 'Escape') {
        if (document.querySelector('.popover, .modal-backdrop, [data-modal]')) return
        e.stopPropagation()
        if (typing) (t as HTMLElement).blur()
        else onClose()
        return
      }
      if (typing || t.closest?.('.popover')) return
      if ((e.key === 'ArrowUp' || e.key === 'k') && prev) onNavigate(prev)
      if ((e.key === 'ArrowDown' || e.key === 'j') && next) onNavigate(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [prev, next, onNavigate, onClose])

  useEffect(() => {
    if (!rec) onClose()
  }, [rec, onClose])
  if (!rec) return null

  const primary = fields[0]
  const title = primary ? displayText(primary, cellValue(rec, primary)) : ''
  const visible = fields.filter((f, idx) => idx === 0 || !hidden.has(f.id))
  const hiddenFields = fields.filter((f, idx) => idx > 0 && hidden.has(f.id))

  return (
    <div className="bt-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="bt-sheet" role="dialog">
        <header className="bt-sheet-head">
          <div className="bt-sheet-title ellipsis">{title || '未命名记录'}</div>
          <span className="spacer" />
          <button className="icon-btn" title="上一条 (↑)" aria-label="上一条 (↑)" disabled={!prev} onClick={() => prev && onNavigate(prev)}>
            <IconUp />
          </button>
          <button className="icon-btn" title="下一条 (↓)" aria-label="下一条 (↓)" disabled={!next} onClick={() => next && onNavigate(next)}>
            <IconDown />
          </button>
          {!readOnly && (
            <button
              className="icon-btn"
              title="删除记录" aria-label="删除记录"
              onClick={async () => {
                if (!(await confirmDialog('确定删除这条记录吗？可用 Ctrl+Z 撤销。', { danger: true, okText: '删除' }))) return
                const target = next ?? prev
                model.deleteRecords([rec.id])
                if (target) onNavigate(target)
                else onClose()
              }}
            >
              <IconTrash />
            </button>
          )}
          <button className="icon-btn" title="关闭" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="bt-sheet-body">
          {visible.map((f) => (
            <div key={rec.id + f.id} className="bt-sheet-field">
              <div className="bt-sheet-label" title={fieldTypeLabel(f.type)}>
                {f.name}
              </div>
              <FieldInput model={model} field={f} rec={rec} readOnly={readOnly} />
            </div>
          ))}
          {hiddenFields.length > 0 && (
            <details className="bt-sheet-hidden">
              <summary>{hiddenFields.length} 个隐藏字段</summary>
              {hiddenFields.map((f) => (
                <div key={rec.id + f.id} className="bt-sheet-field">
                  <div className="bt-sheet-label">{f.name}</div>
                  <FieldInput model={model} field={f} rec={rec} readOnly={readOnly} />
                </div>
              ))}
            </details>
          )}
          <div className="bt-sheet-meta">
            创建于 {fmtDateTime(rec.created_at)} · 修改于 {fmtDateTime(rec.updated_at)}
          </div>
          {!readOnly && !model.readOnly && <RecordHistory key={rec.id} model={model} recordId={rec.id} />}
        </div>
      </aside>
    </div>
  )
}
