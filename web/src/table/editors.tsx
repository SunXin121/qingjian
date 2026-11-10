import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatSize, uploadFile } from '../api'
import { openPopover, toast } from '../components/dialog'
import { IconClose, IconDoc, IconLink, IconPlus, IconUpload } from '../components/icons'
import { cellValue, choiceCollector, displayText, formatProgress, parseText } from './engine'
import type { TableModel } from './model'
import type { AttachmentValue, Choice, Field, Rec } from './types'
import { isComputed, ratingMax } from './types'

export function Tag({ choice, onRemove }: { choice: Choice; onRemove?: () => void }) {
  return (
    <span className={`bt-tag c${choice.color % 10}`}>
      <span className="ellipsis">{choice.name || ' '}</span>
      {onRemove && (
        <button
          className="bt-tag-x"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}

export function Tags({ field, value }: { field: Field; value: any }) {
  const ids: string[] = field.type === 'select' ? (value ? [value] : []) : Array.isArray(value) ? value : []
  const choices = ids.map((id) => field.options.choices?.find((c) => c.id === id)).filter(Boolean) as Choice[]
  return (
    <span className="bt-tags">
      {choices.map((c) => (
        <Tag key={c.id} choice={c} />
      ))}
    </span>
  )
}

/** Searchable option list for single / multi select, can create new options. */
export function ChoicePicker({
  field,
  value,
  onChange,
  onCreate,
  onDone,
  initialQuery = '',
  readOnly,
}: {
  field: Field
  value: any
  onChange: (v: any) => void
  onCreate?: (name: string) => string
  onDone?: () => void
  initialQuery?: string
  readOnly?: boolean
}) {
  const multi = field.type === 'multiselect'
  const [q, setQ] = useState(initialQuery)
  const [hi, setHi] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // inside the grid overlay, the grid may grab focus back right after opening
  useEffect(() => {
    const focus = () => {
      const el = inputRef.current
      if (el && document.activeElement !== el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    }
    const raf = requestAnimationFrame(focus)
    const t = setTimeout(focus, 60)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(t)
    }
  }, [])
  const selected: string[] = multi ? (Array.isArray(value) ? value : []) : value ? [value] : []
  const choices = field.options.choices ?? []
  const query = q.trim().toLowerCase()
  const list = query ? choices.filter((c) => c.name.toLowerCase().includes(query)) : choices
  const canCreate = !!onCreate && !readOnly && query !== '' && !choices.some((c) => c.name.toLowerCase() === query)
  const total = list.length + (canCreate ? 1 : 0)

  const pick = (id: string) => {
    if (multi) {
      onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
      setQ('')
    } else {
      onChange(selected[0] === id ? undefined : id)
      onDone?.()
    }
  }
  const create = () => {
    if (!onCreate) return
    const id = onCreate(q.trim())
    if (multi) {
      onChange([...selected, id])
      setQ('')
    } else {
      onChange(id)
      onDone?.()
    }
  }

  return (
    <div className="bt-picker" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      {multi && selected.length > 0 && (
        <div className="bt-picker-selected">
          {selected.map((id) => {
            const c = choices.find((x) => x.id === id)
            return c ? <Tag key={id} choice={c} onRemove={readOnly ? undefined : () => pick(id)} /> : null
          })}
        </div>
      )}
      <input
        ref={inputRef}
        className="bt-picker-input"
        autoFocus
        value={q}
        placeholder={onCreate ? '搜索或创建选项' : '搜索选项'}
        onChange={(e) => {
          setQ(e.target.value)
          setHi(0)
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(total - 1, h + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(0, h - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            if (hi < list.length) pick(list[hi].id)
            else if (canCreate) create()
            else onDone?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone?.()
          } else if (e.key === 'Backspace' && !q && multi && selected.length) {
            onChange(selected.slice(0, -1))
          }
        }}
      />
      <div className="bt-picker-list">
        {list.map((c, i) => (
          <button key={c.id} className={'bt-picker-item' + (i === hi ? ' hi' : '')} onMouseEnter={() => setHi(i)} onClick={() => !readOnly && pick(c.id)}>
            <Tag choice={c} />
            <span className="spacer" />
            {selected.includes(c.id) && <span className="bt-check">✓</span>}
          </button>
        ))}
        {canCreate && (
          <button className={'bt-picker-item create' + (hi === list.length ? ' hi' : '')} onMouseEnter={() => setHi(list.length)} onClick={create}>
            <IconPlus width={14} height={14} /> 创建 <Tag choice={{ id: '', name: q.trim(), color: choices.length % 10 }} />
          </button>
        )}
        {!list.length && !canCreate && <div className="bt-picker-empty">{choices.length ? '没有匹配的选项' : '还没有选项'}</div>}
      </div>
    </div>
  )
}

const isImage = (a: AttachmentValue) => a.mime.startsWith('image/')

export function pickFiles(multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    input.onchange = () => {
      resolve(Array.from(input.files ?? []))
      input.remove()
    }
    input.addEventListener('cancel', () => input.remove())
    input.click()
  })
}

export async function uploadAll(files: File[], onProgress?: (text: string) => void): Promise<AttachmentValue[]> {
  const out: AttachmentValue[] = []
  for (const [i, file] of files.entries()) {
    try {
      const a = await uploadFile(file, undefined, (r) => onProgress?.(`上传中 ${i + 1}/${files.length} · ${Math.round(r * 100)}%`))
      out.push({ id: a.id, name: a.name, url: a.url, mime: a.mime, size: a.size })
    } catch (e: any) {
      toast(`「${file.name}」上传失败：${e.message}`)
    }
  }
  onProgress?.('')
  return out
}

export function AttachmentList({ value, onChange, readOnly }: { value: AttachmentValue[] | undefined; onChange: (v: AttachmentValue[]) => void; readOnly?: boolean }) {
  const list = value ?? []
  const [progress, setProgress] = useState('')
  const [over, setOver] = useState(false)
  const add = async (files: File[]) => {
    if (!files.length) return
    const added = await uploadAll(files, setProgress)
    if (added.length) onChange([...list, ...added])
  }
  return (
    <div
      className={'bt-files' + (over ? ' over' : '')}
      onDragOver={(e) => {
        if (readOnly || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (readOnly) return
        e.preventDefault()
        setOver(false)
        add(Array.from(e.dataTransfer.files))
      }}
    >
      {list.map((a, i) => (
        <div key={a.id + i} className="bt-file">
          <a href={a.url} target="_blank" rel="noreferrer" className="bt-file-thumb">
            {isImage(a) ? <img src={a.url} alt="" loading="lazy" /> : <IconDoc width={20} height={20} />}
          </a>
          <a href={a.url} target="_blank" rel="noreferrer" className="bt-file-name ellipsis" title={a.name}>
            {a.name}
          </a>
          <span className="bt-file-size">{formatSize(a.size)}</span>
          {!readOnly && (
            <button className="icon-btn sm" title="移除" onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <IconClose width={14} height={14} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button className="btn sm bt-file-add" disabled={!!progress} onClick={async () => add(await pickFiles())}>
          <IconUpload width={14} height={14} /> {progress || '上传文件'}
        </button>
      )}
      {readOnly && !list.length && <span className="muted">无附件</span>}
    </div>
  )
}

/** Stored date ↔ <input type="date|datetime-local"> value. */
export const toInputDate = (v: unknown) => (typeof v === 'string' ? v.replace(' ', 'T') : '')
export const fromInputDate = (s: string, withTime: boolean) => {
  if (!s) return undefined
  const [d, t] = s.split('T')
  return withTime ? `${d} ${(t || '00:00').slice(0, 5)}` : d
}

export const contactHref = (type: string, v: string) => (type === 'phone' ? 'tel:' + v.replace(/[^\d+]/g, '') : 'mailto:' + v.trim())

/** Stars; clicking the current score clears it. */
export function Rating({ field, value, onChange, small }: { field: Field; value: any; onChange?: (v: number | undefined) => void; small?: boolean }) {
  const [hover, setHover] = useState(0)
  const n = typeof value === 'number' ? value : 0
  const shown = hover || n
  return (
    <span className={'bt-rating' + (small ? ' sm' : '') + (onChange ? ' editable' : '')} onMouseLeave={() => setHover(0)}>
      {Array.from({ length: ratingMax(field) }, (_, i) => (
        <span
          key={i}
          className={'bt-star' + (i < shown ? ' on' : '')}
          onMouseEnter={() => onChange && setHover(i + 1)}
          onClick={(e) => {
            if (!onChange) return
            e.stopPropagation()
            onChange(n === i + 1 ? undefined : i + 1)
          }}
        >
          ★
        </span>
      ))}
    </span>
  )
}

export function ProgressBar({ field, value }: { field: Field; value: any }) {
  if (typeof value !== 'number') return null
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <span className="bt-progress">
      <span className="bt-progress-track">
        <span className={'bt-progress-fill' + (value >= 1 ? ' done' : '')} style={{ width: pct + '%' }} />
      </span>
      <span className="bt-progress-text">{formatProgress(field, value)}</span>
    </span>
  )
}

/** Text input that commits on blur / Enter. */
function CommitInput({ value, onCommit, multiline, readOnly, inputMode, placeholder }: { value: string; onCommit: (s: string) => void; multiline?: boolean; readOnly?: boolean; inputMode?: 'decimal' | 'url' | 'tel' | 'email'; placeholder?: string }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => setV(value), [value])
  useEffect(() => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight + 2, 320) + 'px'
    }
  }, [v])
  const commit = () => v !== value && onCommit(v)
  if (multiline)
    return <textarea ref={ref} className="bt-input" rows={2} value={v} readOnly={readOnly} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} />
  return (
    <input
      className="bt-input"
      value={v}
      readOnly={readOnly}
      inputMode={inputMode}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && (e.target as HTMLInputElement).blur()}
    />
  )
}

