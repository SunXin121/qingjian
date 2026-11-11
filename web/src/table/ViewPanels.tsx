import { useMemo, useRef, useState, type ReactNode } from 'react'
import { openMenu, openPopover } from '../components/dialog'
import { IconClose, IconEdit, IconPlus } from '../components/icons'
import { ChoicePicker, Tags } from './editors'
import { cellValue, DATE_PRESETS, defaultCondValue, displayText, exprField, filterOps, kanbanField, kanbanFieldOk, orderedFields } from './engine'
import { openFieldEditor } from './FieldEditor'
import { compileFilter, compileFormula, FORMULA_FUNCTIONS, toDisplayExpr, toStoredExpr } from './formula'
import { orderIds, useTable, type TableModel } from './model'
import { coverField } from './GalleryView'
import { calendarEndField, calendarField, calendarFieldOk } from './CalendarView'
import { ganttColorOk, ganttDepOk, ganttProgressOk } from './GanttView'
import { baseField, fieldTypeLabel, isComputed, newId, type Field, type FilterCond, type SortRule, type View } from './types'

/** select value standing for "use an expression" */
const EXPR = '__expr'

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
        const conj = (
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
        )
        const remove = (
          <button className="icon-btn sm" title="删除条件" onClick={() => set(filter.conds.filter((_, j) => j !== i))}>
            <IconClose width={14} height={14} />
          </button>
        )
        if (c.op === 'expr') return <ExprCond key={c.id} model={model} value={c.value ?? ''} conj={conj} remove={remove} onChange={(value) => update(i, { value })} />
        const f0 = fields.find((x) => x.id === c.field)
        const f = f0 && baseField(f0)
        const ops = f ? filterOps(f.type) : []
        const op = ops.find((o) => o.op === c.op)
        return (
          <div key={c.id} className="bt-cond">
            {conj}
            <FieldSelect
              fields={fields}
              value={c.field}
              onChange={(id) => {
                const nf = baseField(fields.find((x) => x.id === id)!)
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
            {remove}
          </div>
        )
      })}
      <div className="bt-panel-actions">
        <button
          className="btn ghost sm"
          onClick={() => {
            const f = fields[0]
            set([...filter.conds, { id: newId(), field: f.id, op: filterOps(f.type)[0].op, value: defaultCondValue(f.type) }])
          }}
        >
          <IconPlus width={14} height={14} /> 添加条件
        </button>
        <button className="btn ghost sm" onClick={() => set([...filter.conds, { id: newId(), field: '', op: 'expr', value: '' }])}>
          <IconPlus width={14} height={14} /> 添加表达式
        </button>
      </div>
    </div>
  )
}

/** A filter condition written as a formula expression (formula.ts). */
function ExprCond({ model, value, conj, remove, onChange }: { model: TableModel; value: string; conj: ReactNode; remove: ReactNode; onChange: (stored: string) => void }) {
  return <ExprInput model={model} value={value} lead={conj} trailing={remove} onChange={onChange} mode="filter" />
}

/**
 * Formula expression input (formula.ts) with field / function pickers. The text as typed
 * (field names) is the source while editing; `value` / `onChange` use the stored form,
 * which references fields by id. `filter` mode reports how many records match, `value`
 * mode how many distinct values the expression gives.
 */
