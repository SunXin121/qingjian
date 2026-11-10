// Custom canvas cells for the grid (tags, dates, attachments, row index, group headers)
// and their overlay editors.

import { useRef, useState } from 'react'
import { drawTextCell, GridCellKind, roundedRect, type CustomCell, type CustomRenderer, type ProvideEditorCallbackResult } from '@glideapps/glide-data-grid'
import { AttachmentList, fromInputDate, LiveLinkPicker, LivePicker, toInputDate } from './editors'
import { displayText, parseText } from './engine'
import type { TableModel } from './model'
import { palette } from './theme'
import type { AttachmentValue, Field } from './types'
import { ratingMax } from './types'

export interface ValueData {
  kind: 'qj-value'
  field: Field
  value: any
  model: TableModel
}
export type ValueCell = CustomCell<ValueData>

export interface IndexData {
  kind: 'qj-index'
  n: number
  /** show the drag handle (left part of the cell) on hover */
  grip?: boolean
}

/** Width of the drag handle area at the left of the index cell. */
export const GRIP_W = 22
export type IndexCell = CustomCell<IndexData>

export interface GroupData {
  kind: 'qj-group'
  label: string
  count: number
  depth: number
  collapsed: boolean
  color?: number
}
export type GroupCell = CustomCell<GroupData>

export interface AddData {
  kind: 'qj-add'
}
export type AddCell = CustomCell<AddData>

const font = (theme: { baseFontFull: string }) => theme.baseFontFull

function drawPill(ctx: CanvasRenderingContext2D, x: number, cy: number, maxRight: number, text: string, bg: string, fg: string): number {
  const padX = 8
  const h = 20
  const w = Math.min(ctx.measureText(text).width + padX * 2, maxRight - x)
  if (w < 18) return x
  ctx.fillStyle = bg
  ctx.beginPath()
  roundedRect(ctx, x, cy - h / 2, w, h, 4)
  ctx.fill()
  ctx.fillStyle = fg
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, cy - h / 2, w - padX + 4, h)
  ctx.clip()
  ctx.fillText(text, x + padX, cy)
  ctx.restore()
  return x + w + 4
}

export const valueRenderer: CustomRenderer<ValueCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is ValueCell => (c.data as any).kind === 'qj-value',
  draw: (args, cell) => {
    const { ctx, rect, theme } = args
    const { field, value } = cell.data
    const cy = rect.y + rect.height / 2
    const left = rect.x + theme.cellHorizontalPadding
    const right = rect.x + rect.width - theme.cellHorizontalPadding
    ctx.font = font(theme)
    ctx.textBaseline = 'middle'
    switch (field.type) {
      case 'select':
      case 'multiselect': {
        const ids: string[] = field.type === 'select' ? (value ? [value] : []) : Array.isArray(value) ? value : []
        let x = left
        for (const id of ids) {
          const c = field.options.choices?.find((ch) => ch.id === id)
          if (!c) continue
          const nx = drawPill(ctx, x, cy, right, c.name, palette.tagBg[c.color % 10], palette.tagFg[c.color % 10])
          if (nx === x) break
          x = nx
        }
        return true
      }
      case 'link': {
        let x = left
        const titles = field.rt?.titles
        for (const id of Array.isArray(value) ? value : []) {
          const t = titles?.get(id)
          if (t === undefined) continue
          const nx = drawPill(ctx, x, cy, right, t, palette.linkBg, palette.linkFg)
          if (nx === x) break
          x = nx
        }
        return true
      }
      case 'attachment': {
        let x = left
        for (const a of (value as AttachmentValue[] | undefined) ?? []) {
          const nx = drawPill(ctx, x, cy, right, a.name, palette.chipBg, palette.chipFg)
          if (nx === x) break
          x = nx
        }
        return true
      }
      case 'number':
        drawTextCell(args, displayText(field, value), 'right')
        return true
      case 'rating': {
        const n = typeof value === 'number' ? value : 0
        const max = ratingMax(field)
        for (let i = 0; i < max; i++) {
          const x = left + i * STAR_W + STAR_W / 2
          if (x + STAR_W / 2 > right) break
          drawStar(ctx, x, cy, 6.5, i < n ? palette.star : palette.starOff)
        }
        return true
      }
      case 'progress': {
        if (typeof value !== 'number') return true
        const text = displayText(field, value)
        const tw = 44
        const w = Math.max(0, right - left - tw - 6)
        const h = 6
        ctx.fillStyle = palette.chipBg
        ctx.beginPath()
        roundedRect(ctx, left, cy - h / 2, w, h, 3)
        ctx.fill()
        const fw = Math.max(0, Math.min(1, value)) * w
        if (fw > 0) {
          ctx.fillStyle = value >= 1 ? palette.success : palette.link
          ctx.beginPath()
          roundedRect(ctx, left, cy - h / 2, Math.max(fw, h), h, 3)
          ctx.fill()
        }
        ctx.fillStyle = theme.textMedium
        ctx.textAlign = 'right'
        ctx.fillText(text, right, cy)
        ctx.textAlign = 'start'
        return true
      }
      default:
        drawTextCell(args, displayText(field, value))
        return true
    }
  },
  provideEditor: (cell) => {
    const { field } = cell.data
    if (field.type === 'select' || field.type === 'multiselect') return { editor: ChoiceEditor, disablePadding: true, disableStyling: false } as ProvideEditorCallbackResult<ValueCell>
    if (field.type === 'date') return { editor: DateEditor } as ProvideEditorCallbackResult<ValueCell>
    if (field.type === 'number' || field.type === 'progress' || field.type === 'rating') return { editor: NumberEditor } as ProvideEditorCallbackResult<ValueCell>
    if (field.type === 'attachment') return { editor: FilesEditor, disablePadding: true } as ProvideEditorCallbackResult<ValueCell>
    if (field.type === 'link') return { editor: LinkEditor, disablePadding: true } as ProvideEditorCallbackResult<ValueCell>
    return undefined
  },
  onPaste: () => undefined,
  onClick: (a) => {
    const { field, value } = a.cell.data
    if (field.type !== 'rating' || a.cell.readonly) return undefined
    const pad = a.theme.cellHorizontalPadding
    const i = Math.floor((a.posX - pad) / STAR_W)
    if (i < 0 || i >= ratingMax(field)) return undefined
    a.preventDefault()
    // clicking the current score clears it
    const next = value === i + 1 ? undefined : i + 1
    return withValue(a.cell, next)
  },
}