/** Editor for one field of one record (record card). */
export function FieldInput({ model, field, rec, readOnly }: { model: TableModel; field: Field; rec: Rec; readOnly?: boolean }) {
  const v = cellValue(rec, field)
  const set = (value: any) => model.setCells([{ rec: rec.id, field: field.id, value }])
  const parse = (s: string) => {
    const col = choiceCollector([field])
    return parseText(field, s, col.resolve)
  }
  const ro = readOnly || model.readOnly
  if (isComputed(field.type)) return <div className="bt-static">{displayText(field, v) || <span className="muted">—</span>}</div>
  switch (field.type) {
    case 'text':
      return <CommitInput value={v ?? ''} readOnly={ro} onCommit={(s) => set(s.trim())} placeholder={ro ? '' : '输入文本'} />
    case 'longtext':
      return <CommitInput multiline value={v ?? ''} readOnly={ro} onCommit={(s) => set(s)} placeholder={ro ? '' : '输入文本'} />
    case 'number':
      return <CommitInput value={displayText(field, v)} readOnly={ro} inputMode="decimal" onCommit={(s) => set(parse(s))} placeholder={ro ? '' : '输入数字'} />
    case 'url':
      return (
        <div className="bt-url">
          <CommitInput value={v ?? ''} readOnly={ro} inputMode="url" onCommit={(s) => set(s.trim())} placeholder={ro ? '' : 'https://'} />
          {v && (
            <a className="icon-btn" href={safeHref(v)} target="_blank" rel="noreferrer" title="打开链接">
              <IconLink width={16} height={16} />
            </a>
          )}
        </div>
      )
    case 'phone':
    case 'email':
      return (
        <div className="bt-url">
          <CommitInput value={v ?? ''} readOnly={ro} inputMode={field.type === 'phone' ? 'tel' : 'email'} onCommit={(s) => set(s.trim())} placeholder={ro ? '' : field.type === 'phone' ? '输入电话号码' : 'name@example.com'} />
          {v && (
            <a className="icon-btn" href={contactHref(field.type, v)} title={field.type === 'phone' ? '拨打' : '发送邮件'}>
              <IconLink width={16} height={16} />
            </a>
          )}
        </div>
      )
    case 'rating':
      return <Rating field={field} value={v} onChange={ro ? undefined : set} />
    case 'progress':
      return (
        <div className="bt-progress-input">
          <ProgressBar field={field} value={v} />
          <CommitInput
            value={typeof v === 'number' ? String(Math.round(v * 1e6) / 1e4) : ''}
            readOnly={ro}
            inputMode="decimal"
            onCommit={(s) => set(parse(s))}
            placeholder={ro ? '' : '0'}
          />
          <span className="muted">%</span>
        </div>
      )
    case 'checkbox':
      return <input type="checkbox" className="bt-checkbox" checked={!!v} disabled={ro} onChange={(e) => set(e.target.checked)} />
    case 'date':
      return (
        <input
          className="bt-input bt-date"
          type={field.options.time ? 'datetime-local' : 'date'}
          value={toInputDate(v)}
          readOnly={ro}
          onChange={(e) => set(fromInputDate(e.target.value, !!field.options.time))}
        />
      )
    case 'select':
    case 'multiselect':
      return <ChoiceField model={model} field={field} value={v} onChange={set} readOnly={ro} />
    case 'attachment':
      return <AttachmentList value={v} onChange={set} readOnly={ro} />
  }
  return null
}

