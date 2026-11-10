// Client-side table state. Every change is expressed as a list of ops (see types.ts):
// applied to local state immediately, queued and sent to the server in batches, and —
// for data changes — recorded with their inverse for undo / redo.

import { useSyncExternalStore } from 'react'
import { api } from '../api'
import { toast } from '../components/dialog'
import { cellValue, choiceCollector, convertValue, isEmptyValue } from './engine'
import type { Choice, Field, FieldOptions, FieldType, Op, Rec, TableData, View, ViewConfig, ViewType } from './types'
import { isComputed, newId } from './types'

export type SyncState = 'saved' | 'saving' | 'error'

interface HistoryEntry {
  forward: Op[]
  inverse: Op[]
}

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

function bySortSeq(a: Rec, b: Rec) {
  return a.sort - b.sort || a.seq - b.seq
}

/** Pure local application of ops, mirroring the server. */
export function applyOps(t: TableData, ops: Op[]): TableData {
  let fields = t.fields
  let views = t.views
  let records = t.records
  let recordsDirty = false
  let index: Map<string, number> | null = null
  const recIndex = () => (index ??= new Map(records.map((r, i) => [r.id, i])))
  const now = Date.now()
  for (const op of ops) {
    switch (op.op) {
      case 'field.create':
        fields = [...fields, { id: op.id, name: op.name, type: op.type, options: op.options ?? {}, sort: op.sort }].sort((a, b) => a.sort - b.sort)
        break
      case 'field.update':
        fields = fields
          .map((f) =>
            f.id === op.id
              ? { ...f, ...(op.name !== undefined && { name: op.name }), ...(op.type && { type: op.type }), ...(op.options && { options: op.options }), ...(op.sort !== undefined && { sort: op.sort }) }
              : f,
          )
          .sort((a, b) => a.sort - b.sort)
        break
      case 'field.delete':
        fields = fields.filter((f) => f.id !== op.id)
        records = records.map((r) => {
          if (!(op.id in r.data)) return r
          const data = { ...r.data }
          delete data[op.id]
          return { ...r, data }
        })
        index = null
        break
      case 'view.create':
        views = [...views, { id: op.id, name: op.name, type: op.type, config: op.config ?? {}, sort: op.sort }].sort((a, b) => a.sort - b.sort)
        break
      case 'view.update':
        views = views
          .map((v) => (v.id === op.id ? { ...v, ...(op.name !== undefined && { name: op.name }), ...(op.config && { config: op.config }), ...(op.sort !== undefined && { sort: op.sort }) } : v))
          .sort((a, b) => a.sort - b.sort)
        break
      case 'view.delete':
        views = views.filter((v) => v.id !== op.id)
        break
      case 'record.create': {
        const data: Record<string, any> = {}
        for (const [k, v] of Object.entries(op.data)) if (v !== null && v !== undefined) data[k] = v
        records = [...records, { id: op.id, seq: op.seq, data, sort: op.sort, created_at: op.created_at ?? now, updated_at: now }]
        recordsDirty = true
        index = null
        break
      }
      case 'record.update': {
        const i = recIndex().get(op.id)
        if (i === undefined) break
        const r = records[i]
        const data = { ...r.data }
        for (const [k, v] of Object.entries(op.data ?? {})) {
          if (v === null || v === undefined) delete data[k]
          else data[k] = v
        }
        if (records === t.records) records = [...records]
        // a move (sort only) is not a modification
        records[i] = { ...r, data, updated_at: op.data ? now : r.updated_at, ...(op.sort !== undefined && { sort: op.sort }) }
        if (op.sort !== undefined) recordsDirty = true
        break
      }
      case 'record.delete':
        records = records.filter((r) => r.id !== op.id)
        index = null
        break
    }
  }
  if (recordsDirty) records = [...records].sort(bySortSeq)
  return { ...t, fields, views, records }
}

export interface CellChange {
  rec: string
  field: string
  value: any
}

