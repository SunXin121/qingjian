import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type DataEditorRef,
  type EditableGridCell,
  type EditListItem,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridMouseEventArgs,
  type GridSelection,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { confirmDialog, openMenu, toast, type MenuItem } from '../components/dialog'
import { IconCopy, IconDown, IconEdit, IconEye, IconLink, IconLock, IconPlus, IconTrash, IconUp } from '../components/icons'
import { IconEyeOff, IconGroup } from './icons'
import { customRenderers, GRIP_W, type AddCell, type GroupCell, type IndexCell, type ValueCell } from './cells'
import { safeHref } from './editors'
import {
  cellMatches,
  cellValue,
  choiceCollector,
  displayText,
  groupKey,
  groupLabel,
  groupPaths,
  groupRows,
  parseText,
  searchNeedle,
  summarize,
  summaryKinds,
  viewRecords,
  visibleFields,
  type GridRow,
} from './engine'
import { openFieldEditor } from './FieldEditor'
import { choiceOps, orderIds, type CellChange, type TableModel } from './model'
import { palette, useGridTheme } from './theme'
import type { Field, FieldType, Rec, TableData, View } from './types'
import { isComputed } from './types'

// the overlay editor portal Glide expects at the document root
if (typeof document !== 'undefined' && !document.getElementById('portal')) {
  const p = document.createElement('div')
  p.id = 'portal'
  p.style.cssText = 'position:fixed;left:0;top:0;z-index:250'
  document.body.appendChild(p)
}

const ICONS: Record<FieldType, GridColumnIcon> = {
  text: GridColumnIcon.HeaderString,
  longtext: GridColumnIcon.HeaderTextTemplate,
  number: GridColumnIcon.HeaderNumber,
  select: GridColumnIcon.HeaderSingleValue,
  multiselect: GridColumnIcon.HeaderArray,
  date: GridColumnIcon.HeaderDate,
  checkbox: GridColumnIcon.HeaderBoolean,
  url: GridColumnIcon.HeaderUri,
  attachment: GridColumnIcon.HeaderImage,
  autonumber: GridColumnIcon.HeaderRowID,
  created_time: GridColumnIcon.HeaderTime,
  modified_time: GridColumnIcon.HeaderTime,
}

const narrow = () => typeof window !== 'undefined' && window.innerWidth < 600
const defaultWidth = (f: Field, primary: boolean) => (primary ? (narrow() ? 150 : 220) : f.type === 'checkbox' ? 90 : f.type === 'longtext' ? 240 : f.type === 'number' || f.type === 'autonumber' ? 120 : 160)

const INDEX_W = 52
const ROW_H = 34
const HEADER_H = 36

// fields our own type-to-edit box can handle (text parsed into the field's value)
const TYPEABLE = new Set<FieldType>(['text', 'longtext', 'number', 'url', 'date', 'select', 'multiselect'])

const cellSelection = (col: number, row: number): GridSelection => ({
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
  current: { cell: [col, row], range: { x: col, y: row, width: 1, height: 1 }, rangeStack: [] },
})

interface Props {
  model: TableModel
  table: TableData
  view: View
  readOnly: boolean
  onOpenRecord: (id: string, list: string[]) => void
  /** height of the grid area in px */
  height: number
  /** table search text and the index of the current match */
  search: string
  searchCursor: number
  onSearchCount: (n: number) => void
}

interface DropTarget {
  anchor: Rec
  place: 'before' | 'after'
  /** group values the record takes on in its new place */
  data: Record<string, any>
  /** gap index in the grid rows and its client y */
  gap: number
  y: number
}

