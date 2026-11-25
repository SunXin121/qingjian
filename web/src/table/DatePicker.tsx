import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Calendar, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Clock, X } from 'lucide-react'
import { openPopover, type Anchor } from '../components/dialog'
import { fmtDateTime, todayStr } from './engine'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const MINUTES = Array.from({ length: 60 }, (_, i) => i)
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

const pad2 = (n: number) => String(n).padStart(2, '0')
const pad4 = (n: number) => String(n).padStart(4, '0')

export interface CalendarCell {
  date: string
  day: number
  inMonth: boolean
}

/** Builds a 6×7 Monday-first calendar grid for `year` and 1-based `month` (1..12). */
export function calendarMonthDays(year: number, month: number): CalendarCell[] {
  const first = new Date(0)
  first.setFullYear(year, month - 1, 1)
  first.setHours(0, 0, 0, 0)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(0)
    d.setFullYear(year, month - 1, 1 - offset + i)
    d.setHours(0, 0, 0, 0)
    const y = d.getFullYear()
    const m = d.getMonth() + 1
    const day = d.getDate()
    return {
      date: `${pad4(y)}-${pad2(m)}-${pad2(day)}`,
      day,
      inMonth: y === year && m === month,
    }
  })
}

export function splitDateValue(v: unknown): { day: string; hour: number; minute: number } {
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(v.trim())
    if (m) {
      return {
        day: `${m[1]}-${m[2]}-${m[3]}`,
        hour: m[4] !== undefined ? Math.min(23, Math.max(0, Number(m[4]))) : 0,
        minute: m[5] !== undefined ? Math.min(59, Math.max(0, Number(m[5]))) : 0,
      }
    }
  }
  return { day: '', hour: 0, minute: 0 }
}

export function composeDateValue(day: string, hour: number, minute: number, withTime: boolean): string | undefined {
  if (!day) return undefined
  return withTime ? `${day} ${pad2(hour)}:${pad2(minute)}` : day
}

function validCalendarParts(y: number, m: number, d: number, h: number, min: number): boolean {
  if (y < 100 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31 || h < 0 || h > 23 || min < 0 || min > 59) return false
  const dt = new Date(0)
  dt.setFullYear(y, m - 1, d)
  dt.setHours(0, 0, 0, 0)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

const reFull = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:分(?:\d{1,2}秒?)?|[:：]\d{1,2}秒?)?)?$/
const reCompact = /^(\d{4})(\d{2})(\d{2})(?:[ T]+(\d{2}):?(\d{2}))?$/
const reShort = /^(\d{1,2})[-/.月](\d{1,2})日?(?:[ T]+(\d{1,2})[:：时](\d{1,2})(?:分(?:\d{1,2}秒?)?|[:：]\d{1,2}秒?)?)?$/

/**
 * Parses interactive date/datetime input strictly (rejecting rolled-over dates like Feb 30)
 * and supports YYYY-MM-DD, YYYY/M/D, YYYY年M月D日, YYYYMMDD, and shorthand M-D / M/D.
 */
export function parsePickerInput(raw: string, withTime: boolean, refYear = new Date().getFullYear()): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  let y: number
  let m: number
  let d: number
  let h: number
  let min: number
  const mf = reFull.exec(s) ?? reCompact.exec(s)
  if (mf) {
    y = Number(mf[1])
    m = Number(mf[2])
    d = Number(mf[3])
    h = mf[4] !== undefined ? Number(mf[4]) : 0
    min = mf[5] !== undefined ? Number(mf[5]) : 0
  } else {
    const ms = reShort.exec(s)
    if (!ms) return undefined
    y = refYear
    m = Number(ms[1])
    d = Number(ms[2])
    h = ms[3] !== undefined ? Number(ms[3]) : 0
    min = ms[4] !== undefined ? Number(ms[4]) : 0
  }
  if (!validCalendarParts(y, m, d, h, min)) return undefined
  return composeDateValue(`${pad4(y)}-${pad2(m)}-${pad2(d)}`, h, min, withTime)
}

