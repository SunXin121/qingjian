import { useLayoutEffect, useMemo, useState, type DragEvent } from 'react'
import { openPopover } from '../components/dialog'
import { IconChevron, IconPlus } from '../components/icons'
import { cellMatches, cellValue, displayText, fmtDateTime, primaryField, searchNeedle, viewRecords, visibleFields } from './engine'
import type { TableModel } from './model'
import { baseField, type Field, type Rec, type TableData, type View } from './types'

interface Props {
  model: TableModel
  table: TableData
  view: View
  readOnly: boolean
  onOpenRecord: (id: string, list: string[]) => void
  search?: string
  onSearchCount?: (n: number) => void
}

/** Fields a calendar can place records by: dates (formula dates too) and created / modified time. */
export const calendarFieldOk = (f: Field) => baseField(f).type === 'date' || f.type === 'created_time' || f.type === 'modified_time'

export function calendarField(t: TableData, v: View): Field | undefined {
  return t.fields.find((f) => f.id === v.config.dateField && calendarFieldOk(f)) ?? t.fields.find((f) => f.type === 'date') ?? t.fields.find(calendarFieldOk)
}

export function calendarEndField(t: TableData, v: View): Field | undefined {
  return t.fields.find((f) => f.id === v.config.endField && calendarFieldOk(f))
}

const DAY = 86_400_000
const WEEK = ['一', '二', '三', '四', '五', '六', '日']
/** chips shown per day before "+N" */
const MAX_CHIPS = 3
/** longest span a record is drawn over */
const MAX_SPAN = 62

/** YYYY-MM-DD of a date-ish cell value. */
function dayOf(v: any): string | undefined {
  if (typeof v === 'number') return fmtDateTime(v, false)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  return undefined
}

const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const dayStr = (d: Date) => fmtDateTime(d.getTime(), false)
const addDays = (s: string, n: number) => {
  const d = parseDay(s)
  d.setDate(d.getDate() + n)
  return dayStr(d)
}
const diffDays = (a: string, b: string) => Math.round((parseDay(a).getTime() - parseDay(b).getTime()) / DAY)

