// Callout (提示块) and fold (折叠块) blocks.
//
// They are stored as plain blockquotes using the Obsidian / GitHub "alert" syntax, so the
// markdown stays portable:
//
//   > [!INFO]            > [!FOLD]- 标题
//   >                    >
//   > 内容                > 折叠的内容
//
// Rendering is purely a decoration layer on top of the blockquote node: the marker is
// hidden unless the cursor is in the title line, and a `-` / `+` suffix (or the FOLD
// type) makes the block collapsible. Collapse state is per-view and never saved.

import type { Ctx } from '@milkdown/kit/ctx'
import { commandsCtx, editorViewCtx } from '@milkdown/kit/core'
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'

export type CalloutStyle = 'info' | 'warn' | 'success' | 'error' | 'fold'

const STYLE_OF: Record<string, CalloutStyle> = {}
const alias = (style: CalloutStyle, ...names: string[]) => names.forEach((n) => (STYLE_OF[n] = style))
alias('info', 'INFO', 'NOTE', 'ABSTRACT', 'SUMMARY', 'TLDR', 'TODO', 'QUESTION', 'HELP', 'FAQ', 'IMPORTANT', 'EXAMPLE', 'QUOTE', 'CITE')
alias('warn', 'WARN', 'WARNING', 'ATTENTION')
alias('success', 'SUCCESS', 'TIP', 'HINT', 'CHECK', 'DONE')
alias('error', 'ERROR', 'DANGER', 'CAUTION', 'FAILURE', 'FAIL', 'MISSING', 'BUG')
alias('fold', 'FOLD', 'DETAILS', 'COLLAPSE')

export const CALLOUT_LABEL: Record<CalloutStyle, string> = {
  info: '信息',
  warn: '警告',
  success: '成功',
  error: '错误',
  fold: '折叠块',
}

const ICON: Record<CalloutStyle, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  fold: '',
}

const MARKER = /^\[!([A-Za-z]+)\]([+-]?)[ \t]*/

interface Parsed {
  style: CalloutStyle
  markerLen: number
  foldable: boolean
  collapsedByDefault: boolean
  hasTitle: boolean
}

function parseCallout(node: PMNode): Parsed | null {
  const first = node.firstChild
  if (!first || first.type.name !== 'paragraph') return null
  const text = first.textContent
  const m = MARKER.exec(text)
  if (!m) return null
  // the marker must be plain text at the start of the paragraph
  const lead = first.firstChild
  if (!lead?.isText || !lead.text!.startsWith(m[0].trimEnd())) return null
  const style = STYLE_OF[m[1].toUpperCase()] ?? 'info'
  const foldable = style === 'fold' || m[2] !== ''
  return {
    style,
    markerLen: m[0].length,
    foldable,
    collapsedByDefault: foldable && m[2] !== '+',
    hasTitle: text.length > m[0].length,
  }
}

interface CalloutState {
  /** positions (blockquote start) whose collapse state differs from its default */
  toggled: Set<number>
  decos: DecorationSet
}

export const calloutKey = new PluginKey<CalloutState>('ink-callout')

