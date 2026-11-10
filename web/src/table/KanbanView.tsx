import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { openMenu, promptText } from '../components/dialog'
import { IconEdit, IconMore, IconPlus, IconTrash } from '../components/icons'
import { ValueView, Tag } from './editors'
import { cellMatches, cellValue, displayText, isEmptyValue, primaryField, searchNeedle, viewRecords, visibleFields } from './engine'
import { openFieldEditor } from './FieldEditor'
import type { TableModel } from './model'
import { newId, TAG_COLORS, type Choice, type Field, type Rec, type TableData, type View } from './types'

interface Props {
  model: TableModel
  table: TableData
  view: View
  readOnly: boolean
  onOpenRecord: (id: string, list: string[]) => void
  /** table search: only cards with a matching visible field are shown */
  search?: string
  onSearchCount?: (n: number) => void
}

const EMPTY = '__empty'
/** cards rendered per column at first and added each time the column is scrolled to its end */
const PAGE = 50

export default function KanbanView({ model, table, view, readOnly, onOpenRecord, search = '', onSearchCount }: Props) {
  const cfg = view.config
  const selectFields = table.fields.filter((f) => f.type === 'select')
  const groupField = selectFields.find((f) => f.id === cfg.kanbanField) ?? selectFields[0]
  const needle = searchNeedle(search)
  const records = useMemo(() => {
    const list = viewRecords(table, view, model.sticky)
    if (!needle) return list
    const fields = visibleFields(table, view)
    return list.filter((r) => fields.some((f) => cellMatches(f, r, needle)))
  }, [table, view, model, needle])
  useLayoutEffect(() => onSearchCount?.(records.length), [records.length, onSearchCount])
  const primary = primaryField(table)
  const cardFields = useMemo(() => visibleFields(table, view).filter((f) => f.id !== primary?.id && f.id !== groupField?.id), [table, view, primary, groupField])
  const [drag, setDrag] = useState<{ id: string; over?: string; before?: string } | null>(null)
  const sorted = !!cfg.sorts?.length
  // how many cards each column shows; starts over when the view or the search changes
  const [limits, setLimits] = useState<Record<string, number>>({})
  useEffect(() => setLimits({}), [view.id, needle, groupField?.id])
  const limitOf = (key: string) => limits[key] ?? PAGE

  if (!groupField) {
    return (
      <div className="bt-kanban-empty">
        <p>看板按「单选」字段分组展示记录，当前表格还没有单选字段。</p>
        {!readOnly && (
          <button
            className="btn primary"
            onClick={(e) =>
              openFieldEditor(e.currentTarget, model, {
                type: 'select',
                name: '状态',
                onCreated: (id) => model.updateView(view.id, { kanbanField: id }),
              })
            }
          >
            <IconPlus width={16} height={16} /> 新建单选字段
          </button>
        )}
      </div>
    )
  }

  const choices = groupField.options.choices ?? []
  const columns: { key: string; choice?: Choice }[] = [...choices.map((c) => ({ key: c.id, choice: c })), ...(cfg.hideEmptyColumn ? [] : [{ key: EMPTY }])]
  const byColumn = new Map<string, Rec[]>(columns.map((c) => [c.key, []]))
  for (const r of records) {
    const v = r.data[groupField.id]
    const key = v && byColumn.has(v) ? v : EMPTY
    byColumn.get(key)?.push(r)
  }
  const allIds = columns.flatMap((c) => byColumn.get(c.key)!.map((r) => r.id))

  const drop = (e: DragEvent, colKey: string) => {
    e.preventDefault()
    if (!drag) return
    const rec = model.record(drag.id)
    const before = drag.before ?? byColumn.get(colKey)!.filter((r) => r.id !== drag.id)[limitOf(colKey)]?.id
    setDrag(null)
    if (!rec) return
    const value = colKey === EMPTY ? null : colKey
    const data = (rec.data[groupField.id] ?? null) === value ? undefined : { [groupField.id]: value }
    let sort: number | undefined
    if (!sorted) {
      // place between neighbours in the global record order
      const list = byColumn.get(colKey)!.filter((r) => r.id !== rec.id)
      const idx = before ? list.findIndex((r) => r.id === before) : list.length
      const prev = list[idx - 1]
      const next = list[idx]
      if (prev && next) sort = (prev.sort + next.sort) / 2
      else if (next) sort = next.sort - 1
      else if (prev) sort = prev.sort + 1
      if (sort === rec.sort) sort = undefined
    }
    if (data || sort !== undefined) {
      model.sticky.add(rec.id)
      model.moveRecord(rec.id, sort, data)
    }
  }

  const addCard = (colKey: string) => {
    const data = colKey === EMPTY ? {} : { [groupField.id]: colKey }
    const list = byColumn.get(colKey)!
    const [id] = model.addRecords([data], list.at(-1)?.id)
    // make sure the new card at the end of the column is rendered
    setLimits((l) => ({ ...l, [colKey]: Math.max(limitOf(colKey), list.length + 1) }))
    onOpenRecord(id, [...allIds, id])
  }

  const columnMenu = (el: HTMLElement, c: Choice) =>
    openMenu(el, [
      {
        label: '重命名分组',
        icon: <IconEdit />,
        onClick: async () => {
          const name = await promptText('重命名分组', c.name)
          if (name) model.updateField(groupField.id, { options: { ...groupField.options, choices: choices.map((x) => (x.id === c.id ? { ...x, name } : x)) } })
        },
      },
      {
        label: '删除分组',
        icon: <IconTrash />,
        danger: true,
        onClick: () => model.updateField(groupField.id, { options: { ...groupField.options, choices: choices.filter((x) => x.id !== c.id) } }),
      },
    ])

  return (
    <div className="bt-kanban">
      {columns.map((col) => {
        const list = byColumn.get(col.key)!
        const shown = list.slice(0, limitOf(col.key))
        return (
          <div
            key={col.key}
            className={'bt-col' + (drag?.over === col.key ? ' over' : '')}
            onDragOver={(e) => {
              if (!drag) return
              e.preventDefault()
              if (drag.over !== col.key) setDrag({ ...drag, over: col.key, before: undefined })
            }}
            onDrop={(e) => drop(e, col.key)}
          >
            <div className="bt-col-head">
              {col.choice ? <Tag choice={col.choice} /> : <span className="bt-col-none">未分组</span>}
              <span className="bt-col-count">{list.length}</span>
              <span className="spacer" />
              {!readOnly && (
                <>
                  <button className="icon-btn sm" title="新建记录" onClick={() => addCard(col.key)}>
                    <IconPlus width={15} height={15} />
                  </button>
                  {col.choice && (
                    <button className="icon-btn sm" title="更多" onClick={(e) => columnMenu(e.currentTarget, col.choice!)}>
                      <IconMore width={15} height={15} />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="bt-col-body">
              {shown.map((r) => (
                <div
                  key={r.id}
                  className={'bt-card' + (drag?.id === r.id ? ' dragging' : '') + (drag?.over === col.key && drag.before === r.id ? ' drop-before' : '')}
                  draggable={!readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', r.id)
                    setDrag({ id: r.id })
                  }}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => {
                    if (!drag || drag.id === r.id) return
                    e.preventDefault()
                    e.stopPropagation()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    const i = shown.indexOf(r)
                    const before = e.clientY < rect.top + rect.height / 2 ? r.id : list[i + 1]?.id
                    if (drag.over !== col.key || drag.before !== before) setDrag({ ...drag, over: col.key, before })
                  }}
                  onDrop={(e) => {
                    e.stopPropagation()
                    drop(e, col.key)
                  }}
                  onClick={() => onOpenRecord(r.id, allIds)}
                >
                  <div className={'bt-card-title' + (primary && displayText(primary, cellValue(r, primary)) ? '' : ' muted')}>{(primary && displayText(primary, cellValue(r, primary))) || '未命名记录'}</div>
                  {cardFields.map((f) => (
                    <CardLine key={f.id} field={f} rec={r} />
                  ))}
                </div>
              ))}
              {shown.length < list.length && (
                <LoadMore
                  key={shown.length}
                  rest={list.length - shown.length}
                  onLoad={() => setLimits((l) => ({ ...l, [col.key]: (l[col.key] ?? PAGE) + PAGE }))}
                />
              )}
              {!readOnly && shown.length === list.length && (
                <button className="bt-col-add" onClick={() => addCard(col.key)}>
                  <IconPlus width={14} height={14} /> 新建记录
                </button>
              )}
            </div>
          </div>
        )
      })}
      {!readOnly && (
        <button
          className="bt-col-new"
          onClick={async () => {
            const name = await promptText('新建分组', '', '分组名称')
            if (name) model.updateField(groupField.id, { options: { ...groupField.options, choices: [...choices, { id: newId(), name, color: choices.length % TAG_COLORS }] } })
          }}
        >
          <IconPlus width={15} height={15} /> 新建分组
        </button>
      )}
    </div>
  )
}

/** Placeholder at the end of a partly rendered column: loads the next page once it scrolls into view. */
function LoadMore({ rest, onLoad }: { rest: number; onLoad: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  const load = useRef(onLoad)
  load.current = onLoad
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    // implicit root: the visible part of the target, clipped by the column and page scrollers
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && load.current(), { rootMargin: '300px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <button ref={ref} className="bt-col-more" onClick={() => load.current()}>
      还有 {rest} 条记录，继续加载
    </button>
  )
}

function CardLine({ field, rec }: { field: Field; rec: Rec }) {
  if (isEmptyValue(cellValue(rec, field))) return null
  const content = ValueView({ field, rec })
  return (
    <div className="bt-card-line">
      <span className="bt-card-label">{field.name}</span>
      <span className="bt-card-value">{content}</span>
    </div>
  )
}
