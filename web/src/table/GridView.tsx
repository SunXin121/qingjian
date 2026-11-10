import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  type GridSelection,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid'
import '@glideapps/glide-data-grid/dist/index.css'
import { confirmDialog, openMenu, type MenuItem } from '../components/dialog'
import { IconCopy, IconDown, IconEdit, IconEye, IconLink, IconLock, IconPlus, IconTrash, IconUp } from '../components/icons'
import { IconEyeOff, IconGroup } from './icons'
import { customRenderers, type AddCell, type GroupCell, type IndexCell, type ValueCell } from './cells'
import { safeHref } from './editors'
import { cellValue, choiceCollector, displayText, groupLabel, groupRows, parseText, summarize, summaryKinds, viewRecords, visibleFields, type GridRow } from './engine'
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
}

export default function GridView({ model, table, view, readOnly, onOpenRecord, height }: Props) {
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
        const f = fieldAt(col)!
        const kind = cfg.summary?.[f.id] ?? (col === 1 ? 'count' : 'none')
        const text = summarize(f, kind, records)
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
      if (col === 0) return { kind: GridCellKind.Custom, data: { kind: 'qj-index', n: ordinal.get(rec.id) ?? 0 }, copyData: '', allowOverlay: false, readonly: true, cursor: 'pointer' } as IndexCell
      const f = fieldAt(col)
      if (!f) return empty
      return makeCell(model, f, rec, readOnly)
    },
    [rows, records, fields, ordinal, cfg.summary, readOnly, model, theme.textLight],
  )

  const getRowThemeOverride = useCallback(
    (row: number) => {
      // the summary row is styled per cell: glide also uses this index for blank space
      if (rows[row]?.kind === 'group') return { bgCell: palette.groupBg }
      return undefined
    },
    [rows],
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
    <div className="bt-grid" onContextMenu={(e) => e.preventDefault()}>
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
        rowHeight={34}
        headerHeight={36}
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