export class TableModel {
  state: TableData
  readonly readOnly: boolean
  sync: SyncState = 'saved'
  /** records that stay visible until the view changes, so new / edited rows don't vanish */
  sticky = new Set<string>()
  private listeners = new Set<() => void>()
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private queue: Op[] = []
  private timer = 0
  private flushing: Promise<void> | null = null
  private onReload?: () => void

  constructor(data: TableData, opts: { readOnly?: boolean; onReload?: () => void } = {}) {
    this.state = { ...data, records: [...data.records].sort(bySortSeq) }
    this.readOnly = !!opts.readOnly
    this.onReload = opts.onReload
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  getSnapshot = () => this.state
  private emit() {
    for (const fn of this.listeners) fn()
  }

  get canUndo() {
    return this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  get pending() {
    return this.queue.length > 0 || this.flushing !== null
  }

  field(id: string) {
    return this.state.fields.find((f) => f.id === id)
  }
  view(id: string) {
    return this.state.views.find((v) => v.id === id)
  }
  record(id: string) {
    return this.state.records.find((r) => r.id === id)
  }

  private txn: HistoryEntry[] | null = null

  /** Applies ops locally and queues them for the server; inverse=null means not undoable. */
  apply(forward: Op[], inverse: Op[] | null) {
    if (!forward.length) return
    this.state = applyOps(this.state, forward)
    if (inverse) {
      const entry = { forward, inverse: inverse.reverse() }
      if (this.txn) this.txn.push(entry)
      else this.pushHistory(entry)
    }
    this.enqueue(forward)
    this.emit()
  }

  private pushHistory(e: HistoryEntry) {
    this.undoStack.push(e)
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
  }

  /** Groups every change made inside fn into a single undo step. */
  transact<T>(fn: () => T): T {
    if (this.txn) return fn()
    this.txn = []
    try {
      return fn()
    } finally {
      const entries = this.txn
      this.txn = null
      if (entries.length)
        this.pushHistory({
          forward: entries.flatMap((e) => e.forward),
          inverse: entries.reverse().flatMap((e) => e.inverse),
        })
    }
  }

  undo() {
    const e = this.undoStack.pop()
    if (!e) return false
    this.state = applyOps(this.state, e.inverse)
    this.redoStack.push(e)
    this.enqueue(e.inverse)
    this.emit()
    return true
  }

  redo() {
    const e = this.redoStack.pop()
    if (!e) return false
    this.state = applyOps(this.state, e.forward)
    this.undoStack.push(e)
    this.enqueue(e.forward)
    this.emit()
    return true
  }

  private enqueue(ops: Op[]) {
    if (this.readOnly) return
    this.queue.push(...ops)
    this.setSync('saving')
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => this.flush(), 400)
  }

  private setSync(s: SyncState) {
    if (this.sync !== s) {
      this.sync = s
      this.emit()
    }
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.flushing) await this.flushing
    if (!this.queue.length) return
    const ops = this.queue
    this.queue = []
    this.flushing = api
      .tableOps(this.state.id, ops)
      .then(() => {
        if (!this.queue.length) this.setSync('saved')
      })
      .catch((e) => {
        // local state no longer matches the server: drop it and reload
        this.queue = []
        this.undoStack = []
        this.redoStack = []
        this.setSync('error')
        toast('保存失败：' + e.message)
        this.onReload?.()
      })
      .finally(() => {
        this.flushing = null
      })
    await this.flushing
    if (this.queue.length) return this.flush()
  }

  // ---------- records ----------

  nextSeq() {
    return this.state.records.reduce((m, r) => Math.max(m, r.seq), 0) + 1
  }