const STAR_W = 18

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.fillStyle = color
  ctx.beginPath()
  for (let k = 0; k < 10; k++) {
    const rad = k % 2 ? r * 0.45 : r
    const a = -Math.PI / 2 + (k * Math.PI) / 5
    const x = cx + Math.cos(a) * rad
    const y = cy + Math.sin(a) * rad
    k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
}

type EditorProps = {
  value: ValueCell
  onChange: (c: ValueCell) => void
  onFinishedEditing: (c?: ValueCell, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void
  initialValue?: string
}

const withValue = (cell: ValueCell, value: any): ValueCell => ({ ...cell, data: { ...cell.data, value }, copyData: displayText(cell.data.field, value) })

function ChoiceEditor({ value: cell, onChange, onFinishedEditing, initialValue }: EditorProps) {
  // a ref, not state: picking a single option changes and finishes in the same tick
  const cur = useRef(cell)
  return (
    <div className="bt-overlay" style={{ width: 260 }}>
      <LivePicker
        model={cell.data.model}
        fieldId={cell.data.field.id}
        initial={cell.data.value}
        initialQuery={initialValue}
        onChange={(v) => {
          cur.current = withValue(cell, v)
          onChange(cur.current)
        }}
        onDone={() => onFinishedEditing(cur.current)}
      />
    </div>
  )
}

/** Plain text box: glide's own number editor drops a trailing "." while typing "3.5". */
function NumberEditor({ value: cell, onChange, onFinishedEditing, initialValue }: EditorProps) {
  const { field } = cell.data
  const cur = useRef(cell)
  const [text, setText] = useState(() => {
    if (initialValue !== undefined) return initialValue
    const v = cell.data.value
    if (typeof v !== 'number') return ''
    // progress is edited as a percentage
    return field.type === 'progress' ? String(Math.round(v * 1e6) / 1e4) : String(v)
  })
  const apply = (s: string) => {
    setText(s)
    cur.current = withValue(cell, parseText(field, s, () => ''))
    onChange(cur.current)
  }
  return (
    <input
      className="bt-overlay-number"
      autoFocus
      inputMode="decimal"
      value={text}
      onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
      onChange={(e) => apply(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          e.stopPropagation()
          onFinishedEditing(cur.current, e.key === 'Tab' ? [e.shiftKey ? -1 : 1, 0] : [0, e.shiftKey ? -1 : 1])
        }
      }}
    />
  )
}

function DateEditor({ value: cell, onChange, onFinishedEditing }: EditorProps) {
  const withTime = !!cell.data.field.options.time
  const cur = useRef(cell)
  return (
    <input
      className="bt-overlay-date"
      type={withTime ? 'datetime-local' : 'date'}
      autoFocus
      defaultValue={toInputDate(cell.data.value)}
      onChange={(e) => {
        cur.current = withValue(cell, fromInputDate(e.target.value, withTime))
        onChange(cur.current)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onFinishedEditing(cur.current, [0, 1])
        }
      }}
    />
  )
}

function LinkEditor({ value: cell, onChange, onFinishedEditing, initialValue }: EditorProps) {
  const cur = useRef(cell)
  return (
    <div className="bt-overlay" style={{ width: 320 }}>
      <LiveLinkPicker
        model={cell.data.model}
        fieldId={cell.data.field.id}
        initial={cell.data.value}
        initialQuery={initialValue}
        onChange={(v) => {
          cur.current = withValue(cell, v)
          onChange(cur.current)
        }}
        onDone={() => onFinishedEditing(cur.current)}
      />
    </div>
  )
}

