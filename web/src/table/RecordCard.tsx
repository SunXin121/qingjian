import { useEffect, useState } from 'react'
import { confirmDialog, toast } from '../components/dialog'
import { IconClose, IconCopy, IconDown, IconPlus, IconTrash, IconUp } from '../components/icons'
import { FieldInput } from './editors'
import { openFieldEditor } from './FieldEditor'
import { FieldTypeIcon } from './icons'
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

/** Feishu-style side drawer (full screen on phones) with every field of one record. */
export default function RecordCard({ model, viewId, recordId, list, readOnly, onNavigate, onClose }: Props) {
  const table = useTable(model)
  const rec = table.records.find((r) => r.id === recordId)
  const view = table.views.find((v) => v.id === viewId)
  const fields = orderedFields(table, view)
  const hidden = new Set(view?.config.hidden ?? [])
  const i = list.indexOf(recordId)
  const prev = i > 0 ? list[i - 1] : undefined
  const next = i >= 0 && i < list.length - 1 ? list[i + 1] : undefined

  const primary = fields[0]
  const rawTitle = primary ? displayText(primary, cellValue(rec ?? ({ data: {} } as any), primary)) : ''
  const [heroTitle, setHeroTitle] = useState(rawTitle)
  useEffect(() => setHeroTitle(rawTitle), [rawTitle, recordId])

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

  const heroEditable = primary?.type === 'text' && !readOnly && !model.readOnly
  const commitHero = () => {
    if (!primary || !heroEditable) return
    const nextVal = heroTitle.trim()
    if (nextVal !== (rec.data[primary.id] ?? '')) model.setCells([{ rec: rec.id, field: primary.id, value: nextVal }])
  }

  // when primary is text, it is edited directly in the hero header; other types also show in the property list
  const bodyVisible = fields.filter((f, idx) => (idx === 0 ? primary?.type !== 'text' : !hidden.has(f.id)))
  const hiddenFields = fields.filter((f, idx) => idx > 0 && hidden.has(f.id))

  return (
    <div className="bt-sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="bt-sheet" role="dialog" aria-label="记录详情">
        <header className="bt-sheet-head">
          <div className="bt-sheet-nav">
            <button className="icon-btn sm" title="上一条 (↑)" aria-label="上一条 (↑)" disabled={!prev} onClick={() => prev && onNavigate(prev)}>
              <IconUp width={15} height={15} />
            </button>
            <button className="icon-btn sm" title="下一条 (↓)" aria-label="下一条 (↓)" disabled={!next} onClick={() => next && onNavigate(next)}>
              <IconDown width={15} height={15} />
            </button>
            {i >= 0 && list.length > 0 && (
              <span className="bt-sheet-pos">
                {i + 1} / {list.length}
              </span>
            )}
          </div>
          <span className="spacer" />
          {!readOnly && (
            <>
              <button
                className="icon-btn sm"
                title="复制记录"
                aria-label="复制记录"
                onClick={() => {
                  const [newRecId] = model.addRecords([JSON.parse(JSON.stringify(rec.data))], rec.id)
                  toast('已复制记录')
                  onNavigate(newRecId)
                }}
              >
                <IconCopy width={15} height={15} />
              </button>
              <button
                className="icon-btn sm"
                title="删除记录"
                aria-label="删除记录"
                onClick={async () => {
                  if (!(await confirmDialog('确定删除这条记录吗？可用 Ctrl+Z 撤销。', { danger: true, okText: '删除' }))) return
                  const target = next ?? prev
                  model.deleteRecords([rec.id])
                  if (target) onNavigate(target)
                  else onClose()
                }}
              >
                <IconTrash width={15} height={15} />
              </button>
            </>
          )}
          <button className="icon-btn sm" title="关闭 (Esc)" aria-label="关闭" onClick={onClose}>
            <IconClose width={16} height={16} />
          </button>
        </header>

        <div className="bt-sheet-body">
          {primary && (
            <div className="bt-sheet-hero">
              <div className="bt-sheet-hero-caption">
                <FieldTypeIcon type={primary.type} size={12} />
                <span>{primary.name}</span>
              </div>
              {heroEditable ? (
                <input
                  className="bt-sheet-hero-input"
                  value={heroTitle}
                  placeholder="未命名记录"
                  onChange={(e) => setHeroTitle(e.target.value)}
                  onBlur={commitHero}
                  onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
                />
              ) : (
                <div className={'bt-sheet-hero-static' + (rawTitle ? '' : ' muted')}>{rawTitle || '未命名记录'}</div>
              )}
            </div>
          )}

          <div className="bt-sheet-fields">
            {bodyVisible.map((f) => (
              <div key={rec.id + f.id} className="bt-sheet-field">
                <button
                  type="button"
                  className="bt-sheet-label"
                  title={readOnly ? fieldTypeLabel(f.type) : `${f.name}（${fieldTypeLabel(f.type)}）· 点击编辑字段`}
                  disabled={readOnly}
                  onClick={(e) => !readOnly && openFieldEditor(e.currentTarget, model, { field: f })}
                >
                  <FieldTypeIcon type={f.type} size={14} className="bt-sheet-label-icon" />
                  <span className="ellipsis">{f.name}</span>
                </button>
                <div className="bt-sheet-control">
                  <FieldInput model={model} field={f} rec={rec} readOnly={readOnly} />
                </div>
              </div>
            ))}
          </div>

          {hiddenFields.length > 0 && (
            <details className="bt-sheet-hidden">
              <summary>展开 {hiddenFields.length} 个当前视图隐藏的字段</summary>
              <div className="bt-sheet-fields">
                {hiddenFields.map((f) => (
                  <div key={rec.id + f.id} className="bt-sheet-field">
                    <button
                      type="button"
                      className="bt-sheet-label"
                      title={fieldTypeLabel(f.type)}
                      disabled={readOnly}
                      onClick={(e) => !readOnly && openFieldEditor(e.currentTarget, model, { field: f })}
                    >
                      <FieldTypeIcon type={f.type} size={14} className="bt-sheet-label-icon" />
                      <span className="ellipsis">{f.name}</span>
                    </button>
                    <div className="bt-sheet-control">
                      <FieldInput model={model} field={f} rec={rec} readOnly={readOnly} />
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {!readOnly && !model.readOnly && (
            <button
              type="button"
              className="btn ghost sm bt-sheet-add-field"
              onClick={(e) => openFieldEditor(e.currentTarget, model, { viewId, after: fields.at(-1)?.id })}
            >
              <IconPlus width={14} height={14} /> 新建字段
            </button>
          )}

          <div className="bt-sheet-meta">
            创建于 {fmtDateTime(rec.created_at)} · 最后修改 {fmtDateTime(rec.updated_at)}
          </div>
          {!readOnly && !model.readOnly && <RecordHistory key={rec.id} model={model} recordId={rec.id} />}
        </div>
      </aside>
    </div>
  )
}