export interface DatePickerProps {
  value: string | undefined
  withTime?: boolean
  initialText?: string
  /** Live draft callback (e.g. Glide overlay cell state before finishing). */
  onDraftChange?: (v: string | undefined) => void
  /** Final commit callback when user confirms a date/time or closes the picker. */
  onCommit: (v: string | undefined, movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => void
  onCancel?: () => void
}

export function DatePicker({ value, withTime = false, initialText, onDraftChange, onCommit, onCancel }: DatePickerProps) {
  const today = todayStr()
  const initParsed = initialText !== undefined ? parsePickerInput(initialText, withTime) : value
  const initParts = splitDateValue(initParsed)
  const baseParts = splitDateValue(initParts.day ? initParsed : today)

  const [selectedDay, setSelectedDay] = useState(initParts.day)
  const [hour, setHour] = useState(initParts.hour)
  const [minute, setMinute] = useState(initParts.minute)
  const [viewYear, setViewYear] = useState(() => Number(baseParts.day.slice(0, 4)) || new Date().getFullYear())
  const [viewMonth, setViewMonth] = useState(() => Number(baseParts.day.slice(5, 7)) || new Date().getMonth() + 1)
  const [ymMode, setYmMode] = useState<'day' | 'month'>('day')
  const [text, setText] = useState(() => (initialText !== undefined ? initialText : (value ?? '')))
  const [invalid, setInvalid] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const hourListRef = useRef<HTMLDivElement>(null)
  const minListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const focus = () => {
      const el = inputRef.current
      if (el && document.activeElement !== el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
    const raf = requestAnimationFrame(focus)
    const t = setTimeout(focus, 50)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [])

  // Center the active hour & minute in the time columns without page scroll jumps
  useLayoutEffect(() => {
    if (!withTime) return
    for (const box of [hourListRef.current, minListRef.current]) {
      const active = box?.querySelector<HTMLElement>('.bt-dp-time-btn.active')
      if (box && active) {
        box.scrollTop = Math.max(0, active.offsetTop - (box.clientHeight - active.offsetHeight) / 2)
      }
    }
  }, [withTime, hour, minute])

  const days = useMemo(() => calendarMonthDays(viewYear, viewMonth), [viewYear, viewMonth])
  const todayYear = Number(today.slice(0, 4))
  const todayMonth = Number(today.slice(5, 7))

  const shiftMonth = (delta: number) => {
    const d = new Date(0)
    d.setFullYear(viewYear, viewMonth - 1 + delta, 1)
    setViewYear(d.getFullYear())
    setViewMonth(d.getMonth() + 1)
  }

  const shiftYear = (delta: number) => {
    setViewYear((y) => Math.max(100, Math.min(9999, y + delta)))
  }

  const syncSelection = (day: string, h: number, m: number, syncInput = true) => {
    setSelectedDay(day)
    setHour(h)
    setMinute(m)
    setInvalid(false)
    if (day) {
      setViewYear(Number(day.slice(0, 4)))
      setViewMonth(Number(day.slice(5, 7)))
    }
    const next = composeDateValue(day, h, m, withTime)
    if (syncInput) setText(next ?? '')
    onDraftChange?.(next)
    return next
  }

  const handleInputChange = (raw: string) => {
    setText(raw)
    setInvalid(false)
    if (!raw.trim()) {
      setSelectedDay('')
      onDraftChange?.(undefined)
      return
    }
    const parsed = parsePickerInput(raw, withTime, viewYear)
    if (parsed) {
      const p = splitDateValue(parsed)
      setSelectedDay(p.day)
      setHour(p.hour)
      setMinute(p.minute)
      setViewYear(Number(p.day.slice(0, 4)))
      setViewMonth(Number(p.day.slice(5, 7)))
      onDraftChange?.(parsed)
    }
  }

  const commitInput = (movement?: readonly [-1 | 0 | 1, -1 | 0 | 1]) => {
    const trimmed = text.trim()
    if (!trimmed) {
      onDraftChange?.(undefined)
      onCommit(undefined, movement)
      return
    }
    const parsed = parsePickerInput(trimmed, withTime, viewYear)
    if (!parsed) {
      setInvalid(true)
      inputRef.current?.focus()
      return
    }
    onDraftChange?.(parsed)
    onCommit(parsed, movement)
  }

  const pickDay = (day: string) => {
    setYmMode('day')
    const next = syncSelection(day, hour, minute, true)
    if (!withTime) onCommit(next)
  }

  const pickHour = (h: number) => {
    const day = selectedDay || today
    syncSelection(day, h, minute, true)
  }

  const pickMinute = (m: number, finish = false) => {
    const day = selectedDay || today
    const next = syncSelection(day, hour, m, true)
    if (finish) onCommit(next)
  }

  const pickToday = () => {
    if (!withTime) {
      const next = syncSelection(today, 0, 0, true)
      onCommit(next)
    } else {
      syncSelection(today, hour, minute, true)
    }
  }

  const pickNow = () => {
    const nowStr = fmtDateTime(Date.now(), true)
    const p = splitDateValue(nowStr)
    const next = syncSelection(p.day, p.hour, p.minute, true)
    onCommit(next)
  }

  const clear = () => {
    syncSelection('', 0, 0, true)
    onCommit(undefined)
  }

  return (
    <div className={'bt-dp' + (withTime ? ' with-time' : '')} onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <div className="bt-dp-top">
        <div className={'bt-dp-input-wrap' + (invalid ? ' invalid' : '')}>
          <Calendar size={14} className="bt-dp-input-icon" aria-hidden />
          <input
            ref={inputRef}
            className="bt-dp-input"
            value={text}
            placeholder={withTime ? 'YYYY-MM-DD HH:mm' : 'YYYY-MM-DD'}
            spellCheck={false}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                commitInput([0, e.shiftKey ? -1 : 1])
              } else if (e.key === 'Tab') {
                e.preventDefault()
                e.stopPropagation()
                const trimmed = text.trim()
                const parsed = trimmed ? parsePickerInput(trimmed, withTime, viewYear) : undefined
                const fallback = composeDateValue(selectedDay, hour, minute, withTime)
                const out = !trimmed ? undefined : (parsed ?? fallback)
                onDraftChange?.(out)
                onCommit(out, [e.shiftKey ? -1 : 1, 0])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onCancel?.()
              }
            }}
          />
          {text && (
            <button
              type="button"
              className="bt-dp-clear"
              title="清空输入"
              aria-label="清空输入"
              onClick={() => {
                setText('')
                setSelectedDay('')
                setInvalid(false)
                onDraftChange?.(undefined)
                inputRef.current?.focus()
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="bt-dp-body">
        <div className="bt-dp-cal">
          <div className="bt-dp-nav">
            <button type="button" className="bt-dp-nav-btn" title="上一年" aria-label="上一年" onClick={() => shiftYear(-1)}>
              <ChevronsLeft size={15} />
            </button>
            {ymMode === 'day' && (
              <button type="button" className="bt-dp-nav-btn" title="上个月" aria-label="上个月" onClick={() => shiftMonth(-1)}>
                <ChevronLeft size={15} />
              </button>
            )}
            <button
              type="button"
              className={'bt-dp-title' + (ymMode === 'month' ? ' active' : '')}
              onClick={() => setYmMode((m) => (m === 'day' ? 'month' : 'day'))}
              title={ymMode === 'day' ? '点击快速选择月份' : '返回日期面板'}
            >
              {ymMode === 'day' ? `${viewYear} 年 ${viewMonth} 月` : `${viewYear} 年`}
            </button>
            {ymMode === 'day' && (
              <button type="button" className="bt-dp-nav-btn" title="下个月" aria-label="下个月" onClick={() => shiftMonth(1)}>
                <ChevronRight size={15} />
              </button>
            )}
            <button type="button" className="bt-dp-nav-btn" title="下一年" aria-label="下一年" onClick={() => shiftYear(1)}>
              <ChevronsRight size={15} />
            </button>
          </div>

          {ymMode === 'month' ? (
            <div className="bt-dp-months">
              {MONTHS.map((m) => {
                const isCur = viewYear === todayYear && m === todayMonth
                const isSel = m === viewMonth
                return (
                  <button
                    key={m}
                    type="button"
                    className={'bt-dp-month' + (isCur ? ' today' : '') + (isSel ? ' selected' : '')}
                    onClick={() => {
                      setViewMonth(m)
                      setYmMode('day')
                    }}
                  >
                    {m} 月
                  </button>
                )
              })}
            </div>
          ) : (
            <>
              <div className="bt-dp-weeks">
                {WEEKDAYS.map((w, i) => (
                  <span key={w} className={'bt-dp-week' + (i >= 5 ? ' weekend' : '')}>
                    {w}
                  </span>
                ))}
              </div>
              <div className="bt-dp-days">
                {days.map((c) => {
                  const isToday = c.date === today
                  const isSelected = c.date === selectedDay
                  return (
                    <button
                      key={c.date}
                      type="button"
                      className={'bt-dp-day' + (!c.inMonth ? ' other' : '') + (isToday ? ' today' : '') + (isSelected ? ' selected' : '')}
                      onClick={() => pickDay(c.date)}
                    >
                      <span>{c.day}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>

        {withTime && (
          <div className="bt-dp-time">
            <div className="bt-dp-time-head">
              <Clock size={12} aria-hidden />
              <span>
                {pad2(hour)}:{pad2(minute)}
              </span>
            </div>
            <div className="bt-dp-time-cols">
              <div ref={hourListRef} className="bt-dp-time-col" aria-label="小时">
                {HOURS.map((h) => (
                  <button key={h} type="button" className={'bt-dp-time-btn' + (h === hour ? ' active' : '')} onClick={() => pickHour(h)}>
                    {pad2(h)}
                  </button>
                ))}
              </div>
              <div ref={minListRef} className="bt-dp-time-col" aria-label="分钟">
                {MINUTES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={'bt-dp-time-btn' + (m === minute ? ' active' : '')}
                    onClick={() => pickMinute(m)}
                    onDoubleClick={() => pickMinute(m, true)}
                  >
                    {pad2(m)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bt-dp-foot">
        <div className="bt-dp-shortcuts">
          {withTime ? (
            <>
              <button type="button" className="bt-dp-link" onClick={pickNow}>
                此刻
              </button>
              <button type="button" className="bt-dp-link subtle" onClick={pickToday}>
                今天
              </button>
            </>
          ) : (
            <button type="button" className="bt-dp-link" onClick={pickToday}>
              今天
            </button>
          )}
        </div>
        <span className="spacer" />
        {(selectedDay || text) && (
          <button type="button" className="btn ghost sm" onClick={clear}>
            清除
          </button>
        )}
        {withTime && (
          <button type="button" className="btn sm primary" onClick={() => commitInput()}>
            确定
          </button>
        )}
      </div>
    </div>
  )
}

/** Imperative helper to open a DatePicker popover anchored to an element or rect, committing once on close/confirm. */
export function openDatePopover(
  anchor: Anchor,
  opts: {
    value: string | undefined
    withTime?: boolean
    initialText?: string
    onChange: (v: string | undefined) => void
    onClose?: () => void
  },
) {
  const withTime = !!opts.withTime
  let draft = opts.value
  let settled = false
  const finish = (v: string | undefined) => {
    if (settled) return
    settled = true
    if (v !== opts.value) opts.onChange(v)
  }
  openPopover(
    anchor,
    (close) => (
      <DatePicker
        value={opts.value}
        withTime={withTime}
        initialText={opts.initialText}
        onDraftChange={(v) => {
          draft = v
        }}
        onCommit={(v) => {
          finish(v)
          close()
        }}
        onCancel={() => {
          settled = true
          close()
        }}
      />
    ),
    {
      width: withTime ? 372 : 276,
      align: 'left',
      onClose: () => {
        finish(draft)
        opts.onClose?.()
      },
    },
  )
}

/** Feishu-style date/datetime field trigger button for record drawer, batch fill, and filter panels. */
export function DateField({
  value,
  withTime = false,
  onChange,
  readOnly,
  small,
  placeholder,
}: {
  value: string | undefined
  withTime?: boolean
  onChange: (v: string | undefined) => void
  readOnly?: boolean
  small?: boolean
  placeholder?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const trigger = () => {
    if (readOnly || !ref.current) return
    setOpen(true)
    openDatePopover(ref.current, {
      value,
      withTime,
      onChange,
      onClose: () => setOpen(false),
    })
  }

  const label = placeholder ?? (withTime ? '请选择日期时间…' : '请选择日期…')

  return (
    <button
      ref={ref}
      type="button"
      className={'bt-input bt-date-field' + (small ? ' sm' : '') + (open ? ' open' : '')}
      onClick={trigger}
      disabled={readOnly}
    >
      <Calendar size={small ? 13 : 14} className="bt-date-field-icon" aria-hidden />
      {value ? <span className="bt-date-field-text ellipsis">{value}</span> : <span className="muted ellipsis">{readOnly ? '—' : label}</span>}
      {!readOnly && value && (
        <span
          role="button"
          tabIndex={-1}
          className="bt-date-field-clear"
          title="清除"
          aria-label="清除"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onChange(undefined)
          }}
        >
          <X size={13} />
        </span>
      )}
    </button>
  )
}
