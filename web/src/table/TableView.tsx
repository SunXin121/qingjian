import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { confirmDialog, openMenu, openPopover, toast } from '../components/dialog'
import { IconClose, IconCopy, IconDown, IconEdit, IconPlus, IconSearch, IconTrash, IconUp } from '../components/icons'
import { activeConds, viewRecords } from './engine'
import {
  IconBoard,
  IconCalendar,
  IconFields,
  IconFilter,
  IconGallery,
  IconGantt,
  IconGrid,
  IconGroup,
  IconRedo,
  IconRowHeight,
  IconSort,
  IconUndo,
} from './icons'
import KanbanView from './KanbanView'
import GalleryView from './GalleryView'
import CalendarView from './CalendarView'
import GanttView from './GanttView'
import { useTable, type TableModel } from './model'
import RecordCard from './RecordCard'
import { CalendarPanel, FieldsPanel, FilterPanel, GalleryPanel, GanttPanel, GroupPanel, KanbanPanel, SortPanel } from './ViewPanels'
import { ROW_HEIGHTS, rowHeightInfo, type View, type ViewType } from './types'

const GridView = lazy(() => import('./GridView'))

interface Props {
  model: TableModel
  readOnly: boolean
  viewId?: string
  onViewChange?: (id: string) => void
}

export const viewIcon = (t: ViewType) => (
  <span className={`bt-view-icon ${t}`}>
    {t === 'kanban' ? (
      <IconBoard width={15} height={15} />
    ) : t === 'gallery' ? (
      <IconGallery width={15} height={15} />
    ) : t === 'calendar' ? (
      <IconCalendar width={15} height={15} />
    ) : t === 'gantt' ? (
      <IconGantt width={15} height={15} />
    ) : (
      <IconGrid width={15} height={15} />
    )}
  </span>
)