  /** Sets cell values; undefined / empty clears. Changes to computed fields are ignored. */
  setCells(changes: CellChange[], extraForward: Op[] = [], extraInverse: Op[] = []) {
    const fwd = new Map<string, Record<string, any>>()
    const inv = new Map<string, Record<string, any>>()
    for (const c of changes) {
      const f = this.field(c.field)
      const r = this.record(c.rec)
      if (!f || !r || isComputed(f.type)) continue
      const next = isEmptyValue(c.value) ? null : c.value
      const prev = r.data[f.id] ?? null
      if (JSON.stringify(next) === JSON.stringify(prev)) continue
      if (!fwd.has(r.id)) {
        fwd.set(r.id, {})
        inv.set(r.id, {})
      }
      fwd.get(r.id)![f.id] = next
      inv.get(r.id)![f.id] = prev
      this.sticky.add(r.id)
    }
    const forward: Op[] = [...extraForward, ...[...fwd].map(([id, data]) => ({ op: 'record.update' as const, id, data }))]
    const inverse: Op[] = [...extraInverse, ...[...inv].map(([id, data]) => ({ op: 'record.update' as const, id, data }))]
    if (fwd.size || extraForward.length) this.apply(forward, inverse)
  }

  /** Inserts records after `after` (or at the end). Returns the new ids. */
  addRecords(datas: Record<string, any>[], after?: string, extraForward: Op[] = [], extraInverse: Op[] = []): string[] {
    const recs = this.state.records
    let lo: number
    let hi: number
    const i = after ? recs.findIndex((r) => r.id === after) : -1
    if (i >= 0) {
      lo = recs[i].sort
      hi = recs[i + 1]?.sort ?? lo + datas.length + 1
    } else {
      lo = recs.at(-1)?.sort ?? 0
      hi = lo + datas.length + 1
    }
    const step = (hi - lo) / (datas.length + 1)
    let seq = this.nextSeq()
    const forward: Op[] = [...extraForward]
    const inverse: Op[] = [...extraInverse]
    const ids: string[] = []
    datas.forEach((data, k) => {
      const id = newId()
      ids.push(id)
      const clean: Record<string, any> = {}
      for (const [key, v] of Object.entries(data)) if (!isEmptyValue(v)) clean[key] = v
      forward.push({ op: 'record.create', id, data: clean, sort: lo + step * (k + 1), seq: seq++ })
      inverse.push({ op: 'record.delete', id })
      this.sticky.add(id)
    })
    this.apply(forward, inverse)
    return ids
  }

  deleteRecords(ids: string[]) {
    const set = new Set(ids)
    const victims = this.state.records.filter((r) => set.has(r.id))
    if (!victims.length) return
    this.apply(
      victims.map((r) => ({ op: 'record.delete', id: r.id })),
      victims.map((r) => ({ op: 'record.create', id: r.id, data: clone(r.data), sort: r.sort, seq: r.seq, created_at: r.created_at })),
    )
  }

  /** Moves a record (kanban drag): new sort key plus optional value changes. */
  moveRecord(id: string, sort: number | undefined, data?: Record<string, any>) {
    const r = this.record(id)
    if (!r) return
    const prev: Record<string, any> = {}
    for (const k of Object.keys(data ?? {})) prev[k] = r.data[k] ?? null
    this.apply(
      [{ op: 'record.update', id, ...(data && { data }), ...(sort !== undefined && { sort }) }],
      [{ op: 'record.update', id, ...(data && { data: prev }), ...(sort !== undefined && { sort: r.sort }) }],
    )
  }