export function ExprInput({
  model,
  value,
  onChange,
  mode,
  lead,
  trailing,
  extra,
  placeholder,
  sample,
}: {
  model: TableModel
  value: string
  onChange: (stored: string) => void
  mode: 'filter' | 'value'
  lead?: ReactNode
  trailing?: ReactNode
  /** controls shown in the bar under the input */
  extra?: ReactNode
  placeholder?: string
  /** value mode: show the first non-empty result instead of the number of distinct values */
  sample?: boolean
}) {
  const t = useTable(model)
  const [text, setText] = useState(() => toDisplayExpr(t, value))
  const ref = useRef<HTMLTextAreaElement>(null)
  const stored = text.trim() ? toStoredExpr(t, text) : ''
  const res = stored ? (mode === 'filter' ? compileFilter(t, stored) : compileFormula(t, stored)) : null
  const status = useMemo(() => {
    if (!res?.ok) return null
    if ('test' in res) {
      let n = 0
      for (const r of t.records) if (res.test(r)) n++
      return `符合 ${n} 条记录`
    }
    const f = exprField(t, stored)
    if (!f) return null
    if (sample) {
      for (const r of t.records) {
        const v = displayText(f, cellValue(r, f))
        if (v) return `示例：${v.length > 24 ? v.slice(0, 24) + '…' : v}`
      }
      return null
    }
    const seen = new Set<string>()
    for (const r of t.records) seen.add(displayText(f, cellValue(r, f)))
    seen.delete('')
    return `得到 ${seen.size} 个不同的值`
  }, [res, t, stored, sample])
  const change = (v: string) => {
    setText(v)
    onChange(v.trim() ? toStoredExpr(t, v) : '')
  }
  const insert = (s: string, back = 0) => {
    const el = ref.current
    if (!el) return
    const a = el.selectionStart
    const v = el.value.slice(0, a) + s + el.value.slice(el.selectionEnd)
    change(v)
    requestAnimationFrame(() => {
      el.focus()
      const p = a + s.length - back
      el.setSelectionRange(p, p)
    })
  }
  return (
    <div className={'bt-cond-expr' + (lead ? '' : ' no-lead')}>
      <div className="bt-cond">
        {lead}
        <textarea
          ref={ref}
          className={'bt-input bt-expr-input' + (res && !res.ok ? ' invalid' : '')}
          rows={2}
          spellCheck={false}
          value={text}
          placeholder={placeholder ?? (mode === 'filter' ? '例如 {价格} > 100 AND CONTAINS({标题}, "bug")' : '例如 YEAR({日期}) & "年" 或 IF({价格} > 100, "高", "低")')}
          onChange={(e) => change(e.target.value)}
        />
        {trailing}
      </div>
      <div className="bt-expr-bar">
        <button
          className="btn ghost sm"
          onClick={(e) =>
            openMenu(
              e.currentTarget,
              t.fields.map((f) => ({ label: f.name, onClick: () => insert(`{${f.name}}`) })),
              { align: 'left', width: 220 },
            )
          }
        >
          {'{ }'} 插入字段
        </button>
        <button className="btn ghost sm" onClick={(e) => openPopover(e.currentTarget, (close) => <FormulaHelp onPick={(name) => (close(), insert(name + '()', 1))} formula={mode === 'value'} />, { width: 380, align: 'left' })}>
          ƒ 函数与语法
        </button>
        {extra}
        <span className="spacer" />
        {res && !res.ok ? <span className="bt-expr-error">{res.error}</span> : status ? <span className="bt-expr-ok">{status}</span> : null}
      </div>
    </div>
  )
}

