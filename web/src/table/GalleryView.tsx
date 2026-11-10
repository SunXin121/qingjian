import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { IconDoc, IconPlus } from '../components/icons'
import { cellMatches, cellValue, displayText, primaryField, searchNeedle, viewRecords, visibleFields } from './engine'
import { CardLine, LoadMore } from './KanbanView'
import type { TableModel } from './model'
import type { AttachmentValue, Field, TableData, View } from './types'

interface Props {
  model: TableModel
  table: TableData
  view: View
  readOnly: boolean
  onOpenRecord: (id: string, list: string[]) => void
  search?: string
  onSearchCount?: (n: number) => void
}

const PAGE = 60

/** The attachment field a gallery shows as cover: the configured one, else the first. */
export function coverField(t: TableData, v: View): Field | undefined {
  if (v.config.coverField === '') return undefined
  return t.fields.find((f) => f.id === v.config.coverField && f.type === 'attachment') ?? t.fields.find((f) => f.type === 'attachment')
}

const isImage = (a: AttachmentValue) => a.mime.startsWith('image/')

/** Cards in a responsive grid, with an image cover taken from an attachment field. */
export default function GalleryView({ model, table, view, readOnly, onOpenRecord, search = '', onSearchCount }: Props) {
  const needle = searchNeedle(search)
  const records = useMemo(() => {
    const list = viewRecords(table, view, model.sticky)
    if (!needle) return list
    const fields = visibleFields(table, view)
    return list.filter((r) => fields.some((f) => cellMatches(f, r, needle)))
  }, [table, view, model, needle])
  useLayoutEffect(() => onSearchCount?.(records.length), [records.length, onSearchCount])
  const [limit, setLimit] = useState(PAGE)
  useEffect(() => setLimit(PAGE), [view.id, needle])
  const primary = primaryField(table)
  const cover = coverField(table, view)
  const fields = useMemo(() => visibleFields(table, view).filter((f) => f.id !== primary?.id && f.id !== cover?.id), [table, view, primary, cover])
  const ids = useMemo(() => records.map((r) => r.id), [records])
  const fit = view.config.coverFit ?? 'cover'

  const add = () => {
    const [id] = model.addRecords([{}])
    onOpenRecord(id, [...ids, id])
  }

  return (
    <div className="bt-gallery">
      {records.slice(0, limit).map((r) => {
        const title = primary ? displayText(primary, cellValue(r, primary)) : ''
        const files = cover ? ((cellValue(r, cover) as AttachmentValue[] | undefined) ?? []) : []
        const img = files.find(isImage)
        return (
          <div key={r.id} className="bt-card bt-gallery-card" onClick={() => onOpenRecord(r.id, ids)}>
            {cover && (
              <div className={'bt-gallery-cover ' + fit}>
                {img ? (
                  <img src={img.url} alt="" loading="lazy" />
                ) : files.length ? (
                  <span className="bt-gallery-file">
                    <IconDoc width={22} height={22} />
                    <span className="ellipsis">{files[0].name}</span>
                  </span>
                ) : null}
              </div>
            )}
            <div className="bt-gallery-body">
              <div className={'bt-card-title' + (title ? '' : ' muted')}>{title || '未命名记录'}</div>
              {fields.map((f) => (
                <CardLine key={f.id} field={f} rec={r} />
              ))}
            </div>
          </div>
        )
      })}
      {records.length > limit && <LoadMore key={limit} rest={records.length - limit} onLoad={() => setLimit((l) => l + PAGE)} />}
      {!readOnly && records.length <= limit && (
        <button className="bt-gallery-add" onClick={add}>
          <IconPlus width={18} height={18} /> 新建记录
        </button>
      )}
      {readOnly && !records.length && <div className="bt-panel-empty">没有记录</div>}
    </div>
  )
}
