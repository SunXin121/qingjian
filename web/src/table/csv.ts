import { toast } from '../components/dialog'
import { cellValue, choiceCollector, displayText, parseCSV, parseText, toCSV, viewRecords, visibleFields } from './engine'
import { choiceOps, type TableModel } from './model'
import { isComputed, type FieldType, type TableData, type View } from './types'

export function download(name: string, data: string | Blob, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type }) : data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || '表格'

/** Exports what the view shows: visible fields, filtered and sorted records. */
export function exportCSV(t: TableData, v: View) {
  const fields = visibleFields(t, v)
  const rows = [fields.map((f) => f.name), ...viewRecords(t, v).map((r) => fields.map((f) => displayText(f, cellValue(r, f))))]
  download(`${safeName(t.title)}-${safeName(v.name)}.csv`, toCSV(rows))
}

/** Guesses a field type for an imported column from its values. */
function guessType(values: string[]): FieldType {
  const filled = values.map((v) => v.trim()).filter(Boolean)
  if (!filled.length) return 'text'
  if (filled.every((v) => /^-?[\d,]*\.?\d+%?$/.test(v))) return 'number'
  if (filled.every((v) => /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.test(v))) return 'date'
  if (filled.every((v) => /^(true|false|是|否|✓|)$/i.test(v))) return 'checkbox'
  if (filled.every((v) => /^https?:\/\/\S+$/.test(v))) return 'url'
  if (filled.some((v) => v.includes('\n'))) return 'longtext'
  return 'text'
}

/**
 * Appends the CSV rows as new records. Columns are matched to fields by name; unknown
 * columns become new fields (type guessed from their values). One undo step.
 */
export async function importCSV(model: TableModel, file: File, viewId?: string) {
  const rows = parseCSV(await file.text())
  if (rows.length < 2) return toast('CSV 文件没有数据行')
  importRows(model, rows, viewId)
}

/** Appends rows (header first) as records; see importCSV. */
export function importRows(model: TableModel, rows: string[][], viewId?: string) {
  const [header, ...body] = rows
  const t = model.state
  const byName = new Map(t.fields.map((f) => [f.name.trim().toLowerCase(), f]))
  let created = 0
  model.transact(() => {
    const cols = header.map((h, i) => {
      const name = h.trim() || `列 ${i + 1}`
      const existing = byName.get(name.toLowerCase())
      if (existing) return existing.id
      const datesWithTime = body.some((r) => /\d{1,2}:\d{2}/.test(r[i] ?? ''))
      const type = guessType(body.map((r) => r[i] ?? ''))
      created++
      const id = model.addField(name, type, type === 'date' && datesWithTime ? { time: true } : {}, { viewId, after: undefined })
      byName.set(name.toLowerCase(), model.field(id)!)
      return id
    })
    // fields with runtime info: link columns match record titles
    const fields = cols.map((id) => model.dataField(id)!)
    const col = choiceCollector(model.state.fields)
    const datas = body.map((r) => {
      const data: Record<string, any> = {}
      fields.forEach((f, i) => {
        if (isComputed(f.type) || f.type === 'attachment') return
        const v = parseText(f, r[i] ?? '', col.resolve)
        if (v !== undefined) data[f.id] = v
      })
      return data
    })
    const [fwd, inv] = choiceOps(model, col.added)
    model.addRecords(datas, undefined, fwd, inv)
  })
  toast(`已导入 ${body.length} 条记录${created ? `，新建 ${created} 个字段` : ''}`)
}