export function FormulaHelp({ onPick, formula }: { onPick: (name: string) => void; formula?: boolean }) {
  const groups = [...new Set(FORMULA_FUNCTIONS.map((f) => f.group))]
  return (
    <div className="bt-formula-help">
      <div className="bt-formula-syntax">
        {formula && <div>公式对每条记录计算一次，结果可以是数字、文本、日期或真假值（显示为复选框）。</div>}
        <div>
          字段写作 <code>{'{字段名}'}</code>，文本用引号 <code>"文本"</code>
        </div>
        <div>
          比较 <code>= != &gt; &gt;= &lt; &lt;=</code>，逻辑 <code>AND OR NOT</code>（或 <code>&amp;&amp; || !</code>），括号分组
        </div>
        <div>
          运算 <code>+ - * / %</code>，<code>&amp;</code> 拼接文本；日期 ± 数字按天计算，日期 − 日期得到天数
        </div>
        <div>单选取选项名；多选与某个值比较时，包含该选项即为相等；文本比较不区分大小写</div>
        <div>
          示例：
          {formula ? <code>{'IF({截止日期} < TODAY(), "已逾期", DAYS({截止日期}, TODAY()) & " 天后到期")'}</code> : <code>{'{截止日期} < TODAY() AND {状态} != "已完成"'}</code>}
        </div>
      </div>
      {groups.map((g) => (
        <div key={g} className="bt-formula-group">
          <div className="bt-formula-group-title">{g}</div>
          {FORMULA_FUNCTIONS.filter((f) => f.group === g).map((f) => (
            <button key={f.name} className="bt-formula-fn" onClick={() => onPick(f.name)}>
              <code>{f.sig}</code>
              <span>{f.desc}</span>
            </button>
          ))}
        </div>
      ))}
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
  const update = (i: number, patch: Partial<SortRule>) => set(rules.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const unused = fields.filter((f) => !rules.some((r) => r.expr === undefined && r.field === f.id) && (kind === 'sorts' || f.type !== 'attachment'))
  const max = kind === 'groups' ? 3 : 5
  const order = (r: SortRule, i: number) => (
    <select className="bt-input sm" value={r.desc ? '1' : '0'} onChange={(e) => update(i, { desc: e.target.value === '1' })}>
      <option value="0">升序 A → Z</option>
      <option value="1">降序 Z → A</option>
    </select>
  )
  const remove = (i: number) => (
    <button className="icon-btn sm" title="删除" onClick={() => set(rules.filter((_, j) => j !== i))}>
      <IconClose width={14} height={14} />
    </button>
  )
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">{kind === 'sorts' ? '排序' : '分组'}</div>
      {rules.length === 0 && <div className="bt-panel-empty">{kind === 'sorts' ? '按字段或表达式对记录排序' : '按字段或表达式把记录分组显示，最多 3 级'}</div>}
      {rules.map((r, i) =>
        r.expr !== undefined ? (
          <ExprInput key={r.id ?? 'e' + i} model={model} value={r.expr} mode="value" trailing={remove(i)} extra={order(r, i)} onChange={(expr) => update(i, { expr })} />
        ) : (
          <div key={r.field + i} className="bt-cond">
            <FieldSelect fields={fields.filter((f) => f.id === r.field || unused.includes(f))} value={r.field} onChange={(id) => update(i, { field: id })} />
            {order(r, i)}
            {remove(i)}
          </div>
        ),
      )}
      {rules.length < max && (
        <div className="bt-panel-actions">
          {unused.length > 0 && (
            <button
              className="btn ghost sm"
              onClick={() => {
                // grouping by a category reads best; fall back to any field
                const pick = kind === 'groups' ? (unused.find((f) => f.type === 'select') ?? unused.find((f) => f.type === 'checkbox' || f.type === 'multiselect') ?? unused[0]) : unused[0]
                set([...rules, { field: pick.id }])
              }}
            >
              <IconPlus width={14} height={14} /> {kind === 'sorts' ? '添加排序' : '添加分组'}
            </button>
          )}
          <button className="btn ghost sm" onClick={() => set([...rules, { field: '', expr: '', id: newId() }])}>
            <IconPlus width={14} height={14} /> 添加表达式
          </button>
        </div>
      )}
    </div>
  )
}

export const SortPanel = (p: { model: TableModel; viewId: string }) => <RulesPanel {...p} kind="sorts" />
export const GroupPanel = (p: { model: TableModel; viewId: string }) => <RulesPanel {...p} kind="groups" />

export function KanbanPanel({ model, viewId }: { model: TableModel; viewId: string }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const t = model.data
  const options = fields.filter(kanbanFieldOk)
  const cur = kanbanField(t, view)
  const isExpr = view.config.kanbanExpr !== undefined
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">看板分组字段</div>
      <select
        className="bt-input sm"
        value={isExpr ? EXPR : (cur?.id ?? '')}
        onChange={(e) => model.updateView(viewId, e.target.value === EXPR ? { kanbanExpr: '' } : { kanbanField: e.target.value, kanbanExpr: undefined })}
      >
        {!cur && !isExpr && <option value="">选择分组字段…</option>}
        {options.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}（{fieldTypeLabel(f.type)}）
          </option>
        ))}
        <option value={EXPR}>按表达式分组…</option>
      </select>
      {isExpr && <ExprInput key={viewId} model={model} value={view.config.kanbanExpr ?? ''} mode="value" onChange={(kanbanExpr) => model.updateView(viewId, { kanbanExpr })} />}
      <div className="bt-panel-empty">
        {isExpr
          ? '每个不同的计算结果一列；结果由表达式自动计算，卡片不能拖到其他列'
          : !cur
          ? '可按除附件、自动编号外的任意字段分组'
          : cur.type === 'select' || cur.type === 'multiselect'
            ? cur.type === 'multiselect'
              ? '每个选项一列，有多个选项的记录会出现在多列中'
              : '每个选项一列，拖动卡片即可修改选项'
            : cur.type === 'checkbox'
              ? '分为「未勾选」「已勾选」两列'
              : isComputed(cur.type)
                ? '每个日期一列；该字段自动生成，卡片不能拖到其他列'
                : '每个不同的值一列，拖动卡片会把值改成目标列的值'}
      </div>
      {cur?.type !== 'checkbox' && (
      <label className="bt-check-row">
        <input type="checkbox" checked={!view.config.hideEmptyColumn} onChange={(e) => model.updateView(viewId, { hideEmptyColumn: !e.target.checked || undefined })} /> 显示「未分组」列
      </label>
      )}
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

