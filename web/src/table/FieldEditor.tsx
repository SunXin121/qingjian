import { useState } from 'react'
import { openPopover, toast, type Anchor } from '../components/dialog'
import { IconClose, IconPlus } from '../components/icons'
import { FormulaOptions, LinkOptions, LookupOptions, NumberFormat } from './ComputedOptions'
import type { TableModel } from './model'
import { FIELD_TYPES, newId, TAG_COLORS, type Choice, type Field, type FieldOptions, type FieldType } from './types'

type Target = { field: Field } | { viewId?: string; after?: string; first?: boolean; type?: FieldType; name?: string; onCreated?: (id: string) => void }

export function openFieldEditor(anchor: Anchor, model: TableModel, target: Target) {
  openPopover(anchor, (close) => <FieldEditor model={model} target={target} onClose={close} />, { width: 340, align: 'left' })
}

function defaultName(model: TableModel, type: FieldType) {
  const base = FIELD_TYPES.find((t) => t.type === type)!.label
  const names = new Set(model.state.fields.map((f) => f.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

function FieldEditor({ model, target, onClose }: { model: TableModel; target: Target; onClose: () => void }) {
  const editing = 'field' in target ? target.field : null
  const isPrimary = editing && model.state.fields[0]?.id === editing.id
  const init = 'field' in target ? {} : target
  const [type, setType] = useState<FieldType>(editing?.type ?? init.type ?? 'text')
  const [name, setName] = useState(editing?.name ?? init.name ?? '')
  const [options, setOptions] = useState<FieldOptions>(() => JSON.parse(JSON.stringify(editing?.options ?? {})))
  const choices = options.choices ?? []

  const setChoices = (c: Choice[]) => setOptions({ ...options, choices: c })

  const submit = () => {
    const finalName = name.trim() || (editing ? editing.name : defaultName(model, type))
    const opts: FieldOptions = { ...options }
    if (type !== 'select' && type !== 'multiselect') delete opts.choices
    else opts.choices = choices.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim() }))
    const numberFormat = type === 'number' || type === 'formula' || type === 'rollup'
    if (!numberFormat && type !== 'progress') delete opts.precision
    if (!numberFormat) delete opts.thousands
    if (type !== 'date') delete opts.time
    if (type !== 'rating') delete opts.max
    if (type !== 'formula') delete opts.expr
    if (type !== 'link') {
      delete opts.table
      delete opts.pair
      delete opts.multiple
    }
    if (type !== 'lookup' && type !== 'rollup') {
      delete opts.link
      delete opts.target
    }
    if (type !== 'rollup') delete opts.agg
    // the pair name is only needed to create the paired field
    if (type !== 'link' || !opts.pair || editing?.options.pair) delete opts.pairName
    if (type === 'link' && !opts.table) return toast('请选择关联的表格')
    if (editing) {
      model.updateField(editing.id, { name: finalName, ...(type !== editing.type && { type }), options: opts })
    } else {
      const t = target as Exclude<Target, { field: Field }>
      const id = model.addField(finalName, type, opts, { viewId: t.viewId, after: t.after, first: t.first })
      t.onCreated?.(id)
    }
    onClose()
  }

  // the primary field identifies a record, so it is limited to text-like types
  const types = isPrimary ? FIELD_TYPES.filter((t) => ['text', 'number', 'date', 'url', 'phone', 'email', 'autonumber'].includes(t.type)) : FIELD_TYPES

  return (
    <form
      className="bt-field-editor"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="bt-form-row">
        <span>字段名称</span>
        <input className="bt-input" autoFocus value={name} placeholder={defaultName(model, type)} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="bt-form-row">
        <span>字段类型</span>
        <select
          className="bt-input"
          value={type}
          onChange={(e) => {
            const t = e.target.value as FieldType
            setType(t)
            if ((t === 'select' || t === 'multiselect') && !options.choices?.length && editing?.type !== 'select' && editing?.type !== 'multiselect' && !editing)
              setOptions({ ...options, choices: [{ id: newId(), name: '选项 1', color: 0 }, { id: newId(), name: '选项 2', color: 1 }] })
          }}
        >
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {type === 'link' && <LinkOptions model={model} editing={editing} options={options} setOptions={setOptions} />}
      {(type === 'lookup' || type === 'rollup') && <LookupOptions model={model} editing={editing} options={options} setOptions={setOptions} type={type} />}
      {type === 'formula' && <FormulaOptions model={model} editing={editing} options={options} setOptions={setOptions} />}
      {editing?.rt?.error && type === editing.type && <div className="bt-hint warn">{editing.rt.error}</div>}

      {type === 'number' && <NumberFormat options={options} setOptions={setOptions} />}

      {type === 'rating' && (
        <label className="bt-form-row">
          <span>最高分</span>
          <select className="bt-input" value={options.max ?? 5} onChange={(e) => setOptions({ ...options, max: Number(e.target.value) })}>
            {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n} 星
              </option>
            ))}
          </select>
        </label>
      )}

      {type === 'progress' && (
        <label className="bt-form-row">
          <span>小数位数</span>
          <select className="bt-input" value={options.precision ?? 0} onChange={(e) => setOptions({ ...options, precision: Number(e.target.value) })}>
            <option value="0">整数 50%</option>
            <option value="1">1 位 50.0%</option>
            <option value="2">2 位 50.00%</option>
          </select>
        </label>
      )}

      {type === 'date' && (
        <label className="bt-check-row">
          <input type="checkbox" checked={!!options.time} onChange={(e) => setOptions({ ...options, time: e.target.checked })} /> 包含时间
        </label>
      )}

      {(type === 'select' || type === 'multiselect') && (
        <div className="bt-form-row">
          <span>选项</span>
          <div className="bt-choices">
            {choices.map((c, i) => (
              <div key={c.id} className="bt-choice-row">
                <button
                  type="button"
                  className={`bt-color-dot c${c.color % 10}`}
                  title="切换颜色"
                  onClick={() => setChoices(choices.map((x, j) => (j === i ? { ...x, color: (x.color + 1) % TAG_COLORS } : x)))}
                />
                <input
                  className="bt-input sm"
                  value={c.name}
                  placeholder="选项名称"
                  onChange={(e) => setChoices(choices.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      setChoices([...choices.slice(0, i + 1), { id: newId(), name: '', color: choices.length % TAG_COLORS }, ...choices.slice(i + 1)])
                      requestAnimationFrame(() => {
                        const inputs = document.querySelectorAll<HTMLInputElement>('.bt-choice-row input')
                        inputs[i + 1]?.focus()
                      })
                    }
                  }}
                />
                <button type="button" className="icon-btn sm" title="删除选项" onClick={() => setChoices(choices.filter((_, j) => j !== i))}>
                  <IconClose width={14} height={14} />
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost sm bt-add-choice" onClick={() => setChoices([...choices, { id: newId(), name: '', color: choices.length % TAG_COLORS }])}>
              <IconPlus width={14} height={14} /> 添加选项
            </button>
          </div>
        </div>
      )}

      {editing && type !== editing.type && <div className="bt-hint warn">修改类型会转换这一列已有的数据，可用 Ctrl+Z 撤销。</div>}
      {(type === 'autonumber' || type === 'created_time' || type === 'modified_time') && <div className="bt-hint">由系统自动生成，不能手动编辑。</div>}
      {editing && type !== editing.type && (type === 'formula' || type === 'lookup' || type === 'rollup') && <div className="bt-hint">这一列会改为自动计算，已有的数据会被清除。</div>}

      <div className="bt-form-actions">
        <button type="button" className="btn sm" onClick={onClose}>
          取消
        </button>
        <button type="submit" className="btn sm primary">
          {editing ? '保存' : '添加字段'}
        </button>
      </div>
    </form>
  )
}
