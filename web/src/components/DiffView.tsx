import { diffChars, diffLines } from 'diff'
import { useMemo, useState, type ReactNode } from 'react'

type Row =
  | { kind: 'same' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number; inline?: ReactNode }
  | { kind: 'fold'; id: number; count: number; rows: Row[] }

const CONTEXT = 3

function splitLines(v: string) {
  const lines = v.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Character-level highlight for a removed/added line pair (works for CJK text without spaces). */
function inlinePair(a: string, b: string): [ReactNode, ReactNode] | null {
  if (a.length + b.length > 2000) return null
  const parts = diffChars(a, b)
  const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0)
  if (same < Math.min(a.length, b.length) * 0.3) return null // too different to be useful
  const render = (side: 'del' | 'add') =>
    parts.map((p, i) => {
      if (p.added && side === 'del') return null
      if (p.removed && side === 'add') return null
      return p.added || p.removed ? <mark key={i}>{p.value}</mark> : <span key={i}>{p.value}</span>
    })
  return [render('del'), render('add')]
}

function buildRows(oldText: string, newText: string): { rows: Row[]; added: number; removed: number } {
  const parts = diffLines(oldText, newText)
  const flat: Row[] = []
  let o = 1
  let n = 1
  let added = 0
  let removed = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    const lines = splitLines(p.value)
    if (p.removed && parts[i + 1]?.added) {
      // modified block: pair lines up for inline highlighting
      const next = splitLines(parts[i + 1].value)
      const dels: Row[] = []
      const adds: Row[] = []
      lines.forEach((t, k) => {
        const pair = next[k] !== undefined ? inlinePair(t, next[k]) : null
        dels.push({ kind: 'del', text: t, oldNo: o++, inline: pair?.[0] })
        if (pair) adds[k] = { kind: 'add', text: next[k], inline: pair[1] }
      })
      next.forEach((t, k) => {
        adds[k] = { ...(adds[k] ?? { kind: 'add', text: t }), newNo: n++ } as Row
      })
      removed += lines.length
      added += next.length
      flat.push(...dels, ...adds)
      i++
      continue
    }
    for (const t of lines) {
      if (p.added) {
        flat.push({ kind: 'add', text: t, newNo: n++ })
        added++
      } else if (p.removed) {
        flat.push({ kind: 'del', text: t, oldNo: o++ })
        removed++
      } else flat.push({ kind: 'same', text: t, oldNo: o++, newNo: n++ })
    }
  }
  // fold long unchanged runs, keeping a few lines of context around changes
  const rows: Row[] = []
  let run: Row[] = []
  let foldId = 0
  const flush = (atStart: boolean, atEnd: boolean) => {
    const keepHead = atStart ? 0 : CONTEXT
    const keepTail = atEnd ? 0 : CONTEXT
    if (run.length > keepHead + keepTail + 2) {
      rows.push(...run.slice(0, keepHead))
      const hidden = run.slice(keepHead, run.length - keepTail)
      rows.push({ kind: 'fold', id: foldId++, count: hidden.length, rows: hidden })
      rows.push(...run.slice(run.length - keepTail))
    } else rows.push(...run)
    run = []
  }
  let seenChange = false
  for (const r of flat) {
    if (r.kind === 'same') run.push(r)
    else {
      flush(!seenChange, false)
      seenChange = true
      rows.push(r)
    }
  }
  flush(!seenChange, true)
  return { rows, added, removed }
}

export default function DiffView({ oldText, newText, oldLabel, newLabel }: { oldText: string; newText: string; oldLabel: string; newLabel: string }) {
  const { rows, added, removed } = useMemo(() => buildRows(oldText, newText), [oldText, newText])
  const [open, setOpen] = useState<Set<number>>(new Set())

  const renderRow = (r: Row, key: string | number): ReactNode => {
    if (r.kind === 'fold') {
      if (open.has(r.id)) return r.rows.map((x, i) => renderRow(x, `${key}-${i}`))
      return (
        <button key={key} className="diff-fold" onClick={() => setOpen(new Set([...open, r.id]))}>
          ⋯ {r.count} 行未变化，点击展开
        </button>
      )
    }
    return (
      <div key={key} className={'diff-line ' + r.kind}>
        <span className="diff-no">{r.oldNo ?? ''}</span>
        <span className="diff-no">{r.newNo ?? ''}</span>
        <span className="diff-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</span>
        <span className="diff-text">{r.inline ?? (r.text || ' ')}</span>
      </div>
    )
  }

  return (
    <div className="diff-view">
      <div className="diff-head">
        <span>
          <span className="diff-legend del">−</span> {oldLabel}
        </span>
        <span>
          <span className="diff-legend add">+</span> {newLabel}
        </span>
        <span className="spacer" />
        <span className="diff-stat">
          <span className="add">+{added}</span> <span className="del">−{removed}</span>
        </span>
      </div>
      {added === 0 && removed === 0 ? <div className="side-empty">内容完全相同</div> : <div className="diff-body">{rows.map((r, i) => renderRow(r, i))}</div>}
    </div>
  )
}