  /**
   * Moves a record right before / after another one in the table order (grid row drag),
   * optionally changing values (the group it was dropped into). False if nothing changed.
   */
  reorderRecord(id: string, anchorId: string, place: 'before' | 'after', data: Record<string, any> = {}): boolean {
    const recs = this.state.records
    const k = recs.findIndex((r) => r.id === id)
    const r = recs[k]
    if (!r || id === anchorId) return false
    const rest = recs.filter((x) => x.id !== id)
    const a = rest.findIndex((x) => x.id === anchorId)
    if (a < 0) return false
    const at = place === 'after' ? a + 1 : a
    const forward: Op[] = []
    const inverse: Op[] = []
    let sort: number | undefined
    if (at !== k) {
      const lo = rest[at - 1]
      const hi = rest[at]
      const mid = lo && hi ? (lo.sort + hi.sort) / 2 : NaN
      if (lo && hi && mid > lo.sort && mid < hi.sort) sort = mid
      else if (lo && !hi) sort = lo.sort + 1
      else if (hi && !lo) sort = hi.sort - 1
      else {
        // no room left between the neighbours (equal keys or float precision): renumber
        const order = [...rest]
        order.splice(at, 0, r)
        order.forEach((x, i) => {
          if (x.id === id || x.sort === i + 1) return
          forward.push({ op: 'record.update', id: x.id, sort: i + 1 })
          inverse.push({ op: 'record.update', id: x.id, sort: x.sort })
        })
        sort = at + 1
      }
    }
    const next: Record<string, any> = {}
    const prev: Record<string, any> = {}
    for (const [key, v] of Object.entries(data)) {
      const cur = r.data[key] ?? null
      if (JSON.stringify(cur) === JSON.stringify(isEmptyValue(v) ? null : v)) continue
      next[key] = isEmptyValue(v) ? null : v
      prev[key] = cur
    }
    const hasData = Object.keys(next).length > 0
    if (sort === undefined && !hasData) return false
    forward.push({ op: 'record.update', id, ...(hasData && { data: next }), ...(sort !== undefined && { sort }) })
    inverse.push({ op: 'record.update', id, ...(hasData && { data: prev }), ...(sort !== undefined && { sort: r.sort }) })
    this.sticky.add(id)
    this.apply(forward, inverse)
    return true
  }

  // ---------- fields ----------

  addField(name: string, type: FieldType, options: FieldOptions, opts: { viewId?: string; after?: string; first?: boolean } = {}): string {
    const id = newId()
    const sort = (this.state.fields.at(-1)?.sort ?? 0) + 1
    const forward: Op[] = [{ op: 'field.create', id, name, type, options, sort }]
    this.apply(forward, [{ op: 'field.delete', id }])
    // place the column right after `after` (or first after the primary) in the view
    if (opts.viewId && (opts.after || opts.first)) {
      const v = this.view(opts.viewId)
      if (v) {
        const order = orderIds(this.state, v).filter((x) => x !== id)
        const i = opts.first ? -1 : order.indexOf(opts.after!)
        order.splice(opts.first ? 0 : i >= 0 ? i + 1 : order.length, 0, id)
        this.updateView(v.id, { order })
      }
    }
    return id
  }

  /** Updates a field; changing the type converts every stored value. */
  updateField(id: string, patch: { name?: string; type?: FieldType; options?: FieldOptions }) {
    const f = this.field(id)
    if (!f) return
    const next: Field = { ...f, ...patch, options: patch.options ?? f.options }
    const forward: Op[] = [{ op: 'field.update', id, ...patch }]
    const inverse: Op[] = [{ op: 'field.update', id, name: f.name, type: f.type, options: clone(f.options) }]
    if (patch.type && patch.type !== f.type) {
      const col = choiceCollector([next])
      const changes: [Rec, any][] = []
      for (const r of this.state.records) {
        const v = r.data[f.id]
        if (v === undefined) continue
        changes.push([r, convertValue(f, next, v, col.resolve)])
      }
      const added = col.added.get(id)
      if (added?.length) {
        next.options = { ...next.options, choices: [...(next.options.choices ?? []), ...added] }
        ;(forward[0] as any).options = next.options
      }
      for (const [r, v] of changes) {
        forward.push({ op: 'record.update', id: r.id, data: { [id]: isEmptyValue(v) ? null : v } })
        inverse.push({ op: 'record.update', id: r.id, data: { [id]: r.data[id] } })
      }
    } else if (patch.options?.choices && (f.type === 'select' || f.type === 'multiselect')) {
      // values pointing at removed choices are cleared
      const keep = new Set(patch.options.choices.map((c) => c.id))
      for (const r of this.state.records) {
        const v = r.data[id]
        if (v === undefined) continue
        const nv = f.type === 'select' ? (keep.has(v) ? v : null) : (v as string[]).filter((x) => keep.has(x))
        if (JSON.stringify(nv) !== JSON.stringify(v)) {
          forward.push({ op: 'record.update', id: r.id, data: { [id]: isEmptyValue(nv) ? null : nv } })
          inverse.push({ op: 'record.update', id: r.id, data: { [id]: v } })
        }
      }
    }
    this.apply(forward, inverse)
  }