function headWidget(p: Parsed, collapsed: boolean, pos: number) {
  return (view: any) => {
    const el = document.createElement('span')
    el.className = 'ink-callout-head'
    el.contentEditable = 'false'
    if (p.foldable) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'ink-callout-toggle' + (collapsed ? '' : ' open')
      btn.title = collapsed ? '展开' : '收起'
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>'
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch(view.state.tr.setMeta(calloutKey, { toggle: pos }))
      })
      el.appendChild(btn)
    }
    if (ICON[p.style]) {
      const icon = document.createElement('span')
      icon.className = 'ink-callout-icon'
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[p.style]}</svg>`
      el.appendChild(icon)
    }
    if (!p.hasTitle) {
      const label = document.createElement('span')
      label.className = 'ink-callout-label'
      label.textContent = CALLOUT_LABEL[p.style]
      el.appendChild(label)
    }
    return el
  }
}

/** Decorations of the callouts inside [from, to) (whole top-level blocks). */
function blockDecorations(doc: PMNode, selection: { from: number; to: number }, toggled: Set<number>, from: number, to: number): Decoration[] {
  const decos: Decoration[] = []
  doc.nodesBetween(from, to, (node: PMNode, pos: number) => {
    if (node.isTextblock || node.type.name === 'code_block') return false
    if (node.type.name !== 'blockquote') return true
    const p = parseCallout(node)
    if (!p) return true
    const collapsed = p.foldable && p.collapsedByDefault !== toggled.has(pos)
    const titlePos = pos + 1 // the first paragraph
    const titleEnd = titlePos + node.firstChild!.nodeSize
    const editingTitle = selection.from >= titlePos && selection.to <= titleEnd && selection.from > titlePos
    decos.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `ink-callout ink-callout-${p.style}` + (p.foldable ? ' ink-foldable' : '') + (collapsed ? ' ink-collapsed' : ''),
      }),
      Decoration.node(titlePos, titleEnd, { class: 'ink-callout-title' + (p.hasTitle ? '' : ' no-title') }),
      Decoration.inline(titlePos + 1, titlePos + 1 + p.markerLen, { class: 'ink-callout-marker' + (editingTitle ? ' editing' : '') }),
      Decoration.widget(titlePos + 1, headWidget(p, collapsed, pos), {
        side: -1,
        ignoreSelection: true,
        key: `callout-${pos}-${p.style}-${collapsed}-${p.hasTitle}`,
      }),
    )
    return true // callouts can nest
  })
  return decos
}

/** [from, to) widened to whole top-level blocks. */
function topLevelSpan(doc: PMNode, from: number, to: number): [number, number] {
  const a = doc.resolve(Math.max(0, Math.min(from, doc.content.size)))
  const b = doc.resolve(Math.max(0, Math.min(to, doc.content.size)))
  return [a.depth > 0 ? a.before(1) : a.pos, b.depth > 0 ? b.after(1) : b.pos]
}

// The decorations live in the plugin state and are updated incrementally: rebuilding them
// for the whole document on every keystroke made typing in long documents sluggish. After
// a transaction only the top-level blocks touched by its changes or by the old / new
// selection (the marker shows while the cursor is in the title) are rebuilt.
export const calloutPlugin = $prose(
  () =>
    new Plugin<CalloutState>({
      key: calloutKey,
      state: {
        init: (_, state) => ({
          toggled: new Set(),
          decos: DecorationSet.create(state.doc, blockDecorations(state.doc, state.selection, new Set(), 0, state.doc.content.size)),
        }),
        apply(tr, prev, oldState, newState) {
          let toggled = prev.toggled
          if (tr.docChanged && toggled.size) {
            toggled = new Set()
            for (const p of prev.toggled) {
              const r = tr.mapping.mapResult(p, 1)
              if (!r.deleted) toggled.add(r.pos)
            }
          }
          const meta = tr.getMeta(calloutKey) as { toggle?: number } | undefined
          const doc = newState.doc
          if (meta?.toggle !== undefined) {
            toggled = new Set(toggled)
            toggled.has(meta.toggle) ? toggled.delete(meta.toggle) : toggled.add(meta.toggle)
            return { toggled, decos: DecorationSet.create(doc, blockDecorations(doc, newState.selection, toggled, 0, doc.content.size)) }
          }
          if (!tr.docChanged && oldState.selection.eq(newState.selection)) return toggled === prev.toggled ? prev : { ...prev, toggled }

          // ranges to rebuild, in the new document's coordinates
          const ranges: [number, number][] = []
          tr.mapping.maps.forEach((map, i) => {
            const rest = tr.mapping.slice(i + 1)
            map.forEach((_os, _oe, ns, ne) => ranges.push([rest.map(ns, -1), rest.map(ne, 1)]))
          })
          const oldSel = oldState.selection
          ranges.push([tr.mapping.map(oldSel.from, -1), tr.mapping.map(oldSel.to, 1)], [newState.selection.from, newState.selection.to])

          let decos = prev.decos.map(tr.mapping, doc)
          const spans = ranges.map(([a, b]) => topLevelSpan(doc, Math.min(a, b), Math.max(a, b))).sort((x, y) => x[0] - y[0])
          for (let i = 0; i < spans.length; i++) {
            let [from, to] = spans[i]
            while (i + 1 < spans.length && spans[i + 1][0] <= to) to = Math.max(to, spans[++i][1])
            const stale = decos.find(from, to).filter((d) => d.from >= from && d.to <= to)
            decos = decos.remove(stale).add(doc, blockDecorations(doc, newState.selection, toggled, from, to))
          }
          return { toggled, decos }
        },
      },
      props: {
        decorations: (state) => calloutKey.getState(state)?.decos,
      },
    }),
)

/** Slash-menu action: replace the current empty block with a callout / fold block. */
export function insertCallout(ctx: Ctx, type: 'INFO' | 'WARNING' | 'SUCCESS' | 'ERROR' | 'FOLD') {
  ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key)
  const view = ctx.get(editorViewCtx)
  const { state } = view
  const { schema } = state
  const { $from } = state.selection
  const fold = type === 'FOLD'
  const marker = fold ? '[!FOLD]- ' : `[!${type}]`
  const title = fold ? '折叠标题' : ''
  const bq = schema.nodes.blockquote.create(null, [
    schema.nodes.paragraph.create(null, schema.text(marker + title)),
    schema.nodes.paragraph.create(),
  ])
  const start = $from.before()
  const tr = state.tr.replaceWith(start, $from.after(), bq)
  if (fold) {
    // select the placeholder title and keep the new block expanded while editing
    const from = start + 2 + marker.length
    tr.setSelection(TextSelection.create(tr.doc, from, from + title.length))
    tr.setMeta(calloutKey, { toggle: start })
  } else {
    tr.setSelection(TextSelection.create(tr.doc, start + 1 + bq.child(0).nodeSize + 1))
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/** remark escapes the leading `[` of callout markers; undo that so the markdown stays readable. */
export function normalizeCalloutMarkdown(md: string) {
  return md.replace(/^((?:>[ \t]?)+)\\\[!([A-Za-z]+)\]/gm, '$1[!$2]')
}