export function safeHref(url: string) {
  const u = url.trim()
  if (/^(https?:|mailto:|tel:|\/)/i.test(u)) return u
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return '#'
  return 'https://' + u
}

function ChoiceField({ model, field, value, onChange, readOnly }: { model: TableModel; field: Field; value: any; onChange: (v: any) => void; readOnly?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  const open = () => {
    if (readOnly || !ref.current) return
    openPopover(
      ref.current,
      (close) => <LivePicker model={model} fieldId={field.id} initial={value} onChange={onChange} onDone={close} />,
      { width: 280 },
    )
  }
  return (
    <button ref={ref} className="bt-input bt-choice-field" onClick={open} disabled={readOnly}>
      <Tags field={field} value={value} />
      {(value === undefined || (Array.isArray(value) && !value.length)) && <span className="muted">{readOnly ? '—' : '选择选项'}</span>}
    </button>
  )
}

/** ChoicePicker that follows the live field (new options appear immediately). */
export function LivePicker({ model, fieldId, initial, onChange, onDone, initialQuery }: { model: TableModel; fieldId: string; initial: any; onChange: (v: any) => void; onDone: () => void; initialQuery?: string }) {
  const [, force] = useState(0)
  const [value, setValue] = useState(initial)
  useEffect(() => model.subscribe(() => force((n) => n + 1)), [model])
  const field = model.field(fieldId)
  if (!field) return null
  return (
    <ChoicePicker
      field={field}
      value={value}
      initialQuery={initialQuery}
      onChange={(v) => {
        setValue(v)
        onChange(v)
      }}
      onCreate={model.readOnly ? undefined : (name) => model.addChoice(fieldId, name)}
      onDone={onDone}
    />
  )
}

/** Compact read-only rendering of a value (kanban cards, embeds in React). */
export function ValueView({ field, rec }: { field: Field; rec: Rec }): ReactNode {
  const v = cellValue(rec, field)
  switch (field.type) {
    case 'select':
    case 'multiselect':
      return <Tags field={field} value={v} />
    case 'checkbox':
      return <input type="checkbox" className="bt-checkbox sm" checked={!!v} readOnly disabled />
    case 'attachment':
      return <AttachmentChips value={v} />
    case 'url':
      return v ? (
        <a href={safeHref(v)} target="_blank" rel="noreferrer" className="bt-link" onClick={(e) => e.stopPropagation()}>
          {v}
        </a>
      ) : null
    case 'phone':
    case 'email':
      return v ? (
        <a href={contactHref(field.type, v)} className="bt-link" onClick={(e) => e.stopPropagation()}>
          {v}
        </a>
      ) : null
    case 'rating':
      return v ? <Rating field={field} value={v} small /> : null
    case 'progress':
      return <ProgressBar field={field} value={v} />
    default:
      return displayText(field, v) || null
  }
}

function AttachmentChips({ value }: { value: AttachmentValue[] | undefined }) {
  const list = useMemo(() => value ?? [], [value])
  const images = list.filter(isImage)
  return (
    <span className="bt-chips">
      {images.slice(0, 3).map((a) => (
        <img key={a.id} className="bt-chip-img" src={a.url} alt="" loading="lazy" />
      ))}
      {list
        .filter((a) => !isImage(a))
        .slice(0, 2)
        .map((a) => (
          <span key={a.id} className="bt-chip ellipsis">
            {a.name}
          </span>
        ))}
    </span>
  )
}