// ---------- gallery / calendar ----------

export function GalleryPanel({ model, viewId }: { model: TableModel; viewId: string }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const files = fields.filter((f) => f.type === 'attachment')
  const cur = coverField(model.data, view)
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">封面</div>
      <select className="bt-input sm" value={cur?.id ?? ''} onChange={(e) => model.updateView(viewId, { coverField: e.target.value })}>
        <option value="">不显示封面</option>
        {files.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {!files.length && <div className="bt-panel-empty">添加一个附件字段后，可把其中的第一张图片作为封面</div>}
      {cur && (
        <label className="bt-check-row">
          <input type="checkbox" checked={view.config.coverFit === 'contain'} onChange={(e) => model.updateView(viewId, { coverFit: e.target.checked ? 'contain' : undefined })} /> 完整显示图片（不裁剪）
        </label>
      )}
      <div className="bt-panel-empty">卡片上显示的字段可在「字段」中设置</div>
    </div>
  )
}

export function CalendarPanel({ model, viewId, gantt }: { model: TableModel; viewId: string; gantt?: boolean }) {
  const [view, fields] = useView(model, viewId)
  if (!view) return null
  const options = fields.filter(calendarFieldOk)
  const cur = calendarField(model.data, view)
  const end = calendarEndField(model.data, view)
  return (
    <div className="bt-panel">
      <div className="bt-panel-title">开始日期</div>
      <select className="bt-input sm" value={cur?.id ?? ''} onChange={(e) => model.updateView(viewId, { dateField: e.target.value })}>
        {!cur && <option value="">选择日期字段…</option>}
        {options.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}（{fieldTypeLabel(f.type)}）
          </option>
        ))}
      </select>
      <div className="bt-panel-title">结束日期</div>
      <select className="bt-input sm" value={end?.id ?? ''} onChange={(e) => model.updateView(viewId, { endField: e.target.value || undefined })}>
        <option value="">{gantt ? '无（每条记录只占一天）' : '无（只显示在开始日期）'}</option>
        {options
          .filter((f) => f.id !== cur?.id)
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
      </select>
      <TitleOptions model={model} view={view} fields={fields} />
      {gantt ? (
        <GanttOptions model={model} view={view} fields={fields} />
      ) : (
        <div className="bt-panel-empty">{cur?.type === 'date' ? '拖动记录可修改日期，双击空白处新建记录' : '该字段自动计算，记录不能拖动'}</div>
      )}
    </div>
  )
}

