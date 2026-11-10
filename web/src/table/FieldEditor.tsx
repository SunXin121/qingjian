import { useState } from 'react'
import { openPopover, type Anchor } from '../components/dialog'
import { IconClose, IconPlus } from '../components/icons'
import type { TableModel } from './model'
import { FIELD_TYPES, newId, TAG_COLORS, type Choice, type Field, type FieldOptions, type FieldType } from './types'

type Target = { field: Field } | { viewId?: string; after?: string; first?: boolean; type?: FieldType; name?: string; onCreated?: (id: string) => void }

export function openFieldEditor(anchor: Anchor, model: TableModel, target: Target) {
  openPopover(anchor, (close) => <FieldEditor model={model} target={target} onClose={close} />, { width: 300, align: 'left' })
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
    if (type !== 'number') {
      delete opts.precision
      delete opts.thousands
    }
    if (type !== 'date') delete opts.time
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
  const types = isPrimary ? FIELD_TYPES.filter((t) => ['text', 'number', 'date', 'url', 'autonumber'].includes(t.type)) : FIELD_TYPES

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

      {type === 'number' && (
        <>
          <label className="bt-form-row">
            <span>小数位数</span>
            <select
              className="bt-input"
              value={options.precision ?? ''}
              onChange={(e) => setOptions({ ...options, precision: e.target.value === '' ? undefined : Number(e.target.value) })}
            >
              <option value="">不限</option>
              <option value="0">整数</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n} 位小数
                </option>
              ))}
            </select>
          </label>
          <label className="bt-check-row">
            <input type="checkbox" checked={!!options.thousands} onChange={(e) => setOptions({ ...options, thousands: e.target.checked })} /> 千分位分隔
          </label>
        </>
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