  deleteField(id: string) {
    const f = this.field(id)
    if (!f || this.state.fields[0]?.id === id) return
    const inverse: Op[] = [{ op: 'field.create', id, name: f.name, type: f.type, options: clone(f.options), sort: f.sort }]
    for (const r of this.state.records) if (r.data[id] !== undefined) inverse.push({ op: 'record.update', id: r.id, data: { [id]: r.data[id] } })
    this.apply([{ op: 'field.delete', id }], inverse.reverse())
  }

  /** Adds a choice to a select field and returns its id (used by editors). */
  addChoice(fieldId: string, name: string): string {
    const f = this.field(fieldId)!
    const choices = f.options.choices ?? []
    const existing = choices.find((c) => c.name === name.trim())
    if (existing) return existing.id
    const c: Choice = { id: newId(), name: name.trim(), color: choices.length % 10 }
    this.apply([{ op: 'field.update', id: fieldId, options: { ...f.options, choices: [...choices, c] } }], [{ op: 'field.update', id: fieldId, options: clone(f.options) }])
    return c.id
  }

  // ---------- views (layout changes are not part of undo history) ----------

  addView(name: string, type: ViewType, config: ViewConfig = {}): string {
    const id = newId()
    this.apply([{ op: 'view.create', id, name, type, config, sort: (this.state.views.at(-1)?.sort ?? 0) + 1 }], null)
    return id
  }

  updateView(id: string, patch: Partial<ViewConfig>, name?: string) {
    const v = this.view(id)
    if (!v) return
    const config = { ...v.config, ...patch }
    for (const k of Object.keys(config) as (keyof ViewConfig)[]) if (config[k] === undefined) delete config[k]
    if (patch.filter || patch.sorts || patch.groups) this.sticky.clear()
    this.apply([{ op: 'view.update', id, config, ...(name !== undefined && { name }) }], null)
  }

  renameView(id: string, name: string) {
    this.apply([{ op: 'view.update', id, name }], null)
  }

  deleteView(id: string) {
    if (this.state.views.length <= 1) return
    this.apply([{ op: 'view.delete', id }], null)
  }

  moveView(id: string, sort: number) {
    this.apply([{ op: 'view.update', id, sort }], null)
  }

  setTitle(title: string) {
    this.state = { ...this.state, title }
    this.emit()
  }

  /** Replaces the whole state (after a reload). */
  reset(data: TableData) {
    this.state = { ...data, records: [...data.records].sort(bySortSeq) }
    this.undoStack = []
    this.redoStack = []
    this.sticky.clear()
    this.setSync('saved')
    this.emit()
  }
}

/** Non-primary field ids in the view's column order. */
export function orderIds(t: TableData, v: View): string[] {
  const order = v.config.order ?? []
  const pos = new Map(order.map((id, i) => [id, i]))
  return t.fields
    .slice(1)
    .map((f, i) => ({ id: f.id, i }))
    .sort((a, b) => (pos.get(a.id) ?? 1e6 + a.i) - (pos.get(b.id) ?? 1e6 + b.i))
    .map((x) => x.id)
}

/** field.update ops adding the choices created while parsing. */
export function choiceOps(model: TableModel, added: Map<string, { id: string; name: string; color: number }[]>): [Op[], Op[]] {
  const fwd: Op[] = []
  const inv: Op[] = []
  for (const [fid, choices] of added) {
    const f = model.field(fid)
    if (!f || !choices.length) continue
    fwd.push({ op: 'field.update', id: fid, options: { ...f.options, choices: [...(f.options.choices ?? []), ...choices] } })
    inv.push({ op: 'field.update', id: fid, options: JSON.parse(JSON.stringify(f.options)) })
  }
  return [fwd, inv]
}

export function useTable(m: TableModel): TableData {
  return useSyncExternalStore(m.subscribe, m.getSnapshot)
}

/** Re-renders on sync-state changes as well (state object identity changes on edits). */
export function useSyncState(m: TableModel): SyncState {
  return useSyncExternalStore(m.subscribe, () => m.sync)
}

export { cellValue }