/** What a calendar / gantt record shows: some fields joined, or an expression. */
function TitleOptions({ model, view, fields }: { model: TableModel; view: View; fields: Field[] }) {
  const cfg = view.config
  const isExpr = cfg.titleExpr !== undefined
  const byId = new Map(fields.map((f) => [f.id, f]))
  const chosen = (cfg.titleFields ?? []).filter((id) => byId.has(id))
  const shown = chosen.length ? chosen : fields[0] ? [fields[0].id] : []
  const rest = fields.filter((f) => !shown.includes(f.id) && f.type !== 'attachment')
  const setFields = (ids: string[]) => model.updateView(view.id, { titleFields: ids.length ? ids : undefined })
  return (
    <>
      <div className="bt-panel-title">
        显示内容
        <span className="spacer" />
        <span className="seg">
          <button className={isExpr ? '' : 'active'} onClick={() => isExpr && model.updateView(view.id, { titleExpr: undefined })}>
            字段
          </button>
          <button className={isExpr ? 'active' : ''} onClick={() => !isExpr && model.updateView(view.id, { titleExpr: '' })}>
            表达式
          </button>
        </span>
      </div>
      {isExpr ? (
        <ExprInput
          key={view.id}
          model={model}
          value={cfg.titleExpr ?? ''}
          mode="value"
          sample
          placeholder={'例如 {标题} & " - " & {负责人}'}
          onChange={(titleExpr) => model.updateView(view.id, { titleExpr })}
        />
      ) : (
        <div className="bt-title-fields">
          {shown.map((id) => (
            <span key={id} className="bt-title-field">
              <span className="ellipsis">{byId.get(id)!.name}</span>
              {shown.length > 1 && (
                <button className="icon-btn sm" title="移除" onClick={() => setFields(shown.filter((x) => x !== id))}>
                  <IconClose width={12} height={12} />
                </button>
              )}
            </span>
          ))}
          {rest.length > 0 && (
            <button
              className="btn ghost sm"
              onClick={(e) =>
                openMenu(
                  e.currentTarget,
                  rest.map((f) => ({ label: f.name, onClick: () => setFields([...shown, f.id]) })),
                  { align: 'left', width: 200 },
                )
              }
            >
              <IconPlus width={14} height={14} /> 添加字段
            </button>
          )}
        </div>
      )}
      <div className="bt-panel-empty">{isExpr ? '用表达式组合多个字段，例如拼接文本、格式化日期' : '多个字段的值用「·」连接显示'}</div>
    </>
  )
}

export const GanttPanel = (p: { model: TableModel; viewId: string }) => <CalendarPanel {...p} gantt />

function GanttOptions({ model, view, fields }: { model: TableModel; view: View; fields: Field[] }) {
  const cfg = view.config
  const colors = fields.filter(ganttColorOk)
  const progress = fields.filter(ganttProgressOk)
  const deps = fields.filter(ganttDepOk(model.data))
  const pick = (list: Field[], id: string | undefined) => list.find((f) => f.id === id)?.id ?? ''
  const addDepField = () => {
    const id = model.addField(uniqueFieldName(fields, '前置任务'), 'link', { table: model.data.id, multiple: true }, { viewId: view.id })
    model.updateView(view.id, { depField: id })
  }
  return (
    <>
      <div className="bt-panel-title">条形颜色</div>
      <select className="bt-input sm" value={pick(colors, cfg.colorField)} onChange={(e) => model.updateView(view.id, { colorField: e.target.value || undefined })}>
        <option value="">默认颜色</option>
        {colors.map((f) => (
          <option key={f.id} value={f.id}>
            按「{f.name}」的选项颜色
          </option>
        ))}
      </select>
      <div className="bt-panel-title">进度</div>
      <select className="bt-input sm" value={pick(progress, cfg.progressField)} onChange={(e) => model.updateView(view.id, { progressField: e.target.value || undefined })}>
        <option value="">不显示</option>
        {progress.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <div className="bt-panel-title">前置任务</div>
      <select className="bt-input sm" value={pick(deps, cfg.depField)} onChange={(e) => model.updateView(view.id, { depField: e.target.value || undefined })}>
        <option value="">不显示依赖</option>
        {deps.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {!deps.length && !model.readOnly && (
        <button className="btn ghost sm bt-panel-add" onClick={addDepField}>
          <IconPlus width={14} height={14} /> 新建「前置任务」字段
        </button>
      )}
      <div className="bt-panel-empty">
        {calendarField(model.data, view)?.type === 'date'
          ? '拖动条形可调整日期，拖动两端可调整开始 / 结束；没有日期的记录点击时间轴即可安排。前置任务是关联本表的关联字段，依赖用箭头表示，冲突时显示为红色。'
          : '前置任务是关联本表的关联字段，依赖用箭头表示，冲突时显示为红色。'}
      </div>
    </>
  )
}

function uniqueFieldName(fields: Field[], base: string) {
  const names = new Set(fields.map((f) => f.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}
