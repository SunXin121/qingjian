import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { IconChevron, IconPlus } from '../components/icons'
import { addDays, calendarEndField, calendarField, dayOf, dayStr, diffDays, parseDay } from './CalendarView'
import { cellMatches, cellValue, choiceOf, displayText, groupLabel, groupPaths, groupRows, primaryField, searchNeedle, viewRecords, visibleFields } from './engine'
import type { CellChange, TableModel } from './model'
import { baseField, type Field, type GanttScale, type Rec, type TableData, type View } from './types'

interface Props {
  model: TableModel
  table: TableData
  view: View
  readOnly: boolean
  onOpenRecord: (id: string, list: string[]) => void
  search?: string
  onSearchCount?: (n: number) => void
}

const DAY = 86_400_000
const ROW_H = 36
const HEAD_H = 52
/** pixels per day */
const DAY_W: Record<GanttScale, number> = { day: 36, week: 16, month: 5 }
/** days a record scheduled by clicking the timeline spans */
const NEW_SPAN: Record<GanttScale, number> = { day: 3, week: 7, month: 30 }
const SCALES: { value: GanttScale; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
]
/** rows rendered above / below the visible ones */
const OVERSCAN = 8
/** pointer movement before a press on a bar becomes a drag */
const DRAG_SLOP = 4

/** Fields that can colour the bars. */
export const ganttColorOk = (f: Field) => f.type === 'select'
/** Fields drawn as progress inside the bars. */
export const ganttProgressOk = (f: Field) => baseField(f).type === 'progress'
/** Link fields pointing at the table itself, usable as predecessors. */
export const ganttDepOk = (t: TableData) => (f: Field) => f.type === 'link' && f.options.table === t.id

const linkIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Value for a date cell on `day`, keeping the time of day of the current value. */
const withTime = (f: Field, day: string, cur: any) => day + (f.options.time ? (typeof cur === 'string' && cur.length > 10 ? cur.slice(10) : ' 09:00') : '')

type Unit = 'day' | 'week' | 'month' | 'year'

interface Period {
  off: number
  len: number
  date: Date
}

/** Calendar periods covering [lo, lo + days), clipped to it, as day offsets from lo. */
function periods(lo: string, days: number, unit: Unit): Period[] {
  const start = parseDay(lo)
  const cur = new Date(start)
  if (unit === 'week') cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7))
  else if (unit === 'month') cur.setDate(1)
  else if (unit === 'year') cur.setMonth(0, 1)
  const out: Period[] = []
  for (;;) {
    const a = Math.max(0, Math.round((cur.getTime() - start.getTime()) / DAY))
    if (a >= days) break
    const next = new Date(cur)
    if (unit === 'day') next.setDate(next.getDate() + 1)
    else if (unit === 'week') next.setDate(next.getDate() + 7)
    else if (unit === 'month') next.setMonth(next.getMonth() + 1)
    else next.setFullYear(next.getFullYear() + 1)
    const b = Math.min(days, Math.round((next.getTime() - start.getTime()) / DAY))
    out.push({ off: a, len: b - a, date: new Date(cur) })
    cur.setTime(next.getTime())
  }
  return out
}

const mondayOf = (s: string) => addDays(s, -((parseDay(s).getDay() + 6) % 7))

interface Drag {
  id: string
  mode: 'move' | 'start' | 'end'
  x0: number
  delta: number
  moved: boolean
}

type Span = [string, string]

