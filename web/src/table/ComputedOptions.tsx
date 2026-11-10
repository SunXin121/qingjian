// Field editor sections for link, lookup, rollup and formula fields.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type TableSummary } from '../api'
import { openMenu, openPopover } from '../components/dialog'
import { ROLLUP_AGGS } from './compute'
import { displayText } from './engine'
import { compileFormula, toCellValue, toDisplayExpr, toStoredExpr } from './formula'
import { useTable, type TableModel } from './model'
import { FormulaHelp } from './ViewPanels'
import { fieldTypeLabel, newId, type Field, type FieldOptions, type FieldType } from './types'

interface Props {
  model: TableModel
  /** the field being edited (undefined while creating one) */
  editing: Field | null
  options: FieldOptions
  setOptions: (o: FieldOptions) => void
}

let tablesCache: Promise<TableSummary[]> | null = null
function useTables(): TableSummary[] | null {
  const [list, setList] = useState<TableSummary[] | null>(null)
  useEffect(() => {
    tablesCache ??= api.tables()
    tablesCache.then(setList).catch(() => setList([]))
    // refreshed next time an editor opens
    return () => {
      tablesCache = null
    }
  }, [])
  return list
}

export function LinkOptions({ model, editing, options, setOptions }: Props) {
  const tables = useTables()
  const self = model.state
  const target = options.table
  const isSelf = target === self.id
  const wasTwoWay = !!editing?.options.pair
  useEffect(() => {
    if (target) model.ensureLinked(target).catch(() => {})
  }, [model, target])
  return (
    <>
      <label className="bt-form-row">
        <span>关联的表格</span>
        <select
          className="bt-input"
          value={target ?? ''}
          onChange={(e) => {
            const table = e.target.value || undefined
            const o: FieldOptions = { ...options, table }
            // a two-way link to this very table is not supported
            if (table === self.id) {
              delete o.pair
              delete o.pairName
            }
            setOptions(o)
          }}
        >
          <option value="">选择表格…</option>
          <option value={self.id}>当前表格（{self.title.trim() || '未命名表格'}）</option>
          {(tables ?? [])
            .filter((t) => t.id !== self.id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.title.trim() || '未命名表格'} · {t.repo_name}
              </option>
            ))}
          {tables && target && target !== self.id && !tables.some((t) => t.id === target) && <option value={target}>（已删除的表格）</option>}
        </select>
      </label>
      {editing && target !== editing.options.table && editing.options.table && <div className="bt-hint warn">更换关联的表格会清空这一列已关联的记录。</div>}
      <label className="bt-check-row">
        <input type="checkbox" checked={options.multiple !== false} onChange={(e) => setOptions({ ...options, multiple: e.target.checked ? undefined : false })} /> 允许关联多条记录
      </label>
      {target && !isSelf && (
        <>
          <label className="bt-check-row">
            <input
              type="checkbox"
              checked={!!options.pair}
              onChange={(e) => {
                const o = { ...options }
                if (e.target.checked) {
                  o.pair = editing?.options.pair ?? newId()
                  if (!wasTwoWay) o.pairName = self.title.trim() || '关联'
                } else {
                  delete o.pair
                  delete o.pairName
                }
                setOptions(o)
              }}
            />{' '}
            双向关联
          </label>
          {options.pair && !wasTwoWay && (
            <label className="bt-form-row">
              <span>对方表格中的字段名称</span>
              <input className="bt-input" value={options.pairName ?? ''} onChange={(e) => setOptions({ ...options, pairName: e.target.value })} />
            </label>
          )}
          <div className="bt-hint">
            {options.pair ? '对方表格会出现一个关联回本表的字段，两边的关联保持同步。' : '单向关联：只在本表记录关联了哪些记录。'}
            {wasTwoWay && !options.pair && ' 取消后对方表格中的字段会保留为单向关联。'}
          </div>
        </>
      )}
    </>
  )
}

