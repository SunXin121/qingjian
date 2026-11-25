import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type DrawHeaderCallback,
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
import { confirmDialog, openMenu, openPopover, toast, type MenuItem } from '../components/dialog'
import { IconClose, IconCopy, IconDown, IconEdit, IconEye, IconLink, IconLock, IconPlus, IconTrash, IconUp } from '../components/icons'
import { FIELD_SPRITE, FieldTypeIcon, HEADER_SPRITES, IconEyeOff, IconFilter, IconGroup } from './icons'
import {
  CHECK_END,
  customRenderers,
  drawCheckboxBox,
  GRIP_W,
  INDEX_W,
  onThumbLoaded,
  type AddRowCell,
  type GroupCell,
  type IndexCell,
  type SummaryCell,
  type ValueCell,
} from './cells'
import { openDatePopover } from './DatePicker'
import { FieldInput, safeHref } from './editors'
import {
  activeConds,
  cellMatches,
  cellValue,
  choiceCollector,
  defaultCondValue,
  displayText,
  filterOps,
  groupKey,
  groupLabel,
  groupPaths,
  groupRows,
  parseText,
  ruleField,
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
import { baseField, isComputed, rowHeightInfo } from './types'

// the overlay editor portal Glide expects at the document root
if (typeof document !== 'undefined' && !document.getElementById('portal')) {
  const p = document.createElement('div')
  p.id = 'portal'
  p.style.cssText = 'position:fixed;left:0;top:0;z-index:250'
  document.body.appendChild(p)
}

const narrow = () => typeof window !== 'undefined' && window.innerWidth < 600
const defaultWidth = (f: Field, primary: boolean) =>
  primary
    ? narrow()
      ? 156
      : 224
    : f.type === 'checkbox'
      ? 92
      : f.type === 'longtext'
        ? 248
        : f.type === 'number' || f.type === 'autonumber' || f.type === 'rating'
          ? 124
          : f.type === 'progress'
            ? 156
            : f.type === 'attachment'
              ? 180
              : 164

const GROUP_ROW_H = 36
const ADD_ROW_H = 34
const SUMMARY_ROW_H = 34
const HEADER_H = 36

// fields our own type-to-edit box can handle (text parsed into the field's value)
const TYPEABLE = new Set<FieldType>(['text', 'longtext', 'number', 'url', 'date', 'select', 'multiselect', 'rating', 'progress', 'phone', 'email'])

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
  const recRowH = rowHeightInfo(cfg.rowHeight).px
  const fields = useMemo(() => visibleFields(table, view), [table, view])
  const records = useMemo(() => viewRecords(table, view, model.sticky), [table, view, model])
  const collapsed = useMemo(() => new Set(cfg.collapsed ?? []), [cfg.collapsed])
  const rows = useMemo(() => groupRows(table, records, cfg.groups ?? [], collapsed), [table, records, cfg.groups, collapsed])
  const ordinal = useMemo(() => new Map(records.map((r, i) => [r.id, i + 1])), [records])
  const recordIds = useMemo(() => records.map((r) => r.id), [records])
  const recordIdSet = useMemo(() => new Set(recordIds), [recordIds])

  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<GridSelection>({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
  const [dragId, setDragId] = useState<string | null>(null)
  const [hoveredRow, setHoveredRow] = useState<number>(-1)
  const prevHoverRef = useRef<number>(-1)
  const [checkedRaw, setCheckedRaw] = useState<Set<string>>(() => new Set())
  const lastCheckedIdRef = useRef<string | null>(null)

  const checkedSet = useMemo(() => {
    if (!checkedRaw.size) return checkedRaw
    const next = new Set<string>()
    for (const id of checkedRaw) if (recordIdSet.has(id)) next.add(id)
    return next
  }, [checkedRaw, recordIdSet])
  const checkedIds = useMemo(() => recordIds.filter((id) => checkedSet.has(id)), [recordIds, checkedSet])

  const hasAddRow = !readOnly
  const addRowIdx = hasAddRow ? rows.length : -1
  const summaryRowIdx = rows.length + (hasAddRow ? 1 : 0)
  const total = summaryRowIdx + 1

  // cumulative y offsets of rows 0..rows.length for exact variable-height drag-and-drop
  const rowOffsets = useMemo(() => {
    const out = new Array<number>(rows.length + 1)
    let y = 0
    for (let i = 0; i < rows.length; i++) {
      out[i] = y
      y += rows[i].kind === 'group' ? GROUP_ROW_H : recRowH
    }
    out[rows.length] = y
    return out
  }, [rows, recRowH])

  const getRowHeight = useCallback(
    (r: number) => {
      if (r === summaryRowIdx) return SUMMARY_ROW_H
      if (r === addRowIdx) return ADD_ROW_H
      return rows[r]?.kind === 'group' ? GROUP_ROW_H : recRowH
    },
    [rows, recRowH, addRowIdx, summaryRowIdx],
  )

  // repaint attachment cells when any thumbnail finishes decoding
  useEffect(() => {
    return onThumbLoaded(() => {
      const cells: { cell: Item }[] = []
      fields.forEach((f, fi) => {
        if (f.type !== 'attachment') return
        rows.forEach((r, ri) => {
          if (r.kind === 'record' && r.rec.data[f.id]?.length) cells.push({ cell: [fi + 1, ri] })
        })
      })
      if (cells.length) ref.current?.updateCells(cells)
    })
  }, [fields, rows])

  // repaint previous & current hovered row so full-row tint and index controls update immediately
  useEffect(() => {
    const prev = prevHoverRef.current
    prevHoverRef.current = hoveredRow
    const damage: { cell: Item }[] = []
    for (const r of [prev, hoveredRow]) {
      if (r >= 0 && r < total) {
        for (let c = 0; c <= fields.length; c++) damage.push({ cell: [c, r] })
      }
    }
    if (damage.length) ref.current?.updateCells(damage)
  }, [hoveredRow, fields.length, total])

  // Escape clears checked rows when no overlay/modal is open
  useEffect(() => {
    if (!checkedSet.size) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('.popover, .bt-sheet, .modal-backdrop, [data-modal]')) return
      if (typing.current) return
      setCheckedRaw(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [checkedSet.size])

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
  useLayoutEffect(() => onSearchCount(matches.length), [matches.length, onSearchCount])

  useEffect(() => setLiveWidths({}), [cfg.widths])

  // active sort & filter indicators per field
  const sortedMap = useMemo(() => {
    const m = new Map<string, 'asc' | 'desc'>()
    for (const s of cfg.sorts ?? []) if (s.field && s.expr === undefined) m.set(s.field, s.desc ? 'desc' : 'asc')
    return m
  }, [cfg.sorts])

  const filteredSet = useMemo(() => {
    const s = new Set<string>()
    for (const c of activeConds(table, view)) if (c.field) s.add(c.field)
    return s
  }, [table, view])

  const columns: GridColumn[] = useMemo(
    () => [
      { id: '__idx', title: '', width: INDEX_W },
      ...fields.map((f, i) => {
        const isSorted = sortedMap.has(f.id)
        const isFiltered = filteredSet.has(f.id)
        return {
          id: f.id,
          title: f.rt?.error ? `${f.name} ⚠` : f.name,
          width: liveWidths[f.id] ?? cfg.widths?.[f.id] ?? defaultWidth(f, i === 0),
          icon: FIELD_SPRITE[f.type],
          hasMenu: !readOnly,
          themeOverride: isSorted
            ? { bgHeader: palette.headerSortBg, textHeader: palette.accent, bgIconHeader: palette.accent }
            : isFiltered
              ? { bgHeader: palette.headerFilterBg }
              : undefined,
        }
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fields, liveWidths, cfg.widths, readOnly, sortedMap, filteredSet, theme],
  )
  const freeze = 1 + Math.max(0, Math.min(cfg.frozen ?? 1, fields.length))

  // summary row texts: computed once per data change
  const summaries = useMemo(
    () =>
      fields.map((f, i) => {
        const text = summarize(f, cfg.summary?.[f.id] ?? (i === 0 ? 'count' : 'none'), records)
        if (!text) return { label: '', value: '' }
        const sp = text.indexOf(' ')
        return sp > 0 ? { label: text.slice(0, sp), value: text.slice(sp + 1) } : { label: '', value: text }
      }),
    [fields, records, cfg.summary],
  )

  const fieldAt = (col: number): Field | undefined => fields[col - 1]
  const recAt = (row: number): Rec | undefined => {
    const r = rows[row]
    return r?.kind === 'record' ? r.rec : undefined
  }

  const drawHeader: DrawHeaderCallback = useCallback(
    (args, drawContent) => {
      const { ctx, columnIndex, rect, theme: hTheme, isHovered } = args
      const cy = rect.y + rect.height / 2
      if (columnIndex === 0) {
        if (!readOnly && records.length > 0 && (isHovered || checkedSet.size > 0)) {
          const allChecked = checkedSet.size >= records.length
          drawCheckboxBox(ctx, rect.x + 30, cy, allChecked, checkedSet.size > 0 && !allChecked, isHovered)
        } else {
          ctx.font = `${hTheme.markerFontStyle} ${hTheme.fontFamily}`
          ctx.fillStyle = hTheme.textLight
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          ctx.fillText('#', rect.x + rect.width / 2 - 2, cy)
          ctx.textAlign = 'start'
        }
        return
      }
      drawContent()
      const f = fields[columnIndex - 1]
      if (!f) return
      const sortDir = sortedMap.get(f.id)
      if (sortDir) {
        const ax = rect.x + rect.width - (isHovered && !readOnly ? 32 : 13)
        ctx.save()
        ctx.strokeStyle = palette.accent
        ctx.lineWidth = 1.6
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        if (sortDir === 'asc') {
          ctx.moveTo(ax, cy + 4)
          ctx.lineTo(ax, cy - 4)
          ctx.moveTo(ax - 3, cy - 1)
          ctx.lineTo(ax, cy - 4)
          ctx.lineTo(ax + 3, cy - 1)
        } else {
          ctx.moveTo(ax, cy - 4)
          ctx.lineTo(ax, cy + 4)
          ctx.moveTo(ax - 3, cy + 1)
          ctx.lineTo(ax, cy + 4)
          ctx.lineTo(ax + 3, cy + 1)
        }
        ctx.stroke()
        ctx.restore()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly, records.length, checkedSet.size, fields, sortedMap, theme],
  )

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const empty: GridCell = { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false, readonly: true }
      if (row === summaryRowIdx) {
        const foot = { bgCell: palette.footBg }
        if (col === 0) return { ...empty, themeOverride: foot }
        const sum = summaries[col - 1] ?? { label: '', value: '' }
        return {
          kind: GridCellKind.Custom,
          data: { kind: 'qj-summary', label: sum.label, value: sum.value, isPrimary: col === 1, editable: !readOnly },
          copyData: sum.label ? `${sum.label} ${sum.value}` : sum.value,
          allowOverlay: false,
          readonly: true,
          cursor: readOnly ? undefined : 'pointer',
          themeOverride: foot,
        } as SummaryCell
      }
      if (row === addRowIdx) {
        return {
          kind: GridCellKind.Custom,
          data: { kind: 'qj-add-row' },
          copyData: '',
          allowOverlay: false,
          readonly: true,
          cursor: 'pointer',
          span: [0, fields.length],
        } as AddRowCell
      }
      const item = rows[row]
      if (!item) return empty
      if (item.kind === 'group') {
        const f = item.field
        const color = f.type === 'select' ? f.options.choices?.find((c) => c.id === item.key)?.color : undefined
        return {
          kind: GridCellKind.Custom,
          data: {
            kind: 'qj-group',
            fieldName: f.name,
            label: groupLabel(f, item.key),
            count: item.count,
            depth: item.depth,
            collapsed: item.collapsed,
            color,
            canAdd: !readOnly && !isComputed(f.type),
          },
          copyData: groupLabel(f, item.key),
          allowOverlay: false,
          readonly: true,
          cursor: 'pointer',
          span: [0, fields.length],
        } as GroupCell
      }
      const rec = item.rec
      if (col === 0)
        return {
          kind: GridCellKind.Custom,
          data: {
            kind: 'qj-index',
            n: ordinal.get(rec.id) ?? 0,
            grip: !readOnly,
            checked: checkedSet.has(rec.id),
            anyChecked: checkedSet.size > 0,
            rowHovered: row === hoveredRow,
          },
          copyData: '',
          allowOverlay: false,
          readonly: true,
          cursor: 'pointer',
        } as IndexCell
      const f = fields[col - 1]
      if (!f) return empty
      const cell = makeCell(model, f, rec, readOnly, recRowH > 42)
      const key = rec.id + ':' + f.id
      if (!matchKeys.has(key)) return cell
      return { ...cell, themeOverride: { ...cell.themeOverride, bgCell: key === currentKey ? palette.searchCurrent : palette.searchHit } } as GridCell
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fields, ordinal, summaries, readOnly, model, matchKeys, currentKey, summaryRowIdx, addRowIdx, checkedSet, hoveredRow, recRowH, theme],
  )

  const getRowThemeOverride = useCallback(
    (row: number) => {
      if (row >= rows.length) return undefined
      const item = rows[row]
      if (item?.kind === 'group') return { bgCell: palette.groupBg }
      if (item?.kind === 'record') {
        if (item.rec.id === dragId) return { bgCell: palette.groupBg, textDark: palette.muted }
        if (checkedSet.has(item.rec.id)) return { bgCell: palette.rowSelected }
        if (row === hoveredRow) return { bgCell: palette.rowHover }
      }
      return undefined
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, dragId, checkedSet, hoveredRow, theme],
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
          const f = fields[col0 + j - 1]
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
    if (checkedIds.length > 0) {
      const fb = fallbackRow !== undefined ? recAt(fallbackRow)?.id : undefined
      if (!fb || checkedSet.has(fb)) return checkedIds
    }
    const ids = new Set<string>()
    const ranges: Rectangle[] = sel.current ? [sel.current.range, ...sel.current.rangeStack] : []
    for (const r of ranges) for (let y = r.y; y < r.y + r.height; y++) recAt(y) && ids.add(recAt(y)!.id)
    for (const row of sel.rows) recAt(row) && ids.add(recAt(row)!.id)
    if (fallbackRow !== undefined && recAt(fallbackRow) && !ids.has(recAt(fallbackRow)!.id)) return [recAt(fallbackRow)!.id]
    return [...ids]
  }

  const toggleRowCheck = (recId: string, shiftKey = false) => {
    setCheckedRaw((prev) => {
      const next = new Set(prev)
      const willCheck = !next.has(recId)
      if (shiftKey && lastCheckedIdRef.current && lastCheckedIdRef.current !== recId) {
        const a = recordIds.indexOf(lastCheckedIdRef.current)
        const b = recordIds.indexOf(recId)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          for (let i = lo; i <= hi; i++) willCheck ? next.add(recordIds[i]) : next.delete(recordIds[i])
          lastCheckedIdRef.current = recId
          return next
        }
      }
      willCheck ? next.add(recId) : next.delete(recId)
      lastCheckedIdRef.current = recId
      return next
    })
  }

  const onDelete = useCallback(
    (sel: GridSelection) => {
      if (readOnly) return false
      model.setCells(
        selectedCells(sel)
          .filter((c) => !isComputed(c.field.type))
          .map((c) => ({ rec: c.rec.id, field: c.field.id, value: undefined })),
      )
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
      const f = ruleField(table, g)
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
        const id = model.addRecords([groupValues(near)])[0]
        model.moveRecord(id, near.sort - 1)
        return id
      }
    }
    const [id] = model.addRecords([groupValues(near)], after)
    return id
  }

  const addAndFocus = (near?: Rec, above = false, focusCol = 1, startTyping = false) => {
    const id = insertRecord(near, above)
    const col = Math.max(1, Math.min(fieldsRef.current.length, focusCol))
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const row = rowsRef.current.findIndex((r) => r.kind === 'record' && r.rec.id === id)
        if (row < 0) return
        ref.current?.scrollTo(col, row)
        setSelection(cellSelection(col, row))
        ref.current?.focus()
        if (startTyping) {
          setTimeout(() => {
            const f = model.field(fieldsRef.current[col - 1]?.id ?? '')
            const b = ref.current?.getBounds(col, row)
            if (f && b && TYPEABLE.has(f.type) && !typing.current) openTyping(col, row, b, '')
          }, 30)
        }
      }),
    )
  }
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields
  const rowOffsetsRef = useRef(rowOffsets)
  rowOffsetsRef.current = rowOffsets

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

  const onHeaderClicked = useCallback(
    (col: number, e: { isDoubleClick?: boolean; bounds: Rectangle; preventDefault: () => void }) => {
      if (readOnly) return
      if (col === 0 && records.length > 0) {
        e.preventDefault()
        setCheckedRaw((prev) => (prev.size >= records.length ? new Set() : new Set(recordIds)))
        return
      }
      if (col >= 1 && e.isDoubleClick) {
        const f = fieldAt(col)
        if (f) {
          e.preventDefault()
          openFieldEditor({ left: e.bounds.x, right: e.bounds.x + e.bounds.width, top: e.bounds.y, bottom: e.bounds.y + e.bounds.height }, model, { field: f })
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly, records.length, recordIds, fields, model],
  )

  const onCellClicked = useCallback(
    ([col, row]: Item, e: { isDoubleClick?: boolean; bounds: Rectangle; localEventX: number; shiftKey?: boolean }) => {
      if (row === summaryRowIdx) {
        if (col >= 1 && !readOnly) {
          const f = fieldAt(col)!
          const cur = cfg.summary?.[f.id] ?? (col === 1 ? 'count' : 'none')
          openMenu(
            { left: e.bounds.x, right: e.bounds.x + e.bounds.width, top: e.bounds.y, bottom: e.bounds.y + e.bounds.height },
            summaryKinds(f.type).map((k) => ({ label: k.label, checked: k.kind === cur, onClick: () => model.updateView(view.id, { summary: { ...cfg.summary, [f.id]: k.kind } }) })),
            { align: 'left', width: 164 },
          )
        }
        return
      }
      if (row === addRowIdx && !readOnly) {
        addAndFocus(records.at(-1), false, Math.max(1, col), true)
        return
      }
      const item = rows[row]
      if (!item) return
      if (item.kind === 'group') {
        toggleGroup(item.path)
        return
      }
      if (col === 0) {
        if (!readOnly && e.localEventX >= GRIP_W && e.localEventX < CHECK_END) {
          toggleRowCheck(item.rec.id, !!e.shiftKey)
        } else {
          onOpenRecord(item.rec.id, recordIds)
        }
      } else if (e.isDoubleClick) {
        const f = fieldAt(col)
        if (f && isComputed(f.type)) onOpenRecord(item.rec.id, recordIds)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, records, fields, cfg.summary, readOnly, recordIds, collapsed, summaryRowIdx, addRowIdx],
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
      const at = { left: e.bounds.x + e.localEventX, right: e.bounds.x + e.localEventX, top: e.bounds.y + e.localEventY, bottom: e.bounds.y + e.localEventY }
      const item = rows[row]
      if (item?.kind === 'group') {
        const allPaths = rows.filter((x): x is Extract<GridRow, { kind: 'group' }> => x.kind === 'group').map((x) => x.path)
        openMenu(
          at,
          [
            {
              label: '在此分组新建记录',
              icon: <IconPlus />,
              hidden: readOnly || isComputed(item.field.type),
              onClick: () => {
                if (item.collapsed) toggleGroup(item.path)
                addAndFocus(item.sample, false, 1, true)
              },
            },
            { label: item.collapsed ? '展开此分组' : '折叠此分组', onClick: () => toggleGroup(item.path) },
            { label: '展开全部分组', divider: true, onClick: () => model.updateView(view.id, { collapsed: [] }) },
            { label: '折叠全部分组', onClick: () => model.updateView(view.id, { collapsed: [...new Set([...collapsed, ...allPaths])] }) },
          ],
          { align: 'left', width: 176 },
        )
        return
      }
      const rec = recAt(row)
      if (!rec) return
      const ids = selectedRecordIds(selection, row)
      const f = fieldAt(col)
      const items: MenuItem[] = [
        { label: '展开记录详情', icon: <IconEye />, onClick: () => onOpenRecord(rec.id, recordIds) },
        { label: '在上方插入记录', icon: <IconUp />, hidden: readOnly, divider: true, onClick: () => addAndFocus(rec, true) },
        { label: '在下方插入记录', icon: <IconDown />, hidden: readOnly, onClick: () => addAndFocus(rec) },
        {
          label: ids.length > 1 ? `复制 ${ids.length} 条记录` : '复制记录',
          icon: <IconCopy />,
          hidden: readOnly,
          onClick: () => {
            const picked = ids.map((id) => model.record(id)).filter((x): x is Rec => !!x)
            if (picked.length) model.addRecords(picked.map((x) => JSON.parse(JSON.stringify(x.data))), picked.at(-1)!.id)
          },
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
            setCheckedRaw(new Set())
            setSelection({ columns: CompactSelection.empty(), rows: CompactSelection.empty() })
          },
        },
      ]
      openMenu(at, items, { align: 'left', width: 184 })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, fields, selection, readOnly, recordIds, checkedIds, collapsed],
  )

  // ---------- row drag ----------
  const wrapRef = useRef<HTMLDivElement>(null)
  const lineRef = useRef<HTMLDivElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)

  /** Client y range of the scrolling record rows (between header and summary row). */
  const bodyRange = () => {
    const g = ref.current
    const head = g?.getBounds(0, -1)
    const foot = g?.getBounds(0, summaryRowIdx)
    const top = head ? head.y + head.height : (wrapRef.current?.getBoundingClientRect().top ?? 0) + HEADER_H
    return { top, bottom: foot ? foot.y : top + height }
  }

  const rowAtRelY = (relY: number, offsets: number[]): number => {
    const n = offsets.length - 1
    if (n <= 0 || relY <= 0) return 0
    if (relY >= offsets[n]) return n - 1
    let lo = 0
    let hi = n - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (relY < offsets[mid]) hi = mid - 1
      else if (relY >= offsets[mid + 1]) lo = mid + 1
      else return mid
    }
    return Math.min(lo, n - 1)
  }

  const dropTarget = (clientY: number, rec: Rec): DropTarget | null => {
    const b0 = ref.current?.getBounds(0, 0)
    if (!b0) return null
    const rs = rowsRef.current
    const offsets = rowOffsetsRef.current
    if (!rs.length) return null
    const { top, bottom } = bodyRange()
    const relY = Math.max(top, Math.min(bottom - 1, clientY)) - b0.y
    let gap: number
    if (relY >= offsets[rs.length]) {
      gap = rs.length
    } else if (relY <= 0) {
      gap = 0
    } else {
      const r = rowAtRelY(relY, offsets)
      const mid = (offsets[r] + offsets[r + 1]) / 2
      gap = relY < mid ? r : r + 1
    }
    const above = rs[gap - 1]
    const below = rs[gap]
    const [anchor, place]: [Rec, 'before' | 'after'] | [undefined, undefined] =
      above?.kind === 'record' ? [above.rec, 'after'] : below?.kind === 'record' ? [below.rec, 'before'] : [undefined, undefined]
    if (!anchor) return null
    const data: Record<string, any> = {}
    for (const g of cfg.groups ?? []) {
      const f = ruleField(table, g)
      if (!f) continue
      const v = cellValue(anchor, f)
      if (groupKey(f, v) === groupKey(f, cellValue(rec, f))) continue
      if (isComputed(f.type)) return null
      data[f.id] = v ?? null
    }
    const from = rs.findIndex((x) => x.kind === 'record' && x.rec.id === rec.id)
    if (anchor.id === rec.id || (!Object.keys(data).length && (gap === from || gap === from + 1))) return null
    return { anchor, place, data, gap, y: b0.y + offsets[gap] }
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
    const b0 = ref.current?.getBounds(0, 0)
    if (!b0 || e.clientX < b0.x || e.clientX > b0.x + GRIP_W) return
    const { top, bottom } = bodyRange()
    if (e.clientY < top || e.clientY >= bottom) return
    const relY = e.clientY - b0.y
    const offsets = rowOffsetsRef.current
    if (relY < 0 || relY >= offsets[rowsRef.current.length]) return
    const item = rowsRef.current[rowAtRelY(relY, offsets)]
    if (item?.kind !== 'record') return
    e.preventDefault()
    e.stopPropagation()
    if (cfg.sorts?.length) {
      toast('视图已设置排序，无法拖动调整顺序')
      return
    }
    startRowDrag(item.rec, e.clientX, e.clientY)
  }

  // ---------- double-click on blank space ----------
  const onBlankDoubleClick = (e: React.MouseEvent) => {
    if (readOnly || dragId || typing.current) return
    const target = e.target as Element
    if (target.closest('textarea, input, button')) return
    const g = ref.current
    if (!g) return
    const lastCol = g.getBounds(fields.length, -1)
    const head = g.getBounds(0, -1)
    if (!lastCol || !head) return
    if (e.clientX > lastCol.x + lastCol.width && e.clientY >= head.y) {
      const f = fields.at(-1)
      openFieldEditor({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }, model, { viewId: view.id, after: f?.id })
      return
    }
    const { top, bottom } = bodyRange()
    const endIdx = hasAddRow ? addRowIdx : rowsRef.current.length - 1
    const last = endIdx >= 0 ? g.getBounds(0, endIdx) : undefined
    const rowsEnd = last ? last.y + last.height : top
    if (e.clientY <= rowsEnd || e.clientY >= bottom) return
    let col = 1
    for (let c = 1; c <= fields.length; c++) {
      const b = g.getBounds(c, -1)
      if (b && e.clientX >= b.x && e.clientX < b.x + b.width) col = c
    }
    if (cfg.sorts?.length) toast('视图已设置排序，新记录会按排序规则显示')
    addAndFocus(records.at(-1), false, col, true)
  }

  // ---------- columns ----------

  const fieldMenu = (col: number, bounds: Rectangle) => {
    const f = fieldAt(col)
    if (!f || readOnly) return
    const anchor = { left: bounds.x, right: bounds.x + bounds.width, top: bounds.y, bottom: bounds.y + bounds.height }
    const isPrimary = col === 1
    const prevField = col > 2 ? fields[col - 2] : undefined
    const order = orderIds(table, view)
    const bf = baseField(f)
    openMenu(
      anchor,
      [
        { label: '编辑字段配置', icon: <IconEdit />, onClick: () => openFieldEditor(anchor, model, { field: f }) },
        {
          label: '向左插入字段',
          icon: <IconPlus />,
          hidden: isPrimary,
          divider: true,
          onClick: () => openFieldEditor(anchor, model, { viewId: view.id, after: prevField?.id, first: col === 2 }),
        },
        {
          label: '向右插入字段',
          icon: <IconPlus />,
          divider: isPrimary,
          onClick: () => openFieldEditor(anchor, model, { viewId: view.id, after: isPrimary ? undefined : f.id, first: isPrimary }),
        },
        { label: '升序排列 (A → Z)', icon: <IconUp />, divider: true, onClick: () => model.updateView(view.id, { sorts: [{ field: f.id }] }) },
        { label: '降序排列 (Z → A)', icon: <IconDown />, onClick: () => model.updateView(view.id, { sorts: [{ field: f.id, desc: true }] }) },
        {
          label: '按此字段筛选',
          icon: <IconFilter />,
          onClick: () => {
            const cur = cfg.filter ?? { conj: 'and' as const, conds: [] }
            const ops = filterOps(bf.type)
            model.updateView(view.id, {
              filter: {
                conj: cur.conj,
                conds: [...cur.conds, { id: Math.random().toString(36).slice(2, 12), field: f.id, op: ops[0].op, value: defaultCondValue(bf.type) }],
              },
            })
            toast(`已添加「${f.name}」筛选条件，可在工具栏「筛选」中调整`)
          },
        },
        {
          label: '按此字段分组',
          icon: <IconGroup />,
          hidden: f.type === 'attachment',
          onClick: () => model.updateView(view.id, { groups: [{ field: f.id }], collapsed: [] }),
        },
        {
          label: col < freeze ? '取消冻结列' : '冻结至此列',
          icon: <IconLock />,
          divider: true,
          onClick: () => model.updateView(view.id, { frozen: col < freeze ? Math.max(0, col - 1) : col }),
        },
        {
          label: '隐藏此字段',
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
      { align: 'left', width: 196 },
    )
  }

  const onColumnMoved = useCallback(
    (from: number, to: number) => {
      if (from <= 1 || to <= 1) return
      const ids = fields.slice(1).map((f) => f.id)
      const [moved] = ids.splice(from - 2, 1)
      ids.splice(to - 2, 0, moved)
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

  // ---------- type-to-edit & keyboard shortcuts ----------
  const typeRef = useRef<HTMLTextAreaElement>(null)
  const typing = useRef<{ rec: string; field: string; col: number; row: number } | null>(null)

  const openTyping = (col: number, row: number, b: Rectangle, initial: string) => {
    const el = typeRef.current
    const item = rowsRef.current[row]
    const rec = item?.kind === 'record' ? item.rec : undefined
    const f = fieldsRef.current[col - 1]
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
    if (e.ctrlKey || e.metaKey || e.altKey || !e.location || !e.bounds) return
    const [col, row] = e.location
    const rec = recAt(row)
    const f = fieldAt(col)
    if (!rec) return

    // Spacebar: Shift+Space toggles row selection; plain Space expands record detail (except on editable checkbox)
    if (e.key === ' ') {
      if (e.shiftKey && !readOnly) {
        e.cancel()
        e.preventDefault()
        toggleRowCheck(rec.id)
        return
      }
      if (!e.shiftKey && f?.type !== 'checkbox') {
        e.cancel()
        e.preventDefault()
        onOpenRecord(rec.id, recordIds)
        return
      }
    }

    // Shift+Enter: insert a new record right below the current row
    if (e.key === 'Enter' && e.shiftKey && !readOnly) {
      e.cancel()
      e.preventDefault()
      addAndFocus(rec, false, Math.max(1, col))
      return
    }

    if (readOnly || !f || !TYPEABLE.has(f.type)) return
    const ime = e.key === 'Process' || e.keyCode === 229
    const frozen = col < freeze
    if (f.type === 'date' && (ime || (frozen && ((e.key === 'Enter' && !e.shiftKey) || (e.key.length === 1 && e.key !== ' '))))) {
      e.cancel()
      if (!ime) e.preventDefault()
      const curVal = cellValue(rec, f)
      openDatePopover(
        { left: e.bounds.x, right: e.bounds.x + e.bounds.width, top: e.bounds.y, bottom: e.bounds.y + e.bounds.height },
        {
          value: typeof curVal === 'string' ? curVal : undefined,
          withTime: !!f.options.time,
          initialText: ime || e.key === 'Enter' ? undefined : e.key,
          onChange: (v) => model.setCells([{ rec: rec.id, field: f.id, value: v }]),
          onClose: () => ref.current?.focus(),
        },
      )
      return
    }
    if (ime || (frozen && e.key.length === 1 && e.key !== ' ')) {
      e.cancel()
      if (!ime) e.preventDefault()
      openTyping(col, row, e.bounds, ime ? '' : e.key)
    } else if (frozen && e.key === 'Enter' && !e.shiftKey) {
      e.cancel()
      e.preventDefault()
      const v = cellValue(rec, f)
      openTyping(col, row, e.bounds, f.type === 'longtext' || f.type === 'text' || f.type === 'url' || f.type === 'phone' || f.type === 'email' ? (v ?? '') : displayText(f, v))
    }
  }

  const onItemHovered = useCallback((args: GridMouseEventArgs) => {
    setHoveredRow(args.kind === 'cell' ? args.location[1] : -1)
  }, [])

  // ---------- batch bar actions ----------
  const openBatchFill = (el: HTMLElement) => {
    const writableFields = fields.filter((f) => !isComputed(f.type))
    if (!writableFields.length) return toast('没有可批量修改的字段')
    openPopover(
      el,
      (close) => <BatchFillPopover model={model} fields={writableFields} recordIds={checkedIds} onDone={close} />,
      { width: 320, align: 'left' },
    )
  }

  const rightElement = readOnly ? undefined : (
    <button
      className="bt-add-col"
      title="新建字段"
      aria-label="新建字段"
      onClick={(e) => openFieldEditor(e.currentTarget, model, { viewId: view.id, after: fields.at(-1)?.id })}
    >
      <IconPlus width={16} height={16} />
    </button>
  )

  return (
    <div
      className="bt-grid"
      ref={wrapRef}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={onPointerDownCapture}
      onDoubleClick={onBlankDoubleClick}
      onMouseLeave={() => setHoveredRow(-1)}
    >
      <div ref={lineRef} className="bt-drop-line" style={{ left: INDEX_W }} />
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
        headerIcons={HEADER_SPRITES}
        drawHeader={drawHeader}
        columns={columns}
        rows={total}
        width="100%"
        height={height}
        rowHeight={getRowHeight}
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
        onItemHovered={onItemHovered}
        onKeyDown={onGridKeyDown}
        onHeaderClicked={onHeaderClicked}
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

      {!readOnly && checkedIds.length > 0 && (
        <div className="bt-batch-bar" role="toolbar" aria-label="批量操作">
          <span className="bt-batch-count">
            <span className="bt-batch-dot">{checkedIds.length}</span>
            <span>已选记录</span>
          </span>
          {checkedIds.length === 1 && (
            <button className="bt-batch-btn" onClick={() => onOpenRecord(checkedIds[0], recordIds)}>
              <IconEye width={14} height={14} /> 展开
            </button>
          )}
          <button className="bt-batch-btn" onClick={(e) => openBatchFill(e.currentTarget)}>
            <IconEdit width={14} height={14} /> 批量修改
          </button>
          <button
            className="bt-batch-btn"
            onClick={() => {
              const picked = checkedIds.map((id) => model.record(id)).filter((x): x is Rec => !!x)
              if (!picked.length) return
              model.addRecords(picked.map((x) => JSON.parse(JSON.stringify(x.data))), picked.at(-1)!.id)
              toast(`已复制 ${picked.length} 条记录`)
            }}
          >
            <IconCopy width={14} height={14} /> 复制
          </button>
          <button
            className="bt-batch-btn danger"
            onClick={async () => {
              if (checkedIds.length > 1 && !(await confirmDialog(`确定删除选中的 ${checkedIds.length} 条记录吗？可用 Ctrl+Z 撤销。`, { danger: true, okText: '删除' }))) return
              const count = checkedIds.length
              model.deleteRecords(checkedIds)
              setCheckedRaw(new Set())
              toast(`已删除 ${count} 条记录（Ctrl+Z 撤销）`)
            }}
          >
            <IconTrash width={14} height={14} /> 删除
          </button>
          <button className="icon-btn sm" title="取消选择 (Esc)" aria-label="取消选择" onClick={() => setCheckedRaw(new Set())}>
            <IconClose width={14} height={14} />
          </button>
        </div>
      )}
    </div>
  )
}

function BatchFillPopover({ model, fields, recordIds, onDone }: { model: TableModel; fields: Field[]; recordIds: string[]; onDone: () => void }) {
  const [fieldId, setFieldId] = useState(fields[0]?.id ?? '')
  const field = fields.find((f) => f.id === fieldId) ?? fields[0]
  const [draft, setDraft] = useState<Rec>(() => ({ id: '__batch', seq: 0, sort: 0, created_at: 0, updated_at: 0, data: {} }))

  // lightweight proxy model for FieldInput so editing updates `draft` locally until user clicks "应用"
  const draftModel = useMemo(() => {
    const proxy = Object.create(model) as TableModel
    proxy.setCells = (changes: CellChange[]) => {
      setDraft((d) => {
        const next = { ...d.data }
        for (const c of changes) next[c.field] = c.value
        return { ...d, data: next }
      })
    }
    return proxy
  }, [model])

  if (!field) return null
  const apply = (clear = false) => {
    const val = clear ? undefined : draft.data[field.id]
    model.setCells(recordIds.map((rec) => ({ rec, field: field.id, value: val })))
    toast(clear ? `已清空 ${recordIds.length} 条记录的「${field.name}」` : `已更新 ${recordIds.length} 条记录的「${field.name}」`)
    onDone()
  }

  return (
    <div className="bt-panel">
      <div className="bt-panel-title">批量修改（{recordIds.length} 条记录）</div>
      <label className="bt-form-row">
        <span>目标字段</span>
        <div className="bt-select-with-icon">
          <FieldTypeIcon type={field.type} size={14} />
          <select className="bt-input sm" value={field.id} onChange={(e) => setFieldId(e.target.value)}>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </label>
      <div className="bt-form-row">
        <span>修改为</span>
        <FieldInput key={field.id} model={draftModel} field={field} rec={draft} />
      </div>
      <div className="bt-form-actions">
        <button type="button" className="btn ghost sm" onClick={() => apply(true)}>
          清空该字段
        </button>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={onDone}>
          取消
        </button>
        <button type="button" className="btn sm primary" onClick={() => apply(false)}>
          应用
        </button>
      </div>
    </div>
  )
}

function makeCell(model: TableModel, f: Field, rec: Rec, readOnly: boolean, tall: boolean): GridCell {
  const v = cellValue(rec, f)
  const ro = readOnly || isComputed(f.type)
  const text = displayText(f, v)
  switch (f.type) {
    case 'text':
    case 'longtext':
      return {
        kind: GridCellKind.Text,
        data: v ?? '',
        displayData: !tall && f.type === 'longtext' ? text.replace(/\s*\n\s*/g, ' ') : text,
        allowWrapping: tall,
        allowOverlay: true,
        readonly: ro,
      }
    case 'autonumber':
    case 'created_time':
    case 'modified_time':
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false, readonly: true, themeOverride: { textDark: palette.muted } }
    case 'formula':
    case 'lookup':
    case 'rollup': {
      const b = baseField(f)
      if (b.type === 'checkbox') return { kind: GridCellKind.Boolean, data: !!v, allowOverlay: false, readonly: true, copyData: v ? '✓' : '' } as GridCell
      return { kind: GridCellKind.Custom, data: { kind: 'qj-value', field: b, value: v, model }, copyData: text, allowOverlay: false, readonly: true } as ValueCell
    }
    case 'checkbox':
      return { kind: GridCellKind.Boolean, data: !!v, allowOverlay: false, readonly: ro, copyData: v ? '✓' : '' } as GridCell
    case 'phone':
    case 'email':
      return {
        kind: GridCellKind.Uri,
        data: v ?? '',
        allowOverlay: !ro,
        readonly: ro,
        hoverEffect: true,
        onClickUri: (a) => {
          if (!v) return
          a.preventDefault()
          window.open((f.type === 'phone' ? 'tel:' : 'mailto:') + String(v).replace(f.type === 'phone' ? /[^\d+]/g : /\s/g, ''), '_self')
        },
      } as GridCell
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
