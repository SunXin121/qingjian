// Custom canvas cells for the grid (tags, dates, attachments with image thumbnails,
// Feishu-style row index with checkbox & expand button, spanning group headers, add-row, summary footer)
// and their overlay editors.

import { useRef, useState } from 'react'
import { drawTextCell, GridCellKind, roundedRect, type CustomCell, type CustomRenderer, type ProvideEditorCallbackResult } from '@glideapps/glide-data-grid'
import { DatePicker } from './DatePicker'
import { AttachmentList, LiveLinkPicker, LivePicker } from './editors'
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
  checked?: boolean
  anyChecked?: boolean
  rowHovered?: boolean
}

/** Hit-test zones inside the 66px index column: [0..GRIP_W] drag, [GRIP_W..CHECK_END] checkbox, [CHECK_END..INDEX_W] expand. */
export const INDEX_W = 66
export const GRIP_W = 18
export const CHECK_END = 42
export type IndexCell = CustomCell<IndexData>

export interface GroupData {
  kind: 'qj-group'
  fieldName: string
  label: string
  count: number
  depth: number
  collapsed: boolean
  color?: number
  canAdd?: boolean
}
export type GroupCell = CustomCell<GroupData>

export interface AddRowData {
  kind: 'qj-add-row'
}
export type AddRowCell = CustomCell<AddRowData>

export interface SummaryData {
  kind: 'qj-summary'
  label: string
  value: string
  isPrimary?: boolean
  editable?: boolean
}
export type SummaryCell = CustomCell<SummaryData>

const font = (theme: { baseFontFull: string }) => theme.baseFontFull

// ---------- attachment thumbnail cache ----------
const thumbCache = new Map<string, HTMLImageElement | 'loading' | 'error'>()
const thumbListeners = new Set<() => void>()

export function onThumbLoaded(fn: () => void): () => void {
  thumbListeners.add(fn)
  return () => {
    thumbListeners.delete(fn)
  }
}

function getThumb(url: string): HTMLImageElement | null {
  const cached = thumbCache.get(url)
  if (cached instanceof HTMLImageElement) return cached
  if (cached) return null
  if (typeof Image === 'undefined') return null
  if (thumbCache.size > 300) {
    const first = thumbCache.keys().next().value
    if (first) thumbCache.delete(first)
  }
  thumbCache.set(url, 'loading')
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => {
    thumbCache.set(url, img)
    for (const fn of thumbListeners) fn()
  }
  img.onerror = () => {
    thumbCache.set(url, 'error')
  }
  img.src = url
  return null
}

// ---------- canvas drawing helpers ----------

export function drawCheckboxBox(ctx: CanvasRenderingContext2D, cx: number, cy: number, checked: boolean, indeterminate: boolean, hovered: boolean) {
  const s = 15
  const x = cx - s / 2
  const y = cy - s / 2
  ctx.save()
  ctx.beginPath()
  roundedRect(ctx, x, y, s, s, 3.5)
  if (checked || indeterminate) {
    ctx.fillStyle = palette.accent
    ctx.fill()
    ctx.strokeStyle = palette.accentFg
    ctx.lineWidth = 1.7
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (indeterminate && !checked) {
      ctx.moveTo(cx - 3.5, cy)
      ctx.lineTo(cx + 3.5, cy)
    } else {
      ctx.moveTo(cx - 3.5, cy + 0.3)
      ctx.lineTo(cx - 0.8, cy + 3)
      ctx.lineTo(cx + 3.8, cy - 2.6)
    }
    ctx.stroke()
  } else {
    ctx.fillStyle = palette.panel
    ctx.fill()
    ctx.strokeStyle = hovered ? palette.accent : palette.muted
    ctx.lineWidth = 1.35
    ctx.stroke()
  }
  ctx.restore()
}