/** A month grid; records sit on the day of the date field (spanning to the end date if set). */
export default function CalendarView({ model, table, view, readOnly, onOpenRecord, search = '', onSearchCount }: Props) {
  const field = calendarField(table, view)
  const end = calendarEndField(table, view)
  const needle = searchNeedle(search)
  const records = useMemo(() => {
    const list = viewRecords(table, view, model.sticky)
    if (!needle) return list
    const fields = visibleFields(table, view)
    return list.filter((r) => fields.some((f) => cellMatches(f, r, needle)))
  }, [table, view, model, needle])
  useLayoutEffect(() => onSearchCount?.(records.length), [records.length, onSearchCount])
  const today = dayStr(new Date())
  const [month, setMonth] = useState(() => today.slice(0, 7))
  const [drag, setDrag] = useState<{ id: string; from: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const primary = primaryField(table)
  const writable = !readOnly && field?.type === 'date'

  // 6 weeks starting on the Monday on / before the 1st
  const days = useMemo(() => {
    const first = parseDay(month + '-01')
    const start = new Date(first)
    start.setDate(1 - ((first.getDay() + 6) % 7))
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return dayStr(d)
    })
  }, [month])

  const { byDay, unscheduled } = useMemo(() => {
    const byDay = new Map<string, Rec[]>()
    const unscheduled: Rec[] = []
    if (!field) return { byDay, unscheduled }
    const lo = days[0]
    const hi = days[days.length - 1]
    for (const r of records) {
      const s = dayOf(cellValue(r, field))
      if (!s) {
        unscheduled.push(r)
        continue
      }
      let e = end ? dayOf(cellValue(r, end)) : undefined
      if (!e || e < s) e = s
      if (e < lo || s > hi) continue
      const n = Math.min(diffDays(e, s), MAX_SPAN)
      for (let i = 0; i <= n; i++) {
        const d = addDays(s, i)
        if (d < lo) continue
        if (d > hi) break
        let l = byDay.get(d)
        if (!l) byDay.set(d, (l = []))
        l.push(r)
      }
    }
    return { byDay, unscheduled }
  }, [records, field, end, days])

  if (!field)
    return (
      <div className="bt-kanban-empty">
        <p>日历按日期字段排布记录，请先添加一个日期字段。</p>
      </div>
    )

  const ids = records.map((r) => r.id)
  const title = (r: Rec) => (primary && displayText(primary, cellValue(r, primary))) || '未命名记录'
  const shift = (n: number) => {
    const d = parseDay(month + '-01')
    d.setMonth(d.getMonth() + n)
    setMonth(dayStr(d).slice(0, 7))
  }
  const withTime = (day: string, cur: any) => day + (field.options.time ? (typeof cur === 'string' && cur.length > 10 ? cur.slice(10) : ' 09:00') : '')

  const add = (day: string) => {
    const [id] = model.addRecords([{ [field.id]: withTime(day, undefined) }])
    onOpenRecord(id, [...ids, id])
  }

  const drop = (e: DragEvent, day: string) => {
    e.preventDefault()
    setOver(null)
    if (!drag) return
    const rec = model.record(drag.id)
    setDrag(null)
    if (!rec) return
    const start = dayOf(rec.data[field.id])
    const delta = start ? diffDays(day, drag.from) : 0
    const nextStart = start ? addDays(start, delta) : day
    if (nextStart === start) return
    const changes = [{ rec: rec.id, field: field.id, value: withTime(nextStart, rec.data[field.id]) }]
    // keep the duration when there is an end date
    const e0 = end?.type === 'date' ? dayOf(rec.data[end.id]) : undefined
    if (end && e0) changes.push({ rec: rec.id, field: end.id, value: (end.options.time ? addDays(e0, delta) + (rec.data[end.id].slice(10) || '') : addDays(e0, delta)) })
    model.sticky.add(rec.id)
    model.setCells(changes)
  }

  const listPopover = (el: HTMLElement, list: Rec[], heading: string) =>
    openPopover(
      el,
      (close) => (
        <div className="bt-cal-pop">
          <div className="bt-panel-title">{heading}</div>
          {list.map((r) => (
            <button
              key={r.id}
              className="bt-cal-chip"
              onClick={() => {
                close()
                onOpenRecord(r.id, list.map((x) => x.id))
              }}
            >
              <span className="ellipsis">{title(r)}</span>
            </button>
          ))}
        </div>
      ),
      { width: 260 },
    )

  const [y, m] = month.split('-').map(Number)
  return (
    <div className="bt-cal">
      <div className="bt-cal-head">
        <button className="icon-btn" title="上个月" onClick={() => shift(-1)}>
          <IconChevron width={16} height={16} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <div className="bt-cal-month">
          {y} 年 {m} 月
        </div>
        <button className="icon-btn" title="下个月" onClick={() => shift(1)}>
          <IconChevron width={16} height={16} />
        </button>
        <button className="btn sm" onClick={() => setMonth(today.slice(0, 7))}>
          今天
        </button>
        <span className="spacer" />
        {unscheduled.length > 0 && (
          <button className="btn ghost sm" onClick={(e) => listPopover(e.currentTarget, unscheduled, `「${field.name}」为空的记录`)}>
            未安排 {unscheduled.length}
          </button>
        )}
      </div>
      <div className="bt-cal-grid">
        {WEEK.map((w, i) => (
          <div key={w} className={'bt-cal-week' + (i >= 5 ? ' weekend' : '')}>
            {w}
          </div>
        ))}
        {days.map((d) => {
          const list = byDay.get(d) ?? []
          const shown = list.slice(0, MAX_CHIPS)
          return (
            <div
              key={d}
              className={'bt-cal-day' + (d.slice(0, 7) !== month ? ' other' : '') + (d === today ? ' today' : '') + (over === d ? ' over' : '')}
              onDragOver={(e) => {
                if (!drag) return
                e.preventDefault()
                if (over !== d) setOver(d)
              }}
              onDragLeave={() => over === d && setOver(null)}
              onDrop={(e) => drop(e, d)}
              onDoubleClick={(e) => writable && e.target === e.currentTarget && add(d)}
            >
              <div className="bt-cal-date">
                <span>{Number(d.slice(8))}</span>
                {writable && (
                  <button className="icon-btn sm bt-cal-add" title="新建记录" onClick={() => add(d)}>
                    <IconPlus width={13} height={13} />
                  </button>
                )}
              </div>
              {shown.map((r) => {
                const s = dayOf(cellValue(r, field))
                return (
                  <button
                    key={r.id}
                    className={'bt-cal-chip' + (end && s !== d ? ' cont' : '')}
                    draggable={writable}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', r.id)
                      setDrag({ id: r.id, from: d })
                    }}
                    onDragEnd={() => {
                      setDrag(null)
                      setOver(null)
                    }}
                    onClick={() => onOpenRecord(r.id, ids)}
                    title={title(r)}
                  >
                    <span className="ellipsis">{title(r)}</span>
                  </button>
                )
              })}
              {list.length > MAX_CHIPS && (
                <button className="bt-cal-more" onClick={(e) => listPopover(e.currentTarget, list, `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8))} 日`)}>
                  还有 {list.length - MAX_CHIPS} 条
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