export default function GridView({ model, table, view, readOnly, onOpenRecord, height, search, searchCursor, onSearchCount }: Props) {
  const theme = useGridTheme()
  const ref = useRef<DataEditorRef>(null)
  const cfg = view.config
  const fields = useMemo(() => visibleFields(table, view), [table, view])
  const records = useMemo(() => viewRecords(table, view, model.sticky), [table, view, model])
  const collapsed = useMemo(() => new Set(cfg.collapsed ?? []), [cfg.collapsed])
  const rows = useMemo(() => groupRows(table, records, cfg.groups ?? [], collapsed), [table, records, cfg.groups, collapsed])
  const ordinal = useMemo(() => new Map(records.map((r, i) => [r.id, i + 1])), [records])
  const recordIds = useMemo(() => records.map((r) => r.id), [records])
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
  const total = rows.length + 1 // trailing summary row
  const [dragId, setDragId] = useState<string | null>(null)

  // ---------- search ----------
  const needle = searchNeedle(search)
  const matches = useMemo(() => {
    const out: { rec: Rec; field: Field }[] = []
    if (needle) for (const r of records) for (const f of fields) if (cellMatches(f, r, needle)) out.push({ rec: r, field: f })
    return out
  }, [needle, records, fields])
  const matchKeys = useMemo(() => new Set(matches.map((m) => m.rec.id + ':' + m.field.id)), [matches])
  const current = matches.length ? matches[((searchCursor % matches.length) + matches.length) % matches.length] : undefined
  const currentKey = current ? current.rec.id + ':' + current.field.id : ''
  // layout effect: the toolbar count must not show a stale value for a frame
  useLayoutEffect(() => onSearchCount(matches.length), [matches.length, onSearchCount])

  useEffect(() => setLiveWidths({}), [cfg.widths])

  const columns: GridColumn[] = useMemo(
    () => [
      { id: '__idx', title: '', width: INDEX_W },
      ...fields.map((f, i) => ({
        id: f.id,
        title: f.name,
        width: liveWidths[f.id] ?? cfg.widths?.[f.id] ?? defaultWidth(f, i === 0),
        icon: ICONS[f.type],
        hasMenu: !readOnly,
      })),
    ],
    [fields, liveWidths, cfg.widths, readOnly],
  )
  const freeze = 1 + Math.max(0, Math.min(cfg.frozen ?? 1, fields.length))

  // summary row texts: computed once per data change, not on every repaint of the row
  const summaries = useMemo(
    () => fields.map((f, i) => summarize(f, cfg.summary?.[f.id] ?? (i === 0 ? 'count' : 'none'), records)),
    [fields, records, cfg.summary],
  )

  const fieldAt = (col: number): Field | undefined => fields[col - 1]
  const rowAt = (row: number): GridRow | undefined => rows[row]
  const recAt = (row: number): Rec | undefined => {
    const r = rows[row]
    return r?.kind === 'record' ? r.rec : undefined
  }

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const empty: GridCell = { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false, readonly: true }
      if (row >= rows.length) {
        // summary row
        const foot = { bgCell: palette.footBg }
        if (col === 0)
          return readOnly ? { ...empty, themeOverride: foot } : ({ kind: GridCellKind.Custom, data: { kind: 'qj-add' }, copyData: '', allowOverlay: false, cursor: 'pointer', themeOverride: foot } as AddCell)
        const text = summaries[col - 1] ?? ''
        return { ...empty, displayData: text, data: text, contentAlign: 'right', themeOverride: { ...foot, textDark: theme.textLight } }
      }
      const item = rowAt(row)!
      if (item.kind === 'group') {
        if (col === 1) {
          const f = item.field
          const color = f.type === 'select' ? f.options.choices?.find((c) => c.id === item.key)?.color : undefined
          return {
            kind: GridCellKind.Custom,
            data: { kind: 'qj-group', label: groupLabel(f, item.key), count: item.count, depth: item.depth, collapsed: item.collapsed, color },
            copyData: groupLabel(f, item.key),
            allowOverlay: false,
            readonly: true,
            cursor: 'pointer',
          } as GroupCell
        }
        return empty
      }
      const rec = item.rec
      if (col === 0)
        return { kind: GridCellKind.Custom, data: { kind: 'qj-index', n: ordinal.get(rec.id) ?? 0, grip: !readOnly }, copyData: '', allowOverlay: false, readonly: true, cursor: 'pointer' } as IndexCell
      const f = fieldAt(col)
      if (!f) return empty
      const cell = makeCell(model, f, rec, readOnly)
      const key = rec.id + ':' + f.id
      if (!matchKeys.has(key)) return cell
      return { ...cell, themeOverride: { ...cell.themeOverride, bgCell: key === currentKey ? palette.searchCurrent : palette.searchHit } } as GridCell
    },
    [rows, fields, ordinal, summaries, readOnly, model, theme.textLight, matchKeys, currentKey],
  )

  const getRowThemeOverride = useCallback(
    (row: number) => {
      // the summary row is styled per cell: glide also uses this index for blank space
      const item = rows[row]
      if (item?.kind === 'group') return { bgCell: palette.groupBg }
      if (item?.kind === 'record' && item.rec.id === dragId) return { bgCell: palette.groupBg, textDark: palette.muted }
      return undefined
    },
    [rows, dragId],
  )

  // ---------- editing ----------

  const valueFromCell = (f: Field, cell: EditableGridCell | GridCell): any => {
    switch (cell.kind) {
      case GridCellKind.Text:
        return f.type === 'longtext' ? cell.data : parseText(f, cell.data, choiceCollector([f]).resolve)
      case GridCellKind.Number:
        return cell.data
      case GridCellKind.Boolean:
        return cell.data === true
      case GridCellKind.Uri:
        return cell.data.trim()
      case GridCellKind.Custom:
        return (cell.data as any).value
    }
    return undefined
  }

  const onCellsEdited = useCallback(
    (items: readonly EditListItem[]) => {
      if (readOnly) return true
      const changes: CellChange[] = []
      for (const { location, value } of items) {
        const rec = recAt(location[1])
        const f = fieldAt(location[0])
        if (!rec || !f || isComputed(f.type)) continue
        changes.push({ rec: rec.id, field: f.id, value: valueFromCell(f, value) })
      }
      model.setCells(changes)
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fields, model, readOnly],
  )

  const onPaste = useCallback(
    (target: Item, values: readonly (readonly string[])[]) => {
      if (readOnly) return false
      const [col0, row0] = target
      const targetRecs = rows.slice(row0).filter((r) => r.kind === 'record') as Extract<GridRow, { kind: 'record' }>[]
      const col = choiceCollector(table.fields)
      const changes: CellChange[] = []
      const newRows: Record<string, any>[] = []
      values.forEach((line, i) => {
        const rec = targetRecs[i]?.rec
        const data: Record<string, any> = {}
        line.forEach((text, j) => {
          const f = fieldAt(col0 + j)
          if (!f || isComputed(f.type) || f.type === 'attachment') return
          const v = parseText(f, text, col.resolve)
          if (rec) changes.push({ rec: rec.id, field: f.id, value: v })
          else data[f.id] = v
        })
        if (!rec) newRows.push(data)
      })
      const [fwd, inv] = choiceOps(model, col.added)
      model.transact(() => {
        model.setCells(changes, fwd, inv)
        if (newRows.length) model.addRecords(newRows)
      })
      return false
    },
    [rows, fields, table.fields, model, readOnly],
  )

  /** Every (record, field) pair covered by the selection. */
  const selectedCells = (sel: GridSelection): { rec: Rec; field: Field }[] => {
    const out: { rec: Rec; field: Field }[] = []
    const seen = new Set<string>()
    const add = (row: number, col: number) => {
      const rec = recAt(row)
      const f = fieldAt(col)
      if (!rec || !f) return
      const k = rec.id + ':' + f.id
      if (seen.has(k)) return
      seen.add(k)
      out.push({ rec, field: f })
    }
    const ranges: Rectangle[] = sel.current ? [sel.current.range, ...sel.current.rangeStack] : []
    for (const r of ranges) for (let y = r.y; y < r.y + r.height; y++) for (let x = Math.max(1, r.x); x < r.x + r.width; x++) add(y, x)
    for (const row of sel.rows) for (let x = 1; x <= fields.length; x++) add(row, x)
    for (const c of sel.columns) for (let y = 0; y < rows.length; y++) add(y, c)
    return out
  }

  const selectedRecordIds = (sel: GridSelection, fallbackRow?: number): string[] => {
    const ids = new Set<string>()
    const ranges: Rectangle[] = sel.current ? [sel.current.range, ...sel.current.rangeStack] : []
    for (const r of ranges) for (let y = r.y; y < r.y + r.height; y++) recAt(y) && ids.add(recAt(y)!.id)
    for (const row of sel.rows) recAt(row) && ids.add(recAt(row)!.id)
    if (fallbackRow !== undefined && recAt(fallbackRow) && !ids.has(recAt(fallbackRow)!.id)) return [recAt(fallbackRow)!.id]
    return [...ids]
  }

  const onDelete = useCallback(
    (sel: GridSelection) => {
      if (readOnly) return false
      model.setCells(selectedCells(sel).filter((c) => !isComputed(c.field.type)).map((c) => ({ rec: c.rec.id, field: c.field.id, value: undefined })))
      return false
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fields, model, readOnly],
  )

  // ---------- rows ----------

  /** Values inherited by a record inserted next to `rec` (its group values). */
  const groupValues = (rec?: Rec) => {
    const data: Record<string, any> = {}
    if (!rec) return data
    for (const g of cfg.groups ?? []) {
      const f = model.field(g.field)
      if (f && !isComputed(f.type)) data[f.id] = cellValue(rec, f)
    }
    return data
  }

  const insertRecord = (near?: Rec, above = false) => {
    const recs = model.state.records
    let after = near?.id
    if (near && above) {
      const i = recs.findIndex((r) => r.id === near.id)
      after = i > 0 ? recs[i - 1].id : undefined
      if (i === 0) {
        // insert before the very first record
        const id = model.addRecords([groupValues(near)])[0]
        model.moveRecord(id, near.sort - 1)
        return id
      }
    }
    const [id] = model.addRecords([groupValues(near)], after)
    return id
  }

  const addAndFocus = (near?: Rec, above = false) => {
    const id = insertRecord(near, above)
    requestAnimationFrame(() => {
      const row = rowsRef.current.findIndex((r) => r.kind === 'record' && r.rec.id === id)
      if (row >= 0) {
        ref.current?.scrollTo(1, row)
        setSelection(cellSelection(1, row))
      }
    })
  }
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // jump to the current search match, expanding the groups it is collapsed in
  const jumpRef = useRef('')
  useEffect(() => {
    jumpRef.current = currentKey
  }, [currentKey])
  useEffect(() => {
    if (!current || jumpRef.current !== currentKey) return
    const row = rows.findIndex((r) => r.kind === 'record' && r.rec.id === current.rec.id)
    const col = fields.findIndex((f) => f.id === current.field.id) + 1
    if (col < 1) return
    if (row < 0) {
      const paths = new Set(groupPaths(table, current.rec, cfg.groups ?? []))
      const still = (cfg.collapsed ?? []).filter((p) => !paths.has(p))
      if (still.length !== (cfg.collapsed ?? []).length) model.updateView(view.id, { collapsed: still })
      else jumpRef.current = ''
      return
    }
    jumpRef.current = ''
    ref.current?.scrollTo(col, row, 'both', 0, 0, { vAlign: 'center' })
    setSelection(cellSelection(col, row))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, rows])

  const toggleGroup = (path: string) => {
    const s = new Set(collapsed)
    s.has(path) ? s.delete(path) : s.add(path)
    model.updateView(view.id, { collapsed: [...s] })
  }

  const onCellClicked = useCallback(
    ([col, row]: Item, e: { isDoubleClick?: boolean; bounds: Rectangle; localEventX: number }) => {
      if (row >= rows.length) {
        if (col === 0 && !readOnly) addAndFocus(records.at(-1))
        else if (col >= 1 && !readOnly) {
          const f = fieldAt(col)!
          const cur = cfg.summary?.[f.id] ?? (col === 1 ? 'count' : 'none')
          openMenu(
            { left: e.bounds.x, right: e.bounds.x + e.bounds.width, top: e.bounds.y, bottom: e.bounds.y + e.bounds.height },
            summaryKinds(f.type).map((k) => ({ label: k.label, checked: k.kind === cur, onClick: () => model.updateView(view.id, { summary: { ...cfg.summary, [f.id]: k.kind } }) })),
            { align: 'left', width: 160 },
          )
        }
        return
      }
      const item = rows[row]
      if (item?.kind === 'group' && col <= 1) toggleGroup(item.path)
      else if (item?.kind === 'record' && col === 0) onOpenRecord(item.rec.id, recordIds)
      else if (item?.kind === 'record' && e.isDoubleClick) {
        const f = fieldAt(col)
        if (f && isComputed(f.type)) onOpenRecord(item.rec.id, recordIds)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, records, fields, cfg.summary, readOnly, recordIds, collapsed],
  )

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      const rec = recAt(row)
      if (rec && col === 0) onOpenRecord(rec.id, recordIds)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, recordIds],
  )

  const onCellContextMenu = useCallback(
    ([col, row]: Item, e: { bounds: Rectangle; localEventX: number; localEventY: number; preventDefault: () => void }) => {
      e.preventDefault()
      const rec = recAt(row)
      if (!rec) return
      const ids = selectedRecordIds(selection, row)
      const at = { left: e.bounds.x + e.localEventX, right: e.bounds.x + e.localEventX, top: e.bounds.y + e.localEventY, bottom: e.bounds.y + e.localEventY }
      const f = fieldAt(col)
      const items: MenuItem[] = [
        { label: '展开记录', icon: <IconEye />, onClick: () => onOpenRecord(rec.id, recordIds) },
        { label: '在上方插入记录', icon: <IconUp />, hidden: readOnly, onClick: () => addAndFocus(rec, true) },
        { label: '在下方插入记录', icon: <IconDown />, hidden: readOnly, onClick: () => addAndFocus(rec) },
        {
          label: '复制记录',
          icon: <IconCopy />,
          hidden: readOnly,
          onClick: () => model.addRecords([JSON.parse(JSON.stringify(rec.data))], rec.id),
        },
        {
          label: '打开链接',
          icon: <IconLink />,
          hidden: !(f?.type === 'url' && rec.data[f.id]),
          onClick: () => window.open(safeHref(rec.data[f!.id]), '_blank', 'noopener'),
        },
        {
          label: ids.length > 1 ? `删除 ${ids.length} 条记录` : '删除记录',
          icon: <IconTrash />,
          danger: true,
          divider: true,
          hidden: readOnly,
          onClick: async () => {
            if (ids.length > 1 && !(await confirmDialog(`确定删除选中的 ${ids.length} 条记录吗？可用 Ctrl+Z 撤销。`, { danger: true, okText: '删除' }))) return
            model.deleteRecords(ids)
            setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
          },
        },
      ]
      openMenu(at, items, { align: 'left' })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fields, selection, readOnly, recordIds],
  )

  // ---------- row drag ----------
  // Rows are dragged by the handle at the left of the index cell. Glide's own row moving
  // needs its row-marker column, so the drag is tracked here: the pointer y maps to a row
  // (fixed row height), a line marks the drop gap and the grid auto-scrolls near its edges.
  const wrapRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)

  /** Client y range of the scrolling record rows (between header and summary row). */
  const bodyRange = () => {
    const g = ref.current
    const head = g?.getBounds(0, -1)
    const foot = g?.getBounds(0, rowsRef.current.length)
    const top = head ? head.y + head.height : (wrapRef.current?.getBoundingClientRect().top ?? 0) + HEADER_H
    return { top, bottom: foot ? foot.y : top + height }
  }

  const dropTarget = (clientY: number, rec: Rec): DropTarget | null => {
    const b0 = ref.current?.getBounds(0, 0)
    if (!b0) return null
    const rs = rowsRef.current
    const { top, bottom } = bodyRange()
    const pos = (Math.max(top, Math.min(bottom - 1, clientY)) - b0.y) / ROW_H
    const r = Math.floor(pos)
    const gap = r >= rs.length ? rs.length : Math.max(0, pos - r < 0.5 ? r : r + 1)
    const above = rs[gap - 1]
    const below = rs[gap]
    const [anchor, place]: [Rec, 'before' | 'after'] | [undefined, undefined] =
      above?.kind === 'record' ? [above.rec, 'after'] : below?.kind === 'record' ? [below.rec, 'before'] : [undefined, undefined]
    if (!anchor) return null
    const data: Record<string, any> = {}
    for (const g of cfg.groups ?? []) {
      const f = model.field(g.field)
      if (!f) continue
      const v = cellValue(anchor, f)
      if (groupKey(f, v) === groupKey(f, cellValue(rec, f))) continue
      // computed values (created time…) cannot follow the record into another group
      if (isComputed(f.type)) return null
      data[f.id] = v ?? null
    }
    const from = rs.findIndex((x) => x.kind === 'record' && x.rec.id === rec.id)
    if (anchor.id === rec.id || (!Object.keys(data).length && (gap === from || gap === from + 1))) return null
    return { anchor, place, data, gap, y: b0.y + gap * ROW_H }
  }

  const startRowDrag = (rec: Rec, x0: number, y0: number) => {
    const scroller = wrapRef.current?.querySelector<HTMLElement>('.dvn-scroller')
    const primary = fields[0]
    let active = false
    let lastX = x0
    let lastY = y0
    let target: DropTarget | null = null
    let raf = 0
    const paint = () => {
      const wrap = wrapRef.current
      const line = lineRef.current
      const ghost = ghostRef.current
      if (!wrap || !line || !ghost) return
      target = dropTarget(lastY, rec)
      const wr = wrap.getBoundingClientRect()
      line.style.display = target ? 'block' : 'none'
      if (target) line.style.top = `${target.y - wr.top - 1}px`
      ghost.style.transform = `translate(${lastX - wr.left + 14}px, ${lastY - wr.top - 14}px)`
    }
    const tick = () => {
      // auto-scroll while the pointer is near the top / bottom edge
      const { top, bottom } = bodyRange()
      const edge = 36
      const dy = lastY < top + edge ? -(top + edge - lastY) : lastY > bottom - edge ? lastY - bottom + edge : 0
      if (dy && scroller) {
        scroller.scrollTop += Math.max(-24, Math.min(24, Math.round(dy / 3)))
        paint()
      }
      raf = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent) => {
      lastX = e.clientX
      lastY = e.clientY
      if (!active) {
        if (Math.abs(lastX - x0) < 4 && Math.abs(lastY - y0) < 4) return
        active = true
        setDragId(rec.id)
        if (ghostRef.current) {
          ghostRef.current.textContent = (primary && displayText(primary, cellValue(rec, primary))) || '未命名记录'
          ghostRef.current.style.display = 'block'
        }
        document.body.classList.add('bt-row-dragging')
        raf = requestAnimationFrame(tick)
      }
      paint()
    }
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      document.body.classList.remove('bt-row-dragging')
      if (lineRef.current) lineRef.current.style.display = 'none'
      if (ghostRef.current) ghostRef.current.style.display = 'none'
      // the grid never saw the pointerdown; keep the click that follows from reaching it
      const stop = (ev: Event) => {
        ev.stopPropagation()
        ev.preventDefault()
      }
      window.addEventListener('click', stop, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
      if (!active) {
        onOpenRecord(rec.id, recordIds)
        return
      }
      setDragId(null)
      if (commit && target) model.reorderRecord(rec.id, target.anchor.id, target.place, target.data)
    }
    const up = () => end(true)
    const cancel = () => end(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      end(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }

  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (readOnly || e.button !== 0 || typing.current) return
    if ((e.target as Element).closest('.bt-insert')) return
    const b0 = ref.current?.getBounds(0, 0)
    if (!b0 || e.clientX < b0.x || e.clientX > b0.x + GRIP_W) return
    const { top, bottom } = bodyRange()
    if (e.clientY < top || e.clientY >= bottom) return
    const item = rowsRef.current[Math.floor((e.clientY - b0.y) / ROW_H)]
    if (item?.kind !== 'record') return
    e.preventDefault()
    e.stopPropagation()
    if (cfg.sorts?.length) {
      toast('视图已设置排序，无法拖动调整顺序')
      return
    }
    startRowDrag(item.rec, e.clientX, e.clientY)
  }

  // ---------- hover insert buttons ----------
  // Hovering a row's index cell shows a "+" on its top or bottom edge (insert above / below);
  // hovering a column header shows one on its right edge (insert a field there). The grid
  // is a canvas, so the buttons are DOM elements placed over it.
  type Hover = { kind: 'row'; row: number; above: boolean } | { kind: 'col'; col: number }
  const [hover, setHover] = useState<Hover | null>(null)
  const [insertHot, setInsertHot] = useState(false)
  const hideTimer = useRef(0)
  const keepHover = () => clearTimeout(hideTimer.current)
  const hideHover = (delay = 150) => {
    clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      setHover(null)
      setInsertHot(false)
    }, delay)
  }
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const onMouseMove = useCallback(
    (a: GridMouseEventArgs) => {
      if (readOnly || a.buttons) return
      let next: Hover | null = null
      if (a.kind === 'cell' && a.location[0] === 0 && rowsRef.current[a.location[1]]?.kind === 'record') {
        next = { kind: 'row', row: a.location[1], above: a.localEventY < a.bounds.height / 2 }
      } else if (a.kind === 'header' && a.location[0] >= 1) {
        next = { kind: 'col', col: a.location[0] }
      }
      if (!next) return hideHover()
      keepHover()
      const n = next
      setHover((h) =>
        h && h.kind === n.kind && (h.kind === 'row' ? n.kind === 'row' && h.row === n.row && h.above === n.above : n.kind === 'col' && h.col === n.col) ? h : n,
      )
    },
    [readOnly],
  )

  /** Button position (relative to the grid wrapper) and the insertion line it previews. */
  const insertSpot = (): { x: number; y: number; line: React.CSSProperties } | null => {
    const g = ref.current
    const wrap = wrapRef.current
    if (!hover || !g || !wrap || dragId) return null
    const wr = wrap.getBoundingClientRect()
    if (hover.kind === 'row') {
      const b = g.getBounds(0, hover.row)
      if (!b) return null
      const y = hover.above ? b.y : b.y + b.height
      const { top, bottom } = bodyRange()
      if (y < top - 1 || y > bottom + 1) return null
      return { x: b.x - wr.left + GRIP_W / 2 + 1, y: y - wr.top, line: { left: 0, right: 0, top: y - wr.top - 1, height: 2 } }
    }
    const b = g.getBounds(hover.col, -1)
    if (!b) return null
    const x = b.x + b.width
    if (x > wr.right - 4) return null
    const foot = g.getBounds(0, rowsRef.current.length)
    const bottom = foot ? foot.y + foot.height : wr.bottom
    return { x: x - wr.left, y: b.y - wr.top + 10, line: { top: b.y - wr.top, height: bottom - b.y, left: x - wr.left - 1, width: 2 } }
  }

  const onInsertClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const h = hover
    setHover(null)
    setInsertHot(false)
    if (!h) return
    if (h.kind === 'row') {
      const rec = recAt(h.row)
      if (!rec) return
      if (cfg.sorts?.length) toast('视图已设置排序，新记录会按排序规则显示')
      addAndFocus(rec, h.above)
      return
    }
    const f = fieldAt(h.col)
    if (!f) return
    const r = e.currentTarget.getBoundingClientRect()
    openFieldEditor({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }, model, { viewId: view.id, after: h.col === 1 ? undefined : f.id, first: h.col === 1 })
  }

  const spot = readOnly ? null : insertSpot()

  // ---------- columns ----------

  const fieldMenu = (col: number, bounds: Rectangle) => {
    const f = fieldAt(col)
    if (!f || readOnly) return
    const anchor = { left: bounds.x, right: bounds.x + bounds.width, top: bounds.y, bottom: bounds.y + bounds.height }
    const isPrimary = col === 1
    const order = orderIds(table, view)
    openMenu(
      anchor,
      [
        { label: '编辑字段', icon: <IconEdit />, onClick: () => openFieldEditor(anchor, model, { field: f }) },
        {
          label: '在右侧插入字段',
          icon: <IconPlus />,
          onClick: () => openFieldEditor(anchor, model, { viewId: view.id, after: isPrimary ? undefined : f.id, first: isPrimary }),
        },
        { label: '升序排列', icon: <IconUp />, divider: true, onClick: () => model.updateView(view.id, { sorts: [{ field: f.id }] }) },
        { label: '降序排列', icon: <IconDown />, onClick: () => model.updateView(view.id, { sorts: [{ field: f.id, desc: true }] }) },
        { label: '按此字段分组', icon: <IconGroup />, onClick: () => model.updateView(view.id, { groups: [{ field: f.id }], collapsed: [] }) },
        {
          label: col < freeze ? '取消冻结' : '冻结至此列',
          icon: <IconLock />,
          onClick: () => model.updateView(view.id, { frozen: col < freeze ? Math.max(0, col - 1) : col }),
        },
        {
          label: '隐藏字段',
          icon: <IconEyeOff />,
          hidden: isPrimary,
          onClick: () => model.updateView(view.id, { hidden: [...(cfg.hidden ?? []), f.id] }),
        },
        {
          label: '删除字段',
          icon: <IconTrash />,
          danger: true,
          divider: true,
          hidden: isPrimary,
          onClick: async () => {
            if (!(await confirmDialog(`确定删除字段「${f.name}」吗？该列的数据会一并删除，可用 Ctrl+Z 撤销。`, { danger: true, okText: '删除' }))) return
            model.deleteField(f.id)
            model.updateView(view.id, { order: order.filter((x) => x !== f.id) })
          },
        },
      ],
      { align: 'left', width: 180 },
    )
  }

  const onColumnMoved = useCallback(
    (from: number, to: number) => {
      // the index and primary columns stay put
      if (from <= 1 || to <= 1) return
      const ids = fields.slice(1).map((f) => f.id)
      const [moved] = ids.splice(from - 2, 1)
      ids.splice(to - 2, 0, moved)
      // keep hidden fields in their relative place
      const all = orderIds(table, view).filter((id) => !ids.includes(id))
      model.updateView(view.id, { order: [...ids, ...all] })
    },
    [fields, table, view, model],
  )

  const onColumnResize = useCallback((col: GridColumn, size: number) => {
    if (col.id && col.id !== '__idx') setLiveWidths((w) => ({ ...w, [col.id!]: size }))
  }, [])
  const onColumnResizeEnd = useCallback(
    (col: GridColumn, size: number) => {
      if (col.id && col.id !== '__idx') model.updateView(view.id, { widths: { ...cfg.widths, ...liveWidths, [col.id]: Math.round(size) } })
    },
    [model, view.id, cfg.widths, liveWidths],
  )

  // ---------- type-to-edit ----------
  // Glide does not start editing when typing into frozen columns, nor for IME input
  // (Chinese / Japanese), whose keydown reports "Process". A plain textarea placed over
  // the cell takes over in those cases; it is focused synchronously inside keydown so
  // the IME composition lands in it.
  const typeRef = useRef<HTMLTextAreaElement>(null)
  const typing = useRef<{ rec: string; field: string; col: number; row: number } | null>(null)

  const openTyping = (col: number, row: number, b: Rectangle, initial: string) => {
    const el = typeRef.current
    const rec = recAt(row)
    const f = fieldAt(col)
    if (!el || !rec || !f) return
    typing.current = { rec: rec.id, field: f.id, col, row }
    el.value = initial
    Object.assign(el.style, { display: 'block', left: `${b.x}px`, top: `${b.y}px`, width: `${Math.max(b.width, 180)}px`, minHeight: `${b.height}px`, height: `${b.height}px` })
    el.focus()
    el.setSelectionRange(initial.length, initial.length)
    growTyping()
  }
  const growTyping = () => {
    const el = typeRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight + 4, parseFloat(el.style.minHeight) || 0)}px`
  }
  const finishTyping = (commit: boolean, move?: [number, number]) => {
    const t = typing.current
    const el = typeRef.current
    if (!t || !el) return
    typing.current = null
    el.style.display = 'none'
    const f = model.field(t.field)
    if (commit && f) {
      const col = choiceCollector([f])
      const v = f.type === 'longtext' ? el.value : parseText(f, el.value, col.resolve)
      const [fwd, inv] = choiceOps(model, col.added)
      model.setCells([{ rec: t.rec, field: t.field, value: v }], fwd, inv)
    }
    ref.current?.focus()
    if (move) {
      const c = Math.max(1, Math.min(fields.length, t.col + move[0]))
      const r = Math.max(0, Math.min(rowsRef.current.length - 1, t.row + move[1]))
      setSelection(cellSelection(c, r))
    }
  }

  const onGridKeyDown = (e: GridKeyEventArgs) => {
    if (readOnly || e.ctrlKey || e.metaKey || e.altKey || !e.location || !e.bounds) return
    const [col, row] = e.location
    const rec = recAt(row)
    const f = fieldAt(col)
    if (!rec || !f || !TYPEABLE.has(f.type)) return
    const ime = e.key === 'Process' || e.keyCode === 229
    const frozen = col < freeze
    if (ime || (frozen && e.key.length === 1 && e.key !== ' ')) {
      e.cancel()
      if (!ime) e.preventDefault()
      openTyping(col, row, e.bounds, ime ? '' : e.key)
    } else if (frozen && e.key === 'Enter' && !e.shiftKey) {
      e.cancel()
      e.preventDefault()
      const v = cellValue(rec, f)
      openTyping(col, row, e.bounds, f.type === 'longtext' || f.type === 'text' || f.type === 'url' ? (v ?? '') : displayText(f, v))
    }
  }

  const rightElement = readOnly ? undefined : (
    <button
      className="bt-add-col"
      title="添加字段"
      onClick={(e) => openFieldEditor(e.currentTarget, model, { viewId: view.id, after: fields.at(-1)?.id })}
    >
      <IconPlus width={16} height={16} />
    </button>
  )

  return (
    <div className="bt-grid" ref={wrapRef} onContextMenu={(e) => e.preventDefault()} onPointerDownCapture={onPointerDownCapture} onMouseLeave={() => hideHover()}>
      <div ref={lineRef} className="bt-drop-line" style={{ left: INDEX_W }} />
      {spot && (
        <>
          {insertHot && <div className="bt-insert-line" style={spot.line} />}
          <button
            className="bt-insert"
            style={{ left: spot.x, top: spot.y }}
            title={hover?.kind === 'row' ? (hover.above ? '在上方插入记录' : '在下方插入记录') : '在右侧插入字段'}
            aria-label={hover?.kind === 'row' ? '插入记录' : '插入字段'}
            onMouseEnter={() => {
              keepHover()
              setInsertHot(true)
            }}
            onMouseLeave={() => {
              setInsertHot(false)
              hideHover()
            }}
            onClick={onInsertClick}
          >
            <IconPlus width={12} height={12} />
          </button>
        </>
      )}
      <div ref={ghostRef} className="bt-drag-ghost ellipsis" />
      <textarea
        ref={typeRef}
        className="bt-type-editor"
        rows={1}
        onInput={growTyping}
        onBlur={() => finishTyping(true)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          const f = typing.current && model.field(typing.current.field)
          if (e.key === 'Escape') {
            e.preventDefault()
            finishTyping(false)
          } else if (e.key === 'Enter' && !(e.shiftKey && f?.type === 'longtext')) {
            e.preventDefault()
            finishTyping(true, [0, e.shiftKey ? -1 : 1])
          } else if (e.key === 'Tab') {
            e.preventDefault()
            finishTyping(true, [e.shiftKey ? -1 : 1, 0])
          }
        }}
      />
      <DataEditor
        ref={ref}
        theme={theme}
        columns={columns}
        rows={total}
        width="100%"
        height={height}
        rowHeight={ROW_H}
        headerHeight={HEADER_H}
        freezeColumns={freeze}
        freezeTrailingRows={1}
        getCellContent={getCellContent}
        getRowThemeOverride={getRowThemeOverride}
        customRenderers={customRenderers}
        getCellsForSelection={true}
        onCellsEdited={onCellsEdited}
        onPaste={onPaste}
        onDelete={onDelete}
        fillHandle={!readOnly}
        rangeSelect="multi-rect"
        columnSelect="none"
        rowSelect="none"
        rowMarkers="none"
        smoothScrollX
        smoothScrollY
        editOnType={!readOnly}
        gridSelection={selection}
        onGridSelectionChange={setSelection}
        onCellClicked={onCellClicked}
        onCellActivated={onCellActivated}
        onCellContextMenu={onCellContextMenu}
        onKeyDown={onGridKeyDown}
        onMouseMove={onMouseMove}
        onVisibleRegionChanged={() => hover && setHover(null)}
        onHeaderMenuClick={fieldMenu}
        onHeaderContextMenu={(col, e) => {
          e.preventDefault()
          fieldMenu(col, e.bounds)
        }}
        onColumnMoved={readOnly ? undefined : onColumnMoved}
        onColumnResize={onColumnResize}
        onColumnResizeEnd={readOnly ? undefined : onColumnResizeEnd}
        minColumnWidth={60}
        maxColumnWidth={800}
        rightElement={rightElement}
        rightElementProps={{ fill: false, sticky: false }}
        scaleToRem={false}
        keybindings={{ search: false, downFill: true, rightFill: true, selectAll: true, copy: true, paste: !readOnly, cut: !readOnly, clear: !readOnly }}
        trapFocus={false}
      />
    </div>
  )
}

function makeCell(model: TableModel, f: Field, rec: Rec, readOnly: boolean): GridCell {
  const v = cellValue(rec, f)
  const ro = readOnly || isComputed(f.type)
  const text = displayText(f, v)
  switch (f.type) {
    case 'text':
    case 'longtext':
      return { kind: GridCellKind.Text, data: v ?? '', displayData: f.type === 'longtext' ? text.replace(/\s*\n\s*/g, ' ') : text, allowOverlay: true, readonly: ro }
    case 'autonumber':
    case 'created_time':
    case 'modified_time':
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, themeOverride: { textDark: palette.muted } }
    case 'checkbox':
      return { kind: GridCellKind.Boolean, data: !!v, allowOverlay: false, readonly: ro, copyData: v ? '✓' : '' } as GridCell
    case 'url':
      return {
        kind: GridCellKind.Uri,
        data: v ?? '',
        allowOverlay: !ro,
        readonly: ro,
        hoverEffect: true,
        onClickUri: (a) => {
          if (!v) return
          a.preventDefault()
          window.open(safeHref(v), '_blank', 'noopener')
        },
      } as GridCell
    default:
      return {
        kind: GridCellKind.Custom,
        data: { kind: 'qj-value', field: f, value: v, model },
        copyData: text,
        allowOverlay: !ro,
        readonly: ro,
      } as ValueCell
  }
}
