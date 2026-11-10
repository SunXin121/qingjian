// Excel (.xlsx) export and import. An .xlsx file is a zip of XML parts; only what a plain
// sheet needs is written (inline strings, a few number formats) and read (first sheet,
// shared strings, date formats). Loaded on demand.

import JSZip from 'jszip'
import { toast } from '../components/dialog'
import { cellValue, displayText, viewRecords, visibleFields } from './engine'
import { download, importRows, safeName } from './csv'
import type { TableModel } from './model'
import { baseField, type Field, type Rec, type TableData, type View } from './types'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const esc = (s: string) =>
  s
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')

function colName(i: number) {
  let s = ''
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  return s
}

// style ids in styles.xml below
const S_HEADER = 1
const S_DATE = 2
const S_DATETIME = 3
const S_PERCENT = 4
const S_WRAP = 5

/** Excel serial date (days since 1899-12-30) of a local date string / timestamp. */
function serial(v: string | number): number | undefined {
  let d: Date
  if (typeof v === 'number') d = new Date(v)
  else {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(v)
    if (!m) return undefined
    d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0))
  }
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes())
  return utc / 86_400_000 + 25569
}

function cellXML(ref: string, f: Field, r: Rec): string {
  const v = cellValue(r, f)
  const b = baseField(f)
  const num = (n: number, s?: number) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${n}</v></c>`
  const str = (t: string, s?: number) => (t === '' ? '' : `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${esc(t)}</t></is></c>`)
  if (v === undefined || v === null || v === '') return ''
  switch (b.type) {
    case 'number':
    case 'rating':
      return typeof v === 'number' && isFinite(v) ? num(v) : str(displayText(f, v))
    case 'autonumber':
      return num(r.seq)
    case 'progress':
      return typeof v === 'number' ? num(v, S_PERCENT) : ''
    case 'checkbox':
      return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
    case 'date':
    case 'created_time':
    case 'modified_time': {
      const n = serial(v)
      const time = b.type !== 'date' || !!b.options.time
      return n === undefined ? str(displayText(f, v)) : num(n, time ? S_DATETIME : S_DATE)
    }
    case 'longtext':
      return str(displayText(f, v), S_WRAP)
    default:
      return str(displayText(f, v))
  }
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`

/** Exports what the view shows (visible fields, filtered and sorted records) as .xlsx. */
export async function exportXLSX(t: TableData, v: View) {
  const fields = visibleFields(t, v)
  const records = viewRecords(t, v)
  const widths = fields.map((f) => (f.type === 'longtext' ? 40 : f.type === 'checkbox' ? 8 : 18))
  const rows: string[] = []
  rows.push(`<row r="1">${fields.map((f, i) => `<c r="${colName(i)}1" t="inlineStr" s="${S_HEADER}"><is><t xml:space="preserve">${esc(f.name)}</t></is></c>`).join('')}</row>`)
  records.forEach((r, k) => {
    const n = k + 2
    rows.push(`<row r="${n}">${fields.map((f, i) => cellXML(colName(i) + n, f, r)).join('')}</row>`)
  })
  const sheet = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join('')}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`
  const sheetName = esc((v.name || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  zip.file(
    'xl/workbook.xml',
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  )
  zip.file('xl/styles.xml', STYLES)
  zip.file('xl/worksheets/sheet1.xml', sheet)
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  download(`${safeName(t.title)}-${safeName(v.name)}.xlsx`, blob)
}

// ---------- import ----------

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57])

const parseXML = (s: string) => new DOMParser().parseFromString(s, 'application/xml')
const kids = (el: Element | Document, name: string) => Array.from(el.getElementsByTagNameNS(NS, name))

/** Column index of a cell reference such as "AB12". */
function colIndex(ref: string) {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

function fromSerial(n: number, withTime: boolean): string {
  const ms = Math.round((n - 25569) * 86_400_000)
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  return withTime && (d.getUTCHours() || d.getUTCMinutes()) ? `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : day
}

/** Rows of the first sheet as text (dates as YYYY-MM-DD [HH:mm]). */
export async function readXLSX(data: ArrayBuffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(data)
  const text = async (path: string) => (await zip.file(path)?.async('string')) ?? ''
  const wb = parseXML(await text('xl/workbook.xml'))
  const rels = parseXML(await text('xl/_rels/workbook.xml.rels'))
  const first = kids(wb, 'sheet')[0]
  if (!first) throw new Error('工作簿中没有工作表')
  const rid = first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') ?? first.getAttribute('r:id')
  let target = Array.from(rels.getElementsByTagName('Relationship')).find((r) => r.getAttribute('Id') === rid)?.getAttribute('Target') ?? 'worksheets/sheet1.xml'
  target = target.startsWith('/') ? target.slice(1) : 'xl/' + target
  const shared = kids(parseXML(await text('xl/sharedStrings.xml')), 'si').map((si) => kids(si, 't').map((t) => t.textContent ?? '').join(''))
  // which cell styles are date formats
  const styles = parseXML(await text('xl/styles.xml'))
  const custom = new Map(kids(styles, 'numFmt').map((n) => [Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') ?? '']))
  const xfs = kids(styles, 'cellXfs')[0] ? kids(kids(styles, 'cellXfs')[0], 'xf') : []
  const dateStyle = xfs.map((xf) => {
    const id = Number(xf.getAttribute('numFmtId') ?? 0)
    if (BUILTIN_DATE.has(id)) return id === 22 ? 'datetime' : 'date'
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').toLowerCase()
    if (!/[yd]/.test(code)) return null
    return /h/.test(code) ? 'datetime' : 'date'
  })
  const sheet = parseXML(await text(target))
  const rows: string[][] = []
  for (const row of kids(sheet, 'row')) {
    const out: string[] = []
    let next = 0
    for (const c of kids(row, 'c')) {
      const ref = c.getAttribute('r')
      const i = ref ? colIndex(ref) : next
      next = i + 1
      const t = c.getAttribute('t')
      const v = kids(c, 'v')[0]?.textContent ?? ''
      let s: string
      if (t === 's') s = shared[Number(v)] ?? ''
      else if (t === 'inlineStr') s = kids(c, 't').map((x) => x.textContent ?? '').join('')
      else if (t === 'b') s = v === '1' ? 'TRUE' : ''
      else if (t === 'str' || t === 'e') s = t === 'e' ? '' : v
      else {
        const ds = dateStyle[Number(c.getAttribute('s') ?? 0)]
        s = ds && v !== '' && isFinite(Number(v)) ? fromSerial(Number(v), ds === 'datetime') : v
      }
      while (out.length < i) out.push('')
      out[i] = s
    }
    const r = Number(row.getAttribute('r'))
    // keep row positions so blank rows inside the data do not shift anything
    if (r > 0) while (rows.length < r - 1) rows.push([])
    rows.push(out)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

export async function importXLSX(model: TableModel, file: File, viewId?: string) {
  const rows = await readXLSX(await file.arrayBuffer())
  if (rows.length < 2) return toast('Excel 文件没有数据行')
  const width = Math.max(...rows.map((r) => r.length))
  importRows(
    model,
    rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? '')),
    viewId,
  )
}
