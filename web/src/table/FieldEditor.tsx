import { useState } from 'react'
import { openPopover, toast, type Anchor } from '../components/dialog'
import { IconCheck, IconChevron, IconClose, IconPlus } from '../components/icons'
import { FormulaOptions, LinkOptions, LookupOptions, NumberFormat } from './ComputedOptions'
import { FieldTypeIcon } from './icons'
import type { TableModel } from './model'
import { FIELD_TYPES, fieldTypeLabel, newId, TAG_COLORS, type Choice, type Field, type FieldOptions, type FieldType } from './types'

type Target = { field: Field } | { viewId?: string; after?: string; first?: boolean; type?: FieldType; name?: string; onCreated?: (id: string) => void }

export function openFieldEditor(anchor: Anchor, model: TableModel, target: Target) {
  openPopover(anchor, (close) => <FieldEditor model={model} target={target} onClose={close} />, { width: 364, align: 'left' })
}

function defaultName(model: TableModel, type: FieldType) {
  const base = FIELD_TYPES.find((t) => t.type === type)!.label
  const names = new Set(model.state.fields.map((f) => f.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

function openColorPalette(anchor: HTMLElement, current: number, onPick: (color: number) => void) {
  openPopover(
    anchor,
    (close) => (
      <div className="bt-swatch-grid">
        {Array.from({ length: TAG_COLORS }, (_, c) => (
          <button
            key={c}
            type="button"
            className={`bt-swatch c${c}` + (current % TAG_COLORS === c ? ' active' : '')}
            onClick={() => {
              onPick(c)
              close()
            }}
          >
            {current % TAG_COLORS === c && <IconCheck width={13} height={13} />}
          </button>
        ))}
      </div>
    ),
    { width: 176, align: 'left' },
  )
}

function FieldEditor({ model, target, onClose }: { model: TableModel; target: Target; onClose: () => void }) {
  const editing = 'field' in target ? target.field : null
  const isPrimary = editing && model.state.fields[0]?.id === editing.id
  const init = 'field' in target ? {} : target
  const [type, setType] = useState<FieldType>(editing?.type ?? init.type ?? 'text')
  const [name, setName] = useState(editing?.name ?? init.name ?? '')
  const [typeOpen, setTypeOpen] = useState(!editing && !init.type)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [options, setOptions] = useState<FieldOptions>(() => JSON.parse(JSON.stringify(editing?.options ?? {})))
  const choices = options.choices ?? []

  const setChoices = (c: Choice[]) => setOptions({ ...options, choices: c })

  const pickType = (t: FieldType) => {
    setType(t)
    setTypeOpen(false)
    if ((t === 'select' || t === 'multiselect') && !options.choices?.length && editing?.type !== 'select' && editing?.type !== 'multiselect' && !editing) {
      setOptions({
        ...options,
        choices: [
          { id: newId(), name: '选项 1', color: 0 },
          { id: newId(), name: '选项 2', color: 1 },
          { id: newId(), name: '选项 3', color: 2 },
        ],
      })
    }
  }

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
  const basicTypes = types.filter((t) => t.group === 'basic')
  const advTypes = types.filter((t) => t.group === 'advanced')

  return (
    <form
      className="bt-field-editor"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="bt-field-editor-head">{editing ? '编辑字段' : '新建字段'}</div>

      <label className="bt-form-row">
        <span>字段名称</span>
        <input className="bt-input" autoFocus value={name} placeholder={defaultName(model, type)} onChange={(e) => setName(e.target.value)} />
      </label>

      <div className="bt-form-row">
        <span>字段类型</span>
        <button type="button" className={'bt-type-trigger' + (typeOpen ? ' open' : '')} onClick={() => setTypeOpen((o) => !o)}>
          <FieldTypeIcon type={type} size={15} className="bt-type-trigger-icon" />
          <span>{fieldTypeLabel(type)}</span>
          <span className="spacer" />
          <IconChevron width={14} height={14} style={{ transform: typeOpen ? 'rotate(270deg)' : 'rotate(90deg)', transition: 'transform 0.15s' }} />
        </button>

        {typeOpen && (
          <div className="bt-type-picker">
            <div className="bt-type-group-label">基础字段</div>
            <div className="bt-type-grid">
              {basicTypes.map((t) => (
                <button key={t.type} type="button" className={'bt-type-option' + (t.type === type ? ' active' : '')} onClick={() => pickType(t.type)}>
                  <FieldTypeIcon type={t.type} size={14} />
                  <span className="ellipsis">{t.label}</span>
                </button>
              ))}
            </div>
            {advTypes.length > 0 && (
              <>
                <div className="bt-type-group-label">高级与计算字段</div>
                <div className="bt-type-grid">
                  {advTypes.map((t) => (
                    <button key={t.type} type="button" className={'bt-type-option' + (t.type === type ? ' active' : '')} onClick={() => pickType(t.type)}>
                      <FieldTypeIcon type={t.type} size={14} />
                      <span className="ellipsis">{t.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

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
          <input type="checkbox" checked={!!options.time} onChange={(e) => setOptions({ ...options, time: e.target.checked })} /> 包含时间 (HH:mm)
        </label>
      )}

      {(type === 'select' || type === 'multiselect') && (
        <div className="bt-form-row">
          <span>选项配置（点击色块切换颜色，可拖拽排序）</span>
          <div className="bt-choices">
            {choices.map((c, i) => (
              <div
                key={c.id}
                className={'bt-choice-row' + (dragIdx === i ? ' dragging' : '')}
                draggable
                onDragStart={(e) => {
                  if (document.activeElement?.tagName === 'INPUT') {
                    e.preventDefault()
                    return
                  }
                  e.dataTransfer.effectAllowed = 'move'
                  setDragIdx(i)
                }}
                onDragEnd={() => setDragIdx(null)}
                onDragOver={(e) => dragIdx !== null && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  if (dragIdx === null || dragIdx === i) return
                  const next = [...choices]
                  const [moved] = next.splice(dragIdx, 1)
                  next.splice(i, 0, moved)
                  setChoices(next)
                  setDragIdx(null)
                }}
              >
                <span className="bt-drag-handle" title="拖动调整顺序">
                  ⠿
                </span>
                <button
                  type="button"
                  className={`bt-color-dot c${c.color % 10}`}
                  title="选择颜色"
                  aria-label="选择颜色"
                  onClick={(e) => openColorPalette(e.currentTarget, c.color, (color) => setChoices(choices.map((x, j) => (j === i ? { ...x, color } : x))))}
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
                <button type="button" className="icon-btn sm" title="删除选项" aria-label="删除选项" onClick={() => setChoices(choices.filter((_, j) => j !== i))}>
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
          {editing ? '保存修改' : '确定创建'}
        </button>
      </div>
    </form>
  )
}