function drawPill(ctx: CanvasRenderingContext2D, x: number, cy: number, maxRight: number, text: string, bg: string, fg: string): number {
  const padX = 8
  const h = 20
  const w = Math.min(ctx.measureText(text).width + padX * 2, maxRight - x)
  if (w < 18) return x
  ctx.fillStyle = bg
  ctx.beginPath()
  roundedRect(ctx, x, cy - h / 2, w, h, 5)
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

/** Draws pills across 1 line (short rows) or wrapped across multiple lines (medium/tall/xtall rows). */
function drawPills(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  padX: number,
  items: { text: string; bg: string; fg: string }[],
) {
  if (!items.length) return
  const left = rect.x + padX
  const right = rect.x + rect.width - padX
  if (right - left < 18) return
  if (rect.height <= 42) {
    let x = left
    const cy = rect.y + rect.height / 2
    for (const it of items) {
      const nx = drawPill(ctx, x, cy, right, it.text, it.bg, it.fg)
      if (nx === x) break
      x = nx
    }
    return
  }
  const lineH = 24
  let x = left
  let cy = rect.y + 17
  const maxCy = rect.y + rect.height - 13
  for (const it of items) {
    const needW = Math.min(ctx.measureText(it.text).width + 16, right - left)
    if (x > left && x + needW > right) {
      if (cy + lineH > maxCy) break
      x = left
      cy += lineH
    }
    const nx = drawPill(ctx, x, cy, right, it.text, it.bg, it.fg)
    if (nx === x) break
    x = nx
  }
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
        const pills: { text: string; bg: string; fg: string }[] = []
        for (const id of ids) {
          const c = field.options.choices?.find((ch) => ch.id === id)
          if (c) pills.push({ text: c.name, bg: palette.tagBg[c.color % 10], fg: palette.tagFg[c.color % 10] })
        }
        ctx.font = `500 ${font(theme)}`
        drawPills(ctx, rect, theme.cellHorizontalPadding, pills)
        return true
      }
      case 'link': {
        const titles = field.rt?.titles
        const pills: { text: string; bg: string; fg: string }[] = []
        for (const id of Array.isArray(value) ? value : []) {
          const t = titles?.get(id)
          if (t !== undefined) pills.push({ text: t, bg: palette.linkBg, fg: palette.linkFg })
        }
        ctx.font = `500 ${font(theme)}`
        drawPills(ctx, rect, theme.cellHorizontalPadding, pills)
        return true
      }
      case 'attachment': {
        const list = (value as AttachmentValue[] | undefined) ?? []
        if (!list.length) return true
        const th = Math.min(Math.max(22, rect.height - 10), 68)
        const ty = rect.height > 42 ? rect.y + 6 : cy - th / 2
        let x = left
        for (const a of list) {
          if (x + 20 > right) break
          if (a.mime.startsWith('image/')) {
            const img = getThumb(a.url)
            const ratio = img && img.naturalHeight > 0 ? Math.max(0.75, Math.min(1.6, img.naturalWidth / img.naturalHeight)) : 1
            const tw = Math.min(Math.round(th * ratio), right - x)
            if (tw < 16) break
            ctx.save()
            ctx.beginPath()
            roundedRect(ctx, x, ty, tw, th, 4)
            ctx.fillStyle = palette.chipBg
            ctx.fill()
            ctx.clip()
            if (img) ctx.drawImage(img, x, ty, tw, th)
            ctx.restore()
            ctx.strokeStyle = palette.border
            ctx.lineWidth = 1
            ctx.beginPath()
            roundedRect(ctx, x + 0.5, ty + 0.5, tw - 1, th - 1, 4)
            ctx.stroke()
            x += tw + 5
          } else {
            const ext = a.name.includes('.') ? a.name.split('.').pop()!.slice(0, 4).toUpperCase() : 'FILE'
            const label = `${ext} · ${a.name}`
            const pillCy = rect.height > 42 ? ty + 11 : cy
            const nx = drawPill(ctx, x, pillCy, right, label, palette.chipBg, palette.chipFg)
            if (nx === x) break
            x = nx
          }
        }
        return true
      }
      case 'number':
        drawTextCell(args, displayText(field, value), 'right')
        return true
      case 'rating': {
        const n = typeof value === 'number' ? value : 0
        const max = ratingMax(field)
        const starY = rect.height > 42 ? rect.y + 17 : cy
        for (let i = 0; i < max; i++) {
          const x = left + i * STAR_W + STAR_W / 2
          if (x + STAR_W / 2 > right) break
          drawStar(ctx, x, starY, 6.8, i < n ? palette.star : palette.starOff)
        }
        return true
      }
      case 'progress': {
        if (typeof value !== 'number') return true
        const text = displayText(field, value)
        const barY = rect.height > 42 ? rect.y + 17 : cy
        const tw = 44
        const w = Math.max(0, right - left - tw - 6)
        const h = 6
        ctx.fillStyle = palette.chipBg
        ctx.beginPath()
        roundedRect(ctx, left, barY - h / 2, w, h, 3)
        ctx.fill()
        const fw = Math.max(0, Math.min(1, value)) * w
        if (fw > 0) {
          ctx.fillStyle = value >= 1 ? palette.success : palette.link
          ctx.beginPath()
          roundedRect(ctx, left, barY - h / 2, Math.max(fw, h), h, 3)
          ctx.fill()
        }
        ctx.fillStyle = theme.textMedium
        ctx.textAlign = 'right'
        ctx.fillText(text, right, barY)
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
    if (field.type === 'date') return { editor: DateEditor, disablePadding: true, disableStyling: false } as ProvideEditorCallbackResult<ValueCell>
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
    <div className="bt-overlay" style={{ width: 268 }}>
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

function DateEditor({ value: cell, onChange, onFinishedEditing, initialValue }: EditorProps) {
  const withTime = !!cell.data.field.options.time
  const cur = useRef(cell)
  return (
    <div className="bt-overlay" style={{ width: withTime ? 372 : 276 }}>
      <DatePicker
        value={typeof cell.data.value === 'string' ? cell.data.value : undefined}
        withTime={withTime}
        initialText={initialValue}
        onDraftChange={(v) => {
          cur.current = withValue(cell, v)
          onChange(cur.current)
        }}
        onCommit={(v, movement) => {
          cur.current = withValue(cell, v)
          onChange(cur.current)
          onFinishedEditing(cur.current, movement)
        }}
        onCancel={() => onFinishedEditing(undefined)}
      />
    </div>
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
    <div className="bt-overlay" style={{ width: 340 }}>
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
  needsHoverPosition: true,
  draw: (args, cell) => {
    const { ctx, rect, theme, hoverAmount, hoverX } = args
    const { n, grip, checked, anyChecked, rowHovered } = cell.data
    const cy = rect.y + rect.height / 2
    const active = hoverAmount > 0.05 || !!rowHovered || !!checked || !!anyChecked
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.font = theme.markerFontFull

    if (!active) {
      ctx.fillStyle = theme.textLight
      ctx.fillText(String(n), rect.x + rect.width / 2 - 2, cy)
      ctx.textAlign = 'start'
      return true
    }

    // 1. Drag grip (left [0..GRIP_W])
    if (grip && (rowHovered || hoverAmount > 0.05)) {
      ctx.fillStyle = hoverX !== undefined && hoverX < GRIP_W ? theme.textMedium : theme.textLight
      const gx = rect.x + GRIP_W / 2 + 1
      for (const dx of [-2.2, 2.2])
        for (const dy of [-4.5, 0, 4.5]) {
          ctx.beginPath()
          ctx.arc(gx + dx, cy + dy, 1.2, 0, Math.PI * 2)
          ctx.fill()
        }
    }

    // 2. Row checkbox (center [GRIP_W..CHECK_END]) or row number when read-only
    if (grip) {
      const boxHover = hoverX !== undefined && hoverX >= GRIP_W && hoverX < CHECK_END
      drawCheckboxBox(ctx, rect.x + 30, cy, !!checked, false, boxHover)
    } else {
      ctx.fillStyle = theme.textLight
      ctx.fillText(String(n), rect.x + 24, cy)
    }

    // 3. Expand record icon button (right [CHECK_END..INDEX_W])
    if (rowHovered || hoverAmount > 0.05) {
      const ex = rect.x + 53
      const expHover = hoverX !== undefined && hoverX >= CHECK_END
      if (expHover) {
        ctx.fillStyle = palette.chipBg
        ctx.beginPath()
        roundedRect(ctx, ex - 10, cy - 10, 20, 20, 4)
        ctx.fill()
      }
      ctx.strokeStyle = expHover ? palette.accent : theme.textMedium
      ctx.lineWidth = 1.45
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const s = 4.5
      ctx.beginPath()
      ctx.moveTo(ex - s, cy + s)
      ctx.lineTo(ex + s, cy - s)
      ctx.moveTo(ex + 0.8, cy - s)
      ctx.lineTo(ex + s, cy - s)
      ctx.lineTo(ex + s, cy - 0.8)
      ctx.moveTo(ex - s, cy + 0.8)
      ctx.lineTo(ex - s, cy + s)
      ctx.lineTo(ex - 0.8, cy + s)
      ctx.stroke()
    }

    ctx.textAlign = 'start'
    return true
  },
}

export const groupRenderer: CustomRenderer<GroupCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is GroupCell => (c.data as any).kind === 'qj-group',
  needsHover: true,
  draw: (args, cell) => {
    const { ctx, rect, theme, hoverAmount } = args
    const { fieldName, label, count, depth, collapsed, color, canAdd } = cell.data
    const cy = rect.y + rect.height / 2
    let x = rect.x + 14 + depth * 18
    // chevron button pill
    if (hoverAmount > 0.1) {
      ctx.fillStyle = palette.chipBg
      ctx.beginPath()
      roundedRect(ctx, x - 4, cy - 9, 18, 18, 4)
      ctx.fill()
    }
    ctx.strokeStyle = theme.textMedium
    ctx.lineWidth = 1.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (collapsed) {
      ctx.moveTo(x + 3, cy - 4)
      ctx.lineTo(x + 7, cy)
      ctx.lineTo(x + 3, cy + 4)
    } else {
      ctx.moveTo(x + 1, cy - 2)
      ctx.lineTo(x + 5, cy + 2)
      ctx.lineTo(x + 9, cy - 2)
    }
    ctx.stroke()
    x += 20

    const right = rect.x + rect.width - 12
    ctx.textBaseline = 'middle'

    // subtle field name caption
    if (fieldName && x + 60 < right) {
      ctx.font = `12px ${theme.fontFamily}`
      ctx.fillStyle = theme.textLight
      const fnText = `${fieldName}`
      ctx.fillText(fnText, x, cy)
      x += ctx.measureText(fnText).width + 8
    }

    ctx.font = `600 ${theme.baseFontFull}`
    if (color !== undefined) {
      x = drawPill(ctx, x, cy, right - 38, label, palette.tagBg[color % 10], palette.tagFg[color % 10]) + 4
    } else {
      ctx.fillStyle = theme.textDark
      const w = Math.min(ctx.measureText(label).width, Math.max(0, right - x - 38))
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, rect.y, w, rect.height)
      ctx.clip()
      ctx.fillText(label, x, cy)
      ctx.restore()
      x += w + 8
    }

    // count badge
    const countStr = String(count)
    ctx.font = `500 11.5px ${theme.fontFamily}`
    const cw = Math.max(18, ctx.measureText(countStr).width + 10)
    if (x + cw <= right) {
      ctx.fillStyle = palette.chipBg
      ctx.beginPath()
      roundedRect(ctx, x, cy - 9, cw, 18, 9)
      ctx.fill()
      ctx.fillStyle = theme.textMedium
      ctx.textAlign = 'center'
      ctx.fillText(countStr, x + cw / 2, cy + 0.5)
      ctx.textAlign = 'start'
      x += cw + 8
    }

    // quick "+" hint on hover
    if (canAdd && hoverAmount > 0.1 && x + 22 <= right) {
      const px = x + 9
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px - 4.5, cy)
      ctx.lineTo(px + 4.5, cy)
      ctx.moveTo(px, cy - 4.5)
      ctx.lineTo(px, cy + 4.5)
      ctx.stroke()
    }
    return true
  },
}

