import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { confirmDialog, openMenu, openPopover, promptText, toast } from '../components/dialog'
import { IconCopy, IconEdit, IconPlus, IconTrash } from '../components/icons'
import { activeConds, viewRecords } from './engine'
import { IconBoard, IconEyeOff, IconFilter, IconGroup, IconGrid, IconRedo, IconSort, IconUndo } from './icons'
import KanbanView from './KanbanView'
import { useTable, type TableModel } from './model'
import RecordCard from './RecordCard'
import { FieldsPanel, FilterPanel, GroupPanel, KanbanPanel, SortPanel } from './ViewPanels'
import type { View, ViewType } from './types'

const GridView = lazy(() => import('./GridView'))

interface Props {
  model: TableModel
  readOnly: boolean
  viewId?: string
  onViewChange?: (id: string) => void
}

export const viewIcon = (t: ViewType) => (t === 'kanban' ? <IconBoard width={15} height={15} /> : <IconGrid width={15} height={15} />)

export default function TableView({ model, readOnly, viewId, onViewChange }: Props) {
  const table = useTable(model)
  const [localView, setLocalView] = useState<string | undefined>(viewId)
  const active: View = table.views.find((v) => v.id === (viewId ?? localView)) ?? table.views[0]
  const [card, setCard] = useState<{ id: string; list: string[] } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)

  const selectView = (id: string) => {
    setLocalView(id)
    onViewChange?.(id)
  }

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(Math.max(200, el.clientHeight)))
    ro.observe(el)
    setHeight(Math.max(200, el.clientHeight))
    return () => ro.disconnect()
  }, [active?.type])

  // undo / redo outside text inputs
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const t = e.target as HTMLElement
      if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        if (!model.undo()) toast('没有可撤销的操作')
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault()
        model.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model, readOnly])

  const openRecord = useCallback((id: string, list: string[]) => setCard({ id, list }), [])
  const closeCard = useCallback(() => setCard(null), [])
  const navCard = useCallback((id: string) => setCard((c) => (c ? { ...c, id } : c)), [])

  if (!active) return <div className="empty-state">表格没有视图</div>
  const cfg = active.config
  const nFilter = activeConds(table, active).length
  const nSort = cfg.sorts?.length ?? 0
  const nGroup = cfg.groups?.length ?? 0
  const nHidden = (cfg.hidden ?? []).filter((id) => table.fields.some((f, i) => i > 0 && f.id === id)).length
  const panel = (el: HTMLElement, render: () => React.ReactNode, width = 420) => openPopover(el, () => render(), { width, align: 'left' })

  const addView = (el: HTMLElement) =>
    openMenu(
      el,
      [
        { label: '表格视图', icon: <IconGrid />, onClick: () => selectView(model.addView(uniqueName(table.views, '表格视图'), 'grid')) },
        { label: '看板视图', icon: <IconBoard />, onClick: () => selectView(model.addView(uniqueName(table.views, '看板视图'), 'kanban')) },
      ],
      { align: 'left', width: 160 },
    )

  const viewMenu = (el: HTMLElement, v: View) =>
    openMenu(
      el,
      [
        {
          label: '重命名视图',
          icon: <IconEdit />,
          onClick: async () => {
            const name = await promptText('重命名视图', v.name)
            if (name) model.renameView(v.id, name)
          },
        },
        { label: '复制视图', icon: <IconCopy />, onClick: () => selectView(model.addView(uniqueName(table.views, v.name), v.type, JSON.parse(JSON.stringify(v.config)))) },
        {
          label: '删除视图',
          icon: <IconTrash />,
          danger: true,
          divider: true,
          hidden: table.views.length <= 1,
          onClick: async () => {
            if (!(await confirmDialog(`确定删除视图「${v.name}」吗？记录不会被删除。`, { danger: true, okText: '删除' }))) return
            model.deleteView(v.id)
            if (v.id === active.id) selectView(table.views.find((x) => x.id !== v.id)!.id)
          },
        },
      ],
      { align: 'left', width: 160 },
    )

  const addRecord = () => {
    const [id] = model.addRecords([{}])
    setCard({ id, list: [...viewRecords(model.state, active, model.sticky).map((r) => r.id)] })
  }

  return (
    <div className="bt">
      <div className="bt-tabs">
        {table.views.map((v) => (
          <button
            key={v.id}
            className={'bt-tab' + (v.id === active.id ? ' active' : '')}
            onClick={() => selectView(v.id)}
            onDoubleClick={async () => {
              if (readOnly) return
              const name = await promptText('重命名视图', v.name)
              if (name) model.renameView(v.id, name)
            }}
            onContextMenu={(e) => {
              if (readOnly) return
              e.preventDefault()
              viewMenu(e.currentTarget, v)
            }}
          >
            {viewIcon(v.type)}
            <span className="ellipsis">{v.name}</span>
            {!readOnly && v.id === active.id && (
              <span
                className="bt-tab-more"
                role="button"
                onClick={(e) => {
                  e.stopPropagation()
                  viewMenu(e.currentTarget.parentElement!, v)
                }}
              >
                ⋯
              </span>
            )}
          </button>
        ))}
        {!readOnly && (
          <button className="bt-tab add" title="添加视图" onClick={(e) => addView(e.currentTarget)}>
            <IconPlus width={15} height={15} />
          </button>
        )}
      </div>

      <div className="bt-toolbar">
        {!readOnly && (
          <button className="btn sm primary" onClick={addRecord}>
            <IconPlus width={14} height={14} /> 添加记录
          </button>
        )}
        <button className={'bt-tool' + (nHidden ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <FieldsPanel model={model} viewId={active.id} readOnly={readOnly} />, 340)}>
          <IconEyeOff width={15} height={15} /> <span className="bt-tool-label">{nHidden ? `${nHidden} 个隐藏字段` : '字段'}</span>
        </button>
        <button className={'bt-tool' + (nFilter ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <FilterPanel model={model} viewId={active.id} />, 560)}>
          <IconFilter width={15} height={15} /> <span className="bt-tool-label">{nFilter ? `${nFilter} 个筛选条件` : '筛选'}</span>
        </button>
        {active.type === 'grid' && (
          <button className={'bt-tool' + (nGroup ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <GroupPanel model={model} viewId={active.id} />)}>
            <IconGroup width={15} height={15} /> <span className="bt-tool-label">{nGroup ? `${nGroup} 级分组` : '分组'}</span>
          </button>
        )}
        {active.type === 'kanban' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <KanbanPanel model={model} viewId={active.id} />, 300)}>
            <IconBoard width={15} height={15} /> <span className="bt-tool-label">看板设置</span>
          </button>
        )}
        <button className={'bt-tool' + (nSort ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <SortPanel model={model} viewId={active.id} />)}>
          <IconSort width={15} height={15} /> <span className="bt-tool-label">{nSort ? `${nSort} 个排序` : '排序'}</span>
        </button>
        <span className="spacer" />
        {!readOnly && (
          <>
            <button className="icon-btn hide-mobile" title="撤销 (Ctrl+Z)" disabled={!model.canUndo} onClick={() => model.undo()}>
              <IconUndo width={16} height={16} />
            </button>
            <button className="icon-btn hide-mobile" title="重做 (Ctrl+Shift+Z)" disabled={!model.canRedo} onClick={() => model.redo()}>
              <IconRedo width={16} height={16} />
            </button>
          </>
        )}
      </div>

      <div className={'bt-body ' + active.type} ref={bodyRef}>
        {active.type === 'grid' ? (
          <Suspense fallback={<div className="ink-loading">加载中…</div>}>
            <GridView key={active.id} model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} height={height} />
          </Suspense>
        ) : (
          <KanbanView model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} />
        )}
      </div>

      {card && <RecordCard model={model} viewId={active.id} recordId={card.id} list={card.list} readOnly={readOnly} onNavigate={navCard} onClose={closeCard} />}
    </div>
  )
}

function uniqueName(views: View[], base: string) {
  const names = new Set(views.map((v) => v.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}
