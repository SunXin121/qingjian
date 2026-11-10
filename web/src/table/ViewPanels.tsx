import { useRef, useState } from 'react'
import { openPopover } from '../components/dialog'
import { IconClose, IconEdit, IconPlus } from '../components/icons'
import { ChoicePicker, Tags } from './editors'
import { DATE_PRESETS, defaultCondValue, filterOps, orderedFields } from './engine'
import { openFieldEditor } from './FieldEditor'
import { orderIds, useTable, type TableModel } from './model'
import { fieldTypeLabel, newId, type Field, type FilterCond, type SortRule, type View } from './types'

function useView(model: TableModel, viewId: string): [View | undefined, Field[]] {
  const t = useTable(model)
  const v = t.views.find((x) => x.id === viewId)
  return [v, t.fields]
}

function FieldSelect({ fields, value, onChange }: { fields: Field[]; value: string; onChange: (id: string) => void }) {
  return (
    <select className="bt-input sm" value={value} onChange={(e) => onChange(e.target.value)}>
      {fields.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  )
}

// ---------- filter ----------

export function FilterPanel({ model, viewId }: { model: TableModel; viewId: string }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const filter = view.config.filter ?? { conj: 'and' as const, conds: [] }
  const set = (conds: FilterCond[], conj = filter.conj) => model.updateView(viewId, { filter: { conj, conds } })
  const update = (i: number, patch: Partial<FilterCond>) => set(filter.conds.map((c, j) => (j === i ? { ...c, ...patch } : c)))

  return (
    <div className="bt-panel">
      <div className="bt-panel-title">筛选条件</div>
      {filter.conds.length === 0 && <div className="bt-panel-empty">还没有筛选条件，只显示符合条件的记录</div>}
      {filter.conds.map((c, i) => {
        const f = fields.find((x) => x.id === c.field)
        const ops = f ? filterOps(f.type) : []
        const op = ops.find((o) => o.op === c.op)
        return (
          <div key={c.id} className="bt-cond">
            <span className="bt-cond-conj">
              {i === 0 ? (
                '当'
              ) : i === 1 ? (
                <select className="bt-input sm" value={filter.conj} onChange={(e) => set(filter.conds, e.target.value as 'and' | 'or')}>
                  <option value="and">且</option>
                  <option value="or">或</option>
                </select>
              ) : filter.conj === 'and' ? (
                '且'
              ) : (
                '或'
              )}
            </span>
            <FieldSelect
              fields={fields}
              value={c.field}
              onChange={(id) => {
                const nf = fields.find((x) => x.id === id)!
                update(i, { field: id, op: filterOps(nf.type)[0].op, value: defaultCondValue(nf.type) })
              }}
            />
            <select className="bt-input sm bt-cond-op" value={c.op} onChange={(e) => update(i, { op: e.target.value as FilterCond['op'] })}>
              {ops.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </select>
            {f && !op?.unary ? <CondValue field={f} value={c.value} onChange={(value) => update(i, { value })} /> : <span className="bt-cond-value" />}
            <button className="icon-btn sm" title="删除条件" onClick={() => set(filter.conds.filter((_, j) => j !== i))}>
              <IconClose width={14} height={14} />
            </button>
          </div>
        )
      })}
      <button
        className="btn ghost sm bt-panel-add"
        onClick={() => {
          const f = fields[0]
          set([...filter.conds, { id: newId(), field: f.id, op: filterOps(f.type)[0].op, value: defaultCondValue(f.type) }])
        }}
      >
        <IconPlus width={14} height={14} /> 添加条件
      </button>
    </div>
  )
}

function CondValue({ field, value, onChange }: { field: Field; value: any; onChange: (v: any) => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  switch (field.type) {
    case 'checkbox':
      return (
        <select className="bt-input sm bt-cond-value" value={value ? '1' : '0'} onChange={(e) => onChange(e.target.value === '1')}>
          <option value="1">已勾选</option>
          <option value="0">未勾选</option>
        </select>
      )
    case 'select':
    case 'multiselect': {
      const pseudo: Field = { ...field, type: 'multiselect' }
      return (
        <button
          ref={ref}
          className="bt-input sm bt-cond-value bt-choice-field"
          onClick={() =>
            openPopover(ref.current!, (close) => <PickerState field={pseudo} initial={Array.isArray(value) ? value : []} onChange={onChange} onDone={close} />, { width: 260 })
          }
        >
          {Array.isArray(value) && value.length ? <Tags field={pseudo} value={value} /> : <span className="muted">选择选项</span>}
        </button>
      )
    }
    case 'date':
    case 'created_time':
    case 'modified_time': {
      const preset = DATE_PRESETS.some((p) => p.value === value)
      return (
        <span className="bt-cond-value bt-cond-date">
          <select className="bt-input sm" value={preset ? value : 'exact'} onChange={(e) => onChange(e.target.value === 'exact' ? '' : e.target.value)}>
            {DATE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="exact">具体日期</option>
          </select>
          {!preset && <input className="bt-input sm" type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />}
        </span>
      )
    }
    default:
      return (
        <input
          className="bt-input sm bt-cond-value"
          value={value ?? ''}
          inputMode={field.type === 'number' || field.type === 'autonumber' ? 'decimal' : undefined}
          placeholder="输入值"
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}

function PickerState({ field, initial, onChange, onDone }: { field: Field; initial: string[]; onChange: (v: string[]) => void; onDone: () => void }) {
  const [v, setV] = useState(initial)
  return (
    <ChoicePicker
      field={field}
      value={v}
      onChange={(x) => {
        setV(x ?? [])
        onChange(x ?? [])
      }}
      onDone={onDone}
    />
  )
}

// ---------- sort / group ----------

function RulesPanel({ model, viewId, kind }: { model: TableModel; viewId: string; kind: 'sorts' | 'groups' }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const rules: SortRule[] = view.config[kind] ?? []
  const set = (r: SortRule[]) => model.updateView(viewId, kind === 'groups' ? { groups: r, collapsed: [] } : { sorts: r })
  const unused = fields.filter((f) => !rules.some((r) => r.field === f.id) && (kind === 'sorts' || f.type !== 'attachment'))
  const max = kind === 'groups' ? 3 : 5
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">{kind === 'sorts' ? '排序' : '分组'}</div>
      {rules.length === 0 && <div className="bt-panel-empty">{kind === 'sorts' ? '按字段对记录排序' : '按字段把记录分组显示，最多 3 级'}</div>}
      {rules.map((r, i) => (
        <div key={r.field + i} className="bt-cond">
          <FieldSelect fields={fields.filter((f) => f.id === r.field || unused.includes(f))} value={r.field} onChange={(id) => set(rules.map((x, j) => (j === i ? { ...x, field: id } : x)))} />
          <select className="bt-input sm" value={r.desc ? '1' : '0'} onChange={(e) => set(rules.map((x, j) => (j === i ? { ...x, desc: e.target.value === '1' } : x)))}>
            <option value="0">升序 A → Z</option>
            <option value="1">降序 Z → A</option>
          </select>
          <button className="icon-btn sm" title="删除" onClick={() => set(rules.filter((_, j) => j !== i))}>
            <IconClose width={14} height={14} />
          </button>
        </div>
      ))}
      {rules.length < max && unused.length > 0 && (
        <button
          className="btn ghost sm bt-panel-add"
          onClick={() => {
            // grouping by a category reads best; fall back to any field
            const pick = kind === 'groups' ? (unused.find((f) => f.type === 'select') ?? unused.find((f) => f.type === 'checkbox' || f.type === 'multiselect') ?? unused[0]) : unused[0]
            set([...rules, { field: pick.id }])
          }}
        >
          <IconPlus width={14} height={14} /> {kind === 'sorts' ? '添加排序' : '添加分组'}
        </button>
      )}
    </div>
  )
}

export const SortPanel = (p: { model: TableModel; viewId: string }) => <RulesPanel {...p} kind="sorts" />
export const GroupPanel = (p: { model: TableModel; viewId: string }) => <RulesPanel {...p} kind="groups" />

export function KanbanPanel({ model, viewId }: { model: TableModel; viewId: string }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const selects = fields.filter((f) => f.type === 'select')
  const cur = selects.find((f) => f.id === view.config.kanbanField) ?? selects[0]
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">看板分组字段</div>
      {selects.length ? (
        <FieldSelect fields={selects} value={cur?.id ?? ''} onChange={(id) => model.updateView(viewId, { kanbanField: id })} />
      ) : (
        <div className="bt-panel-empty">需要一个「单选」字段</div>
      )}
      <label className="bt-check-row">
        <input type="checkbox" checked={!view.config.hideEmptyColumn} onChange={(e) => model.updateView(viewId, { hideEmptyColumn: !e.target.checked || undefined })} /> 显示「未分组」列
      </label>
    </div>
  )
}

// ---------- fields ----------

export function FieldsPanel({ model, viewId, readOnly }: { model: TableModel; viewId: string; readOnly: boolean }) {
  const t = useTable(model)
  const view = t.views.find((v) => v.id === viewId)
  const [drag, setDrag] = useState<string | null>(null)
  if (!view) return null
  const fields = orderedFields(t, view)
  const hidden = new Set(view.config.hidden ?? [])
  const setHidden = (h: Set<string>) => model.updateView(viewId, { hidden: [...h] })
  const move = (id: string, before: string) => {
    const order = orderIds(t, view).filter((x) => x !== id)
    const i = order.indexOf(before)
    order.splice(i < 0 ? order.length : i, 0, id)
    model.updateView(viewId, { order })
  }
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">
        字段
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setHidden(new Set())}>
          全部显示
        </button>
        <button className="btn ghost sm" onClick={() => setHidden(new Set(fields.slice(1).map((f) => f.id)))}>
          全部隐藏
        </button>
      </div>
      <div className="bt-field-list">
        {fields.map((f, i) => (
          <div
            key={f.id}
            className={'bt-field-item' + (drag === f.id ? ' dragging' : '')}
            draggable={i > 0}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              setDrag(f.id)
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => i > 0 && drag && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (drag && drag !== f.id && i > 0) move(drag, f.id)
              setDrag(null)
            }}
          >
            <span className="bt-drag-handle">{i > 0 ? '⠿' : ''}</span>
            <span className="ellipsis bt-field-name">{f.name}</span>
            <span className="bt-field-type">{i === 0 ? '主字段' : fieldTypeLabel(f.type)}</span>
            {!readOnly && (
              <button className="icon-btn sm" title="编辑字段" onClick={(e) => openFieldEditor(e.currentTarget, model, { field: f })}>
                <IconEdit width={14} height={14} />
              </button>
            )}
            <label className="switch bt-switch" title={i === 0 ? '主字段不能隐藏' : hidden.has(f.id) ? '显示' : '隐藏'}>
              <input
                type="checkbox"
                disabled={i === 0}
                checked={i === 0 || !hidden.has(f.id)}
                onChange={(e) => {
                  const h = new Set(hidden)
                  e.target.checked ? h.delete(f.id) : h.add(f.id)
                  setHidden(h)
                }}
              />
              <span />
            </label>
          </div>
        ))}
      </div>
      {!readOnly && (
        <button className="btn ghost sm bt-panel-add" onClick={(e) => openFieldEditor(e.currentTarget, model, { viewId, after: fields.at(-1)?.id })}>
          <IconPlus width={14} height={14} /> 新建字段
        </button>
      )}
    </div>
  )
}
