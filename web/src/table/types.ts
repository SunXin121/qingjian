// 多维表格 data model, mirrored from the server (internal/server/tables.go).

export type FieldType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'attachment'
  | 'autonumber'
  | 'created_time'
  | 'modified_time'

export interface Choice {
  id: string
  name: string
  color: number
}

export interface FieldOptions {
  /** number: digits after the decimal point */
  precision?: number
  /** number: thousands separators */
  thousands?: boolean
  /** select / multiselect */
  choices?: Choice[]
  /** date: also store hours and minutes */
  time?: boolean
}

export interface Field {
  id: string
  name: string
  type: FieldType
  options: FieldOptions
  sort: number
}

export interface AttachmentValue {
  id: string
  name: string
  url: string
  mime: string
  size: number
}

export type FilterOp =
  | 'contains'
  | 'not_contains'
  | 'is'
  | 'is_not'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'empty'
  | 'not_empty'
  /** formula expression (formula.ts); `field` is empty and `value` holds the stored expression */
  | 'expr'

export interface FilterCond {
  id: string
  field: string
  op: FilterOp
  value?: any
}

export interface SortRule {
  field: string
  desc?: boolean
}

export type SummaryKind = 'none' | 'count' | 'filled' | 'empty' | 'unique' | 'percent_filled' | 'sum' | 'avg' | 'min' | 'max' | 'checked'

export interface ViewConfig {
  /** hidden field ids (the primary field cannot be hidden) */
  hidden?: string[]
  /** column order of the non-primary fields; unknown fields follow by field sort */
  order?: string[]
  widths?: Record<string, number>
  /** number of frozen data columns, primary included */
  frozen?: number
  filter?: { conj: 'and' | 'or'; conds: FilterCond[] }
  sorts?: SortRule[]
  /** grid grouping, outermost first */
  groups?: SortRule[]
  /** collapsed group keys (grid) */
  collapsed?: string[]
  summary?: Record<string, SummaryKind>
  /** kanban: field the board is grouped by (any type but attachment / autonumber) */
  kanbanField?: string
  /** kanban: hide the column for records without a value */
  hideEmptyColumn?: boolean
}

export type ViewType = 'grid' | 'kanban'

export interface View {
  id: string
  name: string
  type: ViewType
  config: ViewConfig
  sort: number
}

export interface Rec {
  id: string
  seq: number
  data: Record<string, any>
  sort: number
  created_at: number
  updated_at: number
}

export interface TableData {
  id: string
  repo_id?: string
  title: string
  updated_at: number
  fields: Field[]
  views: View[]
  records: Rec[]
}

export type Op =
  | { op: 'field.create'; id: string; name: string; type: FieldType; options: FieldOptions; sort: number }
  | { op: 'field.update'; id: string; name?: string; type?: FieldType; options?: FieldOptions; sort?: number }
  | { op: 'field.delete'; id: string }
  | { op: 'view.create'; id: string; name: string; type: ViewType; config: ViewConfig; sort: number }
  | { op: 'view.update'; id: string; name?: string; config?: ViewConfig; sort?: number }
  | { op: 'view.delete'; id: string }
  | { op: 'record.create'; id: string; data: Record<string, any>; sort: number; seq: number; created_at?: number }
  | { op: 'record.update'; id: string; data?: Record<string, any>; sort?: number }
  | { op: 'record.delete'; id: string }

/** One entry of a record's change log (internal/server/tables_history.go). */
export interface HistoryChange {
  field: string
  /** field name and type when the change was made */
  name: string
  type: FieldType
  old?: any
  new?: any
}

export interface HistoryEntry {
  id: number
  action: 'create' | 'update' | 'delete' | 'restore'
  changes: HistoryChange[]
  created_at: number
  updated_at: number
}

export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: '文本' },
  { type: 'longtext', label: '多行文本' },
  { type: 'number', label: '数字' },
  { type: 'select', label: '单选' },
  { type: 'multiselect', label: '多选' },
  { type: 'date', label: '日期' },
  { type: 'checkbox', label: '复选框' },
  { type: 'url', label: '链接' },
  { type: 'attachment', label: '附件' },
  { type: 'autonumber', label: '自动编号' },
  { type: 'created_time', label: '创建时间' },
  { type: 'modified_time', label: '修改时间' },
]

export const fieldTypeLabel = (t: FieldType) => FIELD_TYPES.find((x) => x.type === t)?.label ?? t

/** Fields whose value is computed from the record, not stored. */
export const isComputed = (t: FieldType) => t === 'autonumber' || t === 'created_time' || t === 'modified_time'

export const TAG_COLORS = 10

export function newId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let s = ''
  for (const b of bytes) s += alphabet[b % 36]
  return s
}