export default function TableView({ model, readOnly, viewId, onViewChange }: Props) {
  const table = useTable(model)
  const [localView, setLocalView] = useState<string | undefined>(viewId)
  const active: View = table.views.find((v) => v.id === (viewId ?? localView)) ?? table.views[0]
  const [card, setCard] = useState<{ id: string; list: string[] } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)

  // inline rename & tab drag state
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [dragTab, setDragTab] = useState<{ id: string; over?: string; after?: boolean } | null>(null)

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
      if (document.querySelector('.bt-sheet, .modal-backdrop, [data-modal]')) return
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

  const shownCount = useMemo(() => (active ? viewRecords(table, active, model.sticky).length : 0), [table, active, model])

  if (!active) return <div className="empty-state">表格没有视图</div>
  const cfg = active.config
  const nFilter = activeConds(table, active).length
  const nSort = cfg.sorts?.length ?? 0
  const nGroup = cfg.groups?.length ?? 0
  const nHidden = (cfg.hidden ?? []).filter((id) => table.fields.some((f, i) => i > 0 && f.id === id)).length
  const rhInfo = rowHeightInfo(cfg.rowHeight)
  const panel = (el: HTMLElement, render: () => React.ReactNode, width = 420) => openPopover(el, () => render(), { width, align: 'left' })

  const startRename = (v: View) => {
    if (readOnly) return
    setRenamingId(v.id)
    setRenameText(v.name)
  }
  const commitRename = () => {
    if (!renamingId) return
    const next = renameText.trim()
    const v = table.views.find((x) => x.id === renamingId)
    setRenamingId(null)
    if (next && v && next !== v.name) model.renameView(v.id, next)
  }

  const dropViewTab = (targetId: string, after: boolean) => {
    if (!dragTab || dragTab.id === targetId) return setDragTab(null)
    const rest = table.views.filter((v) => v.id !== dragTab.id)
    const idx = rest.findIndex((v) => v.id === targetId)
    setDragTab(null)
    if (idx < 0) return
    const at = after ? idx + 1 : idx
    const lo = rest[at - 1]
    const hi = rest[at]
    let sort: number
    if (lo && hi) sort = (lo.sort + hi.sort) / 2
    else if (lo) sort = lo.sort + 1
    else if (hi) sort = hi.sort - 1
    else return
    model.moveView(dragTab.id, sort)
  }

  const addView = (el: HTMLElement) =>
    openMenu(
      el,
      [
        { label: '表格视图', icon: viewIcon('grid'), onClick: () => selectView(model.addView(uniqueName(table.views, '表格视图'), 'grid')) },
        { label: '看板视图', icon: viewIcon('kanban'), onClick: () => selectView(model.addView(uniqueName(table.views, '看板视图'), 'kanban')) },
        { label: '画册视图', icon: viewIcon('gallery'), onClick: () => selectView(model.addView(uniqueName(table.views, '画册视图'), 'gallery')) },
        { label: '日历视图', icon: viewIcon('calendar'), onClick: () => selectView(model.addView(uniqueName(table.views, '日历视图'), 'calendar')) },
        { label: '甘特视图', icon: viewIcon('gantt'), onClick: () => selectView(model.addView(uniqueName(table.views, '甘特视图'), 'gantt')) },
      ],
      { align: 'left', width: 176 },
    )

  const viewMenu = (el: HTMLElement, v: View) =>
    openMenu(
      el,
      [
        {
          label: '重命名视图',
          icon: <IconEdit />,
          onClick: () => startRename(v),
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
      { align: 'left', width: 168 },
    )

  const rowHeightMenu = (el: HTMLElement) =>
    openMenu(
      el,
      ROW_HEIGHTS.map((r) => ({
        label: `行高：${r.label}`,
        checked: r.value === rhInfo.value,
        onClick: () => model.updateView(active.id, { rowHeight: r.value === 'short' ? undefined : r.value }),
      })),
      { align: 'left', width: 148 },
    )

  const addRecord = () => {
    const [id] = model.addRecords([{}])
    setCard({ id, list: [...viewRecords(model.data, active, model.sticky).map((r) => r.id)] })
  }

  return (
    <div className="bt" ref={rootRef}>
      <div className="bt-tabs" role="tablist">
        {table.views.map((v) => {
          const isRenaming = renamingId === v.id
          const isOver = dragTab?.over === v.id && dragTab.id !== v.id
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={v.id === active.id}
              draggable={!readOnly && !isRenaming && table.views.length > 1}
              className={
                'bt-tab' +
                (v.id === active.id ? ' active' : '') +
                (dragTab?.id === v.id ? ' dragging' : '') +
                (isOver ? (dragTab.after ? ' drop-after' : ' drop-before') : '')
              }
              onClick={() => !isRenaming && selectView(v.id)}
              onDoubleClick={() => startRename(v)}
              onContextMenu={(e) => {
                if (readOnly) return
                e.preventDefault()
                viewMenu(e.currentTarget, v)
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                setDragTab({ id: v.id })
              }}
              onDragEnd={() => setDragTab(null)}
              onDragOver={(e) => {
                if (!dragTab || dragTab.id === v.id) return
                e.preventDefault()
                const r = e.currentTarget.getBoundingClientRect()
                const after = e.clientX > r.left + r.width / 2
                if (dragTab.over !== v.id || dragTab.after !== after) setDragTab({ ...dragTab, over: v.id, after })
              }}
              onDrop={(e) => {
                e.preventDefault()
                dropViewTab(v.id, !!dragTab?.after)
              }}
            >
              {viewIcon(v.type)}
              {isRenaming ? (
                <input
                  className="bt-tab-rename"
                  autoFocus
                  value={renameText}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setRenamingId(null)
                    }
                  }}
                />
              ) : (
                <span className="ellipsis">{v.name}</span>
              )}
              {!readOnly && v.id === active.id && !isRenaming && (
                <span
                  className="bt-tab-more"
                  role="button"
                  title="视图菜单"
                  onClick={(e) => {
                    e.stopPropagation()
                    viewMenu(e.currentTarget.parentElement!, v)
                  }}
                >
                  ▾
                </span>
              )}
            </button>
          )
        })}
        {!readOnly && (
          <button className="bt-tab add" title="新建视图" aria-label="新建视图" onClick={(e) => addView(e.currentTarget)}>
            <IconPlus width={14} height={14} />
            {table.views.length <= 1 && <span className="bt-tab-add-label">新建视图</span>}
          </button>
        )}
      </div>

      <div className="bt-toolbar">
        {!readOnly && (
          <>
            <button className="bt-btn-add" onClick={addRecord}>
              <IconPlus width={14} height={14} /> <span>添加记录</span>
            </button>
            <span className="bt-toolbar-sep" />
          </>
        )}
        <button className={'bt-tool' + (nHidden ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <FieldsPanel model={model} viewId={active.id} readOnly={readOnly} />, 352)}>
          <IconFields width={14} height={14} />
          <span className="bt-tool-label">字段配置</span>
          {nHidden > 0 && <span className="bt-tool-badge">{table.fields.length - nHidden}/{table.fields.length}</span>}
        </button>
        <button className={'bt-tool' + (nFilter ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <FilterPanel model={model} viewId={active.id} />, 580)}>
          <IconFilter width={14} height={14} />
          <span className="bt-tool-label">筛选</span>
          {nFilter > 0 && <span className="bt-tool-badge">{nFilter}</span>}
        </button>
        {(active.type === 'grid' || active.type === 'gantt') && (
          <button className={'bt-tool' + (nGroup ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <GroupPanel model={model} viewId={active.id} />)}>
            <IconGroup width={14} height={14} />
            <span className="bt-tool-label">分组</span>
            {nGroup > 0 && <span className="bt-tool-badge">{nGroup}</span>}
          </button>
        )}
        <button className={'bt-tool' + (nSort ? ' on' : '')} onClick={(e) => panel(e.currentTarget, () => <SortPanel model={model} viewId={active.id} />)}>
          <IconSort width={14} height={14} />
          <span className="bt-tool-label">排序</span>
          {nSort > 0 && <span className="bt-tool-badge">{nSort}</span>}
        </button>
        {active.type === 'grid' && !readOnly && (
          <button className={'bt-tool' + (rhInfo.value !== 'short' ? ' on' : '')} onClick={(e) => rowHeightMenu(e.currentTarget)}>
            <IconRowHeight width={14} height={14} />
            <span className="bt-tool-label">{rhInfo.value === 'short' ? '行高' : `行高·${rhInfo.label}`}</span>
          </button>
        )}
        {active.type === 'kanban' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <KanbanPanel model={model} viewId={active.id} />, 320)}>
            <IconBoard width={14} height={14} /> <span className="bt-tool-label">看板设置</span>
          </button>
        )}
        {active.type === 'gallery' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <GalleryPanel model={model} viewId={active.id} />, 320)}>
            <IconGallery width={14} height={14} /> <span className="bt-tool-label">画册设置</span>
          </button>
        )}
        {active.type === 'calendar' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <CalendarPanel model={model} viewId={active.id} />, 320)}>
            <IconCalendar width={14} height={14} /> <span className="bt-tool-label">日历设置</span>
          </button>
        )}
        {active.type === 'gantt' && (
          <button className="bt-tool" onClick={(e) => panel(e.currentTarget, () => <GanttPanel model={model} viewId={active.id} />, 340)}>
            <IconGantt width={14} height={14} /> <span className="bt-tool-label">甘特设置</span>
          </button>
        )}
        <span className="spacer" />
        <span className="bt-record-stat hide-mobile">
          {nFilter > 0 ? `${shownCount} / ${table.records.length} 条记录` : `共 ${table.records.length} 条记录`}
        </span>
        {searchOpen ? (
          <div className="bt-search">
            <IconSearch width={14} height={14} />
            <input
              ref={searchRef}
              value={query}
              placeholder={active.type === 'grid' ? '搜索单元格…' : '搜索记录…'}
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
                <button className="icon-btn sm" title="上一个 (Shift+Enter)" aria-label="上一个 (Shift+Enter)" disabled={!hits} onClick={() => step(-1)}>
                  <IconUp width={14} height={14} />
                </button>
                <button className="icon-btn sm" title="下一个 (Enter)" aria-label="下一个 (Enter)" disabled={!hits} onClick={() => step(1)}>
                  <IconDown width={14} height={14} />
                </button>
              </>
            )}
            <button className="icon-btn sm" title="关闭搜索 (Esc)" aria-label="关闭搜索 (Esc)" onClick={closeSearch}>
              <IconClose width={14} height={14} />
            </button>
          </div>
        ) : (
          <button className="bt-tool" title="搜索 (Ctrl+F)" aria-label="搜索 (Ctrl+F)" onClick={openSearch}>
            <IconSearch width={15} height={15} />
          </button>
        )}
        {!readOnly && (
          <>
            <span className="bt-toolbar-sep hide-mobile" />
            <button className="icon-btn sm hide-mobile" title="撤销 (Ctrl+Z)" aria-label="撤销 (Ctrl+Z)" disabled={!model.canUndo} onClick={() => model.undo()}>
              <IconUndo width={15} height={15} />
            </button>
            <button className="icon-btn sm hide-mobile" title="重做 (Ctrl+Shift+Z)" aria-label="重做 (Ctrl+Shift+Z)" disabled={!model.canRedo} onClick={() => model.redo()}>
              <IconRedo width={15} height={15} />
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