/** Records as bars on a time line; bars can be moved and resized, predecessors are drawn as arrows. */
export default function GanttView({ model, table, view, readOnly, onOpenRecord, search = '', onSearchCount }: Props) {
  const cfg = view.config
  const field = calendarField(table, view)
  const end = calendarEndField(table, view)
  const color = table.fields.find((f) => f.id === cfg.colorField && ganttColorOk(f))
  const progress = table.fields.find((f) => f.id === cfg.progressField && ganttProgressOk(f))
  const dep = table.fields.find((f) => f.id === cfg.depField && ganttDepOk(table)(f))
  const primary = primaryField(table)
  const needle = searchNeedle(search)
  const records = useMemo(() => {
    const list = viewRecords(table, view, model.sticky)
    if (!needle) return list
    const fields = visibleFields(table, view)
    return list.filter((r) => fields.some((f) => cellMatches(f, r, needle)))
  }, [table, view, model, needle])
  useLayoutEffect(() => onSearchCount?.(records.length), [records.length, onSearchCount])

  const writable = !readOnly && field?.type === 'date' && (!end || end.type === 'date')
  const endWritable = writable && end?.type === 'date'
  const [scale, setScaleState] = useState<GanttScale>(cfg.ganttScale ?? 'day')
  useEffect(() => {
    if (cfg.ganttScale) setScaleState(cfg.ganttScale)
  }, [cfg.ganttScale])
  const setScale = (s: GanttScale) => {
    setScaleState(s)
    if (!readOnly) model.updateView(view.id, { ganttScale: s })
  }
  const dw = DAY_W[scale]
  const today = dayStr(new Date())
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 600px)')
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const listW = narrow ? 128 : 240

  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const [hover, setHover] = useState<{ id: string; off: number } | null>(null)

  /** start / end day of a record (end ≥ start), with the bar being dragged moved. */
  const spanOf = (r: Rec): Span | null => {
    if (!field) return null
    const s = dayOf(cellValue(r, field))
    if (!s) return null
    let e = end ? dayOf(cellValue(r, end)) : undefined
    if (!e || e < s) e = s
    if (drag?.moved && drag.id === r.id && drag.delta) {
      const d = drag.delta
      if (drag.mode === 'move') return [addDays(s, d), addDays(e, d)]
      if (drag.mode === 'start') {
        const ns = addDays(s, d)
        return [ns > e ? e : ns, e]
      }
      const ne = addDays(e, d)
      return [s, ne < s ? s : ne]
    }
    return [s, e]
  }

  // time range: every scheduled record plus some months around today, padded and aligned
  const { lo, days } = useMemo(() => {
    let lo = addDays(today, -30)
    let hi = addDays(today, 120)
    if (field)
      for (const r of records) {
        const s = dayOf(cellValue(r, field))
        if (!s) continue
        let e = end ? dayOf(cellValue(r, end)) : undefined
        if (!e || e < s) e = s
        if (s < lo) lo = s
        if (e > hi) hi = e
      }
    const min = addDays(today, -3650)
    const max = addDays(today, 3650)
    if (lo < min) lo = min
    if (hi > max) hi = max
    const pad = scale === 'day' ? 14 : scale === 'week' ? 56 : 120
    lo = addDays(lo, -pad)
    hi = addDays(hi, pad)
    if (scale === 'month') {
      lo = lo.slice(0, 8) + '01'
      const h = parseDay(hi)
      hi = dayStr(new Date(h.getFullYear(), h.getMonth() + 1, 0))
    } else {
      lo = mondayOf(lo)
      hi = addDays(mondayOf(hi), 6)
    }
    return { lo, days: diffDays(hi, lo) + 1 }
  }, [records, field, end, scale, today])
  const tw = days * dw

  const upper = useMemo(() => periods(lo, days, scale === 'month' ? 'year' : 'month'), [lo, days, scale])
  const lower = useMemo(() => periods(lo, days, scale), [lo, days, scale])

  const rules = view.config.groups ?? []
  const collapsed = useMemo(() => new Set(view.config.collapsed ?? []), [view.config.collapsed])
  const rows = useMemo(() => groupRows(table, records, rules, collapsed), [table, records, rules, collapsed])
  const ids = useMemo(() => records.map((r) => r.id), [records])

  // span of every group, from the records under it
  const groupSpans = useMemo(() => {
    const out = new Map<string, Span>()
    if (!rules.length || !field) return out
    for (const r of records) {
      const s = dayOf(cellValue(r, field))
      if (!s) continue
      let e = end ? dayOf(cellValue(r, end)) : undefined
      if (!e || e < s) e = s
      for (const p of groupPaths(table, r, rules)) {
        const cur = out.get(p)
        out.set(p, cur ? [s < cur[0] ? s : cur[0], e > cur[1] ? e : cur[1]] : [s, e])
      }
    }
    return out
  }, [table, records, rules, field, end])

  // ---------- scrolling ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const [vp, setVp] = useState({ top: 0, h: 600 })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setVp((v) => (v.top === el.scrollTop && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight })))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [!!field])

  // keep the date in the middle of the time line when the range or the scale changes; start at today
  const anchor = useRef<{ lo: string; dw: number } | null>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const half = (el.clientWidth - listW) / 2
    const prev = anchor.current
    if (!prev) el.scrollLeft = diffDays(today, lo) * dw - half / 2
    else if (prev.lo !== lo || prev.dw !== dw) el.scrollLeft = ((el.scrollLeft + half) / prev.dw + diffDays(prev.lo, lo)) * dw - half
    anchor.current = { lo, dw }
  }, [lo, dw, !!field])

  if (!field)
    return (
      <div className="bt-kanban-empty">
        <p>甘特图按日期排布记录，请先添加一个日期字段。</p>
      </div>
    )

  const title = (r: Rec) => (primary && displayText(primary, cellValue(r, primary))) || '未命名记录'
  const xOf = (day: string) => diffDays(day, lo) * dw
  const page = (n: number) => {
    const el = scrollRef.current
    if (el) el.scrollBy({ left: n * (el.clientWidth - listW) * 0.8, behavior: 'smooth' })
  }
  const goToday = () => {
    const el = scrollRef.current
    if (el) el.scrollTo({ left: xOf(today) - (el.clientWidth - listW) / 3, behavior: 'smooth' })
  }
  const toggleGroup = (path: string) => {
    const s = new Set(collapsed)
    if (s.has(path)) s.delete(path)
    else s.add(path)
    model.updateView(view.id, { collapsed: [...s] })
  }

  const add = () => {
    const data: Record<string, any> = { [field.id]: withTime(field, today, undefined) }
    if (endWritable) data[end!.id] = withTime(end!, addDays(today, NEW_SPAN[scale] - 1), undefined)
    const [id] = model.addRecords([data])
    onOpenRecord(id, [...ids, id])
  }

  const schedule = (r: Rec, off: number) => {
    const day = addDays(lo, off)
    const changes: CellChange[] = [{ rec: r.id, field: field.id, value: withTime(field, day, r.data[field.id]) }]
    if (endWritable && !dayOf(r.data[end!.id])) changes.push({ rec: r.id, field: end!.id, value: withTime(end!, addDays(day, NEW_SPAN[scale] - 1), undefined) })
    model.setCells(changes)
    setHover(null)
  }

  // ---------- dragging bars ----------
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>, r: Rec) => {
    if (!writable || e.button !== 0) return
    const edge = (e.target as HTMLElement).dataset.edge
    const mode: Drag['mode'] = edge === 'start' || edge === 'end' ? edge : 'move'
    if (mode !== 'move' && !endWritable) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { id: r.id, mode, x0: e.clientX, delta: 0, moved: false }
  }
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.x0
    if (!d.moved && Math.abs(dx) < DRAG_SLOP) return
    const delta = Math.round(dx / dw)
    if (d.moved && delta === d.delta) return
    dragRef.current = { ...d, moved: true, delta }
    setDrag(dragRef.current)
  }
  const onBarUp = (r: Rec) => {
    const d = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!d) return
    if (!d.moved) return onOpenRecord(r.id, ids)
    if (!d.delta) return
    const s0 = dayOf(r.data[field.id])
    if (!s0) return
    const e0 = end ? dayOf(r.data[end.id]) : undefined
    const e = e0 && e0 >= s0 ? e0 : s0
    let ns = s0
    let ne = e
    if (d.mode === 'move') {
      ns = addDays(s0, d.delta)
      ne = addDays(e, d.delta)
    } else if (d.mode === 'start') {
      ns = addDays(s0, d.delta)
      if (ns > e) ns = e
    } else {
      ne = addDays(e, d.delta)
      if (ne < s0) ne = s0
    }
    const changes: CellChange[] = []
    if (ns !== s0) changes.push({ rec: r.id, field: field.id, value: withTime(field, ns, r.data[field.id]) })
    if (endWritable && (e0 ? ne !== e0 : d.mode === 'end' && ne !== ns)) changes.push({ rec: r.id, field: end!.id, value: withTime(end!, ne, r.data[end!.id]) })
    if (changes.length) model.setCells(changes)
  }
  const onBarCancel = () => {
    dragRef.current = null
    setDrag(null)
  }

  // ---------- rows ----------
  const bodyTop = Math.max(0, vp.top)
  const first = Math.max(0, Math.floor(bodyTop / ROW_H) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((bodyTop + vp.h) / ROW_H) + OVERSCAN)
  const bodyH = (rows.length + (writable ? 1 : 0)) * ROW_H

  // dependency arrows between the bars of expanded rows
  const arrows = dependencyArrows(dep, rows, spanOf, xOf, dw)

  const colorOf = (r: Rec) => {
    if (!color) return undefined
    return choiceOf(color, r.data[color.id])?.color
  }

  const upperLabel = (p: Period) => (scale === 'month' ? `${p.date.getFullYear()} 年` : `${p.date.getFullYear()} 年 ${p.date.getMonth() + 1} 月`)
  const lowerLabel = (p: Period) => (scale === 'day' ? String(p.date.getDate()) : scale === 'week' ? `${p.date.getMonth() + 1}/${p.date.getDate()}` : `${p.date.getMonth() + 1} 月`)

  return (
    <div className={'bt-gantt' + (drag?.moved ? ' dragging' : '')}>
      <div className="bt-cal-head">
        <button className="icon-btn" title="向前" onClick={() => page(-1)}>
          <IconChevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button className="btn sm" onClick={goToday}>
          今天
        </button>
        <button className="icon-btn" title="向后" onClick={() => page(1)}>
          <IconChevron width={16} height={16} />
        </button>
        <span className="spacer" />
        <div className="seg">
          {SCALES.map((s) => (
            <button key={s.value} className={scale === s.value ? 'active' : ''} onClick={() => setScale(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="bt-gantt-scroll" ref={scrollRef}>
        <div className="bt-gantt-canvas" style={{ width: listW + tw }}>
          <div className="bt-gantt-header" style={{ height: HEAD_H }}>
            <div className="bt-gantt-corner" style={{ width: listW }}>
              {primary?.name}
            </div>
            <div className="bt-gantt-scale" style={{ width: tw }}>
              <div className="bt-gantt-scale-row">
                {upper.map((p) => (
                  <div key={p.off} className="bt-gantt-unit upper" style={{ left: p.off * dw, width: p.len * dw }}>
                    <span style={{ left: listW + 8 }}>{upperLabel(p)}</span>
                  </div>
                ))}
              </div>
              <div className="bt-gantt-scale-row">
                {lower.map((p) => {
                  const d = p.date.getDay()
                  const isToday = scale === 'day' && dayStr(p.date) === today
                  return (
                    <div
                      key={p.off}
                      className={'bt-gantt-unit' + (scale === 'day' && (d === 0 || d === 6) ? ' weekend' : '') + (isToday ? ' today' : '')}
                      style={{ left: p.off * dw, width: p.len * dw }}
                    >
                      {p.len * dw >= 18 && <span>{lowerLabel(p)}</span>}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          <div className="bt-gantt-body" style={{ height: bodyH }}>
            <div className="bt-gantt-bg" style={{ left: listW, width: tw }}>
              {lower.map((p) => {
                const d = p.date.getDay()
                return <div key={p.off} className={'bt-gantt-col' + (scale === 'day' && (d === 0 || d === 6) ? ' weekend' : '')} style={{ left: p.off * dw, width: p.len * dw }} />
              })}
              {today >= lo && <div className="bt-gantt-today" style={{ left: xOf(today) + dw / 2 }} />}
            </div>
            {arrows.length > 0 && (
              <svg className="bt-gantt-deps" style={{ left: listW }} width={tw} height={bodyH}>
                <defs>
                  <marker id="bt-gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0L8 4L0 8z" className="bt-gantt-head" />
                  </marker>
                  <marker id="bt-gantt-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0L8 4L0 8z" className="bt-gantt-head bad" />
                  </marker>
                </defs>
                {arrows.map((a) => (
                  <path key={a.key} d={a.d} className={'bt-gantt-dep' + (a.bad ? ' bad' : '')} markerEnd={`url(#bt-gantt-arrow${a.bad ? '-bad' : ''})`}>
                    {a.bad && <title>开始早于前置任务结束</title>}
                  </path>
                ))}
              </svg>
            )}
            {rows.slice(first, last).map((row, k) => {
              const i = first + k
              if (row.kind === 'group') {
                const sp = groupSpans.get(row.path)
                return (
                  <div key={'g' + row.path} className="bt-gantt-row group" style={{ top: i * ROW_H, height: ROW_H }}>
                    <button className="bt-gantt-cell" style={{ width: listW, paddingLeft: 8 + row.depth * 14 }} onClick={() => toggleGroup(row.path)}>
                      <IconChevron width={14} height={14} className={'bt-gantt-chev' + (row.collapsed ? '' : ' open')} />
                      <span className="ellipsis">{groupLabel(row.field, row.key)}</span>
                      <span className="bt-gantt-count">{row.count}</span>
                    </button>
                    <div className="bt-gantt-track" style={{ width: tw }}>
                      {sp && <div className="bt-gantt-summary" style={{ left: xOf(sp[0]), width: (diffDays(sp[1], sp[0]) + 1) * dw }} />}
                    </div>
                  </div>
                )
              }
              const r = row.rec
              const sp = spanOf(r)
              const name = title(r)
              const indent = rules.length ? 8 + rules.length * 14 : 12
              return (
                <div key={r.id} className="bt-gantt-row" style={{ top: i * ROW_H, height: ROW_H }}>
                  <button className="bt-gantt-cell" style={{ width: listW, paddingLeft: indent }} onClick={() => onOpenRecord(r.id, ids)} title={name}>
                    <span className="ellipsis">{name}</span>
                  </button>
                  <div
                    className={'bt-gantt-track' + (!sp && writable ? ' schedulable' : '')}
                    style={{ width: tw }}
                    onMouseMove={
                      !sp && writable
                        ? (e) => {
                            const off = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / dw)
                            if (hover?.id !== r.id || hover.off !== off) setHover({ id: r.id, off })
                          }
                        : undefined
                    }
                    onMouseLeave={() => hover?.id === r.id && setHover(null)}
                    onClick={
                      !sp && writable
                        ? (e) => {
                            if (e.target !== e.currentTarget) return
                            schedule(r, Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left) / dw))
                          }
                        : undefined
                    }
                  >
                    {sp ? (
                      <Bar
                        rec={r}
                        span={sp}
                        name={name}
                        left={xOf(sp[0])}
                        width={(diffDays(sp[1], sp[0]) + 1) * dw}
                        color={colorOf(r)}
                        progress={progress ? cellValue(r, progress) : undefined}
                        resizable={endWritable}
                        draggable={writable}
                        dragging={drag?.moved === true && drag.id === r.id}
                        onDown={onBarDown}
                        onMove={onBarMove}
                        onUp={onBarUp}
                        onCancel={onBarCancel}
                        onOpen={() => onOpenRecord(r.id, ids)}
                      />
                    ) : hover?.id === r.id ? (
                      <div className="bt-gantt-ghost" style={{ left: hover.off * dw, width: (endWritable ? NEW_SPAN[scale] : 1) * dw }}>
                        <span>点击安排</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {writable && (
              <div className="bt-gantt-row add" style={{ top: rows.length * ROW_H, height: ROW_H }}>
                <button className="bt-gantt-cell" style={{ width: listW }} onClick={add}>
                  <IconPlus width={14} height={14} /> 新建记录
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface BarProps {
  rec: Rec
  span: Span
  name: string
  left: number
  width: number
  color?: number
  progress?: any
  resizable: boolean
  draggable: boolean
  dragging: boolean
  onDown: (e: ReactPointerEvent<HTMLDivElement>, r: Rec) => void
  onMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onUp: (r: Rec) => void
  onCancel: () => void
  onOpen: () => void
}

function Bar({ rec, span, name, left, width, color, progress, resizable, draggable, dragging, onDown, onMove, onUp, onCancel, onOpen }: BarProps) {
  const n = diffDays(span[1], span[0]) + 1
  const p = typeof progress === 'number' ? Math.max(0, Math.min(1, progress)) : undefined
  const w = Math.max(width, 6)
  return (
    <>
      <div
        className={'bt-gantt-bar' + (color !== undefined ? ` c${color % 10}` : '') + (draggable ? ' draggable' : '') + (dragging ? ' dragging' : '')}
        style={{ left, width: w }}
        title={`${name}\n${span[0] === span[1] ? span[0] : `${span[0]} → ${span[1]}`}（${n} 天）${p !== undefined ? `\n进度 ${Math.round(p * 100)}%` : ''}`}
        onPointerDown={draggable ? (e) => onDown(e, rec) : undefined}
        onPointerMove={draggable ? onMove : undefined}
        onPointerUp={draggable ? () => onUp(rec) : undefined}
        onPointerCancel={draggable ? onCancel : undefined}
        onClick={draggable ? undefined : onOpen}
      >
        {p !== undefined && <div className="bt-gantt-fill" style={{ width: `${p * 100}%` }} />}
        {w >= 72 && <span className="bt-gantt-label">{name}</span>}
        {resizable && (
          <>
            <span className="bt-gantt-handle start" data-edge="start" />
            <span className="bt-gantt-handle end" data-edge="end" />
          </>
        )}
      </div>
      {w < 72 && (
        <span className="bt-gantt-outlabel" style={{ left: left + w + 6 }}>
          {name}
        </span>
      )}
      {dragging && (
        <span className="bt-gantt-dates" style={{ left }}>
          {span[0].slice(5)} → {span[1].slice(5)}
        </span>
      )}
    </>
  )
}

interface Arrow {
  key: string
  d: string
  bad: boolean
}

/** Elbow arrows from the end of each predecessor's bar to the start of its successor's. */
function dependencyArrows(dep: Field | undefined, rows: ReturnType<typeof groupRows>, spanOf: (r: Rec) => Span | null, xOf: (d: string) => number, dw: number): Arrow[] {
  if (!dep) return []
  const index = new Map<string, number>()
  const spans = new Map<string, Span>()
  rows.forEach((row, i) => {
    if (row.kind !== 'record') return
    const sp = spanOf(row.rec)
    if (!sp) return
    index.set(row.rec.id, i)
    spans.set(row.rec.id, sp)
  })
  const out: Arrow[] = []
  rows.forEach((row, i) => {
    if (row.kind !== 'record') return
    const sp = spans.get(row.rec.id)
    if (!sp) return
    for (const pid of linkIds(row.rec.data[dep.id])) {
      const j = index.get(pid)
      if (j === undefined || pid === row.rec.id) continue
      const ps = spans.get(pid)!
      const x1 = xOf(ps[1]) + dw
      const y1 = j * ROW_H + ROW_H / 2
      const x2 = xOf(sp[0])
      const y2 = i * ROW_H + ROW_H / 2
      let d: string
      if (x2 - x1 >= 16) d = `M${x1} ${y1}H${x1 + 8}V${y2}H${x2 - 1}`
      else {
        const ym = j < i ? i * ROW_H : (i + 1) * ROW_H
        d = `M${x1} ${y1}H${x1 + 8}V${ym}H${x2 - 10}V${y2}H${x2 - 1}`
      }
      out.push({ key: pid + '>' + row.rec.id, d, bad: ps[1] >= sp[0] })
    }
  })
  return out
}
