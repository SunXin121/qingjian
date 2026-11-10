// Links between documents (双链). Typing `[[` (or `【【`) opens a picker of documents and
// tables; the pick is inserted as an ordinary markdown link to the node's page, so the
// markdown stays portable and the server can index it for backlinks (links.go).

import { useEffect, useRef, useState } from 'react'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { api, nodePath, type NodeRef } from '../api'
import { openPopover } from '../components/dialog'
import { IconDoc, IconTable } from '../components/icons'

/** Path of an in-app document / table page, or null for any other link. */
export function nodeLinkPath(href: string | null): string | null {
  if (!href) return null
  let u: URL
  try {
    u = new URL(href, location.href)
  } catch {
    return null
  }
  if (u.origin !== location.origin || !/^\/r\/[0-9a-z]+\/[dt]\/[0-9a-z]+\/?$/.test(u.pathname)) return null
  return u.pathname + u.search + u.hash
}

const BRACKETS = '[【'

/**
 * Asks for a document / table and inserts a link to it at the caret. `onCancel` runs when
 * the picker is dismissed without a pick.
 */
export function openDocLinkPicker(view: EditorView, onCancel?: () => void) {
  const pos = view.state.selection.from
  const c = view.coordsAtPos(pos)
  let picked = false
  openPopover(
    { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
    (close) => (
      <DocLinkPicker
        onPick={(n) => {
          picked = true
          close()
          insertNodeLink(view, pos, n)
        }}
      />
    ),
    {
      width: 340,
      align: 'left',
      className: 'doc-link-popover',
      onClose: () => {
        view.focus()
        if (!picked) onCancel?.()
      },
    },
  )
}

function insertNodeLink(view: EditorView, pos: number, n: NodeRef) {
  const { state } = view
  const link = state.schema.marks.link
  if (!link) return
  const at = Math.min(pos, state.doc.content.size)
  const text = state.schema.text(n.title.trim() || (n.type === 'table' ? '未命名表格' : '无标题文档'), [link.create({ href: nodePath(n) })])
  const tr = state.tr.insert(at, text)
  // keep typing after the link outside of it
  tr.setStoredMarks([])
  view.dispatch(tr.scrollIntoView())
}

function DocLinkPicker({ onPick }: { onPick: (n: NodeRef) => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<NodeRef[] | null>(null)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(
      () =>
        api.findNodes(q.trim()).then(
          (r) => {
            if (!alive) return
            setList(r)
            setActive(0)
          },
          () => alive && setList([]),
        ),
      q ? 120 : 0,
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return (
    <div className="doc-link-picker">
      <input
        className="bt-input"
        autoFocus
        value={q}
        placeholder="搜索文档或表格标题，回车插入链接"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || !list?.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % list.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + list.length) % list.length)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onPick(list[Math.min(active, list.length - 1)])
          }
        }}
      />
      <div className="doc-link-list" ref={listRef}>
        {list === null ? (
          <div className="doc-link-empty">加载中…</div>
        ) : list.length === 0 ? (
          <div className="doc-link-empty">{q.trim() ? '没有匹配的文档' : '还没有文档'}</div>
        ) : (
          list.map((n, i) => (
            <button
              key={n.id}
              data-i={i}
              className={'doc-link-item' + (i === active ? ' active' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(n)}
            >
              {n.type === 'table' ? <IconTable width={15} height={15} /> : <IconDoc width={15} height={15} />}
              <span className="ellipsis">{n.title.trim() || (n.type === 'table' ? '未命名表格' : '无标题文档')}</span>
              <span className="doc-link-repo ellipsis">{n.repo_name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/** `[[` / `【【` outside code opens the picker; dismissing it puts the brackets back. */
export const docLinkTrigger = $prose(
  () =>
    new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          if (text.length !== 1 || !BRACKETS.includes(text) || from !== to) return false
          const $from = view.state.doc.resolve(from)
          if ($from.parent.type.spec.code || $from.parentOffset < 1) return false
          if ($from.marks().some((m) => m.type.name === 'inlineCode')) return false
          const prev = $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, '￼')
          if (!BRACKETS.includes(prev)) return false
          const typed = prev + text
          view.dispatch(view.state.tr.delete(from - 1, from))
          openDocLinkPicker(view, () => {
            const { state } = view
            view.dispatch(state.tr.insertText(typed, state.selection.from))
          })
          return true
        },
      },
    }),
)
