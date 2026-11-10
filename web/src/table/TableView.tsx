import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { confirmDialog, openMenu, openPopover, promptText, toast } from '../components/dialog'
import { IconClose, IconCopy, IconDown, IconEdit, IconPlus, IconSearch, IconTrash, IconUp } from '../components/icons'
import { activeConds, viewRecords } from './engine'
import { IconBoard, IconCalendar, IconEyeOff, IconGantt, IconFilter, IconGallery, IconGroup, IconGrid, IconRedo, IconSort, IconUndo } from './icons'
import KanbanView from './KanbanView'
import GalleryView from './GalleryView'
import CalendarView from './CalendarView'
import GanttView from './GanttView'
import { useTable, type TableModel } from './model'
import RecordCard from './RecordCard'
import { CalendarPanel, FieldsPanel, FilterPanel, GalleryPanel, GanttPanel, GroupPanel, KanbanPanel, SortPanel } from './ViewPanels'
import type { View, ViewType } from './types'

const GridView = lazy(() => import('./GridView'))

interface Props {
  model: TableModel
  readOnly: boolean
  viewId?: string
  onViewChange?: (id: string) => void
}

export const viewIcon = (t: ViewType) =>
  t === 'kanban' ? (
    <IconBoard width={15} height={15} />
  ) : t === 'gallery' ? (
    <IconGallery width={15} height={15} />
  ) : t === 'calendar' ? (
    <IconCalendar width={15} height={15} />
  ) : t === 'gantt' ? (
    <IconGantt width={15} height={15} />
  ) : (
    <IconGrid width={15} height={15} />
  )

export default function TableView({ model, readOnly, viewId, onViewChange }: Props) {
  const table = useTable(model)
  const [localView, setLocalView] = useState<string | undefined>(viewId)
  const active: View = table.views.find((v) => v.id === (viewId ?? localView)) ?? table.views[0]
  const [card, setCard] = useState<{ id: string; list: string[] } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)
  // table search: grid highlights matching cells and steps through them, kanban filters cards
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // big tables: wait for a pause in typing instead of searching on every keystroke
  const [debounced, setDebounced] = useState('')
  const big = table.records.length > 3000
  useEffect(() => {
    if (!big) return setDebounced(query)
    const t = window.setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(t)
  }, [query, big])
  const search = useDeferredValue(big ? debounced : query)
  const [cursor, setCursor] = useState(0)
  const [hits, setHits] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const activeId = active?.id
  useEffect(() => setCursor(0), [search, activeId])

  const openSearch = () => {
    setSearchOpen(true)
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    })
  }
  const closeSearch = () => {
    setSearchOpen(false)
    setQuery('')
  }
  const step = (d: number) => hits && setCursor((c) => (((c + d) % hits) + hits) % hits)

  // Ctrl+F searches the table while focus is in it (or nowhere in particular)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') return
      const t = e.target as HTMLElement
      if (!(t === document.body || rootRef.current?.contains(t))) return
      if (document.querySelector('.bt-sheet, .modal-backdrop')) return
      e.preventDefault()
      openSearch()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        { label: '画册视图', icon: <IconGallery />, onClick: () => selectView(model.addView(uniqueName(table.views, '画册视图'), 'gallery')) },
        { label: '日历视图', icon: <IconCalendar />, onClick: () => selectView(model.addView(uniqueName(table.views, '日历视图'), 'calendar')) },
        { label: '甘特视图', icon: <IconGantt />, onClick: () => selectView(model.addView(uniqueName(table.views, '甘特视图'), 'gantt')) },
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
    setCard({ id, list: [...viewRecords(model.data, active, model.sticky).map((r) => r.id)] })
  }

  return (
    <div className="bt" ref={rootRef}>
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
        {(active.type === 'grid' || active.type === 'gantt') && (
          <button className={'bt-tool' + (nGroup ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <GroupPanel model={model} viewId={active.id} />)}>
            <IconGroup width={15} height={15} /> <span className="bt-tool-label">{nGroup ? `${nGroup} 级分组` : '分组'}</span>
          </button>
        )}
        {active.type === 'kanban' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <KanbanPanel model={model} viewId={active.id} />, 300)}>
            <IconBoard width={15} height={15} /> <span className="bt-tool-label">看板设置</span>
          </button>
        )}
        {active.type === 'gallery' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <GalleryPanel model={model} viewId={active.id} />, 300)}>
            <IconGallery width={15} height={15} /> <span className="bt-tool-label">画册设置</span>
          </button>
        )}
        {active.type === 'calendar' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <CalendarPanel model={model} viewId={active.id} />, 300)}>
            <IconCalendar width={15} height={15} /> <span className="bt-tool-label">日历设置</span>
          </button>
        )}
        {active.type === 'gantt' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <GanttPanel model={model} viewId={active.id} />, 320)}>
            <IconGantt width={15} height={15} /> <span className="bt-tool-label">甘特设置</span>
          </button>
        )}
        <button className={'bt-tool' + (nSort ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <SortPanel model={model} viewId={active.id} />)}>
          <IconSort width={15} height={15} /> <span className="bt-tool-label">{nSort ? `${nSort} 个排序` : '排序'}</span>
        </button>
        <span className="spacer" />
        {searchOpen ? (
          <div className="bt-search">
            <IconSearch width={14} height={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder={active.type === 'grid' ? '搜索单元格' : '搜索记录'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeSearch()
                }
              }}
            />
            {search.trim() && (
              <span className="bt-search-count">{!hits ? '无结果' : active.type === 'grid' ? `${Math.min(cursor, hits - 1) + 1}/${hits}` : `${hits} 条`}</span>
            )}
            {active.type === 'grid' && (
              <>
                <button className="icon-btn sm" title="上一个 (Shift+Enter)" disabled={!hits} onClick={() => step(-1)}>
                  <IconUp width={14} height={14} />
                </button>
                <button className="icon-btn sm" title="下一个 (Enter)" disabled={!hits} onClick={() => step(1)}>
                  <IconDown width={14} height={14} />
                </button>
              </>
            )}
            <button className="icon-btn sm" title="关闭搜索 (Esc)" onClick={closeSearch}>
              <IconClose width={14} height={14} />
            </button>
          </div>
        ) : (
          <button className="bt-tool" title="搜索 (Ctrl+F)" onClick={openSearch}>
            <IconSearch width={15} height={15} />
          </button>
        )}
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
            <GridView
              key={active.id}
              model={model}
              table={table}
              view={active}
              readOnly={readOnly}
              onOpenRecord={openRecord}
              height={height}
              search={search}
              searchCursor={cursor}
              onSearchCount={setHits}
            />
          </Suspense>
        ) : active.type === 'gallery' ? (
          <GalleryView model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} search={search} onSearchCount={setHits} />
        ) : active.type === 'gantt' ? (
          <GanttView model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} search={search} onSearchCount={setHits} />
        ) : active.type === 'calendar' ? (
          <CalendarView model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} search={search} onSearchCount={setHits} />
        ) : (
          <KanbanView model={model} table={table} view={active} readOnly={readOnly} onOpenRecord={openRecord} search={search} onSearchCount={setHits} />
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