function FilesEditor({ value: cell, onChange, onFinishedEditing }: EditorProps) {
  const [cur, setCur] = useState(cell)
  const latest = useRef(cell)
  return (
    <div className="bt-overlay" style={{ width: 320 }}>
      <AttachmentList
        value={cur.data.value}
        onChange={(v) => {
          latest.current = withValue(cell, v)
          setCur(latest.current)
          onChange(latest.current)
        }}
      />
      <div className="bt-overlay-foot">
        <button className="btn sm primary" onClick={() => onFinishedEditing(latest.current)}>
          完成
        </button>
      </div>
    </div>
  )
}

export const indexRenderer: CustomRenderer<IndexCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is IndexCell => (c.data as any).kind === 'qj-index',
  needsHover: true,
  draw: (args, cell) => {
    const { ctx, rect, theme, hoverAmount } = args
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.font = theme.markerFontFull
    if (hoverAmount > 0.1) {
      let ex = cx
      if (cell.data.grip) {
        // drag handle: 2 × 3 dots
        ctx.fillStyle = theme.textLight
        const gx = rect.x + GRIP_W / 2 + 1
        for (const dx of [-2.5, 2.5])
          for (const dy of [-5, 0, 5]) {
            ctx.beginPath()
            ctx.arc(gx + dx, cy + dy, 1.3, 0, Math.PI * 2)
            ctx.fill()
          }
        ex = rect.x + GRIP_W + (rect.width - GRIP_W) / 2 - 2
      }
      // "expand" glyph: two outward arrows
      ctx.strokeStyle = theme.textMedium
      ctx.lineWidth = 1.5
      ctx.lineCap = 'round'
      const s = 5
      ctx.beginPath()
      ctx.moveTo(ex - s, cy + s)
      ctx.lineTo(ex + s, cy - s)
      ctx.moveTo(ex + 1, cy - s)
      ctx.lineTo(ex + s, cy - s)
      ctx.lineTo(ex + s, cy - 1)
      ctx.moveTo(ex - s, cy + 1)
      ctx.lineTo(ex - s, cy + s)
      ctx.lineTo(ex - 1, cy + s)
      ctx.stroke()
    } else {
      ctx.fillStyle = theme.textLight
      ctx.fillText(String(cell.data.n), cx, cy)
    }
    ctx.textAlign = 'start'
    return true
  },
}

export const groupRenderer: CustomRenderer<GroupCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is GroupCell => (c.data as any).kind === 'qj-group',
  draw: (args, cell) => {
    const { ctx, rect, theme } = args
    const { label, count, depth, collapsed, color } = cell.data
    const cy = rect.y + rect.height / 2
    let x = rect.x + 10 + depth * 16
    // chevron
    ctx.strokeStyle = theme.textMedium
    ctx.lineWidth = 1.5
    ctx.lineCap = 'round'
    ctx.beginPath()
    if (collapsed) {
      ctx.moveTo(x + 2, cy - 4)
      ctx.lineTo(x + 6, cy)
      ctx.lineTo(x + 2, cy + 4)
    } else {
      ctx.moveTo(x, cy - 2)
      ctx.lineTo(x + 4, cy + 2)
      ctx.lineTo(x + 8, cy - 2)
    }
    ctx.stroke()
    x += 16
    ctx.font = `600 ${theme.baseFontFull}`
    ctx.textBaseline = 'middle'
    const right = rect.x + rect.width - 8
    if (color !== undefined) x = drawPill(ctx, x, cy, right - 30, label, palette.tagBg[color % 10], palette.tagFg[color % 10]) + 4
    else {
      ctx.fillStyle = theme.textDark
      const w = Math.min(ctx.measureText(label).width, right - x - 30)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, rect.y, w, rect.height)
      ctx.clip()
      ctx.fillText(label, x, cy)
      ctx.restore()
      x += w + 8
    }
    ctx.font = theme.baseFontFull
    ctx.fillStyle = theme.textLight
    if (x < right) ctx.fillText(String(count), x, cy)
    return true
  },
}

export const addRenderer: CustomRenderer<AddCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is AddCell => (c.data as any).kind === 'qj-add',
  needsHover: true,
  draw: (args) => {
    const { ctx, rect, theme, hoverAmount } = args
    const cx = rect.x + rect.width / 2
    const cy = rect.y + rect.height / 2
    ctx.strokeStyle = hoverAmount > 0.1 ? theme.textDark : theme.textLight
    ctx.lineWidth = 1.6
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - 6, cy)
    ctx.lineTo(cx + 6, cy)
    ctx.moveTo(cx, cy - 6)
    ctx.lineTo(cx, cy + 6)
    ctx.stroke()
    return true
  },
}

export const customRenderers = [valueRenderer, indexRenderer, groupRenderer, addRenderer]
