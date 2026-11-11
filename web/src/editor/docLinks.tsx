// Links between documents (双链). Typing `[[` (or `【【`) opens a picker of documents and
// tables; the pick is inserted as an ordinary markdown link to the node's page, so the
// markdown stays portable and the server can index it for backlinks (links.go).

import { useEffect, useRef, useState } from 'react'
import type { Mark } from '@milkdown/kit/prose/model'
import { Plugin } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { $prose } from '@milkdown/kit/utils'
import { api, nodePath, type NodeRef, type NodeRenamed } from '../api'
import { openPopover, toast } from '../components/dialog'
import { IconDoc, IconDocPlus, IconTable } from '../components/icons'
import '../table/table.css'

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

/** Text a link to a node shows by default (mirrored by linkLabel in links.go). */
export const linkLabel = (title: string, type: string) => title.trim() || (type === 'table' ? '未命名表格' : '无标题文档')

/** The document open in the admin UI (where a document created from the picker goes). */
function currentPage(): { repo: string; doc?: string } | null {
  const m = /^\/r\/([0-9a-z]+)(?:\/d\/([0-9a-z]+))?/.exec(location.pathname)
  return m ? { repo: m[1], doc: m[2] } : null
}

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
  const text = state.schema.text(linkLabel(n.title, n.type), [link.create({ href: nodePath(n) })])
  const tr = state.tr.insert(at, text)
  // keep typing after the link outside of it
  tr.setStoredMarks([])
  view.dispatch(tr.scrollIntoView())
}

/** Creates a document next to the current one (or at the root of the current repo). */
async function createDoc(title: string): Promise<NodeRef> {
  const page = currentPage()
  if (!page) throw new Error('无法确定新文档所在的知识库')
  let parent: string | null = null
  if (page.doc) parent = (await api.doc(page.doc).catch(() => null))?.parent_id ?? null
  const n = await api.createNode(page.repo, parent, 'doc', title)
  window.dispatchEvent(new CustomEvent('qj-tree-changed', { detail: page.repo }))
  return { id: n.id, repo_id: n.repo_id, repo_name: '', type: 'doc', title: n.title, updated_at: n.updated_at }
}

function DocLinkPicker({ onPick }: { onPick: (n: NodeRef) => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<NodeRef[] | null>(null)
  const [active, setActive] = useState(0)
  const [creating, setCreating] = useState(false)
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

  const title = q.trim()
  // offer a new document unless one is titled exactly like that
  const canCreate = !!title && !!currentPage() && list !== null && !list.some((n) => n.type === 'doc' && n.title.trim() === title)
  const count = (list?.length ?? 0) + (canCreate ? 1 : 0)
  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      onPick(await createDoc(title))
    } catch (e: any) {
      toast(e?.message ?? String(e))
      setCreating(false)
    }
  }
  const choose = (i: number) => (list && i < list.length ? onPick(list[i]) : canCreate && create())

  return (
    <div className="doc-link-picker">
      <input
        className="bt-input"
        autoFocus
        value={q}
        placeholder="搜索文档或表格标题，回车插入链接"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || !count) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % count)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + count) % count)
          } else if (e.key === 'Enter') {
            e.preventDefault()
            choose(Math.min(active, count - 1))
          }
        }}
      />
      <div className="doc-link-list" ref={listRef}>
        {list === null ? (
          <div className="doc-link-empty">加载中…</div>
        ) : (
          <>
            {list.length === 0 && !canCreate && <div className="doc-link-empty">{title ? '没有匹配的文档' : '还没有文档'}</div>}
            {list.map((n, i) => (
              <button
                key={n.id}
                data-i={i}
                className={'doc-link-item' + (i === active ? ' active' : '')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(n)}
              >
                {n.type === 'table' ? <IconTable width={15} height={15} /> : <IconDoc width={15} height={15} />}
                <span className="ellipsis">{linkLabel(n.title, n.type)}</span>
                <span className="doc-link-repo ellipsis">{n.repo_name}</span>
              </button>
            ))}
            {canCreate && (
              <button
                data-i={list.length}
                className={'doc-link-item create' + (active === list.length ? ' active' : '')}
                disabled={creating}
                onMouseEnter={() => setActive(list.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={create}
              >
                <IconDocPlus width={15} height={15} />
                <span className="ellipsis">
                  新建文档「{title}」
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Follows a rename (window event `qj-node-renamed`): links to the node whose text still is
 * its old title get the new one. The server does the same for stored documents.
 */
export function followRename(view: EditorView, r: NodeRenamed) {
  const from = linkLabel(r.from, r.type)
  const to = linkLabel(r.to, r.type)
  if (from === to) return
  const re = new RegExp(`/r/[0-9a-z]+/[dt]/${r.id}$`)
  const hits: { pos: number; end: number; marks: readonly Mark[] }[] = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== from) return
    const link = node.marks.find((m) => m.type.name === 'link')
    const path = link && nodeLinkPath(link.attrs.href)
    if (path && re.test(path.replace(/[?#].*$/, ''))) hits.push({ pos, end: pos + node.nodeSize, marks: node.marks })
  })
  if (!hits.length) return
  const tr = view.state.tr
  for (const h of hits.reverse()) tr.replaceWith(h.pos, h.end, view.state.schema.text(to, h.marks))
  view.dispatch(tr)
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