export function LookupOptions({ model, editing, options, setOptions, type }: Props & { type: FieldType }) {
  const t = useTable(model)
  const links = t.fields.filter((f) => f.type === 'link' && f.id !== editing?.id)
  const link = links.find((f) => f.id === options.link)
  const linkedTable = link?.rt?.table
  useEffect(() => {
    if (link?.options.table) model.ensureLinked(link.options.table).catch(() => {})
  }, [model, link?.options.table])
  const targets = linkedTable ? (linkedTable.id === t.id ? t.fields : linkedTable.fields) : []
  const target = targets.find((f) => f.id === options.target)
  if (!links.length) return <div className="bt-hint warn">请先添加一个「关联」字段，{type === 'lookup' ? '查找引用' : '汇总'}会读取关联记录中的字段。</div>
  return (
    <>
      <label className="bt-form-row">
        <span>通过关联字段</span>
        <select className="bt-input" value={options.link ?? ''} onChange={(e) => setOptions({ ...options, link: e.target.value || undefined, target: undefined })}>
          <option value="">选择关联字段…</option>
          {links.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
              {f.rt?.table ? `（${f.rt.table.title.trim() || '未命名表格'}）` : ''}
            </option>
          ))}
        </select>
      </label>
      {link && (
        <label className="bt-form-row">
          <span>{type === 'lookup' ? '引用的字段' : '汇总的字段'}</span>
          <select className="bt-input" value={options.target ?? ''} onChange={(e) => setOptions({ ...options, target: e.target.value || undefined })} disabled={!linkedTable}>
            <option value="">{linkedTable ? '选择字段…' : (link.rt?.error ?? '加载中…')}</option>
            {targets
              .filter((f) => !(linkedTable?.id === t.id && f.id === editing?.id))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}（{fieldTypeLabel(f.type)}）
                </option>
              ))}
          </select>
        </label>
      )}
      {type === 'rollup' && (
        <label className="bt-form-row">
          <span>汇总方式</span>
          <select className="bt-input" value={options.agg ?? 'sum'} onChange={(e) => setOptions({ ...options, agg: e.target.value as FieldOptions['agg'] })}>
            {ROLLUP_AGGS.map((a) => (
              <option key={a.agg} value={a.agg}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {type === 'rollup' && target && ['sum', 'avg', 'min', 'max'].includes(options.agg ?? 'sum') && !['number', 'rating', 'progress', 'autonumber', 'formula', 'rollup', 'lookup'].includes(target.type) && (
        <div className="bt-hint warn">「{target.name}」不是数字字段，只有能识别为数字的值会参与计算。</div>
      )}
      {type === 'rollup' && ['sum', 'avg', 'min', 'max'].includes(options.agg ?? 'sum') && <NumberFormat options={options} setOptions={setOptions} />}
    </>
  )
}

export function NumberFormat({ options, setOptions, label = '小数位数' }: { options: FieldOptions; setOptions: (o: FieldOptions) => void; label?: string }) {
  return (
    <>
      <label className="bt-form-row">
        <span>{label}</span>
        <select className="bt-input" value={options.precision ?? ''} onChange={(e) => setOptions({ ...options, precision: e.target.value === '' ? undefined : Number(e.target.value) })}>
          <option value="">自动</option>
          <option value="0">整数</option>
          {[1, 2, 3, 4].map((n) => (
            <option key={n} value={n}>
              {n} 位小数
            </option>
          ))}
        </select>
      </label>
      <label className="bt-check-row">
        <input type="checkbox" checked={!!options.thousands} onChange={(e) => setOptions({ ...options, thousands: e.target.checked || undefined })} /> 千分位分隔
      </label>
    </>
  )
}

/** Formula editor: the text as typed (field names) is kept in `text`; `options.expr` is the stored form. */
export function FormulaOptions({ model, editing, options, setOptions }: Props) {
  const t = useTable(model)
  const [text, setText] = useState(() => toDisplayExpr(t, options.expr ?? ''))
  const ref = useRef<HTMLTextAreaElement>(null)
  // other fields only: a formula cannot reference itself
  const fields = useMemo(() => t.fields.filter((f) => f.id !== editing?.id), [t.fields, editing?.id])
  const stored = toStoredExpr({ fields }, text)
  const check = useMemo(() => {
    if (!text.trim()) return null
    const c = compileFormula({ fields }, stored)
    if (!c.ok) return c
    // preview on the first records
    const samples = t.records.slice(0, 3).map((r) => toCellValue(c.run(r)))
    return { ok: true as const, samples }
  }, [fields, stored, text, t.records])
  const change = (v: string) => {
    setText(v)
    setOptions({ ...options, expr: toStoredExpr({ fields }, v) })
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
  const preview = (v: { value: any; kind?: string }) => {
    if (v.value === undefined) return '空'
    if (v.kind === 'number') return displayText({ id: '', name: '', type: 'number', options: { precision: options.precision, thousands: options.thousands }, sort: 0 }, v.value)
    if (v.kind === 'checkbox') return v.value ? '✓ 真' : '✗ 假'
    return Array.isArray(v.value) ? v.value.join(', ') : String(v.value)
  }
  return (
    <>
      <div className="bt-form-row">
        <span>公式</span>
        <textarea
          ref={ref}
          className={'bt-input bt-expr-input' + (check && !check.ok ? ' invalid' : '')}
          rows={3}
          spellCheck={false}
          autoFocus={!!editing}
          value={text}
          placeholder={'例如 {单价} * {数量}'}
          onChange={(e) => change(e.target.value)}
        />
        <div className="bt-expr-bar">
          <button
            type="button"
            className="btn ghost sm"
            onClick={(e) =>
              openMenu(
                e.currentTarget,
                fields.map((f) => ({ label: f.name, onClick: () => insert(`{${f.name}}`) })),
                { align: 'left', width: 220 },
              )
            }
          >
            {'{ }'} 插入字段
          </button>
          <button
            type="button"
            className="btn ghost sm"
            onClick={(e) => openPopover(e.currentTarget, (close) => <FormulaHelp formula onPick={(name) => (close(), insert(name + '()', 1))} />, { width: 380, align: 'left' })}
          >
            ƒ 函数
          </button>
        </div>
        {check && !check.ok && <div className="bt-expr-error">{check.error}</div>}
        {check?.ok && check.samples.length > 0 && (
          <div className="bt-expr-ok">
            预览：
            {check.samples.map((v, i) => (
              <span key={i} className="bt-expr-sample">
                {preview(v)}
              </span>
            ))}
          </div>
        )}
      </div>
      <NumberFormat options={options} setOptions={setOptions} label="数字结果的小数位数" />
    </>
  )
}