export const addRowRenderer: CustomRenderer<AddRowCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is AddRowCell => (c.data as any).kind === 'qj-add-row',
  needsHover: true,
  draw: (args) => {
    const { ctx, rect, theme, hoverAmount } = args
    const cy = rect.y + rect.height / 2
    if (hoverAmount > 0.05) {
      ctx.fillStyle = palette.rowHover
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    }
    const active = hoverAmount > 0.05
    const cx = rect.x + INDEX_W / 2
    ctx.strokeStyle = active ? palette.accent : theme.textLight
    ctx.lineWidth = 1.55
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(cx - 5, cy)
    ctx.lineTo(cx + 5, cy)
    ctx.moveTo(cx, cy - 5)
    ctx.lineTo(cx, cy + 5)
    ctx.stroke()

    if (rect.width > INDEX_W + 40) {
      ctx.font = theme.baseFontFull
      ctx.textBaseline = 'middle'
      ctx.fillStyle = active ? palette.accent : theme.textLight
      ctx.fillText('添加记录', rect.x + INDEX_W + theme.cellHorizontalPadding, cy)
    }
    return true
  },
}

export const summaryRenderer: CustomRenderer<SummaryCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is SummaryCell => (c.data as any).kind === 'qj-summary',
  needsHover: true,
  draw: (args, cell) => {
    const { ctx, rect, theme, hoverAmount } = args
    const { label, value, isPrimary, editable } = cell.data
    const cy = rect.y + rect.height / 2
    const pad = theme.cellHorizontalPadding
    const hovered = editable && hoverAmount > 0.08

    if (hovered) {
      ctx.fillStyle = palette.chipBg
      ctx.beginPath()
      roundedRect(ctx, rect.x + 3, rect.y + 4, rect.width - 6, rect.height - 8, 5)
      ctx.fill()
    }

    ctx.textBaseline = 'middle'
    if (!label && !value) {
      if (hovered && rect.width > 64) {
        ctx.font = `12px ${theme.fontFamily}`
        ctx.fillStyle = theme.textLight
        ctx.textAlign = 'right'
        ctx.fillText('选择统计 ▾', rect.x + rect.width - pad, cy)
        ctx.textAlign = 'start'
      }
      return true
    }

    const caretW = hovered ? 12 : 0
    if (isPrimary) {
      let x = rect.x + pad
      ctx.font = `12px ${theme.fontFamily}`
      ctx.fillStyle = theme.textLight
      ctx.fillText(label, x, cy)
      x += ctx.measureText(label).width + 5
      ctx.font = `600 12.5px ${theme.fontFamily}`
      ctx.fillStyle = theme.textDark
      ctx.fillText(value, x, cy)
      if (hovered) {
        x += ctx.measureText(value).width + 4
        ctx.font = `11px ${theme.fontFamily}`
        ctx.fillStyle = theme.textLight
        ctx.fillText('▾', x, cy)
      }
    } else {
      let right = rect.x + rect.width - pad
      if (hovered) {
        ctx.font = `11px ${theme.fontFamily}`
        ctx.fillStyle = theme.textLight
        ctx.textAlign = 'right'
        ctx.fillText('▾', right, cy)
        right -= caretW
      }
      ctx.font = `600 12.5px ${theme.fontFamily}`
      ctx.fillStyle = theme.textDark
      ctx.textAlign = 'right'
      ctx.fillText(value, right, cy)
      right -= ctx.measureText(value).width + 5
      if (right - (rect.x + pad) > 20) {
        ctx.font = `12px ${theme.fontFamily}`
        ctx.fillStyle = theme.textLight
        ctx.fillText(label, right, cy)
      }
      ctx.textAlign = 'start'
    }
    return true
  },
}

export const customRenderers = [valueRenderer, indexRenderer, groupRenderer, addRowRenderer, summaryRenderer]
